import type { AiDefinedTool } from '../../../ai/core/tools';
import type { CoachChatToolDeps, CoachChatTurnActions } from './coach-chat-tool.types';
import { createGetCheckInsTool } from './get-check-ins.tool';
import { createGetLastWeeklyReviewTool } from './get-last-weekly-review.tool';
import { createGetProgressPhotoSummaryTool } from './get-progress-photo-summary.tool';
import { createGetRecentWorkoutsTool } from './get-recent-workouts.tool';
import { createGetTodayPlanTool } from './get-today-plan.tool';
import { createGetTrainingSignalsTool } from './get-training-signals.tool';
import { createPauseCoachTool } from './pause-coach.tool';

export * from './coach-chat-tool.types';

/**
 * The coach chat's tool list (spec §2.9; add one per spec §4.4). Six read
 * tools and one narrow write tool. No tool mutates a plan, program or
 * workout: plan changes are a link to the quick-adapt flow.
 */
export const COACH_CHAT_TOOL_NAMES = [
  'get_training_signals',
  'get_today_plan',
  'get_recent_workouts',
  'get_check_ins',
  'get_progress_photo_summary',
  'get_last_weekly_review',
  'pause_coach',
] as const;

export type CoachChatToolName = (typeof COACH_CHAT_TOOL_NAMES)[number];

/** The tools for one turn. `actions` collects what the write tool did. */
export function createCoachChatTools(deps: CoachChatToolDeps, actions: CoachChatTurnActions): AiDefinedTool[] {
  return [
    createGetTrainingSignalsTool(deps),
    createGetTodayPlanTool(deps),
    createGetRecentWorkoutsTool(deps),
    createGetCheckInsTool(deps),
    createGetProgressPhotoSummaryTool(deps),
    createGetLastWeeklyReviewTool(deps),
    createPauseCoachTool(deps, actions),
  ] as AiDefinedTool[];
}
