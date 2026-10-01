// =============================================================================
// The health summary's regeneration trigger (H8, #192)
// =============================================================================
//
//   health.data.changed  (a health write, after commit)  -> requestRegeneration
//
// THE BODY ONLY CALLS THE SERVICE, which reads one consent row and at most
// enqueues one debounced job (no provider call, no storage, no long-running
// work; `apps/api/test/jobs/on-event-no-io.spec.ts` scans this body).
// `async: true` keeps EventEmitter2's synchronous dispatch from waiting on
// it, and nothing escapes: a failed request costs one log line, and the
// summary shows as stale until the next write or a refresh.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { HEALTH_DATA_CHANGED_EVENT, type HealthDataChangedEvent } from '../measurements/health-data-events';
import { HealthSummaryService } from './health-summary.service';

@Injectable()
export class HealthSummaryListener {
  private readonly logger = new Logger(HealthSummaryListener.name);

  constructor(private readonly summaries: HealthSummaryService) {}

  @OnEvent(HEALTH_DATA_CHANGED_EVENT, { async: true })
  async onHealthDataChanged(event: HealthDataChangedEvent): Promise<void> {
    try {
      await this.summaries.requestRegeneration(event.userId);
    } catch (error) {
      this.logger.warn(
        `Could not request a health summary after a ${event.source} change for user ${event.userId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
