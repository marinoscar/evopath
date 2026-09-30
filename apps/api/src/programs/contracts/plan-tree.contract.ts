import { z } from 'zod';

// =============================================================================
// PlanTree: the shape of a training plan's content (E5.1)
// =============================================================================
//
// Blocks hold weeks, weeks hold workouts, workouts hold prescribed exercises.
// Every node carries an optional `id`: present for a row that already exists
// (or a caller-chosen uuid for a new one), absent for a new row the server
// numbers. The same schema validates the `PUT /structure` body, the snapshot
// stored in `program_versions`, the E5.5 compiler's output and the tree the
// `applyChange` chokepoint writes.
//
// Deliberately free of Nest and Prisma imports so the compiler, guardrails and
// tests can share it. Weights are kilograms, always.
// =============================================================================

export const PLAN_LIMITS = {
  weeksMin: 1,
  weeksMax: 52,
  blocksMax: 52,
  /** Per week. A draft may hold an empty week; activation needs a scheduled workout. */
  workoutsPerWeekMax: 7,
  /** Per workout. A draft may hold an empty workout while it is being built. */
  exercisesPerWorkoutMax: 20,
  nameMax: 100,
  focusMax: 200,
  /** Rationale on a block, workout or exercise. */
  nodeRationaleMax: 300,
  /** Rationale of the whole plan (`programs.rationale`). */
  planRationaleMax: 4000,
  notesMax: 1000,
  evidenceRefsMax: 20,
  evidenceRefMax: 200,
  targetSets: { min: 1, max: 20 },
  reps: { min: 1, max: 100 },
  targetLoadKg: { min: 0, max: 1000, decimals: 3 },
  targetRpe: { min: 1, max: 10, step: 0.5 },
  restSeconds: { min: 0, max: 900 },
  estimatedMinutes: { min: 1, max: 600 },
} as const;

export const LOAD_GUIDANCE = ['choose_start', 'from_history', 'fixed'] as const;
export type LoadGuidance = (typeof LOAD_GUIDANCE)[number];

const id = z.uuid().optional().meta({ description: 'The row id: an existing row to keep, or a new uuid. Omit for a new row.' });

const name = z
  .string()
  .trim()
  .min(1, { message: 'Must not be empty' })
  .max(PLAN_LIMITS.nameMax, { message: `Must be at most ${PLAN_LIMITS.nameMax} characters` });

function text(max: number) {
  return z
    .string()
    .trim()
    .max(max, { message: `Must be at most ${max} characters` })
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null);
}

const position = z.number().int().min(0).max(1000);

const targetLoadKg = z
  .number()
  .min(PLAN_LIMITS.targetLoadKg.min)
  .max(PLAN_LIMITS.targetLoadKg.max)
  .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6, { message: 'At most 3 decimal places' })
  .nullable()
  .optional()
  .transform((value) => value ?? null)
  .meta({ description: 'Kilograms, 0..1000, at most 3 decimals; null lets the lifter choose or use history.' });

const targetRpe = z
  .number()
  .min(PLAN_LIMITS.targetRpe.min)
  .max(PLAN_LIMITS.targetRpe.max)
  .refine((value) => Number.isInteger(value / PLAN_LIMITS.targetRpe.step), { message: 'RPE moves in steps of 0.5' })
  .nullable()
  .optional()
  .transform((value) => value ?? null)
  .meta({ description: 'Target RPE, 1..10 in steps of 0.5, or null.' });

export const planExerciseSchema = z
  .object({
    id,
    exerciseId: z.uuid(),
    position,
    isPriority: z.boolean().default(false),
    targetSets: z.number().int().min(PLAN_LIMITS.targetSets.min).max(PLAN_LIMITS.targetSets.max),
    repMin: z.number().int().min(PLAN_LIMITS.reps.min).max(PLAN_LIMITS.reps.max),
    repMax: z.number().int().min(PLAN_LIMITS.reps.min).max(PLAN_LIMITS.reps.max),
    targetLoadKg,
    targetRpe,
    restSeconds: z.number().int().min(PLAN_LIMITS.restSeconds.min).max(PLAN_LIMITS.restSeconds.max),
    loadGuidance: z.enum(LOAD_GUIDANCE).default('choose_start'),
    rationale: text(PLAN_LIMITS.nodeRationaleMax),
    evidenceRefs: z
      .array(z.string().trim().min(1).max(PLAN_LIMITS.evidenceRefMax))
      .max(PLAN_LIMITS.evidenceRefsMax)
      .default([]),
    notes: text(PLAN_LIMITS.notesMax),
    equipmentTypeId: z.uuid().nullable().optional().transform((value) => value ?? null),
  })
  .strict()
  .refine((exercise) => exercise.repMin <= exercise.repMax, { path: ['repMax'], message: 'repMax must be at least repMin' });

export const planWorkoutSchema = z
  .object({
    id,
    position,
    weekday: z
      .number()
      .int()
      .min(1)
      .max(7)
      .nullable()
      .optional()
      .transform((value) => value ?? null)
      .meta({ description: 'ISO weekday 1 (Monday) .. 7 (Sunday); null for an unscheduled workout.' }),
    name,
    estimatedMinutes: z
      .number()
      .int()
      .min(PLAN_LIMITS.estimatedMinutes.min)
      .max(PLAN_LIMITS.estimatedMinutes.max)
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    rationale: text(PLAN_LIMITS.nodeRationaleMax),
    exercises: z.array(planExerciseSchema).max(PLAN_LIMITS.exercisesPerWorkoutMax).default([]),
  })
  .strict();

export const planWeekSchema = z
  .object({
    id,
    weekNumber: z.number().int().min(1).max(PLAN_LIMITS.weeksMax).meta({ description: '1-based and program-wide.' }),
    isDeload: z.boolean().default(false),
    workouts: z.array(planWorkoutSchema).max(PLAN_LIMITS.workoutsPerWeekMax).default([]),
  })
  .strict();

export const planBlockSchema = z
  .object({
    id,
    position,
    name,
    focus: text(PLAN_LIMITS.focusMax),
    rationale: text(PLAN_LIMITS.nodeRationaleMax),
    weeks: z.array(planWeekSchema).min(1, { message: 'A block needs at least one week' }).max(PLAN_LIMITS.weeksMax),
  })
  .strict();

type Issue = { path: (string | number)[]; message: string };

function duplicates<T>(values: T[]): Set<T> {
  const seen = new Set<T>();
  const dup = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) dup.add(value);
    seen.add(value);
  }
  return dup;
}

/**
 * The structural invariants a per-node schema cannot see: program-wide week
 * count and numbering, distinct positions within a parent, distinct weekdays
 * within a week, and distinct ids across the whole tree. Pure; returns every
 * failure with its path.
 */
export function planTreeIssues(tree: PlanTree): Issue[] {
  const issues: Issue[] = [];
  const blocks = tree.blocks;

  for (const position of duplicates(blocks.map((block) => block.position))) {
    const index = blocks.findIndex((block) => block.position === position);
    issues.push({ path: ['blocks', index, 'position'], message: `Duplicate block position ${position}` });
  }

  const weekNumbers: number[] = [];
  const ids: string[] = [];
  blocks.forEach((block, b) => {
    if (block.id) ids.push(block.id);
    for (const number of duplicates(block.weeks.map((week) => week.weekNumber))) {
      const w = block.weeks.findIndex((week) => week.weekNumber === number);
      issues.push({ path: ['blocks', b, 'weeks', w, 'weekNumber'], message: `Duplicate week number ${number}` });
    }
    block.weeks.forEach((week, w) => {
      if (week.id) ids.push(week.id);
      weekNumbers.push(week.weekNumber);
      const workouts = week.workouts;
      const at = (i: number) => ['blocks', b, 'weeks', w, 'workouts', i];
      for (const pos of duplicates(workouts.map((workout) => workout.position))) {
        issues.push({ path: [...at(workouts.findIndex((x) => x.position === pos)), 'position'], message: `Duplicate workout position ${pos}` });
      }
      const weekdays = workouts.map((workout) => workout.weekday).filter((day): day is number => day != null);
      for (const day of duplicates(weekdays)) {
        const i = workouts.map((x) => x.weekday).lastIndexOf(day);
        issues.push({ path: [...at(i), 'weekday'], message: `Two workouts in week ${week.weekNumber} share weekday ${day}` });
      }
      workouts.forEach((workout, i) => {
        if (workout.id) ids.push(workout.id);
        const exercises = workout.exercises;
        for (const pos of duplicates(exercises.map((exercise) => exercise.position))) {
          const e = exercises.findIndex((x) => x.position === pos);
          issues.push({ path: [...at(i), 'exercises', e, 'position'], message: `Duplicate exercise position ${pos}` });
        }
        for (const exercise of exercises) if (exercise.id) ids.push(exercise.id);
      });
    });
  });

  if (weekNumbers.length < PLAN_LIMITS.weeksMin || weekNumbers.length > PLAN_LIMITS.weeksMax) {
    issues.push({ path: ['blocks'], message: `A plan has ${PLAN_LIMITS.weeksMin} to ${PLAN_LIMITS.weeksMax} weeks` });
  } else {
    const sorted = [...weekNumbers].sort((a, b) => a - b);
    if (sorted.some((number, i) => number !== i + 1)) {
      issues.push({ path: ['blocks'], message: 'Week numbers must run 1, 2, 3 ... without gaps across the plan' });
    }
  }

  const dupIds = duplicates(ids);
  if (dupIds.size > 0) {
    issues.push({ path: ['blocks'], message: `Row ids must be unique across the plan: ${[...dupIds].join(', ')}` });
  }

  return issues;
}

const planTreeObjectSchema = z
  .object({
    blocks: z
      .array(planBlockSchema)
      .min(1, { message: 'A plan needs at least one block' })
      .max(PLAN_LIMITS.blocksMax),
  })
  .strict();

/** The tree with every invariant: per-node bounds plus `planTreeIssues`. */
export const planTreeSchema = planTreeObjectSchema.superRefine((tree, ctx) => {
    for (const issue of planTreeIssues(tree)) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  });

export type PlanTreeInput = z.input<typeof planTreeObjectSchema>;
export type PlanTree = z.output<typeof planTreeObjectSchema>;
export type PlanBlock = PlanTree['blocks'][number];
export type PlanWeek = PlanBlock['weeks'][number];
export type PlanWorkout = PlanWeek['workouts'][number];
export type PlanExercise = PlanWorkout['exercises'][number];

/** Every `exerciseId` the tree prescribes, deduplicated (one `findMany` checks them all). */
export function exerciseIdsOf(tree: PlanTree): string[] {
  const ids = new Set<string>();
  for (const block of tree.blocks)
    for (const week of block.weeks)
      for (const workout of week.workouts) for (const exercise of workout.exercises) ids.add(exercise.exerciseId);
  return [...ids];
}

/** Whether any workout has a weekday: the precondition for activation. */
export function hasScheduledWorkout(tree: PlanTree): boolean {
  return tree.blocks.some((block) => block.weeks.some((week) => week.workouts.some((workout) => workout.weekday != null)));
}

/** A copy of the tree with every row id removed (a duplicate gets new ids). */
export function stripIds(tree: PlanTree): PlanTree {
  return {
    blocks: tree.blocks.map(({ id: _b, ...block }) => ({
      ...block,
      weeks: block.weeks.map(({ id: _w, ...week }) => ({
        ...week,
        workouts: week.workouts.map(({ id: _o, ...workout }) => ({
          ...workout,
          exercises: workout.exercises.map(({ id: _e, ...exercise }) => ({ ...exercise, evidenceRefs: [...exercise.evidenceRefs] })),
        })),
      })),
    })),
  };
}

/** The tree a new manual draft starts with: one block, one empty week. */
export function emptyPlanTree(): PlanTree {
  return {
    blocks: [{ position: 0, name: 'Block 1', focus: null, rationale: null, weeks: [{ weekNumber: 1, isDeload: false, workouts: [] }] }],
  };
}
