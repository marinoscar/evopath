import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { renderMemoryBlock, type MemoryAudience } from './memory-context';
import { MemoryService } from './memory.service';

// =============================================================================
// MemoryContextService: the read path (#325; docs/specs/ai-memory.md §2.5)
// =============================================================================
//
// `buildBlock(userId, { audience })` answers the delimited memory block a
// prompt embeds (`renderMemoryBlock`), or '' when there is nothing to send:
//
//   - the system `memory.enabled` or the user's `memory.enabled` is off;
//   - the user has no active memory the audience may see;
//   - a `health` memory is left out while the user's `allowHealth` is off
//     (the switch is honoured at read time too, not only at write time).
//
// It NEVER THROWS into its caller: a failed read logs one id-only line and
// answers '' (a coach message or a plan without memories beats none). The
// rows that made it into the block get `lastUsedAt` bumped with ONE
// `updateMany`, awaited but swallowed.
//
// `forChat` is the coach chat's variant: the block carries `[m<n>]` refs and
// the refs map comes back with it, for the `forget`/`update_memory` tools.
//
// ⚠ NEVER LOG CONTENT.
// =============================================================================

/** The per-turn ref table the coach chat's memory tools resolve `memoryId` through. */
export class MemoryRefs {
  private readonly byRef = new Map<string, string>();

  constructor(initial?: Map<string, string>) {
    for (const [ref, id] of initial ?? []) this.byRef.set(ref, id);
  }

  /** The memory id a model-supplied `memoryId` names: a known ref (`m3`, `[m3]`), or null. */
  resolve(value: string | null | undefined): string | null {
    if (!value) return null;
    const ref = value.trim().replace(/^\[|\]$/g, '').toLowerCase();
    return this.byRef.get(ref) ?? null;
  }

  /** The ref of `id`, adding one when the memory is new this turn. */
  refFor(id: string): string {
    for (const [ref, known] of this.byRef) if (known === id) return ref;
    const ref = `m${this.byRef.size + 1}`;
    this.byRef.set(ref, id);
    return ref;
  }

  get size(): number {
    return this.byRef.size;
  }
}

export interface MemoryChatContext {
  /** Memory is on for this user (the chat registers its memory tools only then). */
  enabled: boolean;
  block: string;
  refs: MemoryRefs;
}

@Injectable()
export class MemoryContextService {
  private readonly logger = new Logger(MemoryContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memories: MemoryService,
  ) {}

  async buildBlock(userId: string, opts: { audience: MemoryAudience }): Promise<string> {
    const result = await this.render(userId, opts.audience, false);
    return result.block;
  }

  async forChat(userId: string): Promise<MemoryChatContext> {
    const result = await this.render(userId, 'coach', true);
    return { enabled: result.enabled, block: result.block, refs: new MemoryRefs(result.refs) };
  }

  private async render(
    userId: string,
    audience: MemoryAudience,
    withRefs: boolean,
  ): Promise<{ enabled: boolean; block: string; refs: Map<string, string> }> {
    const empty = { enabled: false, block: '', refs: new Map<string, string>() };
    try {
      const gate = await this.memories.gate(userId);
      if (!gate.enabled) return empty;
      const rows =
        (await this.prisma.userMemory.findMany({
          where: {
            userId,
            status: 'active',
            ...(gate.user.allowHealth ? {} : { sensitivity: { not: 'health' } }),
          },
          select: { id: true, content: true, category: true, pinned: true, updatedAt: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          take: 500,
        })) ?? [];
      const rendered = renderMemoryBlock(rows, { audience, withRefs });
      await this.memories.touch(userId, rendered.usedIds);
      return { enabled: true, block: rendered.text, refs: rendered.refs };
    } catch {
      this.logger.warn(`Could not build the memory block for user ${userId} (${audience}); none sent`);
      return empty;
    }
  }
}
