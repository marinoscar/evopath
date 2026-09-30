import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AI_FEATURE_IDS, TASK_REASONING_EFFORTS } from '../../../common/schemas/settings.schema';
import { AI_CAPABILITIES, AI_INPUT_MODALITIES, AI_REASONING_EFFORTS } from '../../core/capabilities';

// =============================================================================
// /api/admin/ai/assignments (#173) — the administrator's model per AI feature
// =============================================================================

/** Why an assignment is refused (PUT, 400) or flagged (GET `warning`). */
export const AI_ASSIGNMENT_ISSUES = {
  /** No catalog row for this provider and model. */
  MODEL_NOT_FOUND: 'AI_ASSIGNMENT_MODEL_NOT_FOUND',
  /** The model exists but an administrator has not enabled it. */
  MODEL_DISABLED: 'AI_ASSIGNMENT_MODEL_DISABLED',
  /** The provider no longer lists the model. */
  MODEL_DEPRECATED: 'AI_ASSIGNMENT_MODEL_DEPRECATED',
  /** The provider is not enabled in this deployment, or has no adapter. */
  PROVIDER_DISABLED: 'AI_ASSIGNMENT_PROVIDER_DISABLED',
  /** The model cannot serve the feature (`missing` names what it lacks). */
  MODEL_INCAPABLE: 'AI_ASSIGNMENT_MODEL_INCAPABLE',
  /** A `reasoningEffort` on a feature that takes none (the photo features). PUT only. */
  EFFORT_UNSUPPORTED: 'AI_ASSIGNMENT_EFFORT_UNSUPPORTED',
} as const;

export type AiAssignmentIssueCode = (typeof AI_ASSIGNMENT_ISSUES)[keyof typeof AI_ASSIGNMENT_ISSUES];

/** `details.reason` of the PUT's 400 when any assignment is refused. */
export const AI_ASSIGNMENT_INVALID = 'AI_ASSIGNMENT_INVALID';

const modelRefSchema = z
  .object({
    provider: z.string().trim().min(1).max(100).meta({ description: 'Provider id, e.g. `openai`.' }),
    modelId: z.string().trim().min(1).max(200).meta({ description: 'Catalog model id.' }),
  })
  .strict();

const featureAssignmentInputSchema = modelRefSchema
  .extend({
    reasoningEffort: z
      .enum(TASK_REASONING_EFFORTS)
      .nullable()
      .optional()
      .meta({
        description:
          'Training roles only: the effort to request (clamped to what the model offers). Absent or null = the role default.',
      }),
  })
  .strict();

const featuresInputShape = Object.fromEntries(
  AI_FEATURE_IDS.map((id) => [id, featureAssignmentInputSchema.nullable().optional()]),
) as Record<(typeof AI_FEATURE_IDS)[number], z.ZodOptional<z.ZodNullable<typeof featureAssignmentInputSchema>>>;

export const updateAiAssignmentsSchema = z
  .object({
    default: modelRefSchema
      .nullable()
      .meta({ description: "The organisation's model for every feature it can serve; `null` for none." }),
    features: z
      .object(featuresInputShape)
      .strict()
      .meta({ description: 'Per-feature assignment. A feature left out, or `null`, is unassigned (full replace).' }),
  })
  .strict();

export class UpdateAiAssignmentsDto extends createZodDto(updateAiAssignmentsSchema) {}
export type UpdateAiAssignmentsInput = z.output<typeof updateAiAssignmentsSchema>;

// -----------------------------------------------------------------------------
// Response
// -----------------------------------------------------------------------------

const storedRefSchema = z.object({ provider: z.string(), modelId: z.string() });
const storedAssignmentSchema = storedRefSchema.extend({
  reasoningEffort: z.enum(TASK_REASONING_EFFORTS).nullable().optional(),
});

export const aiAssignmentWarningSchema = z.object({
  code: z.enum(Object.values(AI_ASSIGNMENT_ISSUES) as [AiAssignmentIssueCode, ...AiAssignmentIssueCode[]]),
  message: z.string(),
  /** For `AI_ASSIGNMENT_MODEL_INCAPABLE`: capabilities, `input:<modality>` or `provider:<id>` the model lacks. */
  missing: z.array(z.string()).optional(),
});

export type AiAssignmentWarning = z.infer<typeof aiAssignmentWarningSchema>;

const eligibleModelSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
  displayName: z.string(),
  /** Efforts the model offers (empty for a model without `reasoning`). */
  reasoningEfforts: z.array(z.enum(AI_REASONING_EFFORTS)),
});

export type AiEligibleModel = z.infer<typeof eligibleModelSchema>;

export const aiAssignmentsResponseSchema = z.object({
  /** The stored value — exactly what `PUT` takes back. Every feature id is present (`null` = unassigned). */
  assignments: z.object({
    default: storedRefSchema.nullable(),
    features: z.record(z.enum(AI_FEATURE_IDS), storedAssignmentSchema.nullable()),
  }),
  /** The default model's picker: every enabled model, and a warning when the stored default is not. */
  default: z.object({
    eligibleModels: z.array(eligibleModelSchema),
    warning: aiAssignmentWarningSchema.nullable(),
  }),
  /** One row per feature, in registry order. */
  features: z.array(
    z.object({
      featureId: z.enum(AI_FEATURE_IDS),
      label: z.string(),
      group: z.enum(['photo', 'training']),
      needs: z.array(z.enum(AI_CAPABILITIES)),
      inputModalities: z.array(z.enum(AI_INPUT_MODALITIES)),
      /** Providers the feature is restricted to; `null` = any. */
      providers: z.array(z.string()).nullable(),
      /** The feature also needs the hosted web-search switch (`/admin/settings/ai`). */
      requiresWebSearch: z.boolean(),
      /** Whether `reasoningEffort` applies, and its default (`null` = no effort for this feature). */
      defaultReasoningEffort: z.enum(TASK_REASONING_EFFORTS).nullable(),
      assignment: storedAssignmentSchema.nullable(),
      /** Enabled, non-deprecated models of enabled providers that can serve the feature. */
      eligibleModels: z.array(eligibleModelSchema),
      /** Set when the stored assignment is no longer enabled or capable. */
      warning: aiAssignmentWarningSchema.nullable(),
    }),
  ),
  /** The system-settings row version — send it back as `If-Match` on `PUT`. `0` when nothing is stored yet. */
  version: z.number().int(),
  updatedAt: z.string().nullable(),
  updatedBy: z.object({ id: z.string(), email: z.string() }).nullable(),
});

export class AiAssignmentsResponseDto extends createZodDto(aiAssignmentsResponseSchema) {}
export type AiAssignmentsResponse = z.infer<typeof aiAssignmentsResponseSchema>;
