import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import { fromDbDate } from '../../../check-ins/local-date';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely } from './minimise';

/** How many completed workouts the tool returns. */
export const COACH_RECENT_WORKOUTS_LIMIT = 5;

/**
 * `get_recent_workouts`: the last few COMPLETED workouts: date, name,
 * duration, and per exercise its name and working sets done. The select names
 * every column read: never notes, pain notes, gym, photos or ids.
 */
export function createGetRecentWorkoutsTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_recent_workouts',
    description:
      "The user's last few completed workouts, newest first: date, name, duration in minutes, and per exercise the " +
      'number of completed working sets.',
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async () => {
        const rows = await deps.prisma.workout.findMany({
          where: { userId: ctx.userId, status: 'completed' },
          orderBy: [{ date: 'desc' }, { startedAt: 'desc' }],
          take: COACH_RECENT_WORKOUTS_LIMIT,
          select: {
            name: true,
            date: true,
            durationSeconds: true,
            exercises: {
              orderBy: { position: 'asc' },
              select: {
                exercise: { select: { name: true } },
                sets: { select: { completed: true, isWarmup: true } },
              },
            },
          },
        });

        return {
          workouts: rows.map((row) => ({
            date: fromDbDate(row.date),
            name: row.name,
            durationMinutes: row.durationSeconds === null ? null : Math.round(row.durationSeconds / 60),
            exercises: row.exercises.map((exercise) => ({
              name: exercise.exercise.name,
              workingSetsDone: exercise.sets.filter((set) => set.completed && !set.isWarmup).length,
            })),
          })),
        };
      }, TOOL_UNAVAILABLE),
  });
}
