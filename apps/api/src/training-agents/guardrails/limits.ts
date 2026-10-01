import type { TrainingExperience } from '../contracts/training-intake.contract';

// =============================================================================
// Guardrail limits: the numbers the server enforces on every AI plan
// =============================================================================
//
// One file so a fork can tune them. These are conservative ranges for a
// general adult population, NOT medical advice and not individual
// prescriptions. The guardrails validate and repair a model's plan against
// them; the prompts ask for the same behaviour separately.
// =============================================================================

export interface LevelLimits {
  /** Weekly hard sets per primary muscle: below `min` (goal muscles) warns, above `max` is clamped. */
  weeklySetsPerMuscle: { min: number; max: number };
  /** Sets in one session: above `repairAbove` is trimmed; still above `blockAbove` after repair blocks. */
  sessionSets: { repairAbove: number; blockAbove: number };
  rpeCap: number;
}

/** G4 level table. */
export const LEVEL_LIMITS: Readonly<Record<TrainingExperience, LevelLimits>> = {
  beginner: { weeklySetsPerMuscle: { min: 4, max: 12 }, sessionSets: { repairAbove: 20, blockAbove: 30 }, rpeCap: 8 },
  intermediate: { weeklySetsPerMuscle: { min: 8, max: 18 }, sessionSets: { repairAbove: 26, blockAbove: 36 }, rpeCap: 9 },
  advanced: { weeklySetsPerMuscle: { min: 10, max: 22 }, sessionSets: { repairAbove: 30, blockAbove: 40 }, rpeCap: 9 },
};

export const GUARDRAIL_LIMITS = {
  /** A muscle above this many weekly sets after repair blocks the plan. */
  weeklyMuscleBlockAbove: 25,
  setsPerExercise: 6,
  reps: { min: 1, max: 30 },
  restSeconds: { min: 30, max: 300 },
  rpe: { min: 1, max: 10, step: 0.5 },
  /** Conservative mode (G0 / G6): upper bounds times `factor`, RPE cap, sets per exercise and per session. */
  conservative: { factor: 0.75, rpeCap: 7, setsPerExercise: 4, sessionSets: 22 },
  /** G3: a workout may run this much over the minutes the user has. */
  timeTolerance: 1.05,
  /** G5: plans this long or longer need a deload at least every `deloadEveryWeeks` weeks. */
  deloadMinPlanWeeks: 6,
  deloadEveryWeeks: 6,
  /** G5: this many sets of one primary muscle on two consecutive days is a conflict. */
  consecutiveDayHardSets: 6,
  /** Muscles the plan must reach the weekly minimum for (warn only), per goal. */
  goalMuscles: {
    strength: ['chest', 'lats', 'quads', 'hamstrings', 'shoulders'],
    hypertrophy: ['chest', 'lats', 'quads', 'hamstrings', 'shoulders'],
    general: ['chest', 'quads'],
    fat_loss: [],
    endurance: [],
    custom: [],
  } as Record<string, string[]>,
  /** Muscles that are not counted for volume (cardio and whole-body work). */
  uncountedMuscles: ['full_body'],
  /** G1: a workout left with fewer exercises than this after drops blocks. */
  minExercisesAfterDrops: 2,
} as const;

/** G3 duration model and trim ladder. */
export const DURATION_MODEL = {
  warmupMinutes: 5,
  setupSeconds: 60,
  secondsPerRep: 3,
  setWorkSeconds: { min: 20, max: 60 },
  /** A cardio prescription with a distance and no duration: about 8 min/km. */
  cardioSecondsPerMeter: 0.48,
  /** Used when a rest is 0 (unset). */
  defaultRestSeconds: { priority: 90, accessory: 60 },
  trim: { accessoryRestSeconds: 45, priorityRestSeconds: 75, setFloor: 2 },
} as const;

/** G7 progression bounds (validators; the evaluator sets loads). */
export const PROGRESSION_LIMITS = {
  /** Largest load increase between exposures, kg, by implement; `isolation` wins for isolation patterns. */
  stepKg: { barbell: 2.5, dumbbell: 2, machine: 2, cable: 2, band: 0, bodyweight: 0, isolation: 1 },
  /** And never more than this fraction of the last load. */
  maxIncreaseFraction: 0.1,
  roundKg: 0.5,
  /** P5: after a gap longer than this, at most `gapFactor` of the last load. */
  gapDays: 14,
  gapFactor: 0.9,
  /** P6: deload week. */
  deload: { setsFactor: 0.6, minSets: 2, loadFactor: 0.9, rpeDrop: 2 },
  /** P8: weekly sets of a muscle rise at most this fraction week over week outside deloads (warn). */
  weeklySetIncreaseFraction: 0.2,
} as const;

/** G9: a first-exposure load, relative to the best recent working load. */
export const LOAD_LIMITS = { firstExposure: { min: 0.6, max: 1.05 } } as const;

/** The G4/G6 limits in force for a level, with conservative mode applied. */
export interface EffectiveLimits {
  weeklySetsMin: number;
  weeklySetsMax: number;
  weeklyMuscleBlockAbove: number;
  sessionSetsRepairAbove: number;
  sessionSetsBlockAbove: number;
  setsPerExercise: number;
  rpeCap: number;
}

export function effectiveLimits(level: TrainingExperience, conservative: boolean): EffectiveLimits {
  const base = LEVEL_LIMITS[level];
  const c = GUARDRAIL_LIMITS.conservative;
  const scale = (value: number) => (conservative ? Math.floor(value * c.factor) : value);

  return {
    weeklySetsMin: base.weeklySetsPerMuscle.min,
    weeklySetsMax: scale(base.weeklySetsPerMuscle.max),
    weeklyMuscleBlockAbove: scale(GUARDRAIL_LIMITS.weeklyMuscleBlockAbove),
    sessionSetsRepairAbove: conservative ? Math.min(scale(base.sessionSets.repairAbove), c.sessionSets) : base.sessionSets.repairAbove,
    sessionSetsBlockAbove: scale(base.sessionSets.blockAbove),
    setsPerExercise: conservative ? c.setsPerExercise : GUARDRAIL_LIMITS.setsPerExercise,
    rpeCap: conservative ? Math.min(c.rpeCap, base.rpeCap) : base.rpeCap,
  };
}

/** Higher-risk patterns per limitation area (G6 warns; the critic must address each). */
export const LIMITATION_PATTERN_MAP: Readonly<Record<string, { label: string; patterns: string[]; keys: RegExp | null }>> = {
  knee: { label: 'deep loaded knee flexion and impact', patterns: ['squat', 'lunge'], keys: /(run|jump|burpee|sprint|skip|box)/ },
  shoulder: { label: 'overhead loaded pressing', patterns: ['vertical_push'], keys: /(overhead|dip|upright)/ },
  back: { label: 'heavy spinal loading', patterns: ['hinge'], keys: /(back_squat|good_morning|barbell_row|deadlift)/ },
  hip: { label: 'loaded hip flexion and impact', patterns: ['hinge', 'lunge'], keys: /(run|jump|burpee)/ },
  elbow: { label: 'loaded elbow flexion and extension', patterns: [], keys: /(curl|triceps|skull|dip|pushdown|close_grip)/ },
  wrist: { label: 'loaded wrist extension', patterns: [], keys: /(push_up|front_squat|wrist|plank|dip)/ },
  ankle: { label: 'impact and loaded ankle flexion', patterns: ['lunge'], keys: /(run|jump|calf|burpee|skip)/ },
  neck: { label: 'loaded neck and trap work', patterns: [], keys: /(shrug|overhead|upright)/ },
  other: { label: 'the declared limitation', patterns: [], keys: null },
};
