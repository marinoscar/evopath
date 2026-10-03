import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import type { PlannedSnapshotEntry } from '../../../programs/today/planned-session';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely } from './minimise';
import { invalid, userBasics } from './user-context';
import { WORKOUT_DETAIL_SELECT, plannedSnapshotView, workoutView } from './workout-detail';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `get_workout` (#338): one of the caller's workouts in full (any status, so
 * the one in progress too), plus, when it was started from the plan, the
 * prescription it was started with (`program_sessions.planned_snapshot`).
 * Scoped by `userId`: another user's workout id is `not_found`.
 */
export function createGetWorkoutTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_workout',
    description:
      'One workout in full by its workoutId (from get_workout_history, get_plan_week or get_about_me), in progress ' +
      'or completed: the same detail as get_workout_history, plus `planned`, the prescription it was started from ' +
      'when it came from the plan (exercise, sets, rep range or cardio target, target RPE and load), so you can ' +
      'compare planned with done. Answers not_found for an unknown id.',
    parameters: z.object({
      workoutId: z.string().describe('The workoutId from another tool result.'),
    }),
    execute: (args, ctx) =>
      safely(async () => {
        if (!UUID.test(args.workoutId)) return invalid('workoutId must be a workoutId from another tool result');
        const [row, basics] = await Promise.all([
          deps.prisma.workout.findFirst({ where: { id: args.workoutId, userId: ctx.userId }, select: WORKOUT_DETAIL_SELECT }),
          userBasics(deps, ctx.userId),
        ]);
        if (!row) return { error: 'not_found', message: 'No workout of this user has that id.' };

        const [prs, names] = await Promise.all([
          deps.history ? deps.history.prsForWorkout(ctx.userId, row) : Promise.resolve(new Map()),
          plannedNames(deps, ctx.userId, row.programSession?.plannedSnapshot, row.exercises),
        ]);
        return {
          units: basics.units,
          workout: workoutView(row, basics.timeZone, prs),
          planned: plannedSnapshotView(row.programSession?.plannedSnapshot ?? null, names),
        };
      }, TOOL_UNAVAILABLE),
  });
}

/** Exercise names for a snapshot: from the workout's own exercises, then one read for the rest. */
async function plannedNames(
  deps: CoachChatToolDeps,
  userId: string,
  snapshot: unknown,
  done: ReadonlyArray<{ exerciseId: string; exercise: { name: string } }>,
): Promise<Map<string, string>> {
  const names = new Map(done.map((entry) => [entry.exerciseId, entry.exercise.name]));
  if (!Array.isArray(snapshot)) return names;
  const missing = [...new Set((snapshot as PlannedSnapshotEntry[]).map((entry) => entry.exerciseId))].filter(
    (id) => typeof id === 'string' && !names.has(id),
  );
  if (missing.length > 0) {
    const rows = await deps.prisma.exercise.findMany({ where: { id: { in: missing }, OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
      select: { id: true, name: true } });
    for (const row of rows) names.set(row.id, row.name);
  }
  return names;
}
