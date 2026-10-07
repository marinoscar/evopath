import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { decryptSecret, encryptSecret } from '@marinoscar/platform-api/core';
import { deriveHint } from '../../credentials/credential-internals';
import { PrismaService } from '../../prisma/prisma.service';
import { AiConfigService, providerCallSettings, providerPolicy } from '../config/ai-config.service';
import { withTimeout as withAiCallTimeout } from '../config/ai-provider-test.service';
import { AiError, type AiErrorCode } from '../core/ai-error';
import type { AiCallContext, AiProviderAdapter } from '../core/provider-adapter.interface';
import { AiProviderRegistry } from '../core/provider-registry';
import {
  AI_KEY_RECHECK_BATCH_SIZE,
  AI_KEY_RECHECK_MAX_AGE_MS,
  AI_USER_KEY_AUDIT_TARGET,
  AI_USER_KEY_PURPOSE,
} from './ai-user-key.constants';
import type {
  UserAiKeyTestCheck,
  UserAiKeyTestResult,
  UserAiKeyView,
} from './dto/user-ai-key.dto';

// =============================================================================
// UserAiKeysService — each user's own provider keys (issue #431, epic #419)
// =============================================================================
//
// The `pat.service.ts` pattern: every query is scoped by `{ userId, provider }`
// (never by a bare row id), so no code path here can reach another user's row.
//
// ⚠ THE KEY.
//   - Stored as `encryptSecret(apiKey, 'ai_user_key')` — ciphertext only.
//   - Every read that feeds a response SELECTS AROUND `secret`
//     (`VIEW_SELECT`), so the column never even enters this process for a
//     list/view.
//   - `getDecrypted` is the one plaintext read, and it exists for
//     `AiKeyResolver` alone. It is not reachable from any controller.
//   - Nothing here logs a key, puts one in an `AiError`, or writes one to an
//     audit row; provider error strings are redacted before they leave.
//
// NEVER TO A WORKER NODE. A user's key may never be brokered to a remote
// executor (docs/specs/ai-platform.md §2.20), so every provider round trip in
// this file runs on the server, and the recheck job type is server-only.
// =============================================================================

/** Every column a view needs — deliberately not `secret`. */
const VIEW_SELECT = {
  provider: true,
  hint: true,
  verifiedAt: true,
  lastErrorCode: true,
  reachableModelIds: true,
  reachableCheckedAt: true,
} satisfies Prisma.UserAiKeySelect;

type ViewRow = Prisma.UserAiKeyGetPayload<{ select: typeof VIEW_SELECT }>;

const LABELS = {
  credentials: 'API key accepted',
  list_models: 'Models this key can reach',
} as const;

/** What one probe of a key found. Never carries the key. */
export interface UserAiKeyProbe {
  credentials: UserAiKeyTestCheck;
  listModels: UserAiKeyTestCheck;
  /** Catalog model ids reachable with the key, when `list_models` passed; otherwise null. */
  reachableModelIds: string[] | null;
  /** The first failure, as an `AiError`, or null when both checks passed. */
  error: AiError | null;
}

/** Outcome of re-checking one stored key (`recheckReachable`). */
export type UserAiKeyRecheckOutcome = 'ok' | 'invalid' | 'missing' | 'failed';

/** What one `recheckStale` sweep did, per outcome. */
export type UserAiKeyRecheckCounts = Record<UserAiKeyRecheckOutcome, number>;

@Injectable()
export class UserAiKeysService {
  private readonly logger = new Logger(UserAiKeysService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfigService,
    private readonly registry: AiProviderRegistry,
  ) {}

  /**
   * One view per ENABLED provider (enabled in settings and registered here),
   * configured or not, in registry order. A key stored for a provider that is
   * no longer enabled is not listed — it cannot be used — but is kept.
   */
  async list(userId: string): Promise<UserAiKeyView[]> {
    const policy = await this.aiConfig.resolve();

    if (!policy.enabled) {
      return [];
    }

    const providers = this.registry.ids().filter((id) => providerPolicy(policy, id)?.enabled);

    if (providers.length === 0) {
      return [];
    }

    const rows = await this.prisma.userAiKey.findMany({
      where: { userId, provider: { in: providers } },
      select: VIEW_SELECT,
    });
    const byProvider = new Map(rows.map((row) => [row.provider, row]));

    return providers.map((provider) => toView(provider, byProvider.get(provider) ?? null));
  }

  /**
   * Verify, compute reachable models, then store — in that order, so a key the
   * provider refuses is never stored (`400 AI_KEY_INVALID`) and a provider
   * outage stores nothing either (its own error). Replaces any earlier key.
   */
  async set(userId: string, provider: string, apiKey: string): Promise<UserAiKeyView> {
    const { adapter, call } = await this.providerContext(provider);
    const probe = await this.probe(adapter, provider, apiKey, call);

    if (probe.error) {
      throw probe.error;
    }

    const now = new Date();
    const reachableModelIds = probe.reachableModelIds ?? [];
    const data = {
      secret: encryptSecret(apiKey, AI_USER_KEY_PURPOSE),
      hint: deriveHint(apiKey),
      verifiedAt: now,
      lastErrorCode: null,
      reachableModelIds,
      reachableCheckedAt: now,
    };

    const row = await this.prisma.userAiKey.upsert({
      where: { userId_provider: { userId, provider } },
      create: { userId, provider, ...data },
      update: data,
      select: VIEW_SELECT,
    });

    await this.audit(userId, 'ai_key:set', provider, { reachableCount: reachableModelIds.length });

    return toView(provider, row);
  }

  /** Delete the caller's key for `provider`. Idempotent: no key is not an error. */
  async remove(userId: string, provider: string): Promise<void> {
    const { count } = await this.prisma.userAiKey.deleteMany({ where: { userId, provider } });

    if (count > 0) {
      await this.audit(userId, 'ai_key:delete', provider, {});
    }
  }

  /**
   * Probe a key. Blank `apiKey` probes the STORED key, and only that probe
   * updates the stored row (verification, `lastErrorCode`, reachable models).
   * Never throws for a key or provider problem — the route answers 200.
   */
  async test(userId: string, provider: string, apiKey?: string | null): Promise<UserAiKeyTestResult> {
    const { adapter, call } = await this.providerContext(provider);
    const attemptedAt = new Date();
    const submitted = apiKey?.trim() ?? '';
    const usedStoredKey = submitted.length === 0;
    const key = usedStoredKey ? await this.getDecrypted(userId, provider) : submitted;

    if (!key) {
      const detail = 'Nothing was attempted: no key was submitted and none is stored.';

      return {
        success: false,
        provider,
        usedStoredKey,
        reachableModelCount: null,
        checks: [
          check('credentials', 'skipped', 'not_configured', detail),
          check('list_models', 'skipped', 'not_configured', detail),
        ],
        attemptedAt: attemptedAt.toISOString(),
      };
    }

    const probe = await this.probe(adapter, provider, key, call);

    if (usedStoredKey) {
      await this.recordProbe(userId, provider, probe, attemptedAt);
    }

    return {
      success: probe.error === null,
      provider,
      usedStoredKey,
      reachableModelCount: probe.reachableModelIds?.length ?? null,
      checks: [probe.credentials, probe.listModels],
      attemptedAt: attemptedAt.toISOString(),
    };
  }

  /**
   * The caller's key for `provider`, decrypted, or null when none is stored.
   *
   * ⚠ PLAINTEXT. For `AiKeyResolver` and this service's own probes ONLY —
   * never returned by a controller, never logged, never cached.
   */
  async getDecrypted(userId: string, provider: string): Promise<string | null> {
    const row = await this.prisma.userAiKey.findUnique({
      where: { userId_provider: { userId, provider } },
      select: { secret: true },
    });

    return row ? decryptSecret(row.secret, AI_USER_KEY_PURPOSE) : null;
  }

  /**
   * Re-verify one stored key and refresh its reachable models. Used by the
   * weekly `ai.keys.recheck` job.
   *
   * A revoked key (`AI_KEY_INVALID`) is RECORDED (`lastErrorCode`, `verifiedAt:
   * null`), never deleted — the user decides what to do about it. A rate limit
   * is rethrown so the job can defer; any other failure leaves the row as it
   * was, to be retried next time.
   */
  async recheckReachable(userId: string, provider: string): Promise<UserAiKeyRecheckOutcome> {
    const { adapter, call } = await this.providerContext(provider);
    const key = await this.getDecrypted(userId, provider);

    if (!key) {
      return 'missing';
    }

    const probe = await this.probe(adapter, provider, key, call);

    if (probe.error?.code === 'AI_RATE_LIMITED') {
      throw probe.error;
    }

    await this.recordProbe(userId, provider, probe, new Date());

    if (!probe.error) {
      return 'ok';
    }

    return probe.error.code === 'AI_KEY_INVALID' ? 'invalid' : 'failed';
  }

  /**
   * The cut-off below which a key's reachable list is stale for `provider`:
   * older than AI_KEY_RECHECK_MAX_AGE_MS, OR computed before the newest model
   * the catalog discovered for that provider — a key checked before a model
   * existed in `ai_models` cannot list it, however recently it was checked.
   */
  async staleCutoff(provider: string, now: Date = new Date()): Promise<Date> {
    const byAge = new Date(now.getTime() - AI_KEY_RECHECK_MAX_AGE_MS);
    const newest = await this.prisma.aiModel.findFirst({
      where: { provider },
      orderBy: { discoveredAt: 'desc' },
      select: { discoveredAt: true },
    });

    return newest && newest.discoveredAt > byAge ? newest.discoveredAt : byAge;
  }

  /**
   * Re-check every `provider` key whose reachable list was computed before
   * `olderThan` (or never), AI_KEY_RECHECK_BATCH_SIZE rows at a time, in id
   * order. For the `ai.keys.recheck` job ONLY — each key is one provider
   * round trip, which is exactly the work the queue exists to account for.
   *
   * A rate limit propagates (the job defers; rows already refreshed are no
   * longer stale, so the retry resumes where this left off). AI or the
   * provider being switched off mid-sweep propagates too — the handler treats
   * that as a normal stop.
   */
  async recheckStale(provider: string, olderThan: Date): Promise<UserAiKeyRecheckCounts> {
    const counts: UserAiKeyRecheckCounts = { ok: 0, invalid: 0, missing: 0, failed: 0 };
    let cursor: string | undefined;

    for (;;) {
      const rows = await this.prisma.userAiKey.findMany({
        where: {
          provider,
          OR: [{ reachableCheckedAt: null }, { reachableCheckedAt: { lt: olderThan } }],
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: AI_KEY_RECHECK_BATCH_SIZE,
        select: { id: true, userId: true },
      });

      for (const row of rows) {
        counts[await this.recheckReachable(row.userId, provider)] += 1;
      }

      if (rows.length < AI_KEY_RECHECK_BATCH_SIZE) {
        return counts;
      }

      cursor = rows[rows.length - 1].id;
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * The adapter and the slot's call settings (endpoint and, #448, the other
   * non-secret settings) for an enabled provider; throws `AI_DISABLED` /
   * `AI_PROVIDER_DISABLED`.
   */
  private async providerContext(
    provider: string,
  ): Promise<{ adapter: AiProviderAdapter; call: ReturnType<typeof providerCallSettings> }> {
    const slot = await this.aiConfig.assertProviderEnabled(provider);
    // `assertProviderEnabled` has just proven an adapter is registered.
    const adapter = this.registry.get(provider) as AiProviderAdapter;

    return { adapter, call: providerCallSettings(slot) };
  }

  /**
   * `verifyKey`, then `listModels` ∩ this provider's catalog rows (any row,
   * enabled or not, so an admin enabling a model later needs no recheck).
   * Never throws for a provider problem: failures come back in `error`.
   */
  private async probe(
    adapter: AiProviderAdapter,
    provider: string,
    apiKey: string,
    call: ReturnType<typeof providerCallSettings>,
  ): Promise<UserAiKeyProbe> {
    const redact = (text: string) => text.split(apiKey).join('[redacted]');
    const ctx = (signal: AbortSignal): AiCallContext => ({
      apiKey,
      ...call,
      signal,
      requestId: randomUUID(),
    });

    let credentials: UserAiKeyTestCheck;
    let error: AiError | null = null;

    try {
      const verification = await withAiCallTimeout((signal) => adapter.verifyKey(ctx(signal)));

      if (verification.ok) {
        credentials = check('credentials', 'passed', 'ok', `${adapter.displayName} accepted the key.`);
      } else {
        const code: AiErrorCode = verification.code ?? 'AI_KEY_INVALID';
        const rejected = code === 'AI_KEY_INVALID';

        error = new AiError(
          code,
          rejected
            ? `${adapter.displayName} rejected this API key.`
            : `${adapter.displayName} could not verify this API key.`,
          { details: { provider } },
        );
        credentials = check(
          'credentials',
          'failed',
          code,
          FAILURE_DETAIL[code] ?? GENERIC_FAILURE,
          verification.detail ? redact(verification.detail) : null,
        );
      }
    } catch (thrown) {
      error = AiError.wrap(thrown);
      credentials = failed('credentials', error, redact);
    }

    if (error) {
      return {
        credentials,
        listModels: check(
          'list_models',
          'skipped',
          'not_attempted',
          'Not attempted: the key was not accepted.',
        ),
        reachableModelIds: null,
        error,
      };
    }

    try {
      const models = await withAiCallTimeout((signal) => adapter.listModels(ctx(signal)));
      const ids = [...new Set(models.map((model) => model.id))];
      const rows =
        ids.length === 0
          ? []
          : await this.prisma.aiModel.findMany({
              where: { provider, modelId: { in: ids } },
              select: { modelId: true },
            });
      const reachableModelIds = rows.map((row) => row.modelId).sort();

      return {
        credentials,
        listModels: check(
          'list_models',
          'passed',
          'ok',
          `${reachableModelIds.length} catalog model(s) are reachable with this key.`,
        ),
        reachableModelIds,
        error: null,
      };
    } catch (thrown) {
      const listError = AiError.wrap(thrown);

      return {
        credentials,
        listModels: failed('list_models', listError, redact),
        reachableModelIds: null,
        error: listError,
      };
    }
  }

  /**
   * Write what a probe of the STORED key found. `updateMany`, scoped, so a key
   * deleted mid-probe is simply not resurrected.
   *
   * Only a rejected key changes `verifiedAt`/`lastErrorCode` on failure: a rate
   * limit or an outage says nothing about the key itself.
   */
  private async recordProbe(
    userId: string,
    provider: string,
    probe: UserAiKeyProbe,
    at: Date,
  ): Promise<void> {
    let data: Prisma.UserAiKeyUpdateManyMutationInput | null = null;

    if (probe.credentials.status === 'passed') {
      data = { verifiedAt: at, lastErrorCode: null };

      if (probe.reachableModelIds) {
        data.reachableModelIds = probe.reachableModelIds;
        data.reachableCheckedAt = at;
      }
    } else if (probe.error?.code === 'AI_KEY_INVALID') {
      data = { verifiedAt: null, lastErrorCode: 'AI_KEY_INVALID' };
    }

    if (data) {
      await this.prisma.userAiKey.updateMany({ where: { userId, provider }, data });
    }
  }

  /** Audit a key lifecycle act. `meta` carries counts and the provider — never a key. */
  private async audit(
    userId: string,
    action: 'ai_key:set' | 'ai_key:delete',
    provider: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: userId,
          action,
          targetType: AI_USER_KEY_AUDIT_TARGET,
          targetId: provider,
          meta: { provider, ...meta } as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      // The key write has already committed; failing the request now would
      // tell the user it did not.
      this.logger.error(
        `Could not audit ${action} for user ${userId} (${provider}): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

function toView(provider: string, row: ViewRow | null): UserAiKeyView {
  if (!row) {
    return {
      provider,
      configured: false,
      hint: null,
      verifiedAt: null,
      lastErrorCode: null,
      reachableModelCount: 0,
      reachableCheckedAt: null,
    };
  }

  return {
    provider,
    configured: true,
    hint: row.hint,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    reachableModelCount: row.reachableModelIds.length,
    reachableCheckedAt: row.reachableCheckedAt?.toISOString() ?? null,
  };
}

function check(
  id: 'credentials' | 'list_models',
  status: UserAiKeyTestCheck['status'],
  code: UserAiKeyTestCheck['code'],
  detail: string,
  error: string | null = null,
): UserAiKeyTestCheck {
  return { id, label: LABELS[id], status, code, detail, error };
}

const GENERIC_FAILURE = 'The provider refused the request. See the error for its reason.';

const FAILURE_DETAIL: Partial<Record<AiErrorCode, string>> = {
  AI_KEY_INVALID: 'The provider rejected the key. Check it was copied in full and has not been revoked.',
  AI_RATE_LIMITED: 'The provider rate-limited this key. Wait a moment and test again.',
  AI_PROVIDER_UNAVAILABLE: 'The provider could not be reached. Try again shortly.',
};

function failed(
  id: 'credentials' | 'list_models',
  error: AiError,
  redact: (text: string) => string,
): UserAiKeyTestCheck {
  return check(
    id,
    'failed',
    error.code,
    FAILURE_DETAIL[error.code] ?? GENERIC_FAILURE,
    redact(error.message),
  );
}
