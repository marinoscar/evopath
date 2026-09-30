import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  TRAINING_AGENT_ROLES,
  TRAINING_MAX_RUN_TOKENS,
  TRAINING_MIN_RUN_TOKENS,
} from '../../../common/schemas/settings.schema';
import { TRAINING_RUN_KINDS } from '../token-estimate';
import { ROLE_RESOLUTION_STATES, roleResolutionSchema } from './role-resolution.dto';

// =============================================================================
// /api/ai/training/models and /api/ai/training/estimate
// =============================================================================

const perRole = <T extends z.ZodTypeAny>(schema: T) =>
  z.object(Object.fromEntries(TRAINING_AGENT_ROLES.map((role) => [role, schema])) as Record<
    (typeof TRAINING_AGENT_ROLES)[number],
    T
  >);

const perKind = <T extends z.ZodTypeAny>(schema: T) =>
  z.object(Object.fromEntries(TRAINING_RUN_KINDS.map((kind) => [kind, schema])) as Record<
    (typeof TRAINING_RUN_KINDS)[number],
    T
  >);

export const trainingModelsViewSchema = z.object({
  /** Every agent role, resolved. */
  roles: perRole(roleResolutionSchema),
  webSearch: z.object({
    /** `ai.hostedTools.web_search`: the researcher cannot run while it is off. */
    adminEnabled: z.boolean(),
  }),
  limits: z.object({
    /** The per-run token cap by run kind when the user has not set one. */
    defaultRunTokens: perKind(z.number().int()),
    /** Lowest `ai.training.maxRunTokens` a user may set. */
    minRunTokens: z.literal(TRAINING_MIN_RUN_TOKENS),
    /** Highest `ai.training.maxRunTokens` a user may set. */
    hardMaxRunTokens: z.literal(TRAINING_MAX_RUN_TOKENS),
  }),
  canRun: z.object({
    /** Researcher, planner, critic and evaluator all have a model. */
    create: z.boolean(),
    /** Planner and critic have a model. */
    revise: z.boolean(),
    /** The evaluator has a model (the runtime decides whether the critic is needed). */
    evaluate: z.boolean(),
    /** Every role that cannot run, with its state. */
    blockers: z.array(
      z.object({
        role: z.enum(TRAINING_AGENT_ROLES),
        state: z.enum(ROLE_RESOLUTION_STATES),
      }),
    ),
  }),
});

export class TrainingModelsView extends createZodDto(trainingModelsViewSchema) {}
export type TrainingModelsViewData = z.infer<typeof trainingModelsViewSchema>;

export const estimateTrainingRunSchema = z.object({
  kind: z.enum(TRAINING_RUN_KINDS),
  /** Critic rounds to assume; default the user's `ai.training.maxCriticRounds`, else 2. */
  criticRounds: z.number().int().min(1).max(3).optional(),
  /** Characters of user context the planner and critic will read; default a typical plan's. */
  contextChars: z.number().int().min(0).max(2_000_000).optional(),
});

export class EstimateTrainingRunDto extends createZodDto(estimateTrainingRunSchema) {}

const tokenRangeSchema = z.object({
  low: z.number().int(),
  high: z.number().int(),
});

export const trainingRunEstimateSchema = z.object({
  /** An estimate, not a quote: total input plus output tokens, and by role (only the roles this kind calls). */
  tokens: tokenRangeSchema.extend({
    byRole: z.object(
      Object.fromEntries(TRAINING_AGENT_ROLES.map((role) => [role, tokenRangeSchema.optional()])) as Record<
        (typeof TRAINING_AGENT_ROLES)[number],
        z.ZodOptional<typeof tokenRangeSchema>
      >,
    ),
  }),
  /** The per-run token cap that applies: the user's `maxRunTokens`, else the default for this kind. */
  cap: z.number().int(),
  /** `tokens.high` exceeds `cap`: a run may stop at the cap. */
  capBinding: z.boolean(),
});

export class TrainingRunEstimate extends createZodDto(trainingRunEstimateSchema) {}
export type TrainingRunEstimateData = z.infer<typeof trainingRunEstimateSchema>;
