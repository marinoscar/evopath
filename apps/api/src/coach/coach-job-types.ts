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

/**
 * One user's immediate planning after a manual activity check-in (F9, #269):
 * plans `goal_hit`. Server-only, like every coach job.
 */
export const COACH_ACTIVITY_RECORDED_JOB_TYPE = 'coach.activity_recorded';

/** Generates, guards and delivers one nudge (E7.5). */
export const AI_COACH_NUDGE_JOB_TYPE = 'ai.coach.nudge';

/** Generates one weekly review (E7.10). */
export const AI_COACH_WEEKLY_REVIEW_JOB_TYPE = 'ai.coach.weekly_review';

/** Delivers one persisted coach message as a notification (E7.5). */
export const COACH_MESSAGE_DELIVER_JOB_TYPE = 'coach.message.deliver';

/**
 * Settles one message's spoken version once its `ai.audio.speech` run ended,
 * or when the wait cap elapsed, then enqueues delivery (E7.6).
 */
export const COACH_AUDIO_SETTLE_JOB_TYPE = 'coach.audio.settle';

/** Daily: deletes coach audio older than `audioRetentionDays`, keeping the text (E7.6). */
export const COACH_AUDIO_PURGE_JOB_TYPE = 'coach.audio.purge';

/** `jobs.subject_type` of a per-message coach job (`coach.message.deliver`, `coach.audio.settle`). */
export const COACH_MESSAGE_SUBJECT_TYPE = 'coach_message';

/** `jobs.subject_type` of every per-user coach job. */
export const COACH_USER_SUBJECT_TYPE = 'user';

/**
 * `jobs.subject_type` of a program-activation kickoff (`ai.coach.nudge`,
 * E7.12). The subject is the program, so the active-dedup key is per program
 * (one pending kickoff per program) and a kickoff never collapses onto a
 * sweep nudge queued for the same user.
 */
export const COACH_PROGRAM_SUBJECT_TYPE = 'program';
