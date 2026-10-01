import { isCardioTrackingMode } from '../../programs/contracts/prescription';
import type { PlanDraft, PlanDraftExercise, PlanDraftWorkout } from '../agents/planner/plan-draft.contract';
import { LIB } from './context-fixtures';

// =============================================================================
// Planner drafts for compiler, guardrail and planner-node specs, over the
// fixture library (`context-fixtures.ts`).
// =============================================================================

/** Time and distance exercises default to a cardio prescription (3 x 40 s), everything else to 3 x 8-12. */
export function draftExercise(exerciseKey: string, over: Partial<PlanDraftExercise> = {}): PlanDraftExercise {
  const cardio = LIB[exerciseKey] !== undefined && isCardioTrackingMode(LIB[exerciseKey].trackingMode);
  return {
    exerciseKey,
    isPriority: false,
    sets: 3,
    repMin: cardio ? null : 8,
    repMax: cardio ? null : 12,
    targetDurationSeconds: cardio ? 120 : null,
    targetDistanceMeters: null,
    targetRpe: 7,
    restSeconds: 90,
    loadGuidance: 'choose_start',
    targetLoadKg: null,
    rationale: 'Fits the goal.',
    evidenceRefs: ['E1'],
    ...over,
  };
}

export function draftWorkout(name: string, weekday: number, exercises: PlanDraftExercise[]): PlanDraftWorkout {
  return { name, weekday, rationale: `${name} day.`, exercises };
}

/** Week type A: three full-gym sessions (Mon, Wed, Fri). */
export function weekTypeA(): PlanDraft['blocks'][number]['weekTypes'][number] {
  return {
    key: 'A',
    isDeload: false,
    workouts: [
      draftWorkout('Lower', 1, [
        draftExercise('barbell_back_squat', { isPriority: true, repMin: 5, repMax: 8, restSeconds: 150 }),
        draftExercise('romanian_deadlift', { repMin: 8, repMax: 10 }),
        draftExercise('leg_press', { sets: 2 }),
      ]),
      draftWorkout('Upper', 3, [
        draftExercise('barbell_bench_press', { isPriority: true, repMin: 5, repMax: 8, restSeconds: 150 }),
        draftExercise('barbell_row', { repMin: 8, repMax: 10 }),
        draftExercise('dumbbell_shoulder_press', { sets: 2 }),
      ]),
      draftWorkout('Full', 5, [
        draftExercise('goblet_squat'),
        draftExercise('dumbbell_bench_press'),
        draftExercise('lat_pulldown', { evidenceRefs: ['E2'] }),
      ]),
    ],
  };
}

/** An 8-week draft: Base (weeks 1-5, type A) and Peak (weeks 6-8: deload, then A twice). */
export function draftFixture(over: Partial<PlanDraft> = {}): PlanDraft {
  const deload = { ...weekTypeA(), key: 'D', isDeload: true };
  deload.workouts = deload.workouts.map((w) => ({ ...w, exercises: w.exercises.map((e) => ({ ...e, sets: 2, targetRpe: 5 })) }));

  return {
    title: 'Eight-week strength base',
    summary: 'Three full-gym sessions a week with a deload in week 6.',
    rationale: 'Built around the main lifts with moderate volume (E1, E2).',
    totalWeeks: 8,
    daysPerWeek: 3,
    blocks: [
      {
        name: 'Base',
        focus: 'Technique and volume',
        rationale: 'Build a base.',
        weekStart: 1,
        weekEnd: 5,
        weekSequence: ['A', 'A', 'A', 'A', 'A'],
        weekTypes: [weekTypeA()],
      },
      {
        name: 'Peak',
        focus: 'Recover, then consolidate',
        rationale: 'Deload, then two harder weeks.',
        weekStart: 6,
        weekEnd: 8,
        weekSequence: ['D', 'A', 'A'],
        weekTypes: [deload, weekTypeA()],
      },
    ],
    assumptions: ['You can train three days a week.'],
    safetyNotes: ['Stop a set if you feel sharp pain.'],
    ...over,
  };
}

/** A one-block draft of `weeks` weeks of one week type. */
export function singleTypeDraft(weekType: PlanDraft['blocks'][number]['weekTypes'][number], weeks = 4): PlanDraft {
  return draftFixture({
    totalWeeks: weeks,
    blocks: [
      {
        name: 'Block',
        focus: 'Focus',
        rationale: 'Why.',
        weekStart: 1,
        weekEnd: weeks,
        weekSequence: Array.from({ length: weeks }, () => weekType.key),
        weekTypes: [weekType],
      },
    ],
  });
}
