// =============================================================================
// AI Coach job types (docs/specs/ai-coach.md §3.4)
// =============================================================================
//
// The ONE place the coach's job `type` strings live, so the story that
// enqueues a type and the story that handles it cannot drift apart by a typo.
// A job `type` string is PERMANENT once rows of it exist.
//
// Every coach job is server-only: none implements `nodeResultSchema` or
// `persistNodeResult` (AI rule 3 for the `ai.*` ones; the planning jobs read
// many tables mid-computation).
// =============================================================================

/** Hourly fleet sweep: plans each coach-enabled user's moment (E7.4). */
export const COACH_SWEEP_JOB_TYPE = 'coach.sweep';

/** One user's immediate planning after a finished workout (E7.4). */
export const COACH_WORKOUT_FINISHED_JOB_TYPE = 'coach.workout_finished';

/** Generates, guards and delivers one nudge (E7.5). */
export const AI_COACH_NUDGE_JOB_TYPE = 'ai.coach.nudge';

/** Generates one weekly review (E7.10). */
export const AI_COACH_WEEKLY_REVIEW_JOB_TYPE = 'ai.coach.weekly_review';

/** `jobs.subject_type` of every per-user coach job. */
export const COACH_USER_SUBJECT_TYPE = 'user';
