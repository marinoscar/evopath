import { z } from 'zod';

import { type AiDefinedTool, defineTool } from '../../../ai/core/tools';
import type { PlanTree, PlanWorkout } from '../../../programs/contracts/plan-tree.contract';
import { supportedBy } from '../../context/build-planner-context';
import { estimateMinutes, findSubstitutes } from '../../guardrails';
import { GUARDRAIL_LIMITS } from '../../guardrails/limits';
import { setsByMuscle, weeksOf } from '../../guardrails/tree';
import type { GuardrailContext } from '../../guardrails/types';

// =============================================================================
// The critic's read-only tools, and the server-computed tables it reviews with
// =============================================================================
//
// In-process, pure, bound to THIS run's repaired tree and guardrail context:
// the model passes keys, week numbers and claim ids, never a user id, and
// every answer is a small JSON object that names exercises by slug (never a
// uuid). The same pure helpers the guardrails use compute the answers
// (`setsByMuscle`, `estimateMinutes`, `supportedBy`, `findSubstitutes`), so
// the critic and the server agree on the numbers.
// =============================================================================

/** Tool round-trips the critic may take while investigating. */
export const CRITIC_MAX_STEPS = 4;
/** Per-tool execution timeout. */
export const CRITIC_TOOL_TIMEOUT_MS = 5_000;
/** At most this many substitutes per answer. */
export const CRITIC_MAX_SUBSTITUTES = 5;

export interface CriticToolBinding {
  tree: PlanTree;
  ctx: GuardrailContext;
}

const UNCOUNTED = GUARDRAIL_LIMITS.uncountedMuscles;
const DAY_MS = 24 * 60 * 60 * 1000;

function sortedRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Weekly hard sets per primary muscle, one row per run of identical weeks. */
export function weeklyVolumeTable(b: CriticToolBinding): Array<{ weeks: number[]; isDeload: boolean; setsByMuscle: Record<string, number> }> {
  const rows: Array<{ weeks: number[]; isDeload: boolean; setsByMuscle: Record<string, number>; sig: string }> = [];
  for (const { week } of weeksOf(b.tree)) {
    const sets = sortedRecord(setsByMuscle(b.ctx, week.workouts, UNCOUNTED));
    const sig = JSON.stringify([week.isDeload, sets]);
    const last = rows.at(-1);
    if (last && last.sig === sig) last.weeks.push(week.weekNumber);
    else rows.push({ weeks: [week.weekNumber], isDeload: week.isDeload, setsByMuscle: sets, sig });
  }
  return rows.map(({ sig: _sig, ...row }) => row);
}

/** Estimated minutes per workout, one row per distinct (name, weekday, minutes) with its weeks. */
export function durationTable(b: CriticToolBinding): Array<{ workout: string; weekday: number | null; estimatedMinutes: number; weeks: number[] }> {
  const rows = new Map<string, { workout: string; weekday: number | null; estimatedMinutes: number; weeks: number[] }>();
  for (const { week } of weeksOf(b.tree)) {
    for (const workout of week.workouts) {
      const minutes = workout.estimatedMinutes ?? estimateMinutes(workout);
      const sig = `${workout.name}|${workout.weekday}|${minutes}`;
      const row = rows.get(sig);
      if (row) row.weeks.push(week.weekNumber);
      else rows.set(sig, { workout: workout.name, weekday: workout.weekday ?? null, estimatedMinutes: minutes, weeks: [week.weekNumber] });
    }
  }
  return [...rows.values()];
}

/** Distinct exercise keys per movement pattern across the plan. */
export function patternTable(b: CriticToolBinding): Record<string, string[]> {
  const byPattern = new Map<string, Set<string>>();
  for (const { week } of weeksOf(b.tree))
    for (const workout of week.workouts)
      for (const exercise of workout.exercises) {
        const lib = b.ctx.library.get(exercise.exerciseId);
        const pattern = lib?.movementPattern ?? 'unknown';
        const set = byPattern.get(pattern) ?? new Set<string>();
        set.add(lib?.key ?? 'unknown');
        byPattern.set(pattern, set);
      }
  return Object.fromEntries([...byPattern.entries()].sort(([a], [b2]) => (a < b2 ? -1 : 1)).map(([p, keys]) => [p, [...keys].sort()]));
}

function workoutsNamed(b: CriticToolBinding, name: string): Array<{ weekNumber: number; workout: PlanWorkout }> {
  const wanted = name.trim().toLowerCase();
  const out: Array<{ weekNumber: number; workout: PlanWorkout }> = [];
  for (const { week } of weeksOf(b.tree))
    for (const workout of week.workouts) if (workout.name.trim().toLowerCase() === wanted) out.push({ weekNumber: week.weekNumber, workout });
  return out;
}

/** The critic's function tools, bound to one run. */
export function criticTools(b: CriticToolBinding): AiDefinedTool[] {
  const { ctx } = b;

  return [
    defineTool({
      name: 'get_weekly_volume',
      description: 'Weekly hard sets per primary muscle, workouts and deload flag for one program week.',
      parameters: z.object({ weekNumber: z.number().int().min(1).max(52) }),
      execute: ({ weekNumber }) => {
        const found = weeksOf(b.tree).find(({ week }) => week.weekNumber === weekNumber);
        if (!found) return { weekNumber, error: 'No such week in this plan.' };
        return {
          weekNumber,
          isDeload: found.week.isDeload,
          workouts: found.week.workouts.length,
          setsByMuscle: sortedRecord(setsByMuscle(ctx, found.week.workouts, UNCOUNTED)),
        };
      },
    }),
    defineTool({
      name: 'estimate_duration',
      description: 'Estimated minutes of a workout by its name (server duration model), with the weeks it appears in and the minutes the person has.',
      parameters: z.object({ workoutName: z.string().max(100) }),
      execute: ({ workoutName }) => {
        const found = workoutsNamed(b, workoutName);
        if (found.length === 0) return { workoutName, error: 'No workout with that name.' };
        const byMinutes = new Map<number, number[]>();
        for (const { weekNumber, workout } of found) {
          const minutes = estimateMinutes(workout);
          byMinutes.set(minutes, [...(byMinutes.get(minutes) ?? []), weekNumber]);
        }
        return {
          workoutName,
          budgetMinutes: ctx.minutesPerSession,
          estimates: [...byMinutes.entries()].map(([estimatedMinutes, weeks]) => ({ estimatedMinutes, weeks })),
        };
      },
    }),
    defineTool({
      name: 'check_equipment',
      description: "Whether each exercise (by key) exists in the library and is doable with the person's equipment.",
      parameters: z.object({ exerciseKeys: z.array(z.string().max(80)).max(20) }),
      execute: ({ exerciseKeys }) => ({
        hasGym: ctx.gym !== null,
        results: exerciseKeys.map((key) => {
          const lib = ctx.libraryByKey.get(key);
          return { key, known: lib !== undefined, supported: lib ? supportedBy(lib, ctx.gym) : false };
        }),
      }),
    }),
    defineTool({
      name: 'find_substitutes',
      description: 'Ranked substitutes for an exercise (same movement pattern and main muscle, doable with the equipment, not on the avoid list).',
      parameters: z.object({ exerciseKey: z.string().max(80) }),
      execute: ({ exerciseKey }) => {
        const lib = ctx.libraryByKey.get(exerciseKey);
        if (!lib) return { exerciseKey, error: 'Unknown exercise key.' };
        return {
          exerciseKey,
          substitutes: findSubstitutes(lib, ctx)
            .slice(0, CRITIC_MAX_SUBSTITUTES)
            .map((s) => ({ key: s.key, name: s.name, implement: s.implement, isCompound: s.isCompound })),
        };
      },
    }),
    defineTool({
      name: 'get_exercise_history',
      description: "The person's recent history with an exercise: last and best working load in kg, fewest reps last time, pain flag, days since.",
      parameters: z.object({ exerciseKey: z.string().max(80) }),
      execute: ({ exerciseKey }) => {
        const lib = ctx.libraryByKey.get(exerciseKey);
        const fact = lib ? ctx.history.get(lib.id) : undefined;
        if (!lib) return { exerciseKey, error: 'Unknown exercise key.' };
        if (!fact) return { exerciseKey, hasHistory: false };
        const last = Date.parse(`${fact.lastDate}T00:00:00.000Z`);
        return {
          exerciseKey,
          hasHistory: true,
          lastLoadKg: fact.lastLoadKg,
          lastMinReps: fact.lastMinReps,
          bestRecentLoadKg: fact.bestRecentLoadKg,
          painFlagged: fact.painFlagged,
          daysSinceLast: Number.isFinite(last) ? Math.max(0, Math.floor((ctx.now.getTime() - last) / DAY_MS)) : null,
        };
      },
    }),
    defineTool({
      name: 'get_evidence',
      description: 'One claim of the evidence brief by its id (for example "E2"), with its source ids.',
      parameters: z.object({ claimId: z.string().max(8) }),
      execute: ({ claimId }) => {
        const claim = ctx.brief?.claims.find((c) => c.id === claimId);
        if (!claim) return { claimId, error: 'No such claim in the evidence.' };
        return {
          claimId,
          topic: claim.topic,
          claim: claim.claim,
          applicability: claim.applicability,
          confidence: claim.confidence,
          sourceIds: claim.sourceIds,
        };
      },
    }),
  ];
}
