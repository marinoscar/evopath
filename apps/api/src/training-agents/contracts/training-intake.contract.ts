import { z } from 'zod';

import { RESEARCH_EXPERIENCE_LEVELS, RESEARCH_GOAL_TYPES, RESEARCH_LIMITATION_AREAS } from '../agents/researcher/researcher-context';

// =============================================================================
// TrainingIntake and TrainingRunRequest: what a user asks the agents for
// =============================================================================
//
// One Zod contract, with explicit bounds, shared by the route
// (`POST /api/ai/training/runs`), the context builder and the wizard. The
// intake is stored on the run (`training_plan_runs.input.request`) and, for a
// plan the agents create, snapshotted on the program (`programs.intake`).
//
// Free text (the goal sentence, limitation descriptions, preferences, a
// revise instruction) is screened by `guardrails/safety-screen.ts` before any
// run row or job exists, and is never put in an event, a log line or a span.
// =============================================================================

export const TRAINING_GOAL_TYPES = RESEARCH_GOAL_TYPES;
export const TRAINING_EXPERIENCE_LEVELS = RESEARCH_EXPERIENCE_LEVELS;
export const TRAINING_LIMITATION_AREAS = RESEARCH_LIMITATION_AREAS;
export const TRAINING_AUTONOMY = ['autonomous', 'ask_first'] as const;
/** The cardio the user asks for: walks (outdoor walk, hike), runs (outdoor run), or either. */
export const TRAINING_CARDIO_ACTIVITIES = ['walk', 'run', 'any'] as const;

export type TrainingGoalType = (typeof TRAINING_GOAL_TYPES)[number];
export type TrainingExperience = (typeof TRAINING_EXPERIENCE_LEVELS)[number];
export type TrainingLimitationArea = (typeof TRAINING_LIMITATION_AREAS)[number];
export type TrainingCardioActivity = (typeof TRAINING_CARDIO_ACTIVITIES)[number];

export const TRAINING_INTAKE_LIMITS = {
  goalChars: 300,
  limitationChars: 200,
  maxLimitations: 6,
  maxAvoidKeys: 20,
  avoidKeyChars: 80,
  preferencesChars: 300,
  daysPerWeek: { min: 1, max: 7 },
  minutesPerSession: { min: 20, max: 180 },
  durationWeeks: { min: 4, max: 24, default: 8 },
  instructionChars: 500,
  cardioDaysPerWeek: { min: 1, max: 7 },
  cardioMinutesPerSession: { min: 10, max: 120 },
} as const;

const L = TRAINING_INTAKE_LIMITS;

const isoWeekday = z.number().int().min(1).max(7);

/**
 * Walking or jogging sessions on top of the strength days (#265). `include`
 * false (or no `cardio` at all) leaves cardio to the planner's judgement
 * inside `daysPerWeek`; true asks for cardio sessions, which the guardrails
 * then require. `daysPerWeek` and `minutesPerSession` are the cardio budget:
 * when both are set, the plan's weekly cardio minutes are capped at their
 * product times 1.25.
 */
export const trainingCardioSchema = z
  .object({
    include: z.boolean(),
    activity: z.enum(TRAINING_CARDIO_ACTIVITIES),
    daysPerWeek: z.number().int().min(L.cardioDaysPerWeek.min).max(L.cardioDaysPerWeek.max).optional(),
    minutesPerSession: z.number().int().min(L.cardioMinutesPerSession.min).max(L.cardioMinutesPerSession.max).optional(),
  })
  .strict();

export type TrainingCardio = z.output<typeof trainingCardioSchema>;

export const trainingIntakeSchema = z
  .object({
    goal: z
      .object({
        type: z.enum(TRAINING_GOAL_TYPES),
        description: z.string().trim().max(L.goalChars).default(''),
      })
      .strict(),
    experience: z.enum(TRAINING_EXPERIENCE_LEVELS),
    daysPerWeek: z.number().int().min(L.daysPerWeek.min).max(L.daysPerWeek.max),
    /** ISO weekdays (1 Monday .. 7 Sunday) the user prefers; when set, at least `daysPerWeek` of them. */
    preferredWeekdays: z.array(isoWeekday).max(7).nullable().default(null),
    minutesPerSession: z.number().int().min(L.minutesPerSession.min).max(L.minutesPerSession.max),
    durationWeeks: z
      .number()
      .int()
      .min(L.durationWeeks.min)
      .max(L.durationWeeks.max)
      .default(L.durationWeeks.default),
    /** One of the caller's gyms; `null` plans for no equipment (bodyweight only). */
    gymId: z.uuid().nullable().default(null),
    limitations: z
      .array(
        z
          .object({
            area: z.enum(TRAINING_LIMITATION_AREAS),
            description: z.string().trim().max(L.limitationChars).default(''),
          })
          .strict(),
      )
      .max(L.maxLimitations)
      .default([]),
    /** Exercise slugs the plan must not use. */
    avoidExerciseKeys: z
      .array(z.string().trim().min(1).max(L.avoidKeyChars).regex(/^[a-z0-9][a-z0-9_-]*$/))
      .max(L.maxAvoidKeys)
      .default([]),
    preferences: z.string().trim().max(L.preferencesChars).default(''),
    /** Send the bio (at most 500 characters) to the planner. Default off. */
    includeBio: z.boolean().default(false),
    /** Let the researcher see an age band and sex at birth. Default off. */
    tailorResearch: z.boolean().default(false),
    /** Stored on the program when it is created. */
    autonomy: z.enum(TRAINING_AUTONOMY).default('autonomous'),
    /** Optional walking or jogging sessions (#265); absent on intakes stored before it. */
    cardio: trainingCardioSchema.optional(),
  })
  .strict()
  .superRefine((intake, ctx) => {
    const days = intake.preferredWeekdays;
    if (days === null) return;
    if (new Set(days).size !== days.length) {
      ctx.addIssue({ code: 'custom', path: ['preferredWeekdays'], message: 'Weekdays must be distinct' });
    }
    if (new Set(days).size < intake.daysPerWeek) {
      ctx.addIssue({
        code: 'custom',
        path: ['preferredWeekdays'],
        message: 'Choose at least as many preferred weekdays as days per week',
      });
    }
  });

export type TrainingIntakeInput = z.input<typeof trainingIntakeSchema>;
export type TrainingIntake = z.output<typeof trainingIntakeSchema>;

export const createRunRequestSchema = z
  .object({
    kind: z.literal('create'),
    intake: trainingIntakeSchema,
  })
  .strict();

export const reviseRunRequestSchema = z
  .object({
    kind: z.literal('revise'),
    programId: z.uuid(),
    /** Must equal the program's `currentVersion`, else `409 TRAINING_STALE_PLAN`. */
    basedOnVersion: z.number().int().min(1),
    instruction: z.string().trim().min(1).max(L.instructionChars),
  })
  .strict();

/** The request a `create` or `revise` run is started with. */
export const trainingRunRequestSchema = z.discriminatedUnion('kind', [createRunRequestSchema, reviseRunRequestSchema]);

export type CreateRunRequest = z.output<typeof createRunRequestSchema>;
export type ReviseRunRequest = z.output<typeof reviseRunRequestSchema>;
export type TrainingRunRequest = z.output<typeof trainingRunRequestSchema>;

/** Every free-text string a request carries, for the safety screen. Order: goal, limitations, preferences, instruction. */
export function freeTextOf(request: unknown): string[] {
  if (!request || typeof request !== 'object') return [];
  const value = request as Record<string, unknown>;
  const texts: string[] = [];
  const push = (text: unknown) => {
    if (typeof text === 'string' && text.trim().length > 0) texts.push(text);
  };

  const intake = value.intake as Record<string, unknown> | undefined;
  if (intake && typeof intake === 'object') {
    push((intake.goal as Record<string, unknown> | undefined)?.description);
    if (Array.isArray(intake.limitations)) {
      for (const limitation of intake.limitations) push((limitation as Record<string, unknown> | null)?.description);
    }
    push(intake.preferences);
  }
  push(value.instruction);

  return texts;
}
