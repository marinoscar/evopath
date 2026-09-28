import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// Admin (org) AI key routes — bodies (issue #428, epic #419)
// =============================================================================

/** Accepted key length bounds. Real provider keys are well inside these. */
export const AI_API_KEY_MIN = 8;
export const AI_API_KEY_MAX = 512;

/** `PUT /api/admin/ai/providers/:provider/key`. Write-only: the key is never returned. */
export const setAiProviderKeySchema = z.object({
  apiKey: z.string().trim().min(AI_API_KEY_MIN).max(AI_API_KEY_MAX),
});

export class SetAiProviderKeyDto extends createZodDto(setAiProviderKeySchema) {}
export type SetAiProviderKeyInput = z.output<typeof setAiProviderKeySchema>;

/** The word `DELETE /api/admin/ai/providers/:provider/key` requires. Same typed-literal pattern as push-config's `REMOVE`. */
export const AI_KEY_REMOVE_CONFIRMATION = 'REMOVE';

export const removeAiProviderKeySchema = z.object({
  confirmation: z.literal(AI_KEY_REMOVE_CONFIRMATION),
});

export class RemoveAiProviderKeyDto extends createZodDto(removeAiProviderKeySchema) {}
