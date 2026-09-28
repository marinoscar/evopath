import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AI_CAPABILITIES, aiModelCapabilitiesSchema } from '../../core/capabilities';

// =============================================================================
// Admin model catalog routes (issue #428, epic #419)
// =============================================================================
//
//   GET   /api/admin/ai/models          list (flat pagination, like /api/admin/jobs)
//   PATCH /api/admin/ai/models/:id      enable / rename / override capabilities
//   POST  /api/admin/ai/models/refresh  enqueue `ai.catalog.refresh`
// =============================================================================

/**
 * Where a row's `capabilities` came from (docs/specs/ai-platform.md §2.17). An
 * `admin_override` is never touched by a catalog refresh.
 */
export const AI_CAPABILITY_SOURCES = ['catalog', 'admin_override', 'unclassified'] as const;
export type AiCapabilitySource = (typeof AI_CAPABILITY_SOURCES)[number];

/**
 * `'true'`/`'false'` → boolean. NOT `z.coerce.boolean()`, which turns the
 * string `'false'` into `true` — see `jobs/dto/job-list-query.dto.ts`.
 */
const queryBoolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

export const aiModelListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  provider: z.string().min(1).max(64).optional(),
  /** Only models whose capabilities include this one. */
  capability: z.enum(AI_CAPABILITIES).optional(),
  enabled: queryBoolean.optional(),
  /** Include models the provider no longer lists. Default false. */
  includeDeprecated: queryBoolean.default(false),
  /** Case-insensitive substring of the model id or display name. */
  q: z.string().trim().min(1).max(200).optional(),
});

export class AiModelListQueryDto extends createZodDto(aiModelListQuerySchema) {}
export type AiModelListQuery = z.output<typeof aiModelListQuerySchema>;

export const aiModelSchema = z.object({
  /** Row id — the `:id` of `PATCH /api/admin/ai/models/:id`. */
  id: z.string(),
  provider: z.string(),
  /** The provider's own model id (`gpt-4o-mini`). */
  modelId: z.string(),
  displayName: z.string().nullable(),
  /**
   * What the model can do, or null when the stored value is not a valid
   * capability record (an unclassified row carries an empty placeholder).
   */
  capabilities: aiModelCapabilitiesSchema.nullable(),
  capabilitySource: z.enum(AI_CAPABILITY_SOURCES),
  /** Whether this deployment offers the model to users. Only an admin turns it on. */
  enabled: z.boolean(),
  contextWindow: z.number().int().nullable(),
  maxOutputTokens: z.number().int().nullable(),
  discoveredAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  /** Set when the provider stopped listing the model. A deprecated model cannot be enabled. */
  deprecatedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
  updatedByUserId: z.string().nullable(),
});

export class AiModelDto extends createZodDto(aiModelSchema) {}
export type AiModelView = z.infer<typeof aiModelSchema>;

export const updateAiModelSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** A label for the admin and user UIs. `null` clears it. */
    displayName: z.string().trim().min(1).max(200).nullable().optional(),
    /**
     * A full capability record. Setting it marks the row `admin_override`,
     * which a catalog refresh never overwrites.
     */
    capabilities: aiModelCapabilitiesSchema.optional(),
  })
  .refine(
    (value) =>
      value.enabled !== undefined ||
      value.displayName !== undefined ||
      value.capabilities !== undefined,
    { message: 'Send at least one of enabled, displayName, capabilities.' },
  );

export class UpdateAiModelDto extends createZodDto(updateAiModelSchema) {}
export type UpdateAiModelInput = z.output<typeof updateAiModelSchema>;

export const refreshAiCatalogSchema = z.object({
  /** Provider id whose catalog to refresh, e.g. `openai`. */
  provider: z.string().min(1).max(64),
});

export class RefreshAiCatalogDto extends createZodDto(refreshAiCatalogSchema) {}

export const refreshAiCatalogResultSchema = z.object({
  /**
   * The queued `ai.catalog.refresh` job. A refresh already pending or running
   * for this provider is reused rather than duplicated, so this may be an
   * existing job's id — follow it in `GET /api/admin/jobs`.
   */
  jobId: z.string(),
  /** The job's status at the time of the response (`pending` or `running`). */
  status: z.string(),
});

export class RefreshAiCatalogResultDto extends createZodDto(refreshAiCatalogResultSchema) {}
export type RefreshAiCatalogResult = z.infer<typeof refreshAiCatalogResultSchema>;
