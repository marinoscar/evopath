import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, type UserMemory } from '@prisma/client';

import {
  memorySettingsSchema,
  resolveMemoryUserSettings,
  type ResolvedMemoryUserSettings,
} from '../common/schemas/user-settings-namespaces.schema';
import type { SystemMemoryValue } from '../common/schemas/settings.schema';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import {
  MEMORY_CATEGORIES,
  MEMORY_FORGET_MIN_SIMILARITY,
  MEMORY_IMMUTABLE_TO_EXTRACTION,
  MEMORY_NEAR_DUPLICATE_SIMILARITY,
  memoryContentRejected,
  memoryDisabled,
  memoryHealthNotAllowed,
  memoryLimitReached,
  memoryNotFound,
  memoryNotRestorable,
  type MemoryCategory,
  type MemorySensitivity,
  type MemorySource,
} from './memory.constants';
import { MemoryMetrics } from './memory.metrics';
import { checkMemoryContent, inferMemorySensitivity, normalizeMemoryContent } from './memory-validation';

// =============================================================================
// MemoryService: the one writer of `user_memories` (#325; docs/specs/ai-memory.md)
// =============================================================================
//
// THREE WRITERS, ONE PATH. The settings page (`user_edited`), the coach's chat
// tools (`explicit`) and the background extraction (`extracted`) all write
// through `write()`, which in order:
//
//   1. validates the content (`checkMemoryContent`: length, shape, no
//      instruction, URL, email, code, credential, financial, phone or
//      third-party data) -> 400 `MEMORY_CONTENT_REJECTED` with `rule`;
//   2. gates an AGENT write (tool or extraction) on the system `memory.enabled`
//      and the user's own `memory.enabled` -> 403 `MEMORY_DISABLED`. The
//      user's own routes are NOT gated, so a user can always see, add, edit
//      and delete what is stored about them;
//   3. infers the sensitivity (`inferMemorySensitivity`) and refuses a
//      `health` memory while the user's `allowHealth` is off -> 400
//      `MEMORY_HEALTH_NOT_ALLOWED`;
//   4. de-duplicates: a normalized exact match among the user's active
//      memories returns that memory unchanged; a `pg_trgm` similarity above
//      0.8 in the same category updates it instead of adding a second one
//      (never when the match is `explicit`/`user_edited` and the writer is
//      the extraction: those rows are immutable to the background path);
//   5. enforces the per-user cap (system `memory.maxPerUser`): an extracted
//      add evicts the oldest unpinned extracted memory; any other add over
//      the cap is 409 `MEMORY_LIMIT_REACHED`.
//
// OWNER ONLY. Every read and write carries `userId` in its `where`; a row of
// another user is indistinguishable from a missing one (404
// `MEMORY_NOT_FOUND`).
//
// ⚠ NEVER LOG CONTENT. Log lines and metrics carry ids, categories and
// sources only.
// =============================================================================

export type MemoryWriteActor = 'user' | 'agent';

export interface MemoryWriteInput {
  content: string;
  category: MemoryCategory;
  sensitivity?: MemorySensitivity | null;
  source: MemorySource;
  sourceMessageId?: string | null;
  confidence?: number | null;
}

export type MemoryWriteOp = 'added' | 'updated' | 'unchanged';

export interface MemoryWriteResult {
  op: MemoryWriteOp;
  memory: UserMemory;
  /** Ids an extracted add evicted to stay under the cap. */
  evictedIds: string[];
}

export interface MemoryUpdatePatch {
  content?: string;
  category?: MemoryCategory;
  pinned?: boolean;
  sensitivity?: MemorySensitivity;
}

export interface MemoryGate {
  /** System and user switches both on. */
  enabled: boolean;
  /** Background extraction may run (system and user `autoExtract`, plus `enabled`). */
  autoExtract: boolean;
  user: ResolvedMemoryUserSettings;
  policy: SystemMemoryValue;
}

export interface MemoryListFilter {
  category?: MemoryCategory;
  status?: 'active' | 'deleted';
}

export interface MemoryCounts {
  active: number;
  byCategory: Record<MemoryCategory, number>;
}

const ACTIVE = 'active';

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);
  private trigramWarned = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    @Optional() private readonly metrics: MemoryMetrics = new MemoryMetrics(),
  ) {}

  // ---------------------------------------------------------------------------
  // Settings and gates
  // ---------------------------------------------------------------------------

  /** The user's resolved `memory` namespace, read without creating a settings row. A malformed value degrades to the defaults. */
  async userSettings(userId: string): Promise<ResolvedMemoryUserSettings> {
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    const raw = (row?.value as { memory?: unknown } | null | undefined)?.memory;
    const parsed = memorySettingsSchema.safeParse(raw ?? {});
    return resolveMemoryUserSettings(parsed.success ? parsed.data : undefined);
  }

  async gate(userId: string): Promise<MemoryGate> {
    const [policy, user] = await Promise.all([this.systemSettings.getMemoryPolicy(), this.userSettings(userId)]);
    const enabled = policy.enabled && user.enabled;
    return { enabled, autoExtract: enabled && policy.autoExtract && user.autoExtract, user, policy };
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async list(userId: string, filter: MemoryListFilter = {}) {
    const status = filter.status ?? ACTIVE;
    const [gate, items, counts] = await Promise.all([
      this.gate(userId),
      this.prisma.userMemory.findMany({
        where: {
          userId,
          status,
          ...(filter.category ? { category: filter.category } : {}),
          ...(status === 'deleted' ? { deletedAt: { not: null } } : {}),
        },
        orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
      }),
      this.counts(userId),
    ]);
    return {
      items: (items ?? []).map(toMemoryView),
      settings: gate.user,
      policy: { enabled: gate.policy.enabled, autoExtract: gate.policy.autoExtract, maxPerUser: gate.policy.maxPerUser },
      counts,
    };
  }

  async counts(userId: string): Promise<MemoryCounts> {
    const rows = ((await this.prisma.userMemory.findMany({
      where: { userId, status: ACTIVE },
      select: { category: true },
    })) ?? []) as Array<{ category: string }>;
    const byCategory = Object.fromEntries(MEMORY_CATEGORIES.map((c) => [c, 0])) as Record<MemoryCategory, number>;
    for (const row of rows) {
      const category = (MEMORY_CATEGORIES as readonly string[]).includes(row.category) ? (row.category as MemoryCategory) : 'other';
      byCategory[category] += 1;
    }
    const active = rows.length;
    return { active, byCategory };
  }

  /** The caller's active memories (any category, or one), newest first. */
  async activeMemories(userId: string, category?: MemoryCategory): Promise<UserMemory[]> {
    return (
      (await this.prisma.userMemory.findMany({
        where: { userId, status: ACTIVE, ...(category ? { category } : {}) },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      })) ?? []
    );
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /** The user's own add (settings page): `user_edited`, not gated on the switches. */
  async create(userId: string, input: { content: string; category: MemoryCategory; sensitivity?: MemorySensitivity | null }) {
    const result = await this.write(userId, { ...input, source: 'user_edited' }, 'user');
    return toMemoryView(result.memory);
  }

  /**
   * The shared write path (see the file header). Throws an HttpException for
   * a refusal; `actor: 'agent'` is gated on the memory switches.
   */
  async write(userId: string, input: MemoryWriteInput, actor: MemoryWriteActor): Promise<MemoryWriteResult> {
    const checked = checkMemoryContent(input.content);
    if (!checked.ok) {
      this.metrics.rejected(input.source, checked.rule);
      throw memoryContentRejected(checked.rule, checked.message);
    }
    const content = checked.content;
    const gate = await this.gate(userId);
    if (actor === 'agent' && !gate.enabled) throw memoryDisabled();

    const sensitivity = inferMemorySensitivity(content, input.category, input.sensitivity);
    if (sensitivity === 'health' && !gate.user.allowHealth) {
      this.metrics.rejected(input.source, 'health_not_allowed');
      throw memoryHealthNotAllowed();
    }

    // ---- de-duplication -------------------------------------------------------
    const normalized = normalizeMemoryContent(content);
    const active = await this.activeMemories(userId);
    const exact = active.find((m) => normalizeMemoryContent(m.content) === normalized);
    if (exact) {
      this.metrics.noop(input.source);
      return { op: 'unchanged', memory: exact, evictedIds: [] };
    }

    const near = await this.nearDuplicate(userId, content, input.category);
    if (near) {
      const immutable = input.source === 'extracted' && MEMORY_IMMUTABLE_TO_EXTRACTION.includes(near.source as MemorySource);
      if (immutable) {
        this.metrics.noop(input.source);
        return { op: 'unchanged', memory: near, evictedIds: [] };
      }
      const updated = await this.prisma.userMemory.update({
        where: { id: near.id },
        data: {
          content,
          sensitivity,
          // An explicit or user write takes ownership; an extracted refresh keeps the row's source.
          source: input.source === 'extracted' ? near.source : input.source,
          ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}),
          ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        },
      });
      this.metrics.updated(input.source);
      this.logger.debug(`Memory ${near.id} of user ${userId} refreshed by a near-duplicate (${input.source})`);
      return { op: 'updated', memory: updated, evictedIds: [] };
    }

    // ---- cap --------------------------------------------------------------------
    const evictedIds = await this.makeRoom(userId, active, gate.policy.maxPerUser, input.source);

    const memory = await this.prisma.userMemory.create({
      data: {
        userId,
        content,
        category: input.category,
        source: input.source,
        sensitivity,
        status: ACTIVE,
        sourceMessageId: input.sourceMessageId ?? null,
        confidence: input.confidence ?? null,
      },
    });
    this.metrics.added(input.source);
    this.logger.debug(`Memory ${memory.id} added for user ${userId} (${input.category}, ${input.source})`);
    return { op: 'added', memory, evictedIds };
  }

  /**
   * Edits an active memory. A content edit by the user marks it
   * `user_edited`; by the coach (`update_memory`) `explicit`. 404 for a
   * missing, foreign or inactive id.
   */
  async update(userId: string, id: string, patch: MemoryUpdatePatch, actor: MemoryWriteActor): Promise<UserMemory> {
    const existing = await this.prisma.userMemory.findFirst({ where: { id, userId, status: ACTIVE } });
    if (!existing) throw memoryNotFound();
    const gate = actor === 'agent' || patch.content !== undefined || patch.sensitivity !== undefined || patch.category !== undefined
      ? await this.gate(userId)
      : null;
    if (actor === 'agent' && !gate?.enabled) throw memoryDisabled();

    const data: Prisma.UserMemoryUpdateInput = {};
    let content = existing.content;
    if (patch.content !== undefined) {
      const checked = checkMemoryContent(patch.content);
      if (!checked.ok) {
        const source = actor === 'user' ? 'user_edited' : 'explicit';
        this.metrics.rejected(source, checked.rule);
        throw memoryContentRejected(checked.rule, checked.message);
      }
      content = checked.content;
      data.content = content;
      data.source = actor === 'user' ? 'user_edited' : 'explicit';
    }
    if (patch.category !== undefined) data.category = patch.category;
    if (patch.pinned !== undefined) data.pinned = patch.pinned;

    if (gate && (patch.content !== undefined || patch.sensitivity !== undefined || patch.category !== undefined)) {
      const category = (patch.category ?? existing.category) as MemoryCategory;
      // The user may mark a memory `normal` themselves (an injury stays `health`);
      // otherwise the sensitivity is re-inferred, never lowered below what was declared.
      const sensitivity: MemorySensitivity =
        patch.sensitivity === 'normal' && actor === 'user'
          ? category === 'constraint_injury'
            ? 'health'
            : 'normal'
          : inferMemorySensitivity(
              content,
              category,
              patch.sensitivity ?? (patch.content === undefined ? (existing.sensitivity as MemorySensitivity) : null),
            );
      if (sensitivity === 'health' && !gate.user.allowHealth) throw memoryHealthNotAllowed();
      data.sensitivity = sensitivity;
    }

    const updated = await this.prisma.userMemory.update({ where: { id: existing.id }, data });
    this.metrics.updated(actor === 'user' ? 'user_edited' : 'explicit');
    return updated;
  }

  /** Soft delete (undo window: `purgeAfterDays`). 404 for a missing, foreign or inactive id. */
  async softDelete(userId: string, id: string): Promise<UserMemory> {
    const existing = await this.prisma.userMemory.findFirst({ where: { id, userId, status: ACTIVE } });
    if (!existing) throw memoryNotFound();
    const now = new Date();
    const result = await this.prisma.userMemory.updateMany({
      where: { id, userId, status: ACTIVE },
      data: { status: 'deleted', deletedAt: now },
    });
    if (result.count === 0) throw memoryNotFound();
    this.metrics.deleted(existing.source);
    return { ...existing, status: 'deleted', deletedAt: now };
  }

  /** Brings a soft-deleted memory back while it is inside the purge window. */
  async restore(userId: string, id: string): Promise<UserMemory> {
    const existing = await this.prisma.userMemory.findFirst({ where: { id, userId } });
    if (!existing) throw memoryNotFound();
    if (existing.status === ACTIVE) return existing;
    const policy = await this.systemSettings.getMemoryPolicy();
    const windowStart = Date.now() - policy.purgeAfterDays * 24 * 60 * 60 * 1000;
    if (existing.status !== 'deleted' || !existing.deletedAt || existing.deletedAt.getTime() < windowStart) {
      throw memoryNotRestorable();
    }
    const activeCount = await this.prisma.userMemory.count({ where: { userId, status: ACTIVE } });
    if (activeCount >= policy.maxPerUser) throw memoryLimitReached(policy.maxPerUser);
    const result = await this.prisma.userMemory.updateMany({
      where: { id, userId, status: 'deleted' },
      data: { status: ACTIVE, deletedAt: null },
    });
    if (result.count === 0) throw memoryNotRestorable();
    return { ...existing, status: ACTIVE, deletedAt: null, updatedAt: new Date() };
  }

  /** Soft-deletes every active memory of the user. Returns how many. */
  async deleteAll(userId: string): Promise<number> {
    const result = await this.prisma.userMemory.updateMany({
      where: { userId, status: ACTIVE },
      data: { status: 'deleted', deletedAt: new Date() },
    });
    this.logger.log(`Deleted all ${result.count} active memories of user ${userId}`);
    return result.count;
  }

  /**
   * Supersedes `targetId` with a new row of `content` (extraction UPDATE):
   * the old row becomes `superseded` and points at the new one. Validated
   * and gated like every write; refuses an explicit or user-edited target.
   */
  async supersede(
    userId: string,
    targetId: string,
    input: Omit<MemoryWriteInput, 'category'> & { category?: MemoryCategory },
  ): Promise<MemoryWriteResult | null> {
    const target = await this.prisma.userMemory.findFirst({ where: { id: targetId, userId, status: ACTIVE } });
    if (!target) return null;
    if (input.source === 'extracted' && MEMORY_IMMUTABLE_TO_EXTRACTION.includes(target.source as MemorySource)) return null;
    const checked = checkMemoryContent(input.content);
    if (!checked.ok) {
      this.metrics.rejected(input.source, checked.rule);
      throw memoryContentRejected(checked.rule, checked.message);
    }
    const gate = await this.gate(userId);
    if (!gate.enabled) throw memoryDisabled();
    const category = input.category ?? (target.category as MemoryCategory);
    const sensitivity = inferMemorySensitivity(checked.content, category, input.sensitivity);
    if (sensitivity === 'health' && !gate.user.allowHealth) throw memoryHealthNotAllowed();
    if (normalizeMemoryContent(checked.content) === normalizeMemoryContent(target.content)) {
      this.metrics.noop(input.source);
      return { op: 'unchanged', memory: target, evictedIds: [] };
    }

    const memory = await this.prisma.$transaction(async (tx) => {
      const created = await tx.userMemory.create({
        data: {
          userId,
          content: checked.content,
          category,
          source: input.source,
          sensitivity,
          status: ACTIVE,
          pinned: target.pinned,
          sourceMessageId: input.sourceMessageId ?? null,
          confidence: input.confidence ?? null,
        },
      });
      await tx.userMemory.updateMany({
        where: { id: target.id, userId, status: ACTIVE },
        data: { status: 'superseded', supersededById: created.id },
      });
      return created;
    });
    this.metrics.updated(input.source);
    return { op: 'updated', memory, evictedIds: [] };
  }

  // ---------------------------------------------------------------------------
  // Agent helpers (chat tools)
  // ---------------------------------------------------------------------------

  /** The best active match for `query` at `MEMORY_FORGET_MIN_SIMILARITY` or above, else null. */
  async findBestMatch(userId: string, query: string): Promise<UserMemory | null> {
    const q = query.trim().slice(0, 300);
    if (q.length === 0) return null;
    const active = await this.activeMemories(userId);
    if (active.length === 0) return null;
    const scored = await this.similarities(userId, q, null);
    let best: { id: string; sim: number } | null = null;
    for (const row of scored) if (!best || row.sim > best.sim) best = row;
    if (best && best.sim >= MEMORY_FORGET_MIN_SIMILARITY) return active.find((m) => m.id === best!.id) ?? null;
    // Fallback without pg_trgm (or for a short query): a case-insensitive substring match.
    const needle = normalizeMemoryContent(q);
    if (needle.length >= 3) {
      const hits = active.filter((m) => normalizeMemoryContent(m.content).includes(needle));
      if (hits.length === 1) return hits[0];
    }
    return null;
  }

  /** Bumps `lastUsedAt` on the given rows (one cheap statement). Never throws. */
  async touch(userId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.prisma.userMemory.updateMany({
        where: { userId, id: { in: [...ids] }, status: ACTIVE },
        data: { lastUsedAt: new Date() },
      });
    } catch {
      this.logger.warn(`Could not record memory use for user ${userId}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** The most similar active memory of `category` above the near-duplicate threshold, or null. */
  private async nearDuplicate(userId: string, content: string, category: MemoryCategory): Promise<UserMemory | null> {
    const rows = await this.similarities(userId, content, category);
    const best = rows.filter((r) => r.sim > MEMORY_NEAR_DUPLICATE_SIMILARITY).sort((a, b) => b.sim - a.sim)[0];
    if (!best) return null;
    return this.prisma.userMemory.findFirst({ where: { id: best.id, userId, status: ACTIVE } });
  }

  /** `similarity(content, $q)` for the user's active memories (optionally one category). `[]` without pg_trgm. */
  private async similarities(userId: string, q: string, category: MemoryCategory | null): Promise<Array<{ id: string; sim: number }>> {
    try {
      const rows = category
        ? await this.prisma.$queryRaw<Array<{ id: string; sim: number }>>`
            SELECT id, similarity(content, ${q})::float8 AS sim
              FROM user_memories
             WHERE user_id = ${userId}::uuid AND status = 'active' AND category = ${category}
             ORDER BY sim DESC
             LIMIT 5`
        : await this.prisma.$queryRaw<Array<{ id: string; sim: number }>>`
            SELECT id, similarity(content, ${q})::float8 AS sim
              FROM user_memories
             WHERE user_id = ${userId}::uuid AND status = 'active'
             ORDER BY sim DESC
             LIMIT 5`;
      return Array.isArray(rows) ? rows.map((r) => ({ id: r.id, sim: Number(r.sim) })) : [];
    } catch {
      if (!this.trigramWarned) {
        this.trigramWarned = true;
        this.logger.warn('pg_trgm similarity is unavailable; memory near-duplicate detection falls back to exact matches');
      }
      return [];
    }
  }

  /**
   * Room for one more active memory. An extracted add evicts the oldest
   * unpinned extracted memories (soft delete); any other add over the cap is
   * 409. An extracted add with nothing evictable is refused the same way.
   */
  private async makeRoom(userId: string, active: UserMemory[], max: number, source: MemorySource): Promise<string[]> {
    if (active.length < max) return [];
    if (source !== 'extracted') throw memoryLimitReached(max);
    const overflow = active.length - max + 1;
    const candidates = active
      .filter((m) => m.source === 'extracted' && !m.pinned)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, overflow);
    if (candidates.length < overflow) throw memoryLimitReached(max);
    const ids = candidates.map((m) => m.id);
    await this.prisma.userMemory.updateMany({
      where: { userId, id: { in: ids }, status: ACTIVE },
      data: { status: 'deleted', deletedAt: new Date() },
    });
    for (const _id of ids) this.metrics.deleted('extracted');
    this.logger.log(`Evicted ${ids.length} extracted memories of user ${userId} to stay under the cap`);
    return ids;
  }
}

/** The API shape of one memory. */
export interface MemoryViewData {
  id: string;
  content: string;
  category: MemoryCategory;
  source: MemorySource;
  sensitivity: MemorySensitivity;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export function toMemoryView(row: UserMemory): MemoryViewData {
  return {
    id: row.id,
    content: row.content,
    category: ((MEMORY_CATEGORIES as readonly string[]).includes(row.category) ? row.category : 'other') as MemoryCategory,
    source: row.source as MemorySource,
    sensitivity: (row.sensitivity === 'health' ? 'health' : 'normal') as MemorySensitivity,
    pinned: row.pinned,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}
