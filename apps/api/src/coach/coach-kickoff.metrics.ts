import { type Counter, metrics } from '@opentelemetry/api';

import { APP_METER_NAME } from '../common/otel/app-metrics.service';
import { telemetryGate } from '../common/otel/telemetry-gate';

// =============================================================================
// Kickoff counters (E7.12; docs/specs/ai-coach.md §2.13)
// =============================================================================
//
//   coach.kickoff{coach.outcome}
//     sent       a kickoff message was persisted (model-written)
//     fallback   a kickoff message was persisted from the static persona line
//     deferred   the kickoff was re-queued for the next allowed window
//     confirmed  the user's answer was saved (`save_commitment`)
//
// A closed enum; no user id and no content. A plain module (no DI) so the
// nudge job and the chat tool can both record without a new provider.
// =============================================================================

export const COACH_KICKOFF_OUTCOMES = ['sent', 'fallback', 'deferred', 'confirmed'] as const;
export type CoachKickoffOutcome = (typeof COACH_KICKOFF_OUTCOMES)[number];

let counter: Counter | null = null;

export function recordCoachKickoff(outcome: CoachKickoffOutcome): void {
  try {
    if (!telemetryGate.isEnabled()) return;
    counter ??= metrics.getMeter(APP_METER_NAME).createCounter('coach.kickoff', {
      description: 'Coach kickoff messages after a program activation, by outcome',
    });
    counter.add(1, { 'coach.outcome': outcome });
  } catch {
    // Metrics never fail the caller.
  }
}
