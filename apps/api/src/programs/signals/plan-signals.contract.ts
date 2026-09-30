import { z } from 'zod';

// =============================================================================
// PlanSignals: the facts about a training plan (E5.9)
// =============================================================================
//
// What was planned versus done, how often the user trained, hard sets per
// muscle, how lifts moved, how hard sessions felt, where it hurt, how
// recovered the user was and how body weight moved. The server computes these
// once, deterministically (`aggregate-signals.ts`); the evaluator reads a
// compacted copy (`compact-signals.ts`) and decides what they mean.
//
// Every number is finite or null, never NaN or Infinity. Weights are
// kilograms. Dates are the user's local calendar days (`YYYY-MM-DD`); a week
// is an ISO week keyed by its Monday. Free text a user typed (pain notes,
// check-in notes, set notes) is never part of this contract.
//
// Deliberately free of Nest and Prisma imports so the evaluator and its
// persona fixtures can share it.
// =============================================================================

/** At most this many weeks per request (`to - from + 1 <= 182` days). */
export const SIGNALS_MAX_WEEKS = 26;
/** Default range: this many ISO weeks ending with `asOf`'s week. */
export const SIGNALS_DEFAULT_WEEKS = 8;
/** At most this many set rows are read for the range; beyond it the range shrinks from the old end. */
export const SIGNALS_MAX_SET_ROWS = 25_000;
/** A completed planned session below this share of its planned sets is `partial`. */
export const PARTIAL_SESSION_RATIO = 0.6;
/** Pain looks back this many days, `asOf` included. */
export const PAIN_WINDOW_DAYS = 28;
/** Readiness looks back this many days, `asOf` included. */
export const READINESS_WINDOW_DAYS = 7;
/** Body weight trend looks back this many days (8 weeks), `asOf` included. */
export const BODY_WINDOW_DAYS = 56;
/** `asOf` must be within this many days of the server's today in the user's zone. */
export const SIGNALS_AS_OF_WINDOW_DAYS = 2;
/** The evaluator's range: this many complete weeks before the current one. */
export const EVALUATOR_COMPLETE_WEEKS = 6;

const day = z.iso.date();
const count = z.number().int().min(0);
const nullableNumber = z.number().nullable();

export const SESSION_STATUSES = ['done', 'partial', 'missed', 'upcoming', 'in_progress'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const LIFT_TRENDS = ['up', 'flat', 'down', 'insufficient'] as const;
export type LiftTrend = (typeof LIFT_TRENDS)[number];
export const RPE_TRENDS = ['rising', 'flat', 'falling', 'insufficient'] as const;
export type RpeTrend = (typeof RPE_TRENDS)[number];

const adherenceCounts = {
  planned: count.meta({ description: 'Planned sessions due: occurrence date before `asOf`, or already started or done.' }),
  completed: count.meta({ description: 'Planned sessions with a linked completed workout (partial ones included).' }),
  partialSessions: count.meta({ description: 'Completed planned sessions below 60 percent of their planned sets.' }),
  missed: count.meta({ description: 'Planned sessions before `asOf` with no linked completed or in-progress workout.' }),
  extra: count.meta({ description: 'Completed workouts in range linked to no plan.' }),
  adherencePct: nullableNumber.meta({ description: '`completed / planned` in percent (one decimal); null when nothing was planned.' }),
};

export const adherenceWeekSchema = z.object({
  weekStart: day.meta({ description: 'The Monday of the ISO week.' }),
  ...adherenceCounts,
  partial: z.boolean().meta({ description: 'The week straddles the range edge or is not over at `asOf`; excluded from averages.' }),
});

export const plannedSessionSignalSchema = z.object({
  programWorkoutId: z.uuid(),
  name: z.string(),
  plannedFor: day.meta({ description: 'The occurrence date of the planned workout.' }),
  status: z.enum(SESSION_STATUSES),
  workoutId: z.uuid().nullable().meta({ description: 'The linked workout (completed first, else in progress).' }),
  setsPlanned: count.meta({ description: 'From the session snapshot, else the current plan.' }),
  setsDone: count.meta({ description: 'Completed non-warm-up sets of the linked workout.' }),
  completionPct: nullableNumber.meta({ description: '`setsDone / setsPlanned` in percent, capped at 100; null without a workout or plan.' }),
  avgRpe: nullableNumber,
});

export const muscleVolumeSchema = z.object({
  muscle: z.string(),
  weeks: z.array(z.object({ weekStart: day, plannedSets: count, hardSets: count })),
  totalHardSets: count,
  tonnageKg: nullableNumber.meta({ description: 'Sum of weight x reps over weighted hard sets; null when none was weighted.' }),
});

export const liftPerformanceSchema = z.object({
  exerciseId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  sessions: count,
  best: z.object({
    weightKg: nullableNumber.meta({ description: 'Heaviest working set in range (then most reps); null for unweighted bodyweight sets.' }),
    reps: z.number().int().nullable(),
    e1rmKg: nullableNumber.meta({ description: 'Best Epley estimate in range (1..12 reps).' }),
  }),
  lastTopSets: z
    .array(z.object({ date: day, weightKg: z.number(), reps: z.number().int(), rpe: nullableNumber }))
    .meta({ description: 'Top set of the latest three sessions, newest first.' }),
  trend: z.enum(LIFT_TRENDS),
  trendPct: nullableNumber,
  prInRange: z.boolean().meta({ description: 'A weight, rep or e1RM PR (the workout-history definitions) inside the range.' }),
});

export const painSignalSchema = z.object({
  exerciseId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  lastFlaggedOn: day,
  flaggedSessions28d: count,
  consecutiveFlaggedSessions: count.meta({ description: 'Flagged sessions in a row, counted from the most recent session.' }),
});

const readinessAvgSchema = z.object({
  energy: nullableNumber,
  sleepQuality: nullableNumber,
  soreness: nullableNumber,
  stress: nullableNumber,
});

export const planSignalsSchema = z.object({
  range: z.object({ from: day, to: day }).meta({ description: 'The range the signals cover (after truncation).' }),
  asOf: day.meta({ description: 'The local day the signals are computed for.' }),
  programId: z.uuid().nullable().meta({ description: 'Null when the caller has no program: adherence is then empty.' }),
  planVersion: z.number().int().nullable(),
  weeksInRange: count,
  truncated: z.boolean().meta({ description: 'The set-row cap was hit and `range.from` moved forward.' }),
  planChangedOn: day
    .nullable()
    .meta({ description: 'The latest day the plan changed inside the range; earlier weeks use today\'s structure.' }),
  adherence: z.object({
    weeks: z.array(adherenceWeekSchema),
    totals: z.object(adherenceCounts),
    missedStreak: count.meta({ description: 'Planned sessions missed in a row, counted from the most recent due one.' }),
    completedStreak: count.meta({ description: 'Planned sessions completed in a row, counted from the most recent due one.' }),
  }),
  frequency: z.object({
    avgPerWeek: nullableNumber.meta({ description: 'Mean completed workouts per complete (non-partial) week.' }),
    perWeek: z.array(z.object({ weekStart: day, sessions: count })),
  }),
  sessions: z.array(plannedSessionSignalSchema),
  volume: z.array(muscleVolumeSchema),
  performance: z.array(liftPerformanceSchema),
  effort: z.object({
    avgRpe: nullableNumber,
    setsAtRpe9Plus: count,
    rpeTrend: z.enum(RPE_TRENDS),
  }),
  pain: z.array(painSignalSchema),
  readiness: z.object({
    days: count.meta({ description: 'Days with a check-in in the last 7 days.' }),
    avg: readinessAvgSchema.nullable(),
    lowDays: count,
    lowStreak: count,
  }),
  body: z.object({
    weightKg: z.object({
      latest: nullableNumber,
      changePerWeek: nullableNumber.meta({ description: 'Least-squares slope over the last 8 weeks, kg per week (3+ points).' }),
      points: count,
    }),
    bodyFatPct: z.object({ latest: nullableNumber, points: count }).nullable(),
  }),
});

export type PlanSignals = z.infer<typeof planSignalsSchema>;
export type AdherenceWeek = z.infer<typeof adherenceWeekSchema>;
export type PlannedSessionSignal = z.infer<typeof plannedSessionSignalSchema>;
export type MuscleVolume = z.infer<typeof muscleVolumeSchema>;
export type LiftPerformance = z.infer<typeof liftPerformanceSchema>;
export type PainSignal = z.infer<typeof painSignalSchema>;
