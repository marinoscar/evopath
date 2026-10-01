import { Injectable } from '@nestjs/common';
import { type Counter, type Histogram, metrics } from '@opentelemetry/api';

import { APP_METER_NAME } from '../../common/otel/app-metrics.service';
import { telemetryGate } from '../../common/otel/telemetry-gate';
import type { WeeklyStreakChange } from './weekly-streak';

// =============================================================================
// Weekly review counters (E7.10; docs/specs/ai-coach.md §2.10, §2.11)
// =============================================================================
//
//   app.coach.weekly_review.sent{coach.source}       a review was persisted and
//                                                    queued for delivery
//                                                    (`model` or `static`)
//   app.coach.weekly_review.skipped{coach.reason}    the job ended without one
//   app.coach.weekly_review.fallback{coach.reason}   static prose replaced the
//                                                    model's (`no_model`,
//                                                    `ai_error`, `guard_rejected`)
//   app.coach.weekly_streak.updated{coach.change}    advanced, pass_used, reset, held
//   app.coach.weekly_streak.length                   the streak after each review
//                                                    (histogram)
//
// Attribute values are closed enums; no user id, no number from the stats
// block beyond the streak length, no text. Recorded only while the runtime
// telemetry gate is open. Email delivery is counted by the notification
// dispatcher's own delivery rows (`notification_deliveries`).
// =============================================================================

export const WEEKLY_REVIEW_SKIP_REASONS = [
  'invalid_payload',
  'invalid_week',
  'coach_off',
  'paused',
  'not_due',
  'stale',
  'already_sent',
] as const;
export type WeeklyReviewSkipReason = (typeof WEEKLY_REVIEW_SKIP_REASONS)[number];

export const WEEKLY_REVIEW_FALLBACK_REASONS = ['no_model', 'ai_error', 'guard_rejected'] as const;
export type WeeklyReviewFallbackReason = (typeof WEEKLY_REVIEW_FALLBACK_REASONS)[number];

@Injectable()
export class CoachReviewMetrics {
  private readonly sentCounter: Counter;
  private readonly skippedCounter: Counter;
  private readonly fallbackCounter: Counter;
  private readonly streakCounter: Counter;
  private readonly streakLength: Histogram;

  constructor() {
    const meter = metrics.getMeter(APP_METER_NAME);
    this.sentCounter = meter.createCounter('app.coach.weekly_review.sent', {
      description: 'Weekly reviews persisted and queued for delivery, by source (model or static)',
    });
    this.skippedCounter = meter.createCounter('app.coach.weekly_review.skipped', {
      description: 'ai.coach.weekly_review jobs that ended without a review, by reason',
    });
    this.fallbackCounter = meter.createCounter('app.coach.weekly_review.fallback', {
      description: 'Weekly reviews written from static persona prose instead of the model, by reason',
    });
    this.streakCounter = meter.createCounter('app.coach.weekly_streak.updated', {
      description: 'Weekly streak updates by the weekly review, by change (advanced, pass_used, reset, held)',
    });
    this.streakLength = meter.createHistogram('app.coach.weekly_streak.length', {
      description: 'The weekly streak (weeks) after each weekly review',
    });
  }

  sent(source: 'model' | 'static'): void {
    if (telemetryGate.isEnabled()) this.sentCounter.add(1, { 'coach.source': source });
  }

  skipped(reason: WeeklyReviewSkipReason): void {
    if (telemetryGate.isEnabled()) this.skippedCounter.add(1, { 'coach.reason': reason });
  }

  fallback(reason: WeeklyReviewFallbackReason): void {
    if (telemetryGate.isEnabled()) this.fallbackCounter.add(1, { 'coach.reason': reason });
  }

  streak(change: WeeklyStreakChange, weeklyStreak: number): void {
    if (!telemetryGate.isEnabled()) return;
    this.streakCounter.add(1, { 'coach.change': change });
    this.streakLength.record(weeklyStreak);
  }
}
