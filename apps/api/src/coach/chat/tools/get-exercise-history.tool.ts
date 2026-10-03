import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import { fromDbDate } from '../../../check-ins/local-date';
import { e1rmKg, toWorkingSet, tracksPrs } from '../../../workouts/workout-records';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely } from './minimise';
import { dropNulls, invalid, num, userBasics, userText, weekdayOf } from './user-context';
import { EQUIPMENT_TYPE_SELECT, EXERCISE_META_SELECT, GYM_EQUIPMENT_SELECT, equipmentView, exerciseMeta } from './workout-detail';

/** Sessions `get_exercise_history` returns by default, and at most. */
export const COACH_EXERCISE_HISTORY_DEFAULT = 10;
export const COACH_EXERCISE_HISTORY_MAX = 100;
/** Candidate exercises read when matching a name. */
const MATCH_CANDIDATES = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Candidate {
  id: string;
  name: string;
  slug: string;
  trackingMode: string;
  aliases: string[];
  [key: string]: unknown;
}

/**
 * `get_exercise_history` (#338): one exercise (by name, alias, slug or id;
 * the library's or the caller's own) over the caller's last completed
 * sessions with it, every set in order (notes and pain notes included), each
 * session's top set and e1RM, and the all-time records
 * (`WorkoutHistoryService.history`, the same figures as the exercise page).
 */
export function createGetExerciseHistoryTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_exercise_history',
    description:
      "One exercise's history for the user: `exercise` is a name (e.g. \"bench press\"), alias or id. Answers the " +
      'matched exercise, other close matches, the last sessions (newest first) with date, workout, gym, the exercise ' +
      'notes and every set (weightKg, reps, rpe, rir, durationSeconds, distanceMeters, warmup, painFlag, painNote, ' +
      'notes), each session\'s topSet and e1rmKg, and all-time records (max weight, max reps, best estimated 1RM, ' +
      `each with its date). limit is 1 to ${COACH_EXERCISE_HISTORY_MAX} sessions, or null for ${COACH_EXERCISE_HISTORY_DEFAULT}. ` +
      'Weights are kilograms. Call it before talking about how a lift is progressing.',
    parameters: z.object({
      exercise: z.string().describe('Exercise name, alias, slug or id.'),
      limit: z.number().int().nullable().describe(`Sessions, 1 to ${COACH_EXERCISE_HISTORY_MAX}, or null.`),
    }),
    execute: (args, ctx) =>
      safely(async () => {
        const query = args.exercise.replace(/\s+/g, ' ').trim().slice(0, 100);
        if (query.length === 0) return invalid('exercise must name an exercise');
        const limit = Math.min(Math.max(args.limit ?? COACH_EXERCISE_HISTORY_DEFAULT, 1), COACH_EXERCISE_HISTORY_MAX);
        const lower = query.toLowerCase();

        const candidates: Candidate[] = await deps.prisma.exercise.findMany({
          where: {
            AND: [
              { OR: [{ ownerUserId: null }, { ownerUserId: ctx.userId }] },
              UUID.test(query)
                ? { id: query }
                : { OR: [{ name: { contains: query, mode: 'insensitive' } }, { slug: lower }, { aliases: { has: lower } }] },
            ],
          },
          orderBy: { name: 'asc' },
          take: MATCH_CANDIDATES,
          select: { id: true, slug: true, ...EXERCISE_META_SELECT },
        });
        if (candidates.length === 0) {
          return { found: false, message: `No exercise matches "${query}". Ask the user which exercise they mean.` };
        }
        const exercise = await pick(deps, ctx.userId, candidates, lower);

        const [basics, sessions, history] = await Promise.all([
          userBasics(deps, ctx.userId),
          deps.prisma.workout.findMany({
            where: { userId: ctx.userId, status: 'completed', exercises: { some: { exerciseId: exercise.id } } },
            orderBy: [{ date: 'desc' }, { startedAt: 'desc' }, { id: 'desc' }],
            take: limit,
            select: {
              id: true,
              date: true,
              name: true,
              gym: { select: { name: true, equipment: { select: GYM_EQUIPMENT_SELECT } } },
              exercises: {
                where: { exerciseId: exercise.id },
                orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
                select: {
                  notes: true,
                  equipmentTypeId: true,
                  equipmentType: { select: EQUIPMENT_TYPE_SELECT },
                  sets: {
                    orderBy: { setNumber: 'asc' },
                    select: {
                      setNumber: true,
                      weightKg: true,
                      reps: true,
                      rpe: true,
                      rir: true,
                      durationSeconds: true,
                      distanceMeters: true,
                      isWarmup: true,
                      completed: true,
                      painFlag: true,
                      painNote: true,
                      notes: true,
                    },
                  },
                },
              },
            },
          }),
          deps.history && tracksPrs(exercise.trackingMode)
            ? deps.history.history(ctx.userId, exercise.id, { limit: 1 }, deps.now()).catch(() => null)
            : Promise.resolve(null),
        ]);

        return {
          found: true,
          exercise: { name: exercise.name, ...exerciseMeta(exercise as never) },
          otherMatches: candidates.filter((c) => c.id !== exercise.id).slice(0, 5).map((c) => c.name),
          units: basics.units,
          records: history?.records ?? null,
          sessions: sessions.map((session) => {
            const date = fromDbDate(session.date);
            const sets = session.exercises.flatMap((entry) => entry.sets);
            let topSet: { weightKg: number; reps: number } | null = null;
            let best: number | null = null;
            for (const set of sets) {
              const working = toWorkingSet(
                { weightKg: num(set.weightKg), reps: set.reps, completed: set.completed, isWarmup: set.isWarmup },
                exercise.trackingMode,
              );
              if (!working) continue;
              if (!topSet || working.weightKg > topSet.weightKg || (working.weightKg === topSet.weightKg && working.reps > topSet.reps)) {
                topSet = working;
              }
              const estimate = e1rmKg(working.weightKg, working.reps);
              if (estimate !== null && (best === null || estimate > best)) best = estimate;
            }
            return {
              workoutId: session.id,
              date,
              weekday: weekdayOf(date),
              workout: session.name,
              gym: userText(session.gym?.name ?? null, 80),
              notes: session.exercises.map((entry) => userText(entry.notes)).filter((note): note is string => note !== null),
              equipment: session.exercises
                .map((entry) =>
                  equipmentView(
                    entry.equipmentType,
                    (session.gym?.equipment ?? []).filter((item) => item.equipmentTypeId === entry.equipmentTypeId),
                  ),
                )
                .filter((item) => item !== null),
              topSet,
              e1rmKg: best,
              sets: sets.map((set) => ({
                set: set.setNumber,
                ...(set.isWarmup ? { warmup: true } : {}),
                ...dropNulls({
                  weightKg: num(set.weightKg),
                  reps: set.reps,
                  rpe: num(set.rpe),
                  rir: set.rir,
                  durationSeconds: set.durationSeconds,
                  distanceMeters: num(set.distanceMeters),
                }),
                completed: set.completed,
                ...(set.painFlag ? { painFlag: true } : {}),
                ...dropNulls({ painNote: userText(set.painNote), notes: userText(set.notes) }),
              })),
            };
          }),
        };
      }, TOOL_UNAVAILABLE),
  });
}

/**
 * The best candidate: an exact name, slug or alias match; else the one the
 * user has logged most (one grouped read); else the first by name.
 */
async function pick(deps: CoachChatToolDeps, userId: string, candidates: Candidate[], lower: string): Promise<Candidate> {
  const exact = candidates.find(
    (c) => c.id.toLowerCase() === lower || c.name.toLowerCase() === lower || c.slug === lower || c.aliases.includes(lower),
  );
  if (exact || candidates.length === 1) return exact ?? candidates[0];
  const counts = await deps.prisma.workoutExercise.groupBy({
    by: ['exerciseId'],
    where: { exerciseId: { in: candidates.map((c) => c.id) }, workout: { userId } },
    _count: { _all: true },
  });
  const byId = new Map(counts.map((row) => [row.exerciseId, row._count._all]));
  return [...candidates].sort((a, b) => (byId.get(b.id) ?? 0) - (byId.get(a.id) ?? 0))[0];
}
