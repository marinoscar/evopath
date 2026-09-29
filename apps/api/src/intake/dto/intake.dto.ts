import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  DRAFT_ITEM_CONFIDENCES,
  DRAFT_ITEM_ORIGINS,
  DRAFT_ITEM_STATUSES,
  INTAKE_STATUSES,
  type IntakeStatus,
} from '../intake-kind.interface';

// =============================================================================
// /api/intakes — request and response schemas (E3.1)
// =============================================================================
//
// The module is kind-agnostic, so `context` and `value` are opaque here and
// validated by the kind's own `contextSchema` / `valueSchema` in the service
// (their issues are published under `details.issues` with a `context.` or
// `value.` path prefix, like every other validation error).
//
// Write bodies are `.strict()`: provenance (`origin`, `confidence`,
// `userVerified`, `originalAiValue`) is server-owned and a client sending it
// is refused with a 400.
// =============================================================================

export const INTAKE_KIND_MAX = 64;
export const INTAKE_LIST_LIMIT_DEFAULT = 20;
export const INTAKE_LIST_LIMIT_MAX = 50;
export const INTAKE_ERROR_MESSAGE_MAX = 500;

const kindSchema = z
  .string()
  .trim()
  .min(1)
  .max(INTAKE_KIND_MAX)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, { message: 'kind must be lower-case letters, digits, _ . or -' });

// -----------------------------------------------------------------------------
// POST /api/intakes
// -----------------------------------------------------------------------------

export const createIntakeSchema = z
  .object({
    kind: kindSchema.meta({ description: 'A registered intake kind, e.g. `gym_equipment`.' }),
    context: z
      .record(z.string(), z.unknown())
      .optional()
      .meta({ description: "Kind-specific inputs, validated by the kind's context schema (e.g. `{ gymId }`)." }),
    subjectType: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .meta({ description: 'The record type this intake helps create or change, e.g. `gym`.' }),
    subjectId: z.uuid().optional().meta({ description: 'The id of that record.' }),
  })
  .strict();

export class CreateIntakeDto extends createZodDto(createIntakeSchema) {}
export type CreateIntakeInput = z.output<typeof createIntakeSchema>;

// -----------------------------------------------------------------------------
// PATCH /api/intakes/:id
// -----------------------------------------------------------------------------

export const updateIntakeSchema = z
  .object({
    context: z
      .record(z.string(), z.unknown())
      .optional()
      .meta({
        description:
          "The new kind-specific inputs, replacing the old ones whole; validated by the kind's context schema as on create.",
      }),
  })
  .strict();

export class UpdateIntakeDto extends createZodDto(updateIntakeSchema) {}
export type UpdateIntakeInput = z.output<typeof updateIntakeSchema>;

// -----------------------------------------------------------------------------
// GET /api/intakes
// -----------------------------------------------------------------------------

export const listIntakesQuerySchema = z.object({
  kind: kindSchema.optional(),
  subjectId: z.uuid().optional(),
  status: z
    .string()
    .max(100)
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .refine((parts) => parts.length > 0, { message: 'status must name at least one status' })
    .refine((parts) => parts.every((part) => (INTAKE_STATUSES as readonly string[]).includes(part)), {
      message: `status must be a comma list of ${INTAKE_STATUSES.join(', ')}`,
    })
    .transform((parts) => parts as IntakeStatus[])
    .optional(),
  limit: z.coerce.number().int().min(1).max(INTAKE_LIST_LIMIT_MAX).default(INTAKE_LIST_LIMIT_DEFAULT),
});

export class ListIntakesQueryDto extends createZodDto(listIntakesQuerySchema) {}
export type ListIntakesQuery = z.output<typeof listIntakesQuerySchema>;

// -----------------------------------------------------------------------------
// POST /api/intakes/:id/photos
// -----------------------------------------------------------------------------

export const attachPhotoSchema = z
  .object({
    storageObjectId: z
      .uuid()
      .meta({ description: 'A `ready` image storage object the caller uploaded (PNG, JPEG, GIF or WebP, at most 20 MiB).' }),
  })
  .strict();

export class AttachPhotoDto extends createZodDto(attachPhotoSchema) {}

// -----------------------------------------------------------------------------
// POST /api/intakes/:id/analyze
// -----------------------------------------------------------------------------

export const analyzeIntakeSchema = z
  .object({
    provider: z.string().trim().min(1).max(64).meta({ description: 'An enabled AI provider, e.g. `openai`.' }),
    modelId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .meta({ description: 'An enabled model of that provider with `vision_input` and `structured_output`.' }),
  })
  .strict();

export class AnalyzeIntakeDto extends createZodDto(analyzeIntakeSchema) {}
export type AnalyzeIntakeInput = z.output<typeof analyzeIntakeSchema>;

// -----------------------------------------------------------------------------
// Draft items
// -----------------------------------------------------------------------------

const itemValueSchema = z
  .unknown()
  .refine((value) => value !== undefined, { message: 'value is required' })
  .meta({ description: "The item value, validated by the intake kind's value schema." });

export const createDraftItemSchema = z
  .object({
    kind: kindSchema.meta({ description: 'The item kind inside the intake kind, e.g. `equipment`.' }),
    value: itemValueSchema,
  })
  .strict();

export class CreateDraftItemDto extends createZodDto(createDraftItemSchema) {}
export type CreateDraftItemInput = z.output<typeof createDraftItemSchema>;

export const updateDraftItemSchema = z
  .object({
    value: z
      .unknown()
      .optional()
      .meta({ description: "The new value, validated by the intake kind's value schema." }),
    status: z
      .enum(DRAFT_ITEM_STATUSES)
      .optional()
      .meta({ description: '`accepted`, `rejected`, or `pending` to restore a rejected item.' }),
  })
  .strict()
  .refine((body) => body.value !== undefined || body.status !== undefined, {
    message: 'At least one of value or status is required',
  });

export class UpdateDraftItemDto extends createZodDto(updateDraftItemSchema) {}
export type UpdateDraftItemInput = z.output<typeof updateDraftItemSchema>;

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

const jsonValue = z.unknown().meta({ description: "Kind-specific JSON, shaped by the kind's value schema." });

export const draftItemViewSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  origin: z.enum(DRAFT_ITEM_ORIGINS),
  status: z.enum(DRAFT_ITEM_STATUSES),
  confidence: z
    .enum(DRAFT_ITEM_CONFIDENCES)
    .nullable()
    .meta({ description: 'The AI\'s confidence; always null for a user-added item.' }),
  uncertain: z.boolean().meta({ description: 'The AI flagged that it is not sure about something in this item.' }),
  uncertaintyNote: z.string().nullable(),
  sourcePhotoIds: z
    .array(z.uuid())
    .meta({ description: 'Storage object ids of the photos the item was read from; a removed photo stays listed.' }),
  userVerified: z.boolean().meta({ description: 'True once the user edited or accepted the item, or added it.' }),
  value: jsonValue,
  originalAiValue: z
    .unknown()
    .meta({ description: 'The value the AI proposed; set on the first edit of an AI item, never overwritten; null otherwise.' }),
  sortOrder: z.number().int(),
});

/** Named `DraftItemView` because the class name is the OpenAPI schema name (the public contract). */
export class DraftItemView extends createZodDto(draftItemViewSchema) {}
export type DraftItemViewData = z.infer<typeof draftItemViewSchema>;

export const intakePhotoViewSchema = z.object({
  id: z.uuid(),
  storageObjectId: z.uuid(),
  name: z.string().meta({ description: "The storage object's file name." }),
  sortOrder: z.number().int(),
});

export class PhotoIntakePhotoView extends createZodDto(intakePhotoViewSchema) {}
export type PhotoIntakePhotoViewData = z.infer<typeof intakePhotoViewSchema>;

const intakeFields = {
  id: z.uuid(),
  kind: z.string(),
  status: z.enum(INTAKE_STATUSES),
  subjectType: z.string().nullable(),
  subjectId: z.uuid().nullable(),
  context: z.unknown().meta({ description: 'The kind-specific inputs given on create, or null.' }),
  provider: z.string().nullable().meta({ description: 'The AI provider chosen at analyze time.' }),
  modelId: z.string().nullable(),
  jobId: z.uuid().nullable().meta({ description: 'The analyze job, once queued.' }),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  resultMeta: z
    .record(z.string(), z.unknown())
    .nullable()
    .meta({ description: 'What the analyzer recorded (prompt version, batches, items it could not validate); never keys, prompts or bytes.' }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
};

export const photoIntakeViewSchema = z.object({
  ...intakeFields,
  photos: z.array(intakePhotoViewSchema),
  items: z.array(draftItemViewSchema).meta({ description: 'Every item, rejected ones included, in `sortOrder`.' }),
});

export class PhotoIntakeView extends createZodDto(photoIntakeViewSchema) {}
export type PhotoIntakeViewData = z.infer<typeof photoIntakeViewSchema>;

export const photoIntakeSummarySchema = z.object({
  ...intakeFields,
  photoCount: z.number().int(),
  itemCount: z.number().int(),
});

export class PhotoIntakeSummary extends createZodDto(photoIntakeSummarySchema) {}
export type PhotoIntakeSummaryData = z.infer<typeof photoIntakeSummarySchema>;

export const intakeAnalyzeStartedSchema = z.object({
  intakeId: z.uuid(),
  jobId: z.uuid(),
});

export class IntakeAnalyzeStarted extends createZodDto(intakeAnalyzeStartedSchema) {}
export type IntakeAnalyzeStartedData = z.infer<typeof intakeAnalyzeStartedSchema>;
