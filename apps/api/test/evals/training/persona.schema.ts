import { z } from 'zod';

import { TRAINING_LIMITATION_AREAS, trainingIntakeSchema } from '../../../src/training-agents/contracts/training-intake.contract';

// =============================================================================
// The eval persona: a synthetic person, what they ask for, and what a good
// plan for them must have. No real data, ever.
// =============================================================================

export const EVAL_PROPERTIES = [
  'equipment_feasible',
  'schedule_fits',
  'volume_in_range',
  'limits_respected',
  'loads_safe',
  'citations_valid',
  'safety_stop',
  'injection_inert',
  'goal_fit',
  'progression_present',
  'variety_and_balance',
  'rationale_quality',
] as const;
export type EvalProperty = (typeof EVAL_PROPERTIES)[number];

/** Hard properties gate on the shipped artifact; soft ones only score. */
export const HARD_PROPERTIES: ReadonlySet<EvalProperty> = new Set([
  'equipment_feasible',
  'schedule_fits',
  'volume_in_range',
  'limits_respected',
  'loads_safe',
  'citations_valid',
  'safety_stop',
  'injection_inert',
]);

export const PERSONA_KINDS = ['create', 'safety'] as const;

const slug = z.string().regex(/^[a-z0-9][a-z0-9_]*$/);

export const personaSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    kind: z.enum(PERSONA_KINDS),
    description: z.string().min(1),
    profile: z
      .object({
        ageYears: z.number().int().min(14).max(100),
        sexAtBirth: z.enum(['female', 'male']),
        heightCm: z.number().min(120).max(230),
        weightKg: z.number().min(35).max(250),
      })
      .strict()
      .nullable()
      .default(null),
    /** What the wizard would send; parsed by the real intake contract. */
    intake: z.record(z.string(), z.unknown()),
    /** Seed equipment slugs; `null` plans for no equipment (bodyweight only). */
    gym: z.object({ name: z.string(), equipment: z.array(slug).min(1) }).strict().nullable(),
    history: z
      .object({
        weeks: z.number().int().min(1).max(6),
        sessionsPerWeek: z.number().int().min(1).max(7),
        exercises: z.array(z.object({ slug, weightKg: z.number().min(0), reps: z.number().int().min(1) }).strict()),
        painFlags: z.array(slug).default([]),
      })
      .strict()
      .nullable()
      .default(null),
    readiness: z
      .object({ energy: z.number().int().min(1).max(5), sleepQuality: z.number().int().min(1).max(5), soreness: z.number().int().min(1).max(5), stress: z.number().int().min(1).max(5) })
      .strict()
      .nullable()
      .default(null),
    /** The stored evidence brief (`test/fixtures/training/research/<name>.json`). */
    brief: z.string().default('valid'),
    /** Optional narrowing of the exercises a plan for this person may use (default: what the gym supports, minus the avoid list). */
    allowedExercises: z.array(slug).nullable().default(null),
    /** The attacker text the persona put into the inputs (the pipeline eval checks where it lands in the planner request). */
    injectionPayload: z.array(z.string().min(3)).default([]),
    expect: z
      .array(z.object({ property: z.enum(EVAL_PROPERTIES), area: z.enum(TRAINING_LIMITATION_AREAS).optional() }).strict())
      .min(1),
  })
  .strict()
  .superRefine((persona, ctx) => {
    const intake = trainingIntakeSchema.safeParse({ gymId: null, ...persona.intake });
    if (!intake.success && persona.kind === 'create') {
      ctx.addIssue({ code: 'custom', path: ['intake'], message: intake.error.message });
    }
  });

export type EvalPersona = z.output<typeof personaSchema>;
