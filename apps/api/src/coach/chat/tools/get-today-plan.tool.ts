import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import type { TrainingTodayData } from '../../../programs/today/dto/training-today.dto';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely } from './minimise';

/**
 * Today's plan as the coach sees it (#338: in full): the session, every
 * exercise's prescription, rationale, load guidance, suggested load, last
 * time, muscles and availability at the plan's gym, and the plan's last change.
 */
export function minimiseToday(today: TrainingTodayData) {
  switch (today.kind) {
    case 'no_program':
      return { kind: today.kind, date: today.date };
    case 'not_started':
      return { kind: today.kind, date: today.date, program: today.program.name, startsOn: today.startsOn };
    case 'program_complete':
      return { kind: today.kind, date: today.date, program: today.program.name };
    case 'rest_day':
      return {
        kind: today.kind,
        date: today.date,
        program: today.program.name,
        weekNumber: today.weekNumber,
        totalWeeks: today.totalWeeks,
        next: today.next ? { date: today.next.date, workout: today.next.programWorkout.name } : null,
      };
    case 'workout':
      return {
        kind: today.kind,
        date: today.date,
        program: today.program.name,
        workout: today.programWorkout.name,
        weekNumber: today.weekNumber,
        totalWeeks: today.totalWeeks,
        isDeload: today.isDeload,
        done: today.done,
        inProgress: today.inProgressWorkoutId !== null,
        estimatedMinutes: today.session.estimatedMinutes,
        planVersion: today.session.planVersion,
        lastChange: today.session.lastChange ? { summary: today.session.lastChange.summary, by: today.session.lastChange.actor, at: today.session.lastChange.at } : null,
        exercises: today.session.exercises.map((exercise) => ({
          name: exercise.exercise.name,
          trackingMode: exercise.exercise.trackingMode,
          primaryMuscles: exercise.exercise.primaryMuscles,
          priority: exercise.isPriority,
          loadGuidance: exercise.loadGuidance,
          targetLoadKg: exercise.targetLoadKg,
          suggestedLoadKg: exercise.suggestedLoadKg,
          lastTime: exercise.lastTime,
          availableAtGym: exercise.availableAtGym,
          rationale: exercise.rationale,
          sets: exercise.sets,
          repMin: exercise.repMin,
          repMax: exercise.repMax,
          targetDurationSeconds: exercise.targetDurationSeconds,
          targetDistanceMeters: exercise.targetDistanceMeters,
          targetRpe: exercise.targetRpe,
          restSeconds: exercise.restSeconds,
        })),
      };
  }
}

/** `get_today_plan`: today's planned session from the Today resolver (`TrainingTodayService`). */
export function createGetTodayPlanTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_today_plan',
    description:
      "Today's planned session from the user's active program: whether it is a workout or a rest day, the workout " +
      'name, its exercises with sets, rep range (or, for cardio, a duration in seconds and/or a distance in ' +
      'meters), target RPE, rest, load guidance, target and suggested load, last time, rationale, muscles and ' +
      'availability at the gym, whether it is done, the plan\'s last change, and the next session on a ' +
      'rest day.',
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async () => {
        const date = await deps.checkIns.today(ctx.userId, deps.now());
        return minimiseToday(await deps.today.today(ctx.userId, date, deps.now()));
      }, TOOL_UNAVAILABLE),
  });
}
