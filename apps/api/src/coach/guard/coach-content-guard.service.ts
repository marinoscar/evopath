import { Injectable, Optional } from '@nestjs/common';

import { AppMetricsService, fallbackAppMetrics } from '../../common/otel/app-metrics.service';
import {
  guardCoachMessage,
  type CoachGuardContext,
  type CoachGuardResult,
  type CoachMessageText,
  type CoachTextField,
} from './coach-content-guard';

/**
 * The content guard with its counter (`app.coach.guard.rejected{reason}`).
 * The rules are the pure `guardCoachMessage`; this wrapper only counts each
 * distinct failed rule once per message. Never logs or counts the text.
 */
@Injectable()
export class CoachContentGuard {
  constructor(@Optional() private readonly metrics: AppMetricsService = fallbackAppMetrics()) {}

  check(message: CoachMessageText, ctx: CoachGuardContext, required?: readonly CoachTextField[]): CoachGuardResult {
    const result = guardCoachMessage(message, ctx, required);
    for (const reason of result.reasons) this.metrics.coachGuardRejection(reason);
    return result;
  }
}
