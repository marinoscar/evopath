import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AI_ERROR_CODES } from '../../core/ai-error';
import { AI_API_KEY_MAX } from './ai-provider-key.dto';

// =============================================================================
// POST /api/admin/ai/providers/:provider/test (issue #428, epic #419)
// =============================================================================
//
// ⚠ ALWAYS HTTP 200. A rejected key or an unreachable provider is a successful
// DIAGNOSIS, and it is the reason this endpoint exists — the same argument
// `storage-connection-test.dto.ts` makes. Read `success`.
// =============================================================================

/**
 * What to test. Both fields optional: a blank `apiKey` means "the stored admin
 * key", a blank `baseUrl` means "the stored override, or the provider default".
 * Nothing is saved.
 */
export const testAiProviderSchema = z.object({
  apiKey: z.string().trim().max(AI_API_KEY_MAX).nullish(),
  baseUrl: z.union([z.url().max(2048), z.literal('')]).nullish(),
});

export class TestAiProviderDto extends createZodDto(testAiProviderSchema) {}
export type TestAiProviderInput = z.output<typeof testAiProviderSchema>;

/** The three checks, in attempt order. */
export const AI_TEST_CHECK_IDS = ['credentials', 'list_models', 'responses_smoke'] as const;
export type AiTestCheckId = (typeof AI_TEST_CHECK_IDS)[number];

/** `skipped` is neither a pass nor a failure: the check was not attempted. */
export const AI_TEST_CHECK_STATUSES = ['passed', 'failed', 'skipped'] as const;
export type AiTestCheckStatus = (typeof AI_TEST_CHECK_STATUSES)[number];

/**
 * Machine-readable outcomes. The AI error codes (`AI_KEY_INVALID`,
 * `AI_RATE_LIMITED`, `AI_PROVIDER_UNAVAILABLE`, ...) are reused verbatim for
 * a failure the provider reported, so a client needs one vocabulary, not two.
 */
export const AI_TEST_CHECK_CODES = [
  /** The check passed. */
  'ok',
  /** Nothing was attempted: no key was submitted and none is stored. */
  'not_configured',
  /** An earlier check failed, so this one was not attempted. */
  'not_attempted',
  /** Smoke test skipped: no enabled, non-deprecated text model to call. */
  'no_eligible_model',
  /** Smoke test skipped: the adapter has no responses port. */
  'not_supported',
  ...AI_ERROR_CODES,
] as const;
export type AiTestCheckCode = (typeof AI_TEST_CHECK_CODES)[number];

export const aiProviderTestCheckSchema = z.object({
  id: z.enum(AI_TEST_CHECK_IDS),
  label: z.string(),
  status: z.enum(AI_TEST_CHECK_STATUSES),
  code: z.enum(AI_TEST_CHECK_CODES),
  /** One or two sentences an operator can act on, authored by this API. */
  detail: z.string(),
  /** The adapter's error message, with any key redacted, or null. */
  error: z.string().nullable(),
});

export const aiProviderTestResultSchema = z.object({
  /**
   * True when the key was accepted and no check failed. A smoke test SKIPPED
   * for lack of an enabled model does not make this false — it is the normal
   * state of a deployment that has not enabled a model yet.
   */
  success: z.boolean(),
  provider: z.string(),
  /** Whether the stored admin key was used because `apiKey` was blank. */
  usedStoredKey: z.boolean(),
  /** How many models the key can see, when `list_models` passed; otherwise null. */
  modelCount: z.number().int().nullable(),
  /** The model the smoke test called, or null when it did not run. */
  smokeModelId: z.string().nullable(),
  /** Always all three, in attempt order. */
  checks: z.array(aiProviderTestCheckSchema),
  attemptedAt: z.iso.datetime(),
});

export class AiProviderTestResultDto extends createZodDto(aiProviderTestResultSchema) {}
export type AiProviderTestResult = z.infer<typeof aiProviderTestResultSchema>;
export type AiProviderTestCheck = z.infer<typeof aiProviderTestCheckSchema>;
