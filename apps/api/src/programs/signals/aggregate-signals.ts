import { addDays, isRealDate } from '../../check-ins/local-date';
import { classifySequence, e1rmKg, toWorkingSet, type WeightBucket } from '../../workouts/workout-records';
import { daysFrom, isoWeekday, occurrenceDate } from '../today/resolve-today';
import {
  BODY_WINDOW_DAYS,
  PAIN_WINDOW_DAYS,
  PARTIAL_SESSION_RATIO,
  READINESS_WINDOW_DAYS,
  type AdherenceWeek,
  type LiftPerformance,
  type LiftTrend,
  type MuscleVolume,
  type PainSignal,
  type PlanSignals,
  type PlannedSessionSignal,
  type RpeTrend,
  type SessionStatus,
} from './plan-signals.contract';

// =============================================================================
// aggregateSignals: the plan signals, computed from a bounded row set (E5.9)
// =============================================================================
//
// PURE: no Nest, no Prisma, no clock (`asOf` is the clock). Deterministic
// ordering: weeks ascending, muscles by name, lifts by sessions (desc) then
// name. The loader (`signals.loader.ts`) supplies the rows; persona fixtures
// can supply them directly.
//
// DEFINITIONS (the spec is their single home; this is the implementation):
//
//   Week       ISO week, keyed by its Monday. `partial` when it straddles the
//              range edge or is not over at `asOf`; partial weeks are left out
//              of `avgPerWeek`.
//   Planned    Every program workout (current structure, plus archived rows a
//              logged workout points at) whose occurrence date (E5.7's rule)
//              lies in the range. A session is DUE when its date is before
//              `asOf` or it was already started; only due sessions count as
//              planned, so today's session never lowers adherence until it
//              is done or the day is over.
//   Status     done (linked completed workout) | partial (done, below 60
//              percent of planned sets) | in_progress (linked in-progress
//              workout) | missed (before `asOf`, none of those) | upcoming.
//   Extra      Completed workouts in range linked to no plan at all.
//   Frequency  Every completed workout per week, linked or not.
//   Hard set   Completed, not a warm-up, reps >= 1 (a duration or distance for
//              time-tracked exercises), credited in full to each PRIMARY
//              muscle. Tonnage = weight x reps over weighted hard sets.
//   Lifts      Working sets as E4.4 defines them. Top set per session: the
//              heaviest (then most reps). Trend over the last up-to-4 sessions
//              with an e1RM: mean of the latest 2 against the earliest 2;
//              above +2 percent `up`, below -2 percent `down`; under 3
//              sessions `insufficient`. `prInRange`: a weight, rep or e1RM PR
//              (E4.4) earned inside the range against everything before it.
//   Effort     Completed non-warm-up sets with an RPE. `rpeTrend` compares the
//              mean of the first and second half of the per-session averages
//              (4+ sessions; above +0.5 `rising`, below -0.5 `falling`).
//   Pain       Sessions of an exercise in the last 28 days; a session is
//              flagged when any of its sets carries the pain flag.
//   Readiness  Check-in scores of the last 7 days. A LOW day has energy <= 2,
//              sleep quality <= 2, soreness >= 4 or stress >= 4. `lowStreak`
//              is the run of low days ending at `asOf` (or the day before,
//              when `asOf` has no check-in yet).
//   Body       Weight over the last 8 weeks: latest, and the least-squares
//              slope in kg per week (3+ points on 2+ days).
// =============================================================================

export interface SignalsExercise {
  id: string;
  slug: string;
  name: string;
  primaryMuscles: readonly string[];
  trackingMode: string;
}

export interface SignalsPlannedWorkout {
  programWorkoutId: string;
  name: string;
  weekNumber: number;
  /** ISO weekday; null for an unscheduled workout (never planned on a date). */
  weekday: number | null;
  position: number;
  /** Archived row (kept because a logged workout points at it). */
  archived: boolean;
  exercises: ReadonlyArray<{ exerciseId: string; targetSets: number }>;
}

export interface SignalsSet {
  weightKg: number | null;
  reps: number | null;
  durationSeconds: number | null;
  distanceMeters: number | null;
  rpe: number | null;
  isWarmup: boolean;
  completed: boolean;
}

export interface SignalsWorkout {
  id: string;
  /** The user's local day of the workout. */
  date: string;
  /** ISO instant, to order two workouts on one day. */
  startedAt: string;
  status: 'completed' | 'in_progress' | string;
  /** Linked to any plan (a `program_sessions` row or `workouts.program_workout_id`). */
  linked: boolean;
  /** The planned workout it was started from, when known. */
  programWorkoutId: string | null;
  /** Total planned sets from the session snapshot; null without a snapshot. */
  plannedSets: number | null;
  exercises: ReadonlyArray<{ exerciseId: string; sets: readonly SignalsSet[] }>;
}

export interface SignalsPainSession {
  exerciseId: string;
  workoutId: string;
  date: string;
  startedAt: string;
  flagged: boolean;
}

export interface SignalsCheckIn {
  date: string;
  energy: number | null;
  sleepQuality: number | null;
  soreness: number | null;
  stress: number | null;
}

export interface SignalsReading {
  date: string;
  value: number;
}

export interface SignalsInput {
  range: { from: string; to: string };
  asOf: string;
  program: { id: string; startDate: string | null; planVersion: number } | null;
  planned: readonly SignalsPlannedWorkout[];
  planChangedOn?: string | null;
  truncated?: boolean;
  /**
   * The user's workouts dated in the range, plus any outside it that are
   * linked to a planned workout in `planned`. Completed and in-progress only.
   */
  workouts: readonly SignalsWorkout[];
  exercises: readonly SignalsExercise[];
  /** Working-set history before `range.from`, per exercise (E4.4's buckets). */
  priorBuckets?: Readonly<Record<string, readonly WeightBucket[]>>;
  /** Sessions of the last 28 days (any status), one per workout and exercise. */
  pain: readonly SignalsPainSession[];
  checkIns: readonly SignalsCheckIn[];
  weights: readonly SignalsReading[];
  bodyFat: readonly SignalsReading[];
}

// -----------------------------------------------------------------------------
// Number helpers: finite or null, never NaN or Infinity
// -----------------------------------------------------------------------------

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function roundTo(value: number | null, decimals: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor + (value >= 0 ? 1e-9 : -1e-9)) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function mean(values: readonly number[]): number | null {
  const usable = values.filter(Number.isFinite);
  if (usable.length === 0) return null;
  return finite(usable.reduce((sum, value) => sum + value, 0) / usable.length);
}

function pct(part: number, whole: number): number | null {
  return whole > 0 ? roundTo((part / whole) * 100, 1) : null;
}

/** A plain number from possibly degenerate input (NaN, Infinity, negative counts) or null. */
function num(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : value;
}

// -----------------------------------------------------------------------------
// Calendar helpers
// -----------------------------------------------------------------------------

/** The Monday of `date`'s ISO week. */
export function weekStartOf(date: string): string {
  return addDays(date, -(isoWeekday(date) - 1));
}

/** Mondays of every ISO week touching `from..to`, ascending. */
export function weekStartsBetween(from: string, to: string): string[] {
  const weeks: string[] = [];
  if (to < from) return weeks;
  for (let monday = weekStartOf(from); monday <= to; monday = addDays(monday, 7)) weeks.push(monday);
  return weeks;
}

function byChronology(a: { date: string; startedAt: string; id?: string }, b: { date: string; startedAt: string; id?: string }): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? -1 : 1;
  return (a.id ?? '') < (b.id ?? '') ? -1 : (a.id ?? '') > (b.id ?? '') ? 1 : 0;
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// -----------------------------------------------------------------------------
// Sets
// -----------------------------------------------------------------------------

function isTimeTracked(trackingMode: string): boolean {
  return trackingMode === 'time' || trackingMode === 'distance_time';
}

/** Completed, not a warm-up, and it did something: reps >= 1, or a duration/distance when time-tracked. */
export function isHardSet(set: SignalsSet, trackingMode: string): boolean {
  if (!set.completed || set.isWarmup) return false;
  if (isTimeTracked(trackingMode)) {
    return (num(set.durationSeconds) ?? 0) > 0 || (num(set.distanceMeters) ?? 0) > 0;
  }
  return (num(set.reps) ?? 0) >= 1;
}

function isWorkingDone(set: SignalsSet): boolean {
  return set.completed && !set.isWarmup;
}

// -----------------------------------------------------------------------------
// Lift trend and RPE trend (exported for table-driven tests)
// -----------------------------------------------------------------------------

/**
 * `e1rms` in chronological order. Needs 3+ values; compares the mean of the
 * latest 2 with the mean of the earliest 2 of the last 4.
 */
export function liftTrend(e1rms: readonly number[]): { trend: LiftTrend; trendPct: number | null } {
  const values = e1rms.filter((value) => Number.isFinite(value) && value > 0);
  if (values.length < 3) return { trend: 'insufficient', trendPct: null };
  const last = values.slice(-4);
  const earliest = mean(last.slice(0, 2));
  const latest = mean(last.slice(-2));
  if (earliest === null || latest === null || earliest <= 0) return { trend: 'insufficient', trendPct: null };
  const change = ((latest - earliest) / earliest) * 100;
  const trendPct = roundTo(change, 1);
  if (trendPct === null) return { trend: 'insufficient', trendPct: null };
  return { trend: change > 2 ? 'up' : change < -2 ? 'down' : 'flat', trendPct };
}

/** Per-session RPE averages in chronological order; 4+ sessions, halves compared (odd middle dropped). */
export function rpeTrend(sessionAverages: readonly number[]): RpeTrend {
  const values = sessionAverages.filter(Number.isFinite);
  if (values.length < 4) return 'insufficient';
  const half = Math.floor(values.length / 2);
  const first = mean(values.slice(0, half));
  const second = mean(values.slice(values.length - half));
  if (first === null || second === null) return 'insufficient';
  const change = second - first;
  return change > 0.5 ? 'rising' : change < -0.5 ? 'falling' : 'flat';
}

/** Least-squares slope of `points` in value per week; null under 3 points or on a single day. */
export function slopePerWeek(points: readonly SignalsReading[]): number | null {
  const usable = points.filter((point) => Number.isFinite(point.value) && isRealDate(point.date));
  if (usable.length < 3) return null;
  const origin = usable.reduce((min, point) => (point.date < min ? point.date : min), usable[0].date);
  const xs = usable.map((point) => daysFrom(origin, point.date) / 7);
  const ys = usable.map((point) => point.value);
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < usable.length; i += 1) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) return null;
  return roundTo(sxy / sxx, 2);
}

/** A check-in day that reads as poorly recovered. */
export function isLowDay(checkIn: SignalsCheckIn): boolean {
  const low = (value: number | null) => value !== null && Number.isFinite(value) && value <= 2;
  const high = (value: number | null) => value !== null && Number.isFinite(value) && value >= 4;
  return low(checkIn.energy) || low(checkIn.sleepQuality) || high(checkIn.soreness) || high(checkIn.stress);
}

// -----------------------------------------------------------------------------
// Planned sessions
// -----------------------------------------------------------------------------

interface Occurrence {
  planned: SignalsPlannedWorkout;
  date: string;
}

/**
 * The planned occurrences in range. An archived workout counts only when a
 * logged workout points at it; it then replaces a live workout of the same
 * plan week and weekday (the row that superseded it), so a rewritten past day
 * is not planned twice.
 */
export function occurrencesInRange(input: Pick<SignalsInput, 'program' | 'planned' | 'range'>, linkedIds: ReadonlySet<string>): Occurrence[] {
  const startDate = input.program?.startDate;
  if (!startDate || !isRealDate(startDate)) return [];

  const kept = input.planned.filter((row) => !row.archived || linkedIds.has(row.programWorkoutId));
  const replaced = new Set(
    kept.filter((row) => row.archived && row.weekday !== null).map((row) => `${row.weekNumber}:${row.weekday}`),
  );
  const result: Occurrence[] = [];
  for (const planned of kept) {
    if (planned.weekday === null || planned.weekday < 1 || planned.weekday > 7 || !(planned.weekNumber >= 1)) continue;
    if (!planned.archived && replaced.has(`${planned.weekNumber}:${planned.weekday}`)) continue;
    const date = occurrenceDate(startDate, planned.weekNumber, planned.weekday);
    if (date < input.range.from || date > input.range.to) continue;
    result.push({ planned, date });
  }
  return result.sort((a, b) =>
    a.date !== b.date
      ? byName(a.date, b.date)
      : a.planned.position - b.planned.position || byName(a.planned.programWorkoutId, b.planned.programWorkoutId),
  );
}

function plannedSetsOf(planned: SignalsPlannedWorkout): number {
  return planned.exercises.reduce((sum, exercise) => sum + Math.max(0, num(exercise.targetSets) ?? 0), 0);
}

function sessionRpe(workout: SignalsWorkout): number | null {
  const values = workout.exercises.flatMap((entry) =>
    entry.sets.filter((set) => isWorkingDone(set) && num(set.rpe) !== null).map((set) => set.rpe as number),
  );
  return roundTo(mean(values), 2);
}

// -----------------------------------------------------------------------------
// The aggregator
// -----------------------------------------------------------------------------

export function aggregateSignals(input: SignalsInput): PlanSignals {
  const { range, asOf } = input;
  if (!isRealDate(range.from) || !isRealDate(range.to) || !isRealDate(asOf)) {
    throw new RangeError('range and asOf must be real calendar dates in YYYY-MM-DD format');
  }

  const exercises = new Map(input.exercises.map((exercise) => [exercise.id, exercise]));
  const inRange = (date: string) => date >= range.from && date <= range.to;
  const weekStarts = weekStartsBetween(range.from, range.to);
  const isPartialWeek = (weekStart: string) =>
    weekStart < range.from || addDays(weekStart, 6) > range.to || addDays(weekStart, 6) >= asOf;

  const workouts = [...input.workouts]
    .filter((workout) => isRealDate(workout.date))
    .sort((a, b) => byChronology(a, b));
  const completedInRange = workouts.filter((workout) => workout.status === 'completed' && inRange(workout.date));

  // --- Adherence --------------------------------------------------------------
  const linkedByPlanned = new Map<string, SignalsWorkout[]>();
  if (input.program) {
    for (const workout of workouts) {
      if (!workout.programWorkoutId) continue;
      const list = linkedByPlanned.get(workout.programWorkoutId) ?? [];
      list.push(workout);
      linkedByPlanned.set(workout.programWorkoutId, list);
    }
  }
  const occurrences = occurrencesInRange(input, new Set(linkedByPlanned.keys()));

  const sessions: PlannedSessionSignal[] = occurrences.map(({ planned, date }) => {
    const linked = linkedByPlanned.get(planned.programWorkoutId) ?? [];
    const completed = linked.filter((workout) => workout.status === 'completed');
    const inProgress = linked.find((workout) => workout.status === 'in_progress') ?? null;
    const workout = completed.length > 0 ? completed[completed.length - 1] : inProgress;

    const setsPlanned = Math.max(0, Math.round(num(workout?.plannedSets) ?? plannedSetsOf(planned)));
    const setsDone = workout
      ? workout.exercises.reduce((sum, entry) => sum + entry.sets.filter(isWorkingDone).length, 0)
      : 0;
    const ratio = setsPlanned > 0 ? setsDone / setsPlanned : null;

    let status: SessionStatus;
    if (completed.length > 0) status = ratio !== null && ratio < PARTIAL_SESSION_RATIO ? 'partial' : 'done';
    else if (inProgress) status = 'in_progress';
    else status = date < asOf ? 'missed' : 'upcoming';

    return {
      programWorkoutId: planned.programWorkoutId,
      name: planned.name,
      plannedFor: date,
      status,
      workoutId: workout?.id ?? null,
      setsPlanned,
      setsDone,
      completionPct: workout && ratio !== null ? roundTo(Math.min(100, ratio * 100), 1) : null,
      avgRpe: workout ? sessionRpe(workout) : null,
    };
  });

  const extraWorkouts = completedInRange.filter((workout) => !workout.linked);

  const weekOf = new Map<string, AdherenceWeek>(
    weekStarts.map((weekStart) => [
      weekStart,
      {
        weekStart,
        planned: 0,
        completed: 0,
        partialSessions: 0,
        missed: 0,
        extra: 0,
        adherencePct: null,
        partial: isPartialWeek(weekStart),
      },
    ]),
  );
  const totals = { planned: 0, completed: 0, partialSessions: 0, missed: 0, extra: 0, adherencePct: null as number | null };
  for (const session of sessions) {
    const week = weekOf.get(weekStartOf(session.plannedFor));
    const due = session.status !== 'upcoming';
    for (const bucket of week ? [week, totals] : [totals]) {
      if (due) bucket.planned += 1;
      if (session.status === 'done' || session.status === 'partial') bucket.completed += 1;
      if (session.status === 'partial') bucket.partialSessions += 1;
      if (session.status === 'missed') bucket.missed += 1;
    }
  }
  for (const workout of extraWorkouts) {
    const week = weekOf.get(weekStartOf(workout.date));
    if (week) week.extra += 1;
    totals.extra += 1;
  }
  for (const week of weekOf.values()) week.adherencePct = pct(week.completed, week.planned);
  totals.adherencePct = pct(totals.completed, totals.planned);

  const due = sessions.filter((session) => session.status !== 'upcoming').reverse();
  let missedStreak = 0;
  for (const session of due) {
    if (session.status !== 'missed') break;
    missedStreak += 1;
  }
  let completedStreak = 0;
  for (const session of due) {
    if (session.status !== 'done' && session.status !== 'partial') break;
    completedStreak += 1;
  }

  // --- Frequency --------------------------------------------------------------
  const sessionsPerWeek = new Map(weekStarts.map((weekStart) => [weekStart, 0]));
  for (const workout of completedInRange) {
    const key = weekStartOf(workout.date);
    sessionsPerWeek.set(key, (sessionsPerWeek.get(key) ?? 0) + 1);
  }
  const fullWeeks = weekStarts.filter((weekStart) => !isPartialWeek(weekStart));
  const avgPerWeek = roundTo(mean(fullWeeks.map((weekStart) => sessionsPerWeek.get(weekStart) ?? 0)), 2);

  // --- Volume -----------------------------------------------------------------
  interface MuscleAcc {
    planned: Map<string, number>;
    hard: Map<string, number>;
    total: number;
    tonnage: number;
    weighted: boolean;
  }
  const muscles = new Map<string, MuscleAcc>();
  const muscle = (name: string): MuscleAcc => {
    let acc = muscles.get(name);
    if (!acc) {
      acc = { planned: new Map(), hard: new Map(), total: 0, tonnage: 0, weighted: false };
      muscles.set(name, acc);
    }
    return acc;
  };
  for (const { planned, date } of occurrences) {
    const week = weekStartOf(date);
    for (const entry of planned.exercises) {
      const exercise = exercises.get(entry.exerciseId);
      if (!exercise) continue;
      const sets = Math.max(0, Math.round(num(entry.targetSets) ?? 0));
      for (const name of new Set(exercise.primaryMuscles)) {
        const acc = muscle(name);
        acc.planned.set(week, (acc.planned.get(week) ?? 0) + sets);
      }
    }
  }
  for (const workout of completedInRange) {
    const week = weekStartOf(workout.date);
    for (const entry of workout.exercises) {
      const exercise = exercises.get(entry.exerciseId);
      if (!exercise) continue;
      const hard = entry.sets.filter((set) => isHardSet(set, exercise.trackingMode));
      if (hard.length === 0) continue;
      let tonnage = 0;
      let weighted = false;
      if (!isTimeTracked(exercise.trackingMode)) {
        for (const set of hard) {
          const weight = num(set.weightKg);
          const reps = num(set.reps);
          if (weight !== null && weight > 0 && reps !== null && reps >= 1) {
            tonnage += weight * reps;
            weighted = true;
          }
        }
      }
      for (const name of new Set(exercise.primaryMuscles)) {
        const acc = muscle(name);
        acc.hard.set(week, (acc.hard.get(week) ?? 0) + hard.length);
        acc.total += hard.length;
        acc.tonnage += tonnage;
        acc.weighted ||= weighted;
      }
    }
  }
  const volume: MuscleVolume[] = [...muscles.entries()]
    .sort(([a], [b]) => byName(a, b))
    .map(([name, acc]) => ({
      muscle: name,
      weeks: weekStarts.map((weekStart) => ({
        weekStart,
        plannedSets: acc.planned.get(weekStart) ?? 0,
        hardSets: acc.hard.get(weekStart) ?? 0,
      })),
      totalHardSets: acc.total,
      tonnageKg: acc.weighted ? roundTo(acc.tonnage, 1) : null,
    }));

  // --- Performance ------------------------------------------------------------
  interface LiftSession {
    date: string;
    top: { weightKg: number; reps: number; rpe: number | null };
    e1rm: number | null;
  }
  const lifts = new Map<string, { sessions: LiftSession[]; pr: boolean }>();
  const liftOrder = [...new Set(completedInRange.flatMap((workout) => workout.exercises.map((entry) => entry.exerciseId)))];
  for (const exerciseId of liftOrder) {
    const exercise = exercises.get(exerciseId);
    if (!exercise) continue;
    const liftSessions: LiftSession[] = [];
    const sequence: Array<{ key: number; set: { weightKg: number | null; reps: number | null; completed: boolean; isWarmup: boolean } }> = [];
    let key = 0;
    for (const workout of completedInRange) {
      let top: LiftSession['top'] | null = null;
      let best: number | null = null;
      for (const entry of workout.exercises) {
        if (entry.exerciseId !== exerciseId) continue;
        for (const set of entry.sets) {
          const clean = { weightKg: num(set.weightKg), reps: num(set.reps), completed: set.completed, isWarmup: set.isWarmup };
          sequence.push({ key: key++, set: clean });
          const working = toWorkingSet(clean, exercise.trackingMode);
          if (!working) continue;
          if (!top || working.weightKg > top.weightKg || (working.weightKg === top.weightKg && working.reps > top.reps)) {
            top = { weightKg: working.weightKg, reps: working.reps, rpe: num(set.rpe) };
          }
          const estimate = e1rmKg(working.weightKg, working.reps);
          if (estimate !== null && (best === null || estimate > best)) best = estimate;
        }
      }
      if (top) liftSessions.push({ date: workout.date, top, e1rm: best });
    }
    if (liftSessions.length === 0) continue;
    const classified = classifySequence(sequence, exercise.trackingMode, input.priorBuckets?.[exerciseId] ?? []);
    const pr = [...classified.values()].some((prs) => prs.some((earned) => earned.type !== 'first_time'));
    lifts.set(exerciseId, { sessions: liftSessions, pr });
  }
  const performance: LiftPerformance[] = [...lifts.entries()]
    .map(([exerciseId, lift]): LiftPerformance => {
      const exercise = exercises.get(exerciseId)!;
      let bestTop = lift.sessions[0].top;
      let bestE1rm: number | null = null;
      for (const session of lift.sessions) {
        if (session.top.weightKg > bestTop.weightKg || (session.top.weightKg === bestTop.weightKg && session.top.reps > bestTop.reps)) {
          bestTop = session.top;
        }
        if (session.e1rm !== null && (bestE1rm === null || session.e1rm > bestE1rm)) bestE1rm = session.e1rm;
      }
      const unweighted = bestTop.weightKg === 0;
      return {
        exerciseId,
        slug: exercise.slug,
        name: exercise.name,
        sessions: lift.sessions.length,
        best: { weightKg: unweighted ? null : bestTop.weightKg, reps: bestTop.reps, e1rmKg: bestE1rm },
        lastTopSets: lift.sessions
          .slice(-3)
          .reverse()
          .map((session) => ({ date: session.date, weightKg: session.top.weightKg, reps: session.top.reps, rpe: session.top.rpe })),
        ...liftTrend(lift.sessions.map((session) => session.e1rm).filter((value): value is number => value !== null)),
        prInRange: lift.pr,
      };
    })
    .sort((a, b) => b.sessions - a.sessions || byName(a.name, b.name) || byName(a.exerciseId, b.exerciseId));

  // --- Effort -----------------------------------------------------------------
  const rpes: number[] = [];
  const sessionAverages: number[] = [];
  for (const workout of completedInRange) {
    const values = workout.exercises.flatMap((entry) =>
      entry.sets.filter((set) => isWorkingDone(set) && num(set.rpe) !== null).map((set) => set.rpe as number),
    );
    rpes.push(...values);
    const average = mean(values);
    if (average !== null) sessionAverages.push(average);
  }
  const effort = {
    avgRpe: roundTo(mean(rpes), 2),
    setsAtRpe9Plus: rpes.filter((value) => value >= 9).length,
    rpeTrend: rpeTrend(sessionAverages),
  };

  // --- Pain -------------------------------------------------------------------
  const painFrom = addDays(asOf, -(PAIN_WINDOW_DAYS - 1));
  const painByExercise = new Map<string, SignalsPainSession[]>();
  for (const session of input.pain) {
    if (!isRealDate(session.date) || session.date < painFrom || session.date > asOf) continue;
    const list = painByExercise.get(session.exerciseId) ?? [];
    list.push(session);
    painByExercise.set(session.exerciseId, list);
  }
  const pain: PainSignal[] = [];
  for (const [exerciseId, list] of painByExercise) {
    const exercise = exercises.get(exerciseId);
    if (!exercise) continue;
    // One session per workout: a workout that lists the exercise twice is flagged if either entry is.
    const perWorkout = new Map<string, SignalsPainSession>();
    for (const session of list) {
      const current = perWorkout.get(session.workoutId);
      perWorkout.set(session.workoutId, current ? { ...current, flagged: current.flagged || session.flagged } : session);
    }
    const newestFirst = [...perWorkout.values()].sort((a, b) => byChronology(b, a));
    const flagged = newestFirst.filter((session) => session.flagged);
    if (flagged.length === 0) continue;
    let consecutive = 0;
    for (const session of newestFirst) {
      if (!session.flagged) break;
      consecutive += 1;
    }
    pain.push({
      exerciseId,
      slug: exercise.slug,
      name: exercise.name,
      lastFlaggedOn: flagged[0].date,
      flaggedSessions28d: flagged.length,
      consecutiveFlaggedSessions: consecutive,
    });
  }
  pain.sort((a, b) => byName(b.lastFlaggedOn, a.lastFlaggedOn) || byName(a.name, b.name) || byName(a.exerciseId, b.exerciseId));

  // --- Readiness --------------------------------------------------------------
  const readinessFrom = addDays(asOf, -(READINESS_WINDOW_DAYS - 1));
  const checkInByDate = new Map<string, SignalsCheckIn>();
  for (const checkIn of input.checkIns) {
    if (!isRealDate(checkIn.date) || checkIn.date < readinessFrom || checkIn.date > asOf) continue;
    checkInByDate.set(checkIn.date, checkIn);
  }
  const checkIns = [...checkInByDate.values()];
  const avgOf = (pick: (checkIn: SignalsCheckIn) => number | null) =>
    roundTo(mean(checkIns.map(pick).filter((value): value is number => num(value) !== null)), 2);
  let lowStreak = 0;
  for (let date = checkInByDate.has(asOf) ? asOf : addDays(asOf, -1); date >= readinessFrom; date = addDays(date, -1)) {
    const checkIn = checkInByDate.get(date);
    if (!checkIn || !isLowDay(checkIn)) break;
    lowStreak += 1;
  }
  const readiness = {
    days: checkIns.length,
    avg:
      checkIns.length === 0
        ? null
        : {
            energy: avgOf((checkIn) => checkIn.energy),
            sleepQuality: avgOf((checkIn) => checkIn.sleepQuality),
            soreness: avgOf((checkIn) => checkIn.soreness),
            stress: avgOf((checkIn) => checkIn.stress),
          },
    lowDays: checkIns.filter(isLowDay).length,
    lowStreak,
  };

  // --- Body -------------------------------------------------------------------
  const bodyFrom = addDays(asOf, -(BODY_WINDOW_DAYS - 1));
  const window = (points: readonly SignalsReading[]) =>
    points
      .filter((point) => isRealDate(point.date) && point.date >= bodyFrom && point.date <= asOf && Number.isFinite(point.value))
      .sort((a, b) => byName(a.date, b.date));
  const weights = window(input.weights);
  const bodyFat = window(input.bodyFat);
  const body = {
    weightKg: {
      latest: weights.length ? roundTo(weights[weights.length - 1].value, 2) : null,
      changePerWeek: slopePerWeek(weights),
      points: weights.length,
    },
    bodyFatPct: bodyFat.length ? { latest: roundTo(bodyFat[bodyFat.length - 1].value, 1), points: bodyFat.length } : null,
  };

  const planChangedOn =
    input.planChangedOn && isRealDate(input.planChangedOn) && inRange(input.planChangedOn) ? input.planChangedOn : null;

  return {
    range: { from: range.from, to: range.to },
    asOf,
    programId: input.program?.id ?? null,
    planVersion: input.program?.planVersion ?? null,
    weeksInRange: weekStarts.length,
    truncated: input.truncated ?? false,
    planChangedOn,
    adherence: { weeks: [...weekOf.values()], totals, missedStreak, completedStreak },
    frequency: {
      avgPerWeek,
      perWeek: weekStarts.map((weekStart) => ({ weekStart, sessions: sessionsPerWeek.get(weekStart) ?? 0 })),
    },
    sessions,
    volume,
    performance,
    effort,
    pain,
    readiness,
    body,
  };
}

/** An empty signal set for a caller without a program or data (the zeroed structures). */
export function emptySignals(range: { from: string; to: string }, asOf: string): PlanSignals {
  return aggregateSignals({
    range,
    asOf,
    program: null,
    planned: [],
    workouts: [],
    exercises: [],
    pain: [],
    checkIns: [],
    weights: [],
    bodyFat: [],
  });
}
