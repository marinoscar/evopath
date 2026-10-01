import { z } from 'zod';

// =============================================================================
// PlanDraft: the planner's output, compact by design
// =============================================================================
//
// A 12-week plan enumerated week by week would cost tens of thousands of
// output tokens and give the model more places to be inconsistent. The
// planner authors WEEK TYPES (the workouts of one kind of week) and, per
// block, a WEEK SEQUENCE naming the type of each week. The compiler
// (`compile/compile-plan.ts`) expands it mechanically; the guardrails then
// check and repair the expanded tree.
//
// Strict-mode compatible (every property required, no records): the schema
// is sent to the provider as the structured output format.
//
// PRESCRIPTION SHAPE. An exercise is either sets and reps (`sets`, `repMin`,
// `repMax`; both targets null) or cardio (`targetDurationSeconds` and/or
// `targetDistanceMeters`; reps null; `sets` optional), matching the
// candidate's `trackingMode`. The field descriptions tell the model; the
// guardrails (G1) block a draft whose shape does not fit. Cross-field rules
// (a sequence as long as its block, keys that exist) are not expressible
// there; `draftIssues` lists them and the compiler repairs them
// deterministically.
// =============================================================================

export const PLAN_DRAFT_SCHEMA_NAME = 'plan_draft';

export const PLAN_DRAFT_LIMITS = {
  titleChars: 80,
  summaryChars: 600,
  rationaleChars: 3000,
  totalWeeks: { min: 1, max: 24 },
  blocksMax: 4,
  weekTypesPerBlockMax: 4,
  workoutsPerWeekMax: 7,
  exercisesPerWorkoutMax: 12,
  blockNameChars: 60,
  blockFocusChars: 160,
  blockRationaleChars: 400,
  weekTypeKeyChars: 12,
  workoutNameChars: 60,
  workoutRationaleChars: 200,
  exerciseRationaleChars: 200,
  evidenceRefsMax: 3,
  noteChars: 200,
  notesMax: 6,
} as const;

const L = PLAN_DRAFT_LIMITS;

export const planDraftExerciseSchema = z.object({
  /** A candidate exercise's `key`. */
  exerciseKey: z.string().max(80),
  isPriority: z.boolean(),
  sets: z
    .number()
    .int()
    .min(1)
    .max(8)
    .nullable()
    .describe('Sets. Required for weight_reps and bodyweight_reps exercises; null or a count for time and distance_time.'),
  repMin: z.number().int().min(1).max(30).nullable().describe('Null for time and distance_time exercises.'),
  repMax: z.number().int().min(1).max(30).nullable().describe('Null for time and distance_time exercises.'),
  targetDurationSeconds: z
    .number()
    .int()
    .min(60)
    .max(36000)
    .nullable()
    .describe('Total seconds for a time or distance_time exercise (required for time); null for reps exercises.'),
  targetDistanceMeters: z
    .number()
    .min(100)
    .max(100000)
    .nullable()
    .describe('Total meters for a distance_time exercise (with or instead of a duration); null otherwise.'),
  targetRpe: z.number().nullable(),
  restSeconds: z.number().int().min(30).max(300),
  loadGuidance: z.enum(['choose_start', 'from_history', 'fixed']),
  targetLoadKg: z.number().nullable(),
  rationale: z.string().max(L.exerciseRationaleChars),
  /** Claim ids of the evidence brief (`E2`). */
  evidenceRefs: z.array(z.string().max(8)).max(L.evidenceRefsMax),
});

export const planDraftWorkoutSchema = z.object({
  name: z.string().max(L.workoutNameChars),
  /** ISO weekday, 1 Monday .. 7 Sunday. */
  weekday: z.number().int().min(1).max(7),
  rationale: z.string().max(L.workoutRationaleChars),
  exercises: z.array(planDraftExerciseSchema).min(1).max(L.exercisesPerWorkoutMax),
});

export const planDraftWeekTypeSchema = z.object({
  key: z.string().max(L.weekTypeKeyChars),
  isDeload: z.boolean(),
  workouts: z.array(planDraftWorkoutSchema).min(1).max(L.workoutsPerWeekMax),
});

export const planDraftBlockSchema = z.object({
  name: z.string().max(L.blockNameChars),
  focus: z.string().max(L.blockFocusChars),
  rationale: z.string().max(L.blockRationaleChars),
  /** Program-wide, 1-based, inclusive. */
  weekStart: z.number().int(),
  weekEnd: z.number().int(),
  /** The week type key of each week of the block, in order. */
  weekSequence: z.array(z.string().max(L.weekTypeKeyChars)),
  weekTypes: z.array(planDraftWeekTypeSchema).min(1).max(L.weekTypesPerBlockMax),
});

export const planDraftSchema = z.object({
  title: z.string().max(L.titleChars),
  summary: z.string().max(L.summaryChars),
  rationale: z.string().max(L.rationaleChars),
  totalWeeks: z.number().int().min(L.totalWeeks.min).max(L.totalWeeks.max),
  daysPerWeek: z.number().int().min(1).max(7),
  blocks: z.array(planDraftBlockSchema).min(1).max(L.blocksMax),
  assumptions: z.array(z.string().max(L.noteChars)).max(L.notesMax),
  safetyNotes: z.array(z.string().max(L.noteChars)).max(L.notesMax),
});

export type PlanDraft = z.infer<typeof planDraftSchema>;
export type PlanDraftBlock = z.infer<typeof planDraftBlockSchema>;
export type PlanDraftWeekType = z.infer<typeof planDraftWeekTypeSchema>;
export type PlanDraftWorkout = z.infer<typeof planDraftWorkoutSchema>;
export type PlanDraftExercise = z.infer<typeof planDraftExerciseSchema>;

/** What `plan` puts in `RunState.draft`. */
export interface PlanDraftState {
  /** 1 for the first draft, +1 per revision. */
  round: number;
  draft: PlanDraft;
  /** Context sections the budget dropped for this call (ids). */
  droppedContext: string[];
}

/** The cross-field problems of a draft the schema cannot express. */
export function draftIssues(draft: PlanDraft): string[] {
  const issues: string[] = [];
  let expected = 1;
  const blocks = [...draft.blocks].sort((a, b) => a.weekStart - b.weekStart);

  blocks.forEach((block, i) => {
    const length = block.weekEnd - block.weekStart + 1;
    if (block.weekStart !== expected) issues.push(`block ${i + 1} starts at week ${block.weekStart}, expected ${expected}`);
    if (length < 1) issues.push(`block ${i + 1} ends before it starts`);
    if (block.weekSequence.length !== Math.max(0, length)) {
      issues.push(`block ${i + 1} has ${block.weekSequence.length} weeks in its sequence for ${Math.max(0, length)} weeks`);
    }
    const keys = new Set(block.weekTypes.map((t) => t.key));
    if (keys.size !== block.weekTypes.length) issues.push(`block ${i + 1} repeats a week type key`);
    for (const key of new Set(block.weekSequence)) {
      if (!keys.has(key)) issues.push(`block ${i + 1} names an unknown week type`);
    }
    expected = block.weekEnd + 1;
  });

  if (expected - 1 !== draft.totalWeeks) issues.push(`the blocks cover ${expected - 1} weeks, totalWeeks is ${draft.totalWeeks}`);
  return issues;
}

/** One week of the expanded draft. */
export interface ExpandedDraftWeek {
  /** Index into `draft.blocks` (original order). */
  blockIndex: number;
  type: PlanDraftWeekType;
}

/**
 * The draft's weeks in program order, expanded mechanically: blocks by
 * `weekStart` (then their order); a block lasts `weekEnd - weekStart + 1`
 * weeks (its sequence length when that is not positive, at least 1); week i
 * takes the type named at `weekSequence[i]`, cycling a short sequence; an
 * unknown or missing name takes the block's first week type. At most 24
 * weeks. `draftIssues` reports every place a fallback was needed.
 */
export function expandDraftWeeks(draft: PlanDraft): ExpandedDraftWeek[] {
  const out: ExpandedDraftWeek[] = [];
  const order = draft.blocks.map((block, index) => ({ block, index })).sort((a, b) => a.block.weekStart - b.block.weekStart || a.index - b.index);

  for (const { block, index } of order) {
    const types = new Map(block.weekTypes.map((t) => [t.key, t]));
    const declared = block.weekEnd - block.weekStart + 1;
    const length = declared >= 1 ? declared : Math.max(1, block.weekSequence.length);
    for (let i = 0; i < length && out.length < PLAN_DRAFT_LIMITS.totalWeeks.max; i += 1) {
      const key = block.weekSequence.length > 0 ? block.weekSequence[i % block.weekSequence.length] : undefined;
      out.push({ blockIndex: index, type: (key !== undefined ? types.get(key) : undefined) ?? block.weekTypes[0] });
    }
  }
  return out;
}

/** Counts of the expanded plan, for the `plan.draft` event. */
export function draftCounts(draft: PlanDraft): { weeks: number; workouts: number; exercises: number } {
  const weeks = expandDraftWeeks(draft);
  return {
    weeks: weeks.length,
    workouts: weeks.reduce((sum, w) => sum + w.type.workouts.length, 0),
    exercises: weeks.reduce((sum, w) => sum + w.type.workouts.reduce((n, o) => n + o.exercises.length, 0), 0),
  };
}
