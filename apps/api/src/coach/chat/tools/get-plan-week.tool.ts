import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import { addDays, fromDbDate } from '../../../check-ins/local-date';
import type { PlanTree } from '../../../programs/contracts/plan-tree.contract';
import { liveTreeOf } from '../../../programs/plan-diff';
import { loadProgramRows } from '../../../programs/program-mapper';
import { daysFrom, resolveWeek, totalWeeksOf, type WeekSessionStatus } from '../../../programs/today/resolve-today';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely } from './minimise';
import { dropNulls, invalid, userBasics, userText, weekdayOf, WEEKDAY_NAMES } from './user-context';

/** The longest plan rationale the coach is sent, in characters. */
export const COACH_PLAN_RATIONALE_MAX = 4000;

/** The current plan week of a plan started on `startDate`, or null before it starts. */
export function currentPlanWeek(startDate: string | null, today: string): number | null {
  if (!startDate || today < startDate) return null;
  return Math.floor(daysFrom(startDate, today) / 7) + 1;
}

/**
 * `get_plan_week` (#338): the ACTIVE plan's sessions for one plan week
 * (default the current one) with their date, weekday and status (the same
 * occurrence rule and statuses as the Today card: `resolveWeek`), each with
 * its full prescription, plus the program overview (name, goal, start date,
 * weeks, blocks, rationale). Read-only; four indexed tree reads plus one for
 * the linked workouts and one for exercise names.
 */
export function createGetPlanWeekTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_plan_week',
    description:
      "The user's active training plan for one plan week (weekNumber, or null for the current week): each session " +
      'with its date, weekday, status (done, in_progress, missed, today, upcoming; unscheduled when it has no ' +
      'weekday), workoutId of the logged workout when done or in progress, estimated minutes, rationale, and every ' +
      'prescribed exercise (sets, rep range or cardio duration/distance, target RPE, rest seconds, load guidance, ' +
      'target load kg, priority, notes, rationale); the week deload flag; and the plan overview (name, goal, ' +
      'status, start date, current week, total weeks, blocks with their focus and weeks, rationale). program is ' +
      'null without an active plan.',
    parameters: z.object({
      weekNumber: z.number().int().nullable().describe('Plan week, 1-based, or null for the current week.'),
    }),
    execute: (args, ctx) =>
      safely(async () => {
        const [program, today, basics] = await Promise.all([
          deps.prisma.program.findFirst({
            where: { userId: ctx.userId, status: 'active' },
            orderBy: { updatedAt: 'desc' },
            select: {
              id: true,
              name: true,
              goal: true,
              status: true,
              startDate: true,
              rationale: true,
              notes: true,
              currentVersion: true,
              gym: { select: { name: true } },
            },
          }),
          deps.checkIns.today(ctx.userId, deps.now()),
          userBasics(deps, ctx.userId),
        ]);
        if (!program) return { today, program: null };

        const tree = liveTreeOf(await loadProgramRows(deps.prisma, program.id));
        const totalWeeks = totalWeeksOf(tree);
        const startDate = program.startDate ? fromDbDate(program.startDate) : null;
        const current = currentPlanWeek(startDate, today);
        const weekNumber = args.weekNumber ?? (current === null ? 1 : Math.min(current, Math.max(totalWeeks, 1)));
        if (weekNumber < 1 || weekNumber > totalWeeks) {
          return invalid(`weekNumber must be between 1 and ${totalWeeks} for this plan, or null`);
        }

        const weeks = tree.blocks.flatMap((block) => block.weeks.filter((week) => week.weekNumber === weekNumber));
        const workouts = weeks.flatMap((week) => week.workouts);
        const programWorkoutIds = workouts.map((workout) => workout.id!).filter(Boolean);
        const exerciseIds = [...new Set(workouts.flatMap((workout) => workout.exercises.map((exercise) => exercise.exerciseId)))];

        const [linked, exercises] = await Promise.all([
          programWorkoutIds.length
            ? deps.prisma.workout.findMany({
                where: {
                  userId: ctx.userId,
                  OR: [
                    { programWorkoutId: { in: programWorkoutIds } },
                    { programSession: { is: { programWorkoutId: { in: programWorkoutIds } } } },
                  ],
                },
                orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
                select: { id: true, status: true, programWorkoutId: true, programSession: { select: { programWorkoutId: true } } },
              })
            : Promise.resolve([]),
          exerciseIds.length
            ? deps.prisma.exercise.findMany({
                where: { id: { in: exerciseIds }, OR: [{ ownerUserId: null }, { ownerUserId: ctx.userId }] },
                select: { id: true, name: true },
              })
            : Promise.resolve([]),
        ]);
        const names = new Map(exercises.map((row) => [row.id, row.name]));
        const linkedTo = (programWorkoutId: string) =>
          linked.filter((row) => row.programWorkoutId === programWorkoutId || row.programSession?.programWorkoutId === programWorkoutId);
        const completed = new Set(programWorkoutIds.filter((id) => linkedTo(id).some((row) => row.status === 'completed')));
        const inProgress = new Set(programWorkoutIds.filter((id) => linkedTo(id).some((row) => row.status === 'in_progress')));

        const scheduled = startDate
          ? resolveWeek({
              startDate,
              weekNumber,
              tree,
              today,
              completedProgramWorkoutIds: completed,
              inProgressProgramWorkoutIds: inProgress,
              suggestedProgramWorkoutId: null,
            })
          : [];
        const byId = new Map(scheduled.map((session) => [session.programWorkout.id!, session]));

        const sessions = workouts
          .map((workout) => {
            const occurrence = byId.get(workout.id!);
            const status: WeekSessionStatus | 'unscheduled' | 'not_started' = occurrence
              ? occurrence.status
              : workout.weekday == null
                ? 'unscheduled'
                : 'not_started';
            const mine = linkedTo(workout.id!);
            const logged = mine.find((row) => row.status === 'completed') ?? mine.find((row) => row.status === 'in_progress');
            return {
              date: occurrence?.date ?? null,
              weekday: occurrence ? weekdayOf(occurrence.date) : workout.weekday ? WEEKDAY_NAMES[workout.weekday - 1] : null,
              status,
              workoutId: logged?.id ?? null,
              name: workout.name,
              estimatedMinutes: workout.estimatedMinutes,
              rationale: userText(workout.rationale),
              exercises: workout.exercises.map((exercise) =>
                dropNulls({
                  name: names.get(exercise.exerciseId) ?? null,
                  priority: exercise.isPriority || null,
                  sets: exercise.targetSets,
                  repMin: exercise.repMin,
                  repMax: exercise.repMax,
                  targetDurationSeconds: exercise.targetDurationSeconds,
                  targetDistanceMeters: exercise.targetDistanceMeters,
                  targetRpe: exercise.targetRpe,
                  restSeconds: exercise.restSeconds,
                  loadGuidance: exercise.loadGuidance,
                  targetLoadKg: exercise.targetLoadKg,
                  notes: userText(exercise.notes),
                  rationale: userText(exercise.rationale),
                }),
              ),
            };
          })
          .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));

        return {
          today,
          units: basics.units,
          week: {
            weekNumber,
            isCurrent: weekNumber === current,
            isDeload: weeks.some((week) => week.isDeload),
            from: startDate ? addDays(startDate, 7 * (weekNumber - 1)) : null,
            to: startDate ? addDays(startDate, 7 * weekNumber - 1) : null,
            sessions,
          },
          program: {
            name: program.name,
            goal: program.goal,
            status: program.status,
            startDate,
            currentWeek: current !== null && current <= totalWeeks ? current : null,
            totalWeeks,
            planVersion: program.currentVersion,
            gym: userText(program.gym?.name ?? null, 80),
            blocks: blocksOf(tree),
            rationale: userText(program.rationale, COACH_PLAN_RATIONALE_MAX),
            notes: userText(program.notes),
          },
        };
      }, TOOL_UNAVAILABLE),
  });
}

/** The plan's blocks: name, focus, rationale and the week range they span. */
export function blocksOf(tree: PlanTree) {
  return tree.blocks.map((block) => {
    const numbers = block.weeks.map((week) => week.weekNumber);
    return {
      name: block.name,
      focus: userText(block.focus),
      rationale: userText(block.rationale),
      weeks: numbers.length ? { from: Math.min(...numbers), to: Math.max(...numbers) } : null,
      deloadWeeks: block.weeks.filter((week) => week.isDeload).map((week) => week.weekNumber),
    };
  });
}
