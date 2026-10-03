import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import type { TrainingTodayData } from '../../../programs/today/dto/training-today.dto';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely } from './minimise';
import { localTimeOf, userBasics, weekdayOf } from './user-context';

/** Where the plan stands today, compact (no exercises: that is `get_today_plan`). */
export function planNow(today: TrainingTodayData | null) {
  if (!today) return null;
  switch (today.kind) {
    case 'no_program':
      return { status: 'no_plan' as const };
    case 'not_started':
      return { status: 'not_started' as const, program: today.program.name, startsOn: today.startsOn };
    case 'program_complete':
      return { status: 'plan_complete' as const, program: today.program.name };
    case 'rest_day':
      return {
        status: 'rest_day' as const,
        program: today.program.name,
        weekNumber: today.weekNumber,
        totalWeeks: today.totalWeeks,
        next: today.next ? { date: today.next.date, weekday: weekdayOf(today.next.date), workout: today.next.programWorkout.name } : null,
      };
    case 'workout':
      return {
        status: today.done ? ('workout_done' as const) : today.inProgressWorkoutId ? ('workout_in_progress' as const) : ('workout_planned' as const),
        program: today.program.name,
        weekNumber: today.weekNumber,
        totalWeeks: today.totalWeeks,
        isDeload: today.isDeload,
        workout: today.programWorkout.name,
        workoutId: today.completedWorkoutId ?? today.inProgressWorkoutId ?? null,
      };
  }
}

/** Today's plan for the caller's local today, or null when it cannot be read. */
export async function readToday(deps: CoachChatToolDeps, userId: string, date: string): Promise<TrainingTodayData | null> {
  try {
    return await deps.today.today(userId, date, deps.now());
  } catch {
    return null;
  }
}

/**
 * `get_now` (#338): the user's local date, weekday and time in their time
 * zone, and where the active plan stands today (plan week N of M, today's
 * session and whether it is done).
 */
export function createGetNowTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_now',
    description:
      "The user's current local date, weekday, local time (24-hour) and IANA time zone, and where their plan stands " +
      'today: no_plan, not_started, plan_complete, rest_day (with the next session) or a workout (planned, ' +
      'in_progress or done), with plan week N of M. Call it before saying anything about today, yesterday, this ' +
      'week or the time of day.',
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async () => {
        const now = deps.now();
        const [date, basics] = await Promise.all([deps.checkIns.today(ctx.userId, now), userBasics(deps, ctx.userId)]);
        const today = await readToday(deps, ctx.userId, date);
        return {
          localDate: date,
          weekday: weekdayOf(date),
          localTime: localTimeOf(now, basics.timeZone),
          timeZone: basics.timeZone ?? 'UTC',
          ...(basics.timeZone ? {} : { timeZoneNote: 'No time zone is set on the profile, so UTC is used.' }),
          plan: planNow(today),
        };
      }, TOOL_UNAVAILABLE),
  });
}
