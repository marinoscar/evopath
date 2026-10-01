import { PLAN_LIMITS, isRepsExercise, type PlanExercise, type PlanTree, type PlanWeek, type PlanWorkout } from '../../programs/contracts/plan-tree.contract';
import type { LibraryExercise } from '../context/planner-context.contract';
import type { TrainingCardio } from '../contracts/training-intake.contract';
import { CARDIO_LIMITS, DURATION_MODEL } from './limits';
import { Findings, WEEKDAY_NAMES, slotsOf, sortWeek, weeksOf, workoutLabel } from './tree';
import type { GuardrailContext, Violation } from './types';

// =============================================================================
// Cardio sessions (#265): part of G4, run before G3 times the workouts
// =============================================================================
//
// Applies only when the intake asks for cardio (`cardio.include`):
//
// - The plan must prescribe cardio somewhere: a cardio-pattern exercise with
//   a duration or distance. None blocks (`cardio_missing`), so the planner
//   revises; the server does not invent sessions.
// - Cardio belongs on a day without a strength workout. A cardio exercise
//   inside a strength workout moves to a new cardio-only workout on a free
//   weekday (`cardio_moved_to_free_day`); when every weekday is taken it
//   stays (doubling up is then the only way to fit it).
// - When the intake gives both `daysPerWeek` and `minutesPerSession`, a
//   week's cardio minutes may reach their product times 1.25. Above that,
//   every cardio target of the week is scaled down to fit
//   (`cardio_minutes_bounded`).
// - Weekly cardio minutes rising more than 20 percent over the previous
//   non-deload week warn (`cardio_minutes_jump`): walks should grow by about
//   10 percent a week.
//
// Cardio-only workouts do not count against the strength `daysPerWeek` (G4)
// or the preferred weekdays, and are timed against the cardio session length
// (G3); see `isCardioOnlyWorkout`.
// =============================================================================

/** A cardio prescription of a cardio-pattern exercise (a timed plank is not cardio). */
export function isCardioSlot(lib: LibraryExercise | undefined, exercise: PlanExercise): boolean {
  return lib?.movementPattern === 'cardio' && !isRepsExercise(exercise);
}

/** Seconds of cardio work a prescription asks for: its duration, else its distance at the duration model's pace. */
export function cardioSeconds(exercise: Pick<PlanExercise, 'targetDurationSeconds' | 'targetDistanceMeters'>): number {
  if (exercise.targetDurationSeconds !== null) return exercise.targetDurationSeconds;
  return Math.round((exercise.targetDistanceMeters ?? 0) * DURATION_MODEL.cardioSecondsPerMeter);
}

/** The intake asks for cardio sessions. */
export function cardioRequested(ctx: Pick<GuardrailContext, 'cardio'>): boolean {
  return ctx.cardio?.include === true;
}

/** A workout made only of cardio prescriptions. */
export function isCardioOnlyWorkout(ctx: Pick<GuardrailContext, 'library'>, workout: Pick<PlanWorkout, 'exercises'>): boolean {
  return workout.exercises.length > 0 && workout.exercises.every((e) => isCardioSlot(ctx.library.get(e.exerciseId), e));
}

/** A workout that does not count as a strength day: cardio-only, while the intake asks for cardio. */
export function isExtraCardioWorkout(ctx: Pick<GuardrailContext, 'library' | 'cardio'>, workout: Pick<PlanWorkout, 'exercises'>): boolean {
  return cardioRequested(ctx) && isCardioOnlyWorkout(ctx, workout);
}

/** The most weekly cardio minutes the intake allows, or `null` when it gives no budget. */
export function weeklyCardioCapMinutes(cardio: TrainingCardio | null | undefined): number | null {
  if (!cardio?.include || cardio.daysPerWeek === undefined || cardio.minutesPerSession === undefined) return null;
  return Math.floor(cardio.daysPerWeek * cardio.minutesPerSession * CARDIO_LIMITS.weeklyCapFactor);
}

/** Weekly cardio minutes of a week (rounded to one decimal). */
export function weekCardioMinutes(ctx: Pick<GuardrailContext, 'library'>, week: PlanWeek): number {
  const seconds = week.workouts
    .flatMap((w) => w.exercises)
    .filter((e) => isCardioSlot(ctx.library.get(e.exerciseId), e))
    .reduce((sum, e) => sum + cardioSeconds(e), 0);
  return Math.round((seconds / 60) * 10) / 10;
}

const ACTIVITY_WORDS: Record<TrainingCardio['activity'], string> = { walk: 'walking', run: 'running', any: 'walking or running' };

export function checkCardio(tree: PlanTree, ctx: GuardrailContext): Violation[] {
  const f = new Findings('G4');
  const cardio = ctx.cardio;
  if (!cardio?.include) return f.list;

  if (!slotsOf(tree).some(({ exercise }) => isCardioSlot(ctx.library.get(exercise.exerciseId), exercise))) {
    f.add(
      'block',
      'cardio_missing',
      'plan',
      `You asked for ${ACTIVITY_WORDS[cardio.activity]} sessions, but the plan has none: add cardio sessions with a duration on days without a strength workout.`,
    );
    return f.list;
  }

  for (const { week } of weeksOf(tree)) moveCardioToFreeDays(f, ctx, week);

  const cap = weeklyCardioCapMinutes(cardio);
  if (cap !== null) for (const { week } of weeksOf(tree)) boundWeeklyMinutes(f, ctx, week, cap, cardio);

  let previous: number | null = null;
  for (const { week } of weeksOf(tree)) {
    if (week.isDeload) continue;
    const minutes = weekCardioMinutes(ctx, week);
    if (previous !== null && previous > 0 && minutes > previous * (1 + CARDIO_LIMITS.weeklyJumpWarnFraction) + 1e-9) {
      f.add(
        'warn',
        'cardio_minutes_jump',
        `week ${week.weekNumber}`,
        `Weekly cardio rises from about ${Math.round(previous)} to ${Math.round(minutes)} minutes; about ${Math.round(CARDIO_LIMITS.weeklyGrowthFraction * 100)}% a week is easier to recover from.`,
      );
    }
    previous = minutes;
  }

  return f.list;
}

/** Cardio inside a strength workout moves to a new cardio-only workout on a free weekday, while one is free. */
function moveCardioToFreeDays(f: Findings, ctx: GuardrailContext, week: PlanWeek): void {
  let moved = false;
  for (const workout of [...week.workouts]) {
    if (isCardioOnlyWorkout(ctx, workout)) continue;
    const cardio = workout.exercises.filter((e) => isCardioSlot(ctx.library.get(e.exerciseId), e));
    if (cardio.length === 0) continue;

    const used = new Set(week.workouts.map((w) => w.weekday).filter((d): d is number => d != null));
    const free = [1, 2, 3, 4, 5, 6, 7].find((day) => !used.has(day));
    if (free === undefined) return;

    workout.exercises = workout.exercises.filter((e) => !cardio.includes(e));
    workout.exercises.forEach((e, i) => {
      e.position = i;
    });
    cardio.forEach((e, i) => {
      e.position = i;
    });
    week.workouts.push({ position: week.workouts.length, weekday: free, name: 'Cardio', estimatedMinutes: null, rationale: null, exercises: cardio });
    moved = true;
    f.add(
      'repair',
      'cardio_moved_to_free_day',
      `week ${week.weekNumber}`,
      `Moved ${cardio.map((e) => ctx.library.get(e.exerciseId)?.key ?? 'cardio').join(', ')} from the ${workoutLabel(workout)} to ${WEEKDAY_NAMES[free]}, a day without a strength workout.`,
    );
  }
  if (moved) sortWeek(week);
}

/** Scales every cardio target of the week down so its minutes fit `cap`. */
function boundWeeklyMinutes(f: Findings, ctx: GuardrailContext, week: PlanWeek, cap: number, cardio: TrainingCardio): void {
  const before = weekCardioMinutes(ctx, week);
  if (before <= cap) return;

  const factor = cap / before;
  const d = PLAN_LIMITS.targetDurationSeconds;
  const m = PLAN_LIMITS.targetDistanceMeters;
  for (const workout of week.workouts) {
    for (const exercise of workout.exercises) {
      if (!isCardioSlot(ctx.library.get(exercise.exerciseId), exercise)) continue;
      if (exercise.targetDurationSeconds !== null) {
        exercise.targetDurationSeconds = Math.max(d.min, Math.floor((exercise.targetDurationSeconds * factor) / 60) * 60);
      }
      if (exercise.targetDistanceMeters !== null) {
        exercise.targetDistanceMeters = Math.max(m.min, Math.floor(exercise.targetDistanceMeters * factor));
      }
    }
  }

  f.add(
    'repair',
    'cardio_minutes_bounded',
    `week ${week.weekNumber}`,
    `Weekly cardio of about ${Math.round(before)} minutes lowered to ${Math.round(weekCardioMinutes(ctx, week))}: you asked for ${cardio.daysPerWeek} sessions of ${cardio.minutesPerSession} minutes (at most ${cap} minutes a week).`,
  );
}
