import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely } from './minimise';
import { userBasics } from './user-context';
import { WORKOUT_DETAIL_SELECT, prsForWorkouts, workoutView } from './workout-detail';

/** How many completed workouts the tool returns. */
export const COACH_RECENT_WORKOUTS_LIMIT = 5;

/**
 * `get_recent_workouts`: the last few COMPLETED workouts in full (#338: the
 * same detail as `get_workout_history`, `workout-detail.ts`): times, plan
 * link, gym name, notes, every exercise and set, totals and PRs.
 */
export function createGetRecentWorkoutsTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_recent_workouts',
    description:
      `The user's last ${COACH_RECENT_WORKOUTS_LIMIT} completed workouts in full, newest first: the same detail as ` +
      'get_workout_history (date, times, duration, plan session, gym, notes, every exercise and set with weights, ' +
      'reps, RPE, pain and notes, totals and PRs). Use get_workout_history for a date range.',
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async () => {
        const [rows, basics] = await Promise.all([
          deps.prisma.workout.findMany({
            where: { userId: ctx.userId, status: 'completed' },
            orderBy: [{ date: 'desc' }, { startedAt: 'desc' }, { id: 'desc' }],
            take: COACH_RECENT_WORKOUTS_LIMIT,
            select: WORKOUT_DETAIL_SELECT,
          }),
          userBasics(deps, ctx.userId),
        ]);
        const prs = await prsForWorkouts(deps, ctx.userId, rows);
        return { units: basics.units, workouts: rows.map((row) => workoutView(row, basics.timeZone, prs)) };
      }, TOOL_UNAVAILABLE),
  });
}
