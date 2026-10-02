import type { AiDefinedTool } from '../../../ai/core/tools';
import type { CoachChatToolDeps, CoachChatTurnActions } from './coach-chat-tool.types';
import { createGetCheckInsTool } from './get-check-ins.tool';
import { createGetGoalsTool } from './get-goals.tool';
import { createGetLastWeeklyReviewTool } from './get-last-weekly-review.tool';
import { createGetProgressPhotoSummaryTool } from './get-progress-photo-summary.tool';
import { createGetRecentWorkoutsTool } from './get-recent-workouts.tool';
import { createGetTodayPlanTool } from './get-today-plan.tool';
import { createGetTrainingSignalsTool } from './get-training-signals.tool';
import { COACH_CHAT_MEMORY_TOOL_NAMES, createForgetTool, createRememberTool, createUpdateMemoryTool } from './memory.tools';
import { createPauseCoachTool } from './pause-coach.tool';
import { createSaveCommitmentTool } from './save-commitment.tool';

export * from './coach-chat-tool.types';
export { COACH_CHAT_MEMORY_TOOL_NAMES } from './memory.tools';

/**
 * The coach chat's tool list (spec §2.9; add one per spec §4.4). Seven read
 * tools (`get_goals`, F9, reads the activity goals) and two narrow write tools (`pause_coach`; `save_commitment`, E7.12,
 * which writes only `coach.why` and `coach.preferredTime`). No tool mutates a plan, program or
 * workout: plan changes are a link to the quick-adapt flow.
 */
export const COACH_CHAT_TOOL_NAMES = [
  'get_training_signals',
  'get_today_plan',
  'get_recent_workouts',
  'get_check_ins',
  'get_progress_photo_summary',
  'get_last_weekly_review',
  'get_goals',
  'pause_coach',
  'save_commitment',
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
    createPauseCoachTool(deps, actions),
    createSaveCommitmentTool(deps, actions),
    ...memoryTools,
  ] as AiDefinedTool[];
}
