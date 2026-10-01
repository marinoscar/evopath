import type { Prisma } from '@prisma/client';

import type { CoachMoment } from '../personas';

// =============================================================================
// Conversion attribution rules (E7.5, #245; spec §2.8)
// =============================================================================
//
// PURE. `convertedAt` is set on the latest DELIVERED, not yet converted coach
// message the target action follows within its window:
//
//   workout   24 h   missed_twice, streak_at_risk, missed_session,
//                    fresh_start, win_back
//   photo     48 h   photo_prompt
//   check_in  24 h   a supportive message sent under low readiness
//                    (`data.lowReadiness = true`, set by the nudge job)
//
// Celebrations and reviews have no target. Outside the window nothing is set.
// =============================================================================

export const COACH_CONVERSION_TARGETS = ['workout', 'photo', 'check_in'] as const;
export type CoachConversionTarget = (typeof COACH_CONVERSION_TARGETS)[number];

const HOUR_MS = 60 * 60 * 1000;

export const CONVERSION_WINDOW_MS: Readonly<Record<CoachConversionTarget, number>> = {
  workout: 24 * HOUR_MS,
  photo: 48 * HOUR_MS,
  check_in: 24 * HOUR_MS,
};

/** The moments a completed workout converts. */
export const WORKOUT_CONVERTED_MOMENTS: readonly CoachMoment[] = [
  'missed_twice',
  'streak_at_risk',
  'missed_session',
  'fresh_start',
  'win_back',
];

/** `progress_photo.created`: emitted by the progress photos API (E7.9) after the row commits. Ids only. */
export const PROGRESS_PHOTO_CREATED_EVENT = 'progress_photo.created';

export interface ProgressPhotoCreatedEvent {
  userId: string;
  photoId: string;
}

/** The `coach_messages` filter for the message `target` at `at` may convert. */
export function conversionCandidateWhere(
  userId: string,
  target: CoachConversionTarget,
  at: Date,
): Prisma.CoachMessageWhereInput {
  const base: Prisma.CoachMessageWhereInput = {
    userId,
    role: 'coach',
    convertedAt: null,
    deliveredAt: { gte: new Date(at.getTime() - CONVERSION_WINDOW_MS[target]), lte: at },
  };
  switch (target) {
    case 'workout':
      return { ...base, moment: { in: [...WORKOUT_CONVERTED_MOMENTS] } };
    case 'photo':
      return { ...base, moment: 'photo_prompt' };
    case 'check_in':
      return { ...base, data: { path: ['lowReadiness'], equals: true } };
  }
}
