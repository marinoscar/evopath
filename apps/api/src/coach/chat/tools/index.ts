import type { AiDefinedTool } from '../../../ai/core/tools';
import { createGetBiomarkerValuesTool, createListBiomarkersTool } from './biomarker.tools';
import type { CoachChatToolDeps, CoachChatTurnActions } from './coach-chat-tool.types';
import { createGetAboutMeTool } from './get-about-me.tool';
import { createGetActivityTool } from './get-activity.tool';
import { createGetCheckInsTool } from './get-check-ins.tool';
import { createGetExerciseHistoryTool } from './get-exercise-history.tool';
import { createGetGymsTool } from './get-gyms.tool';
import { createGetHealthDocumentsTool } from './get-health-documents.tool';
import { createGetMeasurementsTool } from './get-measurements.tool';
import { createGetPersonalRecordsTool } from './get-personal-records.tool';
import { createGetPlanHistoryTool, createGetProgramsTool } from './get-programs.tool';
import { createGetGoalsTool } from './get-goals.tool';
import { createGetHealthSummaryTool } from './get-health-summary.tool';
import { createGetNowTool } from './get-now.tool';
import { createGetPlanWeekTool } from './get-plan-week.tool';
import { createGetProfileTool } from './get-profile.tool';
import { createGetSleepTool } from './get-sleep.tool';
import { createGetTrainingProfileTool } from './get-training-profile.tool';
import { createGetLastWeeklyReviewTool } from './get-last-weekly-review.tool';
import { createGetProgressPhotoSummaryTool } from './get-progress-photo-summary.tool';
import { createGetRecentWorkoutsTool } from './get-recent-workouts.tool';
import { createGetTodayPlanTool } from './get-today-plan.tool';
import { createGetTrainingSignalsTool } from './get-training-signals.tool';
import { createGetWorkoutHistoryTool } from './get-workout-history.tool';
import { createGetWorkoutTool } from './get-workout.tool';
import { COACH_CHAT_MEMORY_TOOL_NAMES, createForgetTool, createRememberTool, createUpdateMemoryTool } from './memory.tools';
import { createPauseCoachTool } from './pause-coach.tool';
import { createSaveCommitmentTool } from './save-commitment.tool';
import { createSetDisplayNameTool } from './set-display-name.tool';

export * from './coach-chat-tool.types';
export { COACH_CHAT_MEMORY_TOOL_NAMES } from './memory.tools';

/**
 * The coach chat's tool list (spec §2.9; add one per spec §4.4). Twenty-six read
 * tools (`get_goals`, F9, reads the activity goals and the training goal;
 * `get_profile`, `get_training_profile`, `get_health_summary`,
 * `list_biomarkers`, `get_biomarker_values` and `get_sleep`, #327, the health
 * ones consent-gated; `get_now`, `get_about_me`, `get_workout_history`,
 * `get_workout`, `get_plan_week`, `get_exercise_history` and `get_activity`,
 * #338, plus `get_gyms`, `get_measurements`, `get_personal_records`,
 * `get_programs`, `get_plan_history` and `get_health_documents`, which give
 * the coach every data point about the user) and
 * three narrow write tools (`pause_coach`; `save_commitment`, E7.12, which
 * writes only `coach.why` and `coach.preferredTime`; `set_display_name`,
 * #327, which writes only the profile display name). No tool mutates a plan,
 * program or workout: plan changes are a link to the quick-adapt flow.
 */
export const COACH_CHAT_TOOL_NAMES = [
  'get_training_signals',
  'get_today_plan',
  'get_recent_workouts',
  'get_check_ins',
  'get_progress_photo_summary',
  'get_last_weekly_review',
  'get_goals',
  'get_profile',
  'get_training_profile',
  'get_health_summary',
  'list_biomarkers',
  'get_biomarker_values',
  'get_sleep',
  'get_now',
  'get_about_me',
  'get_workout_history',
  'get_workout',
  'get_plan_week',
  'get_exercise_history',
  'get_activity',
  'get_gyms',
  'get_measurements',
  'get_personal_records',
  'get_programs',
  'get_plan_history',
  'get_health_documents',
  'pause_coach',
  'save_commitment',
  'set_display_name',
] as const;

export type CoachChatToolName = (typeof COACH_CHAT_TOOL_NAMES)[number] | (typeof COACH_CHAT_MEMORY_TOOL_NAMES)[number];

/**
 * The tools for one turn. `actions` collects what the write tools did. The
 * three memory tools (`remember`, `forget`, `update_memory`; #325) follow the
 * list only while `deps.memory` is present (memory on for the user).
 */
export function createCoachChatTools(deps: CoachChatToolDeps, actions: CoachChatTurnActions): AiDefinedTool[] {
  const memoryTools = deps.memory
    ? [createRememberTool(deps, actions), createForgetTool(deps, actions), createUpdateMemoryTool(deps, actions)]
    : [];
  return [
    createGetTrainingSignalsTool(deps),
    createGetTodayPlanTool(deps),
    createGetRecentWorkoutsTool(deps),
    createGetCheckInsTool(deps),
    createGetProgressPhotoSummaryTool(deps),
    createGetLastWeeklyReviewTool(deps),
    createGetGoalsTool(deps),
    createGetProfileTool(deps),
    createGetTrainingProfileTool(deps),
    createGetHealthSummaryTool(deps),
    createListBiomarkersTool(deps),
    createGetBiomarkerValuesTool(deps),
    createGetSleepTool(deps),
    createGetNowTool(deps),
    createGetAboutMeTool(deps),
    createGetWorkoutHistoryTool(deps),
    createGetWorkoutTool(deps),
    createGetPlanWeekTool(deps),
    createGetExerciseHistoryTool(deps),
    createGetActivityTool(deps),
    createGetGymsTool(deps),
    createGetMeasurementsTool(deps),
    createGetPersonalRecordsTool(deps),
    createGetProgramsTool(deps),
    createGetPlanHistoryTool(deps),
    createGetHealthDocumentsTool(deps),
    createPauseCoachTool(deps, actions),
    createSaveCommitmentTool(deps, actions),
    createSetDisplayNameTool(deps, actions),
    ...memoryTools,
  ] as AiDefinedTool[];
}
