import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { CredentialsService } from '../../credentials/credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AiError } from '../core/ai-error';
import { aiModelCapabilitiesSchema } from '../core/capabilities';
import { AI_KEYLESS_API_KEY, type AiCallContext, type AiProviderAdapter } from '../core/provider-adapter.interface';
import { AiConfigAdminService } from './ai-config-admin.service';
import { AiConfigService, providerCallSettings, providerPolicy, providerRequiresKey } from './ai-config.service';
import { AI_CREDENTIAL_PURPOSE, aiCredentialName } from './ai-credential.constants';
import type {
  AiProviderTestCheck,
  AiProviderTestResult,
  AiTestCheckCode,
  AiTestCheckId,
  AiTestCheckStatus,
  TestAiProviderInput,
} from './dto/ai-provider-test.dto';

// =============================================================================
// AiProviderTestService — "does this key work?" (issue #428, epic #419)
// =============================================================================
//
// Three checks, each reported separately, mirroring `StorageConnectionTestService`:
//
//   credentials      adapter.verifyKey
//   list_models      adapter.listModels — how many models the key can see
//   responses_smoke  one tiny responses call, ONLY when an admin-enabled,
//                    non-deprecated text model exists (otherwise skipped:
//                    testing a model nobody enabled proves nothing an admin
//                    asked about, and costs money on their account)
//
// NEVER THROWS for a key or connectivity problem — every such outcome is a
// check with `status: 'failed'`, and the route answers 200. It can still
// reject for a genuine fault (the database being down while auditing), which
// is a 500 and correctly so. An unknown provider is a 404, not a diagnosis.
//
// ⚠ THE KEY. A submitted key is used for this call only and never stored; a
// stored key is decrypted at the moment of use and never returned. Every
// `error` string is passed through `redact` before it leaves this file, and the
// audit row carries codes only.
// =============================================================================

/** Upper bound on any one provider call made by the probe. */
export const AI_TEST_CALL_TIMEOUT_MS = 15_000;

/**
 * Output-token budget for the smoke call. Not 1: OpenAI's Responses API rejects
 * `max_output_tokens` below 16, and a probe that fails on its own parameters
 * would report a working key as broken.
 */
export const AI_SMOKE_MAX_OUTPUT_TOKENS = 16;

const LABELS: Record<AiTestCheckId, string> = {
  credentials: 'API key accepted',
  list_models: 'Models visible to this key',
  responses_smoke: 'Test response',
};

@Injectable()
export class AiProviderTestService {
  private readonly logger = new Logger(AiProviderTestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly aiConfig: AiConfigService,
    private readonly admin: AiConfigAdminService,
  ) {}

  async test(
    provider: string,
    input: TestAiProviderInput,
    actorUserId: string,
  ): Promise<AiProviderTestResult> {
    const adapter = this.admin.requireRegistered(provider);
    const attemptedAt = new Date();
    const policy = await this.aiConfig.resolve({ fresh: true });

    const slot = providerPolicy(policy, provider);
    const submittedKey = input.apiKey ?? '';
    const storedKey =
      submittedKey.length === 0
        ? await this.credentials.getSecret(AI_CREDENTIAL_PURPOSE, aiCredentialName(provider))
        : null;
    const usedStoredKey = submittedKey.length === 0 && storedKey !== null;
    // A keyless provider (#448: `requiresKey: false`) is tested with no key at
    // all when none is submitted or stored — exactly how it will be called.
    const apiKey =
      submittedKey.length > 0 ? submittedKey : (storedKey ?? (providerRequiresKey(slot) ? null : AI_KEYLESS_API_KEY));
    // The slot's own settings, with a submitted endpoint taking the stored one's place.
    const call = providerCallSettings(slot);
    const baseUrl = input.baseUrl || call.baseUrl || undefined;

    if (!apiKey) {
      const detail = 'Nothing was attempted: no key was submitted and no admin key is stored.';

      return this.assemble(provider, usedStoredKey, attemptedAt, actorUserId, {
        checks: AI_TEST_CHECK_ORDER.map((id) => check(id, 'skipped', 'not_configured', detail)),
      });
    }

    const redact = (text: string) => text.split(apiKey).join('[redacted]');
    const ctx = (signal: AbortSignal): AiCallContext => ({
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      ...(call.providerSettings ? { providerSettings: call.providerSettings } : {}),
      signal,
      requestId: randomUUID(),
    });

    // 1. credentials
    let credentialsCheck: AiProviderTestCheck;

    try {
      const verification = await withTimeout((signal) => adapter.verifyKey(ctx(signal)));

      credentialsCheck = verification.ok
        ? check('credentials', 'passed', 'ok', `${adapter.displayName} accepted the key.`)
        : check(
            'credentials',
            'failed',
            verification.code ?? 'AI_KEY_INVALID',
            `${adapter.displayName} rejected the key. Check it was copied in full and has not been revoked.`,
            verification.detail ? redact(verification.detail) : null,
          );
    } catch (error) {
      credentialsCheck = failure('credentials', error, redact);
    }

    if (credentialsCheck.status !== 'passed') {
      return this.assemble(provider, usedStoredKey, attemptedAt, actorUserId, {
        checks: [credentialsCheck, notAttempted('list_models'), notAttempted('responses_smoke')],
      });
    }

    // 2. list_models
    let listCheck: AiProviderTestCheck;
    let visibleIds: Set<string> | null = null;

    try {
      const models = await withTimeout((signal) => adapter.listModels(ctx(signal)));
      visibleIds = new Set(models.map((model) => model.id));
      listCheck = check(
        'list_models',
        'passed',
        'ok',
        `${models.length} model(s) are visible to this key.`,
      );
    } catch (error) {
      listCheck = failure('list_models', error, redact);
    }

    if (listCheck.status !== 'passed') {
      return this.assemble(provider, usedStoredKey, attemptedAt, actorUserId, {
        checks: [credentialsCheck, listCheck, notAttempted('responses_smoke')],
      });
    }

    // 3. responses_smoke
    const smoke = await this.smoke(adapter, visibleIds, ctx, redact);

    return this.assemble(provider, usedStoredKey, attemptedAt, actorUserId, {
      checks: [credentialsCheck, listCheck, smoke.check],
      modelCount: visibleIds?.size ?? null,
      smokeModelId: smoke.modelId,
    });
  }

  private async smoke(
    adapter: AiProviderAdapter,
    visibleIds: Set<string> | null,
    ctx: (signal: AbortSignal) => AiCallContext,
    redact: (text: string) => string,
  ): Promise<{ check: AiProviderTestCheck; modelId: string | null }> {
    if (!adapter.responses) {
      return {
        check: check(
          'responses_smoke',
          'skipped',
          'not_supported',
          `${adapter.displayName} does not generate text responses in this deployment.`,
        ),
        modelId: null,
      };
    }

    const modelId = await this.pickSmokeModel(adapter.id, visibleIds);

    if (!modelId) {
      return {
        check: check(
          'responses_smoke',
          'skipped',
          'no_eligible_model',
          'Skipped: no enabled text model is visible to this key yet. Enable one in the model ' +
            'catalog to include a test response.',
        ),
        modelId: null,
      };
    }

    const responses = adapter.responses;

    try {
      await withTimeout((signal) =>
        responses.create(
          { model: modelId, input: 'Reply with the single word: ok', maxOutputTokens: AI_SMOKE_MAX_OUTPUT_TOKENS },
          ctx(signal),
        ),
      );

      return {
        check: check('responses_smoke', 'passed', 'ok', `"${modelId}" answered a test request.`),
        modelId,
      };
    } catch (error) {
      return { check: failure('responses_smoke', error, redact), modelId };
    }
  }

  /**
   * The cheapest-looking enabled, non-deprecated text model this key can see,
   * or null. "Cheapest-looking" is a naming heuristic (`nano` < `mini` <
   * anything else) — the catalog carries no prices — and the tie-break is the
   * id, so the choice is stable between runs.
   */
  private async pickSmokeModel(provider: string, visibleIds: Set<string> | null): Promise<string | null> {
    const rows = await this.prisma.aiModel.findMany({
      where: { provider, enabled: true, deprecatedAt: null },
      select: { modelId: true, capabilities: true },
    });

    const candidates = rows
      .filter((row) => {
        const parsed = aiModelCapabilitiesSchema.safeParse(row.capabilities);
        return parsed.success && parsed.data.capabilities.includes('responses');
      })
      .map((row) => row.modelId)
      .filter((id) => !visibleIds || visibleIds.has(id));

    const rank = (id: string) => (/nano/i.test(id) ? 0 : /mini/i.test(id) ? 1 : 2);

    candidates.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

    return candidates[0] ?? null;
  }

  /** Build the result and audit the attempt (every attempt, successful or not). */
  private async assemble(
    provider: string,
    usedStoredKey: boolean,
    attemptedAt: Date,
    actorUserId: string,
    parts: { checks: AiProviderTestCheck[]; modelCount?: number | null; smokeModelId?: string | null },
  ): Promise<AiProviderTestResult> {
    const { checks } = parts;
    const success =
      checks[0]?.status === 'passed' && checks.every((entry) => entry.status !== 'failed');

    const result: AiProviderTestResult = {
      success,
      provider,
      usedStoredKey,
      modelCount: parts.modelCount ?? null,
      smokeModelId: parts.smokeModelId ?? null,
      checks,
      attemptedAt: attemptedAt.toISOString(),
    };

    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action: 'ai_config:test',
        targetType: 'ai_config',
        targetId: provider,
        meta: {
          provider,
          success,
          usedStoredKey,
          // Codes only — `error` strings are the provider's words and belong in
          // the response an admin is reading, not in a table that outlives it.
          checks: checks.map((entry) => ({ id: entry.id, status: entry.status, code: entry.code })),
        } as Prisma.InputJsonValue,
      },
    });

    if (!success) {
      this.logger.warn(
        `AI provider test failed for "${provider}" (user ${actorUserId}): ` +
          checks
            .filter((entry) => entry.status !== 'passed')
            .map((entry) => `${entry.id}=${entry.code}`)
            .join(' '),
      );
    }

    return result;
  }
}

const AI_TEST_CHECK_ORDER: AiTestCheckId[] = ['credentials', 'list_models', 'responses_smoke'];

function check(
  id: AiTestCheckId,
  status: AiTestCheckStatus,
  code: AiTestCheckCode,
  detail: string,
  error: string | null = null,
): AiProviderTestCheck {
  return { id, label: LABELS[id], status, code, detail, error };
}

function notAttempted(id: AiTestCheckId): AiProviderTestCheck {
  return check(
    id,
    'skipped',
    'not_attempted',
    'Not attempted: an earlier check failed, so this one would say nothing useful.',
  );
}

/** A failed check from whatever the adapter threw — always as an `AiError`. */
function failure(
  id: AiTestCheckId,
  error: unknown,
  redact: (text: string) => string,
): AiProviderTestCheck {
  const aiError = AiError.wrap(error);

  return check(id, 'failed', aiError.code, FAILURE_DETAIL[aiError.code] ?? GENERIC_FAILURE, redact(aiError.message));
}

const GENERIC_FAILURE = 'The provider refused the request. See the error for its reason.';

const FAILURE_DETAIL: Partial<Record<AiError['code'], string>> = {
  AI_KEY_INVALID: 'The provider rejected the key. Check it was copied in full and has not been revoked.',
  AI_RATE_LIMITED: 'The provider rate-limited this key. Wait a moment and test again.',
  AI_PROVIDER_UNAVAILABLE:
    'The provider could not be reached. Check the base URL, and that this server can make outbound HTTPS requests.',
};

/**
 * Run `fn` with an abort signal that fires after AI_TEST_CALL_TIMEOUT_MS, and
 * reject with `AI_PROVIDER_UNAVAILABLE` at that point even if the adapter
 * ignores the signal.
 */
export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AiError('AI_PROVIDER_UNAVAILABLE', 'The provider did not answer in time.'));
    }, AI_TEST_CALL_TIMEOUT_MS);
  });

  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
