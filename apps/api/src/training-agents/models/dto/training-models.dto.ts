import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AI_KEY_SOURCES } from '../../../ai/keys/dto/usable-ai-model.dto';
import {
  TRAINING_AGENT_ROLES,
  TRAINING_MAX_RUN_TOKENS,
  TRAINING_MIN_RUN_TOKENS,
} from '../../../common/schemas/settings.schema';
import { reviseRunRequestSchema, trainingIntakeSchema } from '../../contracts/training-intake.contract';
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

export const estimateTrainingRunSchema = z
  .object({
    kind: z.enum(TRAINING_RUN_KINDS),
    /** Critic rounds to assume; default the user's `ai.training.maxCriticRounds`, else 2. */
    criticRounds: z.number().int().min(1).max(3).optional(),
    /** Characters of user context the planner and critic will read; default a typical plan's. */
    contextChars: z.number().int().min(0).max(2_000_000).optional(),
    /** `create`: the intake the run would start with; with it the answer carries `sentData`. */
    intake: trainingIntakeSchema.optional(),
    /** `revise`: with `basedOnVersion` and `instruction`, the answer carries `sentData`. */
    programId: z.string().uuid().optional(),
    basedOnVersion: reviseRunRequestSchema.shape.basedOnVersion.optional(),
    instruction: reviseRunRequestSchema.shape.instruction.optional(),
  })
  .superRefine((body, ctx) => {
    const foreign = body.kind === 'create' ? (['programId', 'basedOnVersion', 'instruction'] as const) : (['intake'] as const);
    for (const field of body.kind === 'evaluate' ? (['intake', 'basedOnVersion', 'instruction'] as const) : foreign) {
      if (body[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], message: `Not allowed for a ${body.kind} estimate` });
    }
    if (body.kind === 'revise') {
      const given = (['programId', 'basedOnVersion', 'instruction'] as const).filter((f) => body[f] !== undefined);
      if (given.length > 0 && given.length < 3) {
        for (const field of ['programId', 'basedOnVersion', 'instruction'] as const) {
          if (body[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: 'Required with the other revise fields' });
        }
      }
    }
  });

export class EstimateTrainingRunDto extends createZodDto(estimateTrainingRunSchema) {}

export const sentDataSectionSchema = z.object({
  /** The context key the section renders (`goal`, `history`, ...). */
  key: z.string(),
  title: z.string(),
  items: z.array(z.string()),
  count: z.number().int().optional(),
});

export const sentDataEntrySchema = z.object({
  role: z.enum(TRAINING_AGENT_ROLES),
  /** The role's model, when it resolves to one. Identifiers only. */
  provider: z.string().nullable(),
  model: z.string().nullable(),
  /** Whose key pays (`user` or `org`); never a key. */
  keySource: z.enum(AI_KEY_SOURCES).nullable(),
  sections: z.array(sentDataSectionSchema),
  /** Titles of sections the context budget leaves out for this model. */
  dropped: z.array(z.string()),
  /** What is never sent. */
  excluded: z.array(z.string()),
});

export type SentDataEntry = z.infer<typeof sentDataEntrySchema>;

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
  /**
   * What each agent that will run is sent, rendered from the same context
   * builder the run uses (one entry per role, in run order). Empty unless the
   * request carries a `create` intake or the `revise` fields. No provider
   * call, no run row.
   */
  sentData: z.array(sentDataEntrySchema),
});

export class TrainingRunEstimate extends createZodDto(trainingRunEstimateSchema) {}
export type TrainingRunEstimateData = z.infer<typeof trainingRunEstimateSchema>;
