import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AI_API_KEY_MAX, AI_API_KEY_MIN } from '../../config/dto/ai-provider-key.dto';
import { aiProviderTestCheckSchema } from '../../config/dto/ai-provider-test.dto';

// =============================================================================
// /api/ai/keys — the caller's own provider keys (issue #431, epic #419)
// =============================================================================
//
//   GET    /api/ai/keys                   UserAiKeyView[]
//   PUT    /api/ai/keys/:provider         { apiKey }          -> UserAiKeyView
//   DELETE /api/ai/keys/:provider                             -> 204
//   POST   /api/ai/keys/:provider/test    { apiKey? }         -> UserAiKeyTestResult (always 200)
//
// ⚠ WRITE-ONLY KEY. `apiKey` appears in REQUEST schemas only. No response
// schema in this file has a field able to carry key material: the view is a
// masked `hint` plus timestamps and counts, and the probe result is check
// codes. `ai-user-keys.integration.spec.ts` serialises every response and
// searches it for the key.
// =============================================================================

/** `PUT /api/ai/keys/:provider`. Same bounds as the admin key. */
export const setUserAiKeySchema = z.object({
  apiKey: z.string().trim().min(AI_API_KEY_MIN).max(AI_API_KEY_MAX),
});

export class SetUserAiKeyDto extends createZodDto(setUserAiKeySchema) {}
export type SetUserAiKeyInput = z.output<typeof setUserAiKeySchema>;

/**
 * `POST /api/ai/keys/:provider/test`. A blank or absent `apiKey` means "my
 * stored key" — and only THAT probe updates the stored key's verification and
 * reachable models. A submitted key is used for this call only.
 */
export const testUserAiKeySchema = z.object({
  apiKey: z.string().trim().max(AI_API_KEY_MAX).nullish(),
});

export class TestUserAiKeyDto extends createZodDto(testUserAiKeySchema) {}
export type TestUserAiKeyInput = z.output<typeof testUserAiKeySchema>;

/** The caller's key for one provider, masked. One per ENABLED provider, configured or not. */
export const userAiKeyViewSchema = z.object({
  provider: z.string(),
  /** Whether a key is stored for this provider. */
  configured: z.boolean(),
  /** `'••••' + last 4`, or null when nothing is stored. Never the key. */
  hint: z.string().nullable(),
  /** When the provider last accepted the key. Null when never verified, or last found revoked. */
  verifiedAt: z.iso.datetime().nullable(),
  /** The AI error code of the last failed verification (e.g. `AI_KEY_INVALID`), or null. */
  lastErrorCode: z.string().nullable(),
  /** How many catalog models this key could reach at `reachableCheckedAt`. */
  reachableModelCount: z.number().int(),
  /** When the reachable-model list was last computed. Refreshed weekly and on every stored-key test. */
  reachableCheckedAt: z.iso.datetime().nullable(),
});

export class UserAiKeyViewDto extends createZodDto(userAiKeyViewSchema) {}
export type UserAiKeyView = z.infer<typeof userAiKeyViewSchema>;

/**
 * The probe's answer. ⚠ ALWAYS HTTP 200 — read `success`.
 *
 * Two checks, not the admin probe's three: `credentials` (verifyKey) and
 * `list_models` (which catalog models the key can reach). There is no smoke
 * response — it would bill the USER's provider account for a diagnostic.
 */
export const userAiKeyTestResultSchema = z.object({
  /** True when the key was accepted and the model list was read. */
  success: z.boolean(),
  provider: z.string(),
  /** Whether the stored key was probed (because `apiKey` was blank). */
  usedStoredKey: z.boolean(),
  /** Catalog models reachable with the key, when `list_models` passed; otherwise null. */
  reachableModelCount: z.number().int().nullable(),
  /** `credentials`, then `list_models`. */
  checks: z.array(aiProviderTestCheckSchema),
  attemptedAt: z.iso.datetime(),
});

export class UserAiKeyTestResultDto extends createZodDto(userAiKeyTestResultSchema) {}
export type UserAiKeyTestResult = z.infer<typeof userAiKeyTestResultSchema>;
export type UserAiKeyTestCheck = z.infer<typeof aiProviderTestCheckSchema>;
