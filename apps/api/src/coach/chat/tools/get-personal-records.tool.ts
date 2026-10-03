import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import { fromDbDate } from '../../../check-ins/local-date';
import { E1RM_MAX_REPS } from '../../../workouts/workout-records';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely } from './minimise';
import { num, round, userBasics } from './user-context';

interface RecordRow {
  kind: 'weight' | 'reps' | 'e1rm' | 'stats';
  exercise_id: string;
  name: string;
  weight_kg: Prisma.Decimal | number | null;
  reps: number | null;
  date: Date | null;
  e1rm: Prisma.Decimal | number | null;
  sessions: number | bigint | null;
  working_sets: number | bigint | null;
}

/**
 * `get_personal_records` (#338): the caller's all-time records for EVERY
 * exercise they have logged, in one SQL read: max weight (with its reps),
 * max reps (with its weight), best estimated 1RM (Epley, 1..12 reps), each
 * with its date, plus how many sessions and working sets and the last date.
 * The same working-set rule as `WorkoutHistoryService` (completed, not a
 * warmup, reps >= 1, weighted or bodyweight). Scoped by `w.user_id`.
 */
export function createGetPersonalRecordsTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_personal_records',
    description:
      "The user's all-time personal records for every strength exercise they have logged: maxWeight (kg, with reps " +
      'and date), maxReps (with weight and date), bestE1rm (estimated one-rep max in kg, with the set and date), ' +
      'sessions, workingSets and lastDone; strongest first by e1RM. Weights are kilograms; `units` says what the ' +
      'user prefers. Call it for questions about PRs, strength levels or "what is my best".',
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async () => {
        const [rows, basics] = await Promise.all([
          deps.prisma.$queryRaw<RecordRow[]>(Prisma.sql`
            WITH ws AS (
              SELECT we."exercise_id", e."name", COALESCE(s."weight_kg", 0) AS "weight_kg", s."reps", w."date",
                     w."started_at", w."id" AS "workout_id"
                FROM "set_logs" s
                JOIN "workout_exercises" we ON we."id" = s."workout_exercise_id"
                JOIN "workouts" w ON w."id" = we."workout_id"
                JOIN "exercises" e ON e."id" = we."exercise_id"
               WHERE w."user_id" = ${ctx.userId}::uuid
                 AND w."status" = 'completed'
                 AND s."completed" AND NOT s."is_warmup" AND s."reps" >= 1
                 AND e."tracking_mode" IN ('weight_reps', 'bodyweight_reps')
                 AND (s."weight_kg" IS NOT NULL OR e."tracking_mode" = 'bodyweight_reps')
            )
            (SELECT DISTINCT ON ("exercise_id") 'weight' AS "kind", "exercise_id", "name", "weight_kg", "reps", "date",
                    NULL::numeric AS "e1rm", NULL::bigint AS "sessions", NULL::bigint AS "working_sets"
               FROM ws ORDER BY "exercise_id", "weight_kg" DESC, "reps" DESC, "date" ASC, "started_at" ASC)
            UNION ALL
            (SELECT DISTINCT ON ("exercise_id") 'reps', "exercise_id", "name", "weight_kg", "reps", "date", NULL, NULL, NULL
               FROM ws ORDER BY "exercise_id", "reps" DESC, "weight_kg" DESC, "date" ASC, "started_at" ASC)
            UNION ALL
            (SELECT DISTINCT ON ("exercise_id") 'e1rm', "exercise_id", "name", "weight_kg", "reps", "date",
                    ROUND(CASE WHEN "reps" = 1 THEN "weight_kg" ELSE "weight_kg" * (1 + "reps" / 30.0) END, 1), NULL, NULL
               FROM ws WHERE "weight_kg" > 0 AND "reps" <= ${E1RM_MAX_REPS}
               ORDER BY "exercise_id", 7 DESC, "date" ASC, "started_at" ASC)
            UNION ALL
            (SELECT 'stats', "exercise_id", MIN("name"), NULL, NULL, MAX("date"), NULL,
                    COUNT(DISTINCT "workout_id"), COUNT(*)
               FROM ws GROUP BY "exercise_id")`),
          userBasics(deps, ctx.userId),
        ]);

        const byExercise = new Map<string, Record<string, unknown> & { name: string; bestE1rmValue: number }>();
        for (const row of rows ?? []) {
          const entry = byExercise.get(row.exercise_id) ?? { name: row.name, bestE1rmValue: 0 };
          const weightKg = num(row.weight_kg);
          const date = row.date ? fromDbDate(row.date) : null;
          if (row.kind === 'weight') entry.maxWeight = { kg: weightKg, reps: row.reps, date };
          if (row.kind === 'reps') entry.maxReps = { reps: row.reps, kg: weightKg, date };
          if (row.kind === 'e1rm') {
            const e1rm = num(row.e1rm) ?? 0;
            entry.bestE1rm = { kg: round(e1rm, 1), fromKg: weightKg, fromReps: row.reps, date };
            entry.bestE1rmValue = e1rm;
          }
          if (row.kind === 'stats') {
            entry.sessions = Number(row.sessions ?? 0);
            entry.workingSets = Number(row.working_sets ?? 0);
            entry.lastDone = date;
          }
          byExercise.set(row.exercise_id, entry);
        }
        const records = [...byExercise.values()]
          .sort((a, b) => b.bestE1rmValue - a.bestE1rmValue || a.name.localeCompare(b.name))
          .map(({ bestE1rmValue: _sort, ...rest }) => ({ maxWeight: null, maxReps: null, bestE1rm: null, ...rest }));
        return { units: basics.units, count: records.length, records };
      }, TOOL_UNAVAILABLE),
  });
}
