import { HttpException, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { Job, UserMemory } from '@prisma/client';
import { z } from 'zod';

import { AiFeatureModelResolver } from '../../ai/assignments/ai-feature-model-resolver.service';
import { RUNNABLE_FEATURE_STATES } from '../../ai/assignments/dto/ai-feature-resolution.dto';
import { AiConfigService } from '../../ai/config/ai-config.service';
import { AiError } from '../../ai/core/ai-error';
import { AI_RUN_TERMINAL_CODES } from '../../ai/runtime/ai-response-run.handler';
import { AiService } from '../../ai/runtime/ai.service';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { MEMORY_IMMUTABLE_TO_EXTRACTION, memoryReasonOf, type MemoryCategory, type MemorySource } from '../memory.constants';
import { AI_MEMORY_EXTRACT_JOB_TYPE } from '../memory-job-types';
import { MemoryMetrics } from '../memory.metrics';
import { MemoryService } from '../memory.service';
import { checkMemoryContent, inferMemorySensitivity } from '../memory-validation';
import {
  MEMORY_CANDIDATES_SCHEMA_NAME,
  MEMORY_DECISION_SCHEMA_NAME,
  MEMORY_EXTRACT_MAX_CANDIDATES,
  decisionInstructions,
  decisionUserText,
  extractionInstructions,
  extractionUserText,
  memoryCandidatesSchema,
  memoryDecisionSchema,
  type ExtractionTurn,
  type MemoryCandidates,
} from './memory-extract.prompt';

// =============================================================================
// ai.memory.extract: learns durable facts from one user's chat (#325; spec §2.6)
// =============================================================================
//
// Enqueued by `MemoryExtractionScheduler` after every completed coach chat
// turn, five minutes out, deduplicated on (`user`, userId): later turns
// collapse onto the pending job, so a conversation is read once.
//
//   1. GATES, cheapest first: AI on; system `memory.enabled` and
//      `autoExtract`; the user's `memory.enabled` and `autoExtract`; the
//      per-user daily cap (`extractDailyCapPerUser`, `user_memory_states`).
//      Any closed gate ends the job quietly (succeeded, nothing written).
//   2. INPUT: the user's own chat messages (`role: user`, `kind: chat`, never
//      a `data.safety` row) newer than the watermark
//      (`user_memory_states.last_extracted_at`), at most 30, plus the coach's
//      chat replies in between AS CONTEXT ONLY. A fact must cite a user
//      message ref (`u<n>`) or it is dropped: a coach reply or a tool result
//      can never become a memory. Tool results are not stored anywhere the
//      job reads.
//   3. MODEL: `memory.extract` from `AiFeatureModelResolver` (no runnable
//      model: skip quietly, watermark untouched); step 1 extracts candidates,
//      step 2 decides ADD / UPDATE / DELETE / NOOP per candidate against the
//      active memories of its category (skipped, straight to ADD, when the
//      category is empty). Both are strict `respondStructured` calls through
//      `AiService.forUser` (the user's key policy and `ai.limits` apply).
//   4. WRITES through `MemoryService` (validation, health switch, dedup, cap
//      with eviction of the oldest unpinned extracted memory). An
//      `explicit`/`user_edited` memory is never updated or deleted here: such
//      a decision is forced to NOOP.
//   5. The watermark advances to the newest message read and the daily
//      counter increments.
//
// SERVER-ONLY, permanently (AI rule 3): no `nodeResultSchema`, no
// `persistNodeResult`. A rate limit defers the job (`toRateLimitError`); an
// expected refusal (`AI_RUN_TERMINAL_CODES`) ends it quietly; anything else
// throws for the queue's retry.
//
// ⚠ PRIVACY: logs and metrics carry ids, counts, categories and sources;
// never a message, a candidate or a memory.
// =============================================================================

export const memoryExtractPayloadSchema = z.object({ userId: z.uuid() }).passthrough();

export const MEMORY_EXTRACT_FEATURE_ID = 'memory.extract';
/** User messages one run reads at most. */
export const MEMORY_EXTRACT_MAX_MESSAGES = 30;
/** Candidates below this confidence are dropped before any write. */
export const MEMORY_EXTRACT_MIN_CONFIDENCE = 0.5;
const CALL_DEADLINE_MS = 45_000;
const MAX_OUTPUT_TOKENS = 1_200;

export type MemoryExtractOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'done'; added: number; updated: number; deleted: number; noop: number; rejected: number };

interface ChatRow {
  id: string;
  role: string;
  body: string;
  data: unknown;
  createdAt: Date;
}

function isSafetyRow(data: unknown): boolean {
  return Boolean(data && typeof data === 'object' && !Array.isArray(data) && (data as Record<string, unknown>).safety);
}

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

@Injectable()
export class MemoryExtractHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(MemoryExtractHandler.name);

  readonly type = AI_MEMORY_EXTRACT_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: 120_000, maxAttempts: 2 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly features: AiFeatureModelResolver,
    private readonly aiConfig: AiConfigService,
    private readonly memories: MemoryService,
    @Optional() private readonly metrics: MemoryMetrics = new MemoryMetrics(),
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const parsed = memoryExtractPayloadSchema.safeParse(job.payload ?? {});
    if (!parsed.success) {
      this.logger.warn(`Memory extraction job ${job.id} carries no valid payload; nothing to do`);
      return;
    }
    const outcome = await this.run(job.id, parsed.data.userId, new Date());
    if (outcome.status === 'skipped') {
      this.logger.log(`Memory extraction job ${job.id} for user ${parsed.data.userId}: skipped (${outcome.reason})`);
    } else {
      this.logger.log(
        `Memory extraction job ${job.id} for user ${parsed.data.userId}: added ${outcome.added}, updated ${outcome.updated}, ` +
          `deleted ${outcome.deleted}, noop ${outcome.noop}, rejected ${outcome.rejected}`,
      );
    }
  }

  /** One extraction for `userId` as of `now`. */
  async run(jobId: string, userId: string, now: Date): Promise<MemoryExtractOutcome> {
    // ---- 1. gates -------------------------------------------------------------
    if (!(await this.aiConfig.isEnabled())) return { status: 'skipped', reason: 'ai_disabled' };
    const gate = await this.memories.gate(userId);
    if (!gate.enabled) return { status: 'skipped', reason: 'memory_disabled' };
    if (!gate.autoExtract) return { status: 'skipped', reason: 'auto_extract_off' };

    const state = await this.prisma.userMemoryState.findUnique({ where: { userId } });
    const today = utcDay(now);
    const usedToday = state?.extractionDayUtc && utcDay(state.extractionDayUtc) === today ? state.extractionsToday : 0;
    if (usedToday >= gate.policy.extractDailyCapPerUser) return { status: 'skipped', reason: 'daily_cap' };

    // ---- 2. input ---------------------------------------------------------------
    const since = state?.lastExtractedAt ?? null;
    const userRows = ((await this.prisma.coachMessage.findMany({
      where: { userId, role: 'user', kind: 'chat', createdAt: { ...(since ? { gt: since } : {}), lte: now } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MEMORY_EXTRACT_MAX_MESSAGES,
      select: { id: true, role: true, body: true, data: true, createdAt: true },
    })) ?? []) as ChatRow[];
    if (userRows.length === 0) return { status: 'skipped', reason: 'no_new_messages' };
    userRows.reverse();
    const watermark = userRows[userRows.length - 1].createdAt;
    const usable = userRows.filter((row) => !isSafetyRow(row.data) && row.body.trim().length > 0);
    if (usable.length === 0) {
      await this.advance(userId, watermark, today, usedToday, false);
      return { status: 'skipped', reason: 'no_usable_messages' };
    }

    const coachRows = ((await this.prisma.coachMessage.findMany({
      where: {
        userId,
        role: 'coach',
        kind: 'chat',
        createdAt: { gte: usable[0].createdAt, lte: new Date(watermark.getTime() + 60_000) },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MEMORY_EXTRACT_MAX_MESSAGES,
      select: { id: true, role: true, body: true, data: true, createdAt: true },
    })) ?? []) as ChatRow[];

    const refs = new Map<string, string>();
    const turns: Array<ExtractionTurn & { at: number }> = [];
    usable.forEach((row, i) => {
      const ref = `u${i + 1}`;
      refs.set(ref, row.id);
      turns.push({ role: 'user', ref, body: row.body, at: row.createdAt.getTime() });
    });
    for (const row of coachRows) {
      if (isSafetyRow(row.data)) continue;
      turns.push({ role: 'coach', ref: null, body: row.body, at: row.createdAt.getTime() });
    }
    turns.sort((a, b) => a.at - b.at || (a.role === 'user' ? -1 : 1));

    // ---- 3. model ---------------------------------------------------------------
    const resolution = await this.features.resolve(userId, MEMORY_EXTRACT_FEATURE_ID);
    if (!RUNNABLE_FEATURE_STATES.includes(resolution.state) || !resolution.model) {
      return { status: 'skipped', reason: 'no_model' };
    }
    const model = { provider: resolution.model.provider, modelId: resolution.model.modelId };

    let candidates: MemoryCandidates['candidates'];
    try {
      const extracted = await this.call(userId, jobId, model, {
        schema: memoryCandidatesSchema,
        schemaName: MEMORY_CANDIDATES_SCHEMA_NAME,
        instructions: extractionInstructions({ allowHealth: gate.user.allowHealth }),
        text: extractionUserText(turns),
      });
      candidates = extracted.candidates;
    } catch (err) {
      return this.onAiError(err, jobId);
    }

    // ---- 4. decide and write ------------------------------------------------------
    const tally = { added: 0, updated: 0, deleted: 0, noop: 0, rejected: 0 };
    for (const candidate of candidates.slice(0, MEMORY_EXTRACT_MAX_CANDIDATES)) {
      const sourceMessageId = refs.get(candidate.sourceMessageRef.trim().toLowerCase()) ?? null;
      // A fact must come from one of the user's own messages in this batch.
      if (!sourceMessageId) {
        tally.rejected += 1;
        this.metrics.rejected('extracted', 'unsourced');
        continue;
      }
      if (!(candidate.confidence >= MEMORY_EXTRACT_MIN_CONFIDENCE)) {
        tally.noop += 1;
        this.metrics.noop('extracted');
        continue;
      }
      const checked = checkMemoryContent(candidate.content);
      if (!checked.ok) {
        tally.rejected += 1;
        this.metrics.rejected('extracted', checked.rule);
        continue;
      }
      const category = candidate.category as MemoryCategory;
      const sensitivity = inferMemorySensitivity(checked.content, category, candidate.sensitivity);
      if (sensitivity === 'health' && !gate.user.allowHealth) {
        tally.rejected += 1;
        this.metrics.rejected('extracted', 'health_not_allowed');
        continue;
      }

      try {
        const op = await this.apply(userId, jobId, model, {
          content: checked.content,
          category,
          sensitivity,
          sourceMessageId,
          confidence: Math.max(0, Math.min(1, candidate.confidence)),
        });
        tally[op] += 1;
      } catch (err) {
        if (err instanceof HttpException) {
          tally.rejected += 1;
          const reason = memoryReasonOf(err);
          if (reason === 'MEMORY_DISABLED') break;
          continue;
        }
        if (err instanceof AiError) {
          const rateLimit = err.toRateLimitError();
          if (rateLimit) throw rateLimit;
          if (AI_RUN_TERMINAL_CODES.has(err.code)) {
            tally.rejected += 1;
            continue;
          }
        }
        throw err;
      }
    }

    // ---- 5. watermark --------------------------------------------------------------
    await this.advance(userId, watermark, today, usedToday, true);
    return { status: 'done', ...tally };
  }

  /** One candidate: ADD straight away into an empty category, else ask the decision step. */
  private async apply(
    userId: string,
    jobId: string,
    model: { provider: string; modelId: string },
    candidate: { content: string; category: MemoryCategory; sensitivity: 'normal' | 'health'; sourceMessageId: string; confidence: number },
  ): Promise<'added' | 'updated' | 'deleted' | 'noop'> {
    const existing = await this.memories.activeMemories(userId, candidate.category);
    const add = async () => {
      const result = await this.memories.write(userId, { ...candidate, source: 'extracted' }, 'agent');
      return result.op === 'added' ? 'added' : result.op === 'updated' ? 'updated' : 'noop';
    };
    if (existing.length === 0) return add();

    const byRef = new Map<string, UserMemory>();
    const listed = existing.slice(0, 30).map((m, i) => {
      const ref = `e${i + 1}`;
      byRef.set(ref, m);
      return { ref, content: m.content, locked: MEMORY_IMMUTABLE_TO_EXTRACTION.includes(m.source as MemorySource) };
    });
    const decision = await this.call(userId, jobId, model, {
      schema: memoryDecisionSchema,
      schemaName: MEMORY_DECISION_SCHEMA_NAME,
      instructions: decisionInstructions(),
      text: decisionUserText(candidate, listed),
    });

    if (decision.action === 'NOOP') {
      this.metrics.noop('extracted');
      return 'noop';
    }
    if (decision.action === 'ADD') return add();

    const target = decision.targetRef ? byRef.get(decision.targetRef.trim().toLowerCase()) : undefined;
    if (!target) {
      this.metrics.noop('extracted');
      return 'noop';
    }
    if (MEMORY_IMMUTABLE_TO_EXTRACTION.includes(target.source as MemorySource)) {
      // The user's own words are never rewritten or removed by the background path.
      this.metrics.rejected('extracted', 'immutable');
      this.metrics.noop('extracted');
      return 'noop';
    }
    if (decision.action === 'DELETE') {
      await this.memories.softDelete(userId, target.id);
      return 'deleted';
    }
    const merged = (decision.content ?? '').trim() || candidate.content;
    const result = await this.memories.supersede(userId, target.id, {
      content: merged,
      category: candidate.category,
      sensitivity: candidate.sensitivity,
      source: 'extracted',
      sourceMessageId: candidate.sourceMessageId,
      confidence: candidate.confidence,
    });
    if (!result || result.op === 'unchanged') {
      this.metrics.noop('extracted');
      return 'noop';
    }
    return 'updated';
  }

  private async call<S extends z.ZodTypeAny>(
    userId: string,
    jobId: string,
    model: { provider: string; modelId: string },
    req: { schema: S; schemaName: string; instructions: string; text: string },
  ): Promise<z.infer<S>> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('Memory extraction timed out')), CALL_DEADLINE_MS);
    deadline.unref?.();
    try {
      const response = await this.ai.forUser(userId, { jobId }).respondStructured(
        {
          provider: model.provider,
          model: model.modelId,
          schema: req.schema,
          schemaName: req.schemaName,
          strict: true,
          instructions: req.instructions,
          input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: req.text }] }],
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          metadata: { feature: MEMORY_EXTRACT_FEATURE_ID },
        },
        { signal: controller.signal },
      );
      return response.parsed as z.infer<S>;
    } finally {
      clearTimeout(deadline);
    }
  }

  private onAiError(err: unknown, jobId: string): MemoryExtractOutcome {
    if (err instanceof AiError) {
      const rateLimit = err.toRateLimitError();
      if (rateLimit) throw rateLimit;
      if (AI_RUN_TERMINAL_CODES.has(err.code)) {
        this.logger.log(`Memory extraction job ${jobId} ended with ${err.code}`);
        return { status: 'skipped', reason: err.code };
      }
    }
    throw err;
  }

  private async advance(userId: string, watermark: Date, today: string, usedToday: number, countRun: boolean): Promise<void> {
    const extractionsToday = usedToday + (countRun ? 1 : 0);
    const extractionDayUtc = new Date(`${today}T00:00:00.000Z`);
    await this.prisma.userMemoryState.upsert({
      where: { userId },
      create: { userId, lastExtractedAt: watermark, extractionsToday, extractionDayUtc },
      update: { lastExtractedAt: watermark, extractionsToday, extractionDayUtc },
    });
  }
}
