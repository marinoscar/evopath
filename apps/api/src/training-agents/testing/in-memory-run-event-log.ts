import { parseRunEventData } from '../runtime/run-events.registry';
import { RUN_EVENTS_MAX_PAGE, type RunEventLog, type RunEventRecord } from '../runtime/run-events.service';

/**
 * `RunEventLog` over a Map, with the same validation and `seq` rules as
 * `RunEventsService`: gapless per run, starting at 1, invalid data refused.
 * For node and graph tests that run without a database. Every run id is
 * accepted unless `knownRuns` is given.
 */
export class InMemoryRunEventLog implements RunEventLog {
  readonly events = new Map<string, RunEventRecord[]>();

  constructor(private readonly knownRuns?: Set<string>) {}

  async append(
    runId: string,
    type: string,
    data: Record<string, unknown> = {},
    stage: string | null = null,
  ): Promise<number | null> {
    const parsed = parseRunEventData(type, data);
    if (this.knownRuns && !this.knownRuns.has(runId)) return null;

    const log = this.events.get(runId) ?? [];
    const seq = log.length + 1;
    log.push({ seq, type, stage, data: parsed, createdAt: new Date() });
    this.events.set(runId, log);

    return seq;
  }

  async emit(
    runId: string,
    type: string,
    data?: Record<string, unknown>,
    stage?: string | null,
  ): Promise<number | null> {
    try {
      return await this.append(runId, type, data, stage);
    } catch {
      return null;
    }
  }

  async list(runId: string, afterSeq: number, limit: number): Promise<RunEventRecord[]> {
    return (this.events.get(runId) ?? [])
      .filter((event) => event.seq > afterSeq)
      .slice(0, Math.min(limit, RUN_EVENTS_MAX_PAGE));
  }

  /** The types appended to `runId`, in order. */
  types(runId: string): string[] {
    return (this.events.get(runId) ?? []).map((event) => event.type);
  }
}
