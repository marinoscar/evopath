import { Injectable } from '@nestjs/common';
import { type Counter, metrics } from '@opentelemetry/api';

import { APP_METER_NAME } from '../../common/otel/app-metrics.service';
import { telemetryGate } from '../../common/otel/telemetry-gate';
import type { CoachMoment, CoachSuppressionReason } from './plan-coach-moments';

// =============================================================================
// Coach planning counters (E7.4; docs/specs/ai-coach.md §2.5)
// =============================================================================
//
//   coach.moment.planned{coach.moment}       an eligible moment was enqueued
//   coach.nudge.suppressed{coach.reason}     a gate removed a moment, or its
//                                            handler is not registered here
//   coach.sweep.users                        users a sweep pass planned
//   coach.sweep.user_error                   a user skipped after an error
//   coach.time_zone.invalid                  an unknown zone fell back to UTC
//
// Attribute values are closed enums (moment and reason names); no counter
// carries a user id or any content. Recorded only while the runtime telemetry
// gate is open, like `AppMetricsService`.
// =============================================================================

/** The reasons a moment is not enqueued: the planner's gates plus a missing downstream handler. */
export type CoachSuppressionMetricReason = CoachSuppressionReason | 'handler_missing';

@Injectable()
export class CoachPlanningMetrics {
  private readonly planned: Counter;
  private readonly suppressedCounter: Counter;
  private readonly users: Counter;
  private readonly userErrors: Counter;
  private readonly invalidZones: Counter;

  constructor() {
    const meter = metrics.getMeter(APP_METER_NAME);
    this.planned = meter.createCounter('coach.moment.planned', { description: 'Coach moments enqueued, by moment' });
    this.suppressedCounter = meter.createCounter('coach.nudge.suppressed', {
      description: 'Coach moments not enqueued, by reason',
    });
    this.users = meter.createCounter('coach.sweep.users', { description: 'Users planned by the coach sweep' });
    this.userErrors = meter.createCounter('coach.sweep.user_error', {
      description: 'Users the coach sweep skipped after an error',
    });
    this.invalidZones = meter.createCounter('coach.time_zone.invalid', {
      description: 'Coach planning passes that fell back to UTC for an unknown time zone',
    });
  }

  momentPlanned(moment: CoachMoment): void {
    if (telemetryGate.isEnabled()) this.planned.add(1, { 'coach.moment': moment });
  }

  suppressed(reason: CoachSuppressionMetricReason, moment: CoachMoment): void {
    if (telemetryGate.isEnabled()) this.suppressedCounter.add(1, { 'coach.reason': reason, 'coach.moment': moment });
  }

  usersPlanned(count: number): void {
    if (count > 0 && telemetryGate.isEnabled()) this.users.add(count);
  }

  userError(): void {
    if (telemetryGate.isEnabled()) this.userErrors.add(1);
  }

  invalidTimeZone(): void {
    if (telemetryGate.isEnabled()) this.invalidZones.add(1);
  }
}
