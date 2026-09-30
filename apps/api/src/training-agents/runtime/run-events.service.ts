import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { parseRunEventData } from './run-events.registry';

// =============================================================================
// RunEventsService: the persisted, sequenced progress log of a training run
// =============================================================================
//
// `append` allocates the next `seq` with ONE atomic statement,
//
//   UPDATE training_plan_runs SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq
//
// and inserts the event, both in one small transaction. The row lock the
// UPDATE takes serialises concurrent appends to one run, so `seq` is gapless
// and unique per run (the `(run_id, seq)` unique index is the backstop). A
// run that no longer exists (deleted, or its user deleted) appends nothing.
//
// `data` is validated against the type's registered schema
// (`run-events.registry.ts`) before anything is written. No prompt text,
// provider message or key can reach it: the schemas are strict and carry
// identifiers, enums and counts only.
//
// `emit` is `append` for callers that must never fail because of an event (a
// node, the handler's lifecycle bookkeeping): it logs a warning and returns
// `null` instead of throwing. The run's terminal status is written by the
// handler, never derived from events.
// =============================================================================

export interface RunEventRecord {
  seq: number;
  type: string;
  stage: string | null;
  data: Record<string, unknown>;
  createdAt: Date;
}

/** The event log as the runtime uses it; `RunEventsService` over Prisma, an in-memory one in tests. */
export interface RunEventLog {
  /** Appends one event and returns its `seq`, or `null` when the run no longer exists. Throws on invalid data. */
  append(runId: string, type: string, data?: Record<string, unknown>, stage?: string | null): Promise<number | null>;
  /** `append` that never throws: failures are logged and yield `null`. */
  emit(runId: string, type: string, data?: Record<string, unknown>, stage?: string | null): Promise<number | null>;
  /** Events with `seq > afterSeq`, ascending, at most `limit`. */
  list(runId: string, afterSeq: number, limit: number): Promise<RunEventRecord[]>;
}

/** Most events one `list` call returns. */
export const RUN_EVENTS_MAX_PAGE = 500;

@Injectable()
export class RunEventsService implements RunEventLog {
  private readonly logger = new Logger(RunEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async append(
    runId: string,
    type: string,
    data: Record<string, unknown> = {},
    stage: string | null = null,
  ): Promise<number | null> {
    const parsed = parseRunEventData(type, data);

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ event_seq: number }>>`
        UPDATE training_plan_runs SET event_seq = event_seq + 1 WHERE id = ${runId}::uuid RETURNING event_seq`;

      const seq = rows[0]?.event_seq;
      if (seq === undefined) return null;

      await tx.trainingRunEvent.create({
        data: { runId, seq, type, stage, data: parsed as Prisma.InputJsonValue },
      });

      return seq;
    });
  }

  async emit(
    runId: string,
    type: string,
    data: Record<string, unknown> = {},
    stage: string | null = null,
  ): Promise<number | null> {
    try {
      return await this.append(runId, type, data, stage);
    } catch (error) {
      // The message names the type and failing paths only, never values.
      this.logger.warn(
        `Training run ${runId}: event ${type} was not recorded: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
  }

  async list(runId: string, afterSeq: number, limit: number): Promise<RunEventRecord[]> {
    const rows = await this.prisma.trainingRunEvent.findMany({
      where: { runId, seq: { gt: Math.max(0, Math.floor(afterSeq)) } },
      orderBy: { seq: 'asc' },
      take: Math.min(Math.max(1, Math.floor(limit)), RUN_EVENTS_MAX_PAGE),
      select: { seq: true, type: true, stage: true, data: true, createdAt: true },
    });

    return rows.map((row) => ({ ...row, data: (row.data ?? {}) as Record<string, unknown> }));
  }
}
