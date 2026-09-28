import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { aiModelCapabilitiesSchema } from '../../core/capabilities';

// =============================================================================
// GET /api/ai/models — the models the caller can call right now (issue #431)
// =============================================================================
//
// usable(user) = admin-enabled, non-deprecated models
//                ∩ reachable with the user's own key          (keySource 'user')
//              — or every admin-enabled, non-deprecated model
//                when the org fallback serves the provider     (keySource 'org')
//                or the provider is keyless (#448)             (keySource 'none')
//
// docs/specs/ai-platform.md §2.18. Carries no key, no hint and no catalog
// provenance — only what a model picker needs.
// =============================================================================

export const AI_KEY_SOURCES = ['user', 'org', 'none'] as const;

export const usableAiModelSchema = z.object({
  provider: z.string(),
  /** The provider's own model id — what a request's `model` names. */
  modelId: z.string(),
  displayName: z.string().nullable(),
  /** What the model can do. An unclassified model reports empty lists. */
  capabilities: aiModelCapabilitiesSchema,
  /**
   * Whose key would pay for a call: the caller's own, the organisation's
   * fallback, or `none` — a keyless server the administrator opted in to (#448).
   */
  keySource: z.enum(AI_KEY_SOURCES),
});

export class UsableAiModelDto extends createZodDto(usableAiModelSchema) {}
export type UsableAiModel = z.infer<typeof usableAiModelSchema>;
