import type { CoachMoment } from '../personas';

// =============================================================================
// Moment -> message kind -> notification event (E7.5, #245; spec §2.2, §3.5)
// =============================================================================
//
// The kind is the `/coach` timeline card type; the event is what
// `coach.message.deliver` raises. The event mapping agrees with the planner's
// `COACH_MOMENT_EVENT` (the `pref_off` gate), pinned by the spec of this file.
// =============================================================================

export const COACH_MESSAGE_KINDS = [
  'nudge',
  'chat',
  'weekly_review',
  'celebration',
  'photo_prompt',
  'comeback',
  'kickoff',
  'system',
] as const;

export type CoachMessageKind = (typeof COACH_MESSAGE_KINDS)[number];

export type CoachNotificationEventKey = 'coach.nudge' | 'coach.celebration' | 'coach.photo_prompt' | 'coach.weekly_review';

/** The timeline kind of a coach-authored message for `moment`. */
export function kindForMoment(moment: CoachMoment): CoachMessageKind {
  switch (moment) {
    case 'pr':
    case 'weekly_target_hit':
    case 'goal_hit':
      return 'celebration';
    case 'comeback':
      return 'comeback';
    case 'photo_prompt':
      return 'photo_prompt';
    case 'kickoff':
      return 'kickoff';
    case 'weekly_review':
      return 'weekly_review';
    case 'back_off':
    case 'win_back':
      return 'system';
    default:
      return 'nudge';
  }
}

/** The notification event a message of `kind` is delivered as. */
export function eventForKind(kind: string): CoachNotificationEventKey {
  switch (kind) {
    case 'celebration':
      return 'coach.celebration';
    case 'photo_prompt':
      return 'coach.photo_prompt';
    case 'weekly_review':
      return 'coach.weekly_review';
    default:
      return 'coach.nudge';
  }
}
