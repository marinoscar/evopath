// =============================================================================
// AiUsageRecorder — one `ai_usage_events` row per provider round-trip
// (issue #432, epic #419; docs/specs/ai-platform.md §2.21)
// =============================================================================
//
// Success AND failure: a failed call can still have been billed, and "how
// often does this model fail for us" is an accounting question too.
//
// BEST EFFORT — `record` NEVER THROWS. The usage row is written after the
// provider answered; failing the caller's request because the ledger insert
// failed would throw away a response the user has already paid for. A lost
// row is logged at `warn` instead.
//
// ⚠ Only ids, counts, codes and a duration. No prompt, no output, no key —
// the table has no column able to hold any of them.
//
// `units` (#437) is the count for an operation that is not (only) token-
// metered: `{ images: 2 }` for image generation, and — for the audio stories
// next — `{ audioSeconds: 31.4 }` or `{ characters: 1200 }`. A flat record of
// finite, non-negative numbers; anything else in it is dropped, and an empty
// record is stored as no units at all (`null`), so the #443 aggregates never
// sum a key that carries nothing.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import type { AiUsage } from '../core/types/responses.types';
import type { AiKeySource } from '../keys/ai-key-resolver.service';

/** The kinds of provider call the runtime records. Permanent strings. */
export type AiUsageOperation =
  | 'responses'
  | 'images'
  | 'audio.transcribe'
  | 'audio.speech'
  | 'embeddings'
  // #449: one minted realtime session, `units: { sessions: 1 }` — no tokens (the media never passes through the server).
  | 'realtime';

/** A round-trip's outcome. `cancelled` — the caller aborted it. */
export type AiUsageStatus = 'succeeded' | 'failed' | 'cancelled';

/** Non-token units of one round-trip, e.g. `{ images: 2 }`. */
export type AiUsageUnits = Record<string, number>;

export interface AiUsageRecord {
  userId: string | null;
  provider: string;
  modelId: string;
  operation: AiUsageOperation;
  keySource: AiKeySource;
  usage?: AiUsage;
  /** Non-token units — see the file header. */
  units?: AiUsageUnits;
  latencyMs: number;
  status: AiUsageStatus;
  errorCode?: string | null;
  providerRequestId?: string | null;
  jobId?: string | null;
}

@Injectable()
export class AiUsageRecorder {
  private readonly logger = new Logger(AiUsageRecorder.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Writes one row. Never throws — see the file header. */
  async record(event: AiUsageRecord): Promise<void> {
    const units = usageUnits(event.units);

    try {
      await this.prisma.aiUsageEvent.create({
        data: {
          userId: event.userId,
          provider: event.provider,
          modelId: event.modelId,
          operation: event.operation,
          keySource: event.keySource,
          inputTokens: tokenCount(event.usage?.inputTokens),
          outputTokens: tokenCount(event.usage?.outputTokens),
          reasoningTokens: tokenCount(event.usage?.reasoningTokens),
          cachedInputTokens: tokenCount(event.usage?.cachedInputTokens),
          ...(units ? { units } : {}),
          latencyMs: Math.max(0, Math.round(event.latencyMs)),
          status: event.status,
          errorCode: event.errorCode ?? null,
          providerRequestId: event.providerRequestId ?? null,
          jobId: event.jobId ?? null,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Could not record AI usage (${event.provider}/${event.modelId}, ${event.status}): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

/** The storable units: finite, non-negative numbers only; `null` when none are left. */
export function usageUnits(units: AiUsageUnits | undefined): AiUsageUnits | null {
  if (!units) return null;

  const clean = Object.entries(units).filter(
    ([key, value]) => key.length > 0 && typeof value === 'number' && Number.isFinite(value) && value >= 0,
  );

  return clean.length > 0 ? Object.fromEntries(clean) : null;
}

/** A provider-reported count as an `Int` column value, or null when unusable. */
function tokenCount(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}
