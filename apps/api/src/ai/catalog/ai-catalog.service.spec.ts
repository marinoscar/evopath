// =============================================================================
// AiCatalogService (issue #427, epic #419)
// =============================================================================
//
// The preservation rules are the point of this file (docs/specs/ai-platform.md
// §2.17): a refresh never turns a model on, never flips `enabled` on a model the
// provider still lists, never overwrites an `admin_override`, and deprecates +
// force-disables (never deletes) a model the provider withdrew.
//
// Prisma is an in-memory fake over `ai_models` rather than a call-by-call mock,
// so each test states a before/after table and the assertions read as the
// rules themselves rather than as a transcript of Prisma calls.
// =============================================================================

import type { Job } from '@prisma/client';

import type { CredentialsService } from '../../credentials/credentials.service';
import type { JobsService } from '../../jobs/jobs.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { AiError } from '../core/ai-error';
import { AiModelCapabilities } from '../core/capabilities';
import { AI_KEYLESS_API_KEY } from '../core/provider-adapter.interface';
import { AiProviderRegistry } from '../core/provider-registry';
import { FAKE_TEXT_MODEL_CAPABILITIES, FakeAiProvider } from '../testing/fake-ai-provider';
import {
  AiCatalogService,
  AiCatalogSyncCounts,
  canonicalJson,
  EMPTY_AI_MODEL_CAPABILITIES,
} from './ai-catalog.service';

// ---- In-memory Prisma ---------------------------------------------------------

interface ModelRow {
  id: string;
  provider: string;
  modelId: string;
  capabilities: unknown;
  capabilitySource: string;
  enabled: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  discoveredAt: Date;
  lastSeenAt: Date;
  deprecatedAt: Date | null;
}

type IdFilter = { id: { in: string[] }; enabled?: boolean };

class FakePrisma {
  rows: ModelRow[] = [];
  usage: Record<string, unknown>[] = [];
  audits: Record<string, unknown>[] = [];
  private seq = 0;

  readonly aiModel = {
    findMany: jest.fn(async ({ where }: { where: { provider: string } }) =>
      this.rows.filter((row) => row.provider === where.provider).map((row) => ({ ...row })),
    ),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<ModelRow> }) => {
      const row = this.rows.find((candidate) => candidate.id === where.id)!;
      Object.assign(row, data);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: { where: IdFilter; data: Partial<ModelRow> }) => {
      const matched = this.rows.filter(
        (row) =>
          where.id.in.includes(row.id) &&
          (where.enabled === undefined || row.enabled === where.enabled),
      );
      matched.forEach((row) => Object.assign(row, data));
      return { count: matched.length };
    }),
    createMany: jest.fn(async ({ data }: { data: Partial<ModelRow>[] }) => {
      for (const input of data) {
        const defaults = { contextWindow: null, maxOutputTokens: null, deprecatedAt: null };
        this.rows.push({ ...defaults, ...input, id: `row-${++this.seq}` } as ModelRow);
      }
      return { count: data.length };
    }),
  };

  readonly aiUsageEvent = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      this.usage.push(data);
      return data;
    }),
  };

  readonly auditEvent = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      this.audits.push(data);
      return data;
    }),
  };

  readonly $transaction = jest.fn(async (fn: (tx: FakePrisma) => Promise<unknown>) => fn(this));

  seed(row: Partial<ModelRow> & { modelId: string }): ModelRow {
    const full: ModelRow = {
      id: `row-${++this.seq}`,
      provider: 'fake',
      capabilities: FAKE_TEXT_MODEL_CAPABILITIES,
      capabilitySource: 'catalog',
      enabled: false,
      contextWindow: null,
      maxOutputTokens: null,
      discoveredAt: new Date('2000-01-01T00:00:00Z'),
      lastSeenAt: new Date('2000-01-01T00:00:00Z'),
      deprecatedAt: null,
      ...row,
    };
    this.rows.push(full);
    return full;
  }

  row(modelId: string): ModelRow {
    return this.rows.find((row) => row.modelId === modelId)!;
  }
}

// ---- Harness --------------------------------------------------------------------

const ADMIN_KEY = 'sk-admin-discovery';

interface HarnessOptions {
  /** Extra settings on the provider's slot (#448). */
  slot?: Record<string, unknown>;
  aiEnabled?: boolean;
  providerEnabled?: boolean;
  baseUrl?: string;
  adminKey?: string | null;
  register?: boolean;
  provider?: FakeAiProvider;
}

function makeHarness(options: HarnessOptions = {}) {
  const prisma = new FakePrisma();
  const provider = options.provider ?? new FakeAiProvider({ models: ['m-a', 'm-b'] });
  const registry = new AiProviderRegistry();

  if (options.register !== false) {
    registry.register(provider);
  }

  const getAiPolicy = jest.fn().mockResolvedValue({
    enabled: options.aiEnabled ?? true,
    keyPolicy: 'byok',
    providers: {
      openai: { enabled: false },
      [provider.id]: {
        enabled: options.providerEnabled ?? true,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.slot ?? {}),
      },
    },
    defaults: { allowBackgroundRuns: false },
    logPromptContent: false,
  });
  const getSecret = jest
    .fn()
    .mockResolvedValue(options.adminKey === undefined ? ADMIN_KEY : options.adminKey);
  const enqueue = jest.fn().mockResolvedValue({ id: 'job-9' } as Job);

  const service = new AiCatalogService(
    prisma as unknown as PrismaService,
    { getAiPolicy } as unknown as SystemSettingsService,
    { getSecret } as unknown as CredentialsService,
    registry,
    { enqueue } as unknown as JobsService,
  );

  return { service, prisma, provider, getSecret, enqueue, getAiPolicy };
}

function fakeWith(models: string[], classify?: (id: string) => AiModelCapabilities | null) {
  return new FakeAiProvider({ models, ...(classify ? { classify } : {}) });
}

const OVERRIDE: AiModelCapabilities = {
  capabilities: ['responses'],
  inputModalities: ['text'],
  outputModalities: ['text'],
};

// ---- Tests ---------------------------------------------------------------------

describe('AiCatalogService.sync', () => {
  describe('gates (no provider call, no rows touched)', () => {
    it('skips with AI_DISABLED when the kill switch is off', async () => {
      const h = makeHarness({ aiEnabled: false });

      await expect(h.service.sync('fake')).resolves.toEqual({ skipped: 'AI_DISABLED' });
      expect(h.provider.calls).toHaveLength(0);
      expect(h.getSecret).not.toHaveBeenCalled();
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
      expect(h.prisma.usage).toHaveLength(0);
      expect(h.prisma.audits).toHaveLength(0);
    });

    it('skips with AI_PROVIDER_DISABLED when this provider is off', async () => {
      const h = makeHarness({ providerEnabled: false });

      await expect(h.service.sync('fake')).resolves.toEqual({ skipped: 'AI_PROVIDER_DISABLED' });
      expect(h.provider.calls).toHaveLength(0);
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('skips with AI_PROVIDER_DISABLED for a provider id the policy does not know', async () => {
      const h = makeHarness();

      await expect(h.service.sync('nope')).resolves.toEqual({ skipped: 'AI_PROVIDER_DISABLED' });
    });

    it('skips with PROVIDER_NOT_REGISTERED when no adapter is registered', async () => {
      const h = makeHarness({ register: false });

      await expect(h.service.sync('fake')).resolves.toEqual({ skipped: 'PROVIDER_NOT_REGISTERED' });
      expect(h.getSecret).not.toHaveBeenCalled();
    });

    it('skips with NO_ADMIN_KEY when no admin key is stored', async () => {
      const h = makeHarness({ adminKey: null });

      await expect(h.service.sync('fake')).resolves.toEqual({ skipped: 'NO_ADMIN_KEY' });
      expect(h.provider.calls).toHaveLength(0);
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
      expect(h.prisma.usage).toHaveLength(0);
    });

    it('discovers a keyless provider (#448) with no admin key, passing its slot settings', async () => {
      const h = makeHarness({ adminKey: null, slot: { requiresKey: false, apiStyle: 'chat_completions' } });

      await expect(h.service.sync('fake')).resolves.toMatchObject({ added: 2 });
      expect(h.provider.calls).toHaveLength(1);
      expect(h.provider.calls[0]).toMatchObject({
        apiKey: AI_KEYLESS_API_KEY,
        providerSettings: { requiresKey: false, apiStyle: 'chat_completions' },
      });
    });
  });

  describe('the admin key', () => {
    it('reads the admin key from the credential store at (ai, <provider>)', async () => {
      const h = makeHarness();

      await h.service.sync('fake');

      expect(h.getSecret).toHaveBeenCalledWith('ai', 'fake');
    });

    it('calls the adapter with the admin key and the configured base URL', async () => {
      const h = makeHarness({ baseUrl: 'https://proxy.example.com/v1' });

      await h.service.sync('fake');

      const calls = h.provider.callsTo('listModels');
      expect(calls).toHaveLength(1);
      expect(calls[0].apiKey).toBe(ADMIN_KEY);
      expect(calls[0].baseUrl).toBe('https://proxy.example.com/v1');
      expect(calls[0].requestId).toEqual(expect.any(String));
    });

    it('records one catalog usage row with keySource admin_discovery', async () => {
      const h = makeHarness();

      await h.service.sync('fake', { jobId: 'job-1' });

      expect(h.prisma.usage).toEqual([
        expect.objectContaining({
          userId: null,
          provider: 'fake',
          modelId: '*',
          operation: 'catalog',
          keySource: 'admin_discovery',
          status: 'succeeded',
          errorCode: null,
          jobId: 'job-1',
          latencyMs: expect.any(Number),
        }),
      ]);
    });

    it('never writes the key into the usage or audit rows', async () => {
      const h = makeHarness();

      await h.service.sync('fake', { actorUserId: 'admin-1' });

      expect(JSON.stringify([h.prisma.usage, h.prisma.audits])).not.toContain(ADMIN_KEY);
    });
  });

  describe('first sync', () => {
    it('inserts every model disabled, classified or unclassified', async () => {
      const provider = fakeWith(['known', 'mystery'], (id) =>
        id === 'known' ? FAKE_TEXT_MODEL_CAPABILITIES : null,
      );
      const h = makeHarness({ provider });

      const result = await h.service.sync('fake');

      expect(result).toEqual({ added: 2, updated: 0, deprecated: 0, total: 2 });
      expect(h.prisma.rows).toHaveLength(2);
      expect(h.prisma.rows.every((row) => row.enabled === false)).toBe(true);

      expect(h.prisma.row('known')).toMatchObject({
        provider: 'fake',
        capabilitySource: 'catalog',
        capabilities: FAKE_TEXT_MODEL_CAPABILITIES,
        contextWindow: FAKE_TEXT_MODEL_CAPABILITIES.contextWindow,
        maxOutputTokens: FAKE_TEXT_MODEL_CAPABILITIES.maxOutputTokens,
        deprecatedAt: null,
      });
      expect(h.prisma.row('mystery')).toMatchObject({
        capabilitySource: 'unclassified',
        capabilities: EMPTY_AI_MODEL_CAPABILITIES,
        contextWindow: null,
      });
      expect(h.prisma.row('known').discoveredAt).toEqual(h.prisma.row('known').lastSeenAt);
    });

    it('stores an invalid classifier output as unclassified rather than trusting it', async () => {
      const provider = fakeWith(['weird'], () => ({ capabilities: ['teleport'] }) as never);
      const h = makeHarness({ provider });

      await h.service.sync('fake');

      expect(h.prisma.row('weird').capabilitySource).toBe('unclassified');
      expect(h.prisma.row('weird').capabilities).toEqual(EMPTY_AI_MODEL_CAPABILITIES);
    });

    it('hands the listing metadata of each id back to the classifier (#447)', async () => {
      const provider = fakeWith(['rich', 'plain']);
      const classify = jest.spyOn(provider, 'classifyModel').mockImplementation((_id, metadata) =>
        metadata?.outputTokenLimit
          ? { ...FAKE_TEXT_MODEL_CAPABILITIES, maxOutputTokens: metadata.outputTokenLimit }
          : FAKE_TEXT_MODEL_CAPABILITIES,
      );
      jest.spyOn(provider, 'listModels').mockResolvedValue([
        { id: 'rich', metadata: { outputTokenLimit: 12_345, supportedActions: ['generateContent'] } },
        // A repeat of an id keeps the FIRST listing's metadata, like the id itself.
        { id: 'rich', metadata: { outputTokenLimit: 1 } },
        { id: 'plain' },
      ]);
      const h = makeHarness({ provider });

      await h.service.sync('fake');

      expect(classify).toHaveBeenCalledWith('rich', { outputTokenLimit: 12_345, supportedActions: ['generateContent'] });
      // No metadata -> the one-argument call every existing classifier expects.
      expect(classify).toHaveBeenCalledWith('plain');
      expect(h.prisma.row('rich')).toMatchObject({ maxOutputTokens: 12_345 });
      expect(h.prisma.row('plain')).toMatchObject({ maxOutputTokens: FAKE_TEXT_MODEL_CAPABILITIES.maxOutputTokens });
    });

    it('deduplicates repeated ids in the listing', async () => {
      const h = makeHarness({ provider: fakeWith(['dup', 'dup', 'other']) });

      const result = await h.service.sync('fake');

      expect(result).toMatchObject({ added: 2, total: 2 });
      expect(h.prisma.rows).toHaveLength(2);
    });

    it('writes an ai_catalog:refresh audit row with the counts', async () => {
      const h = makeHarness();

      await h.service.sync('fake', { actorUserId: 'admin-1' });

      expect(h.prisma.audits).toEqual([
        {
          actorUserId: 'admin-1',
          action: 'ai_catalog:refresh',
          targetType: 'ai_provider',
          targetId: 'fake',
          meta: { added: 2, updated: 0, deprecated: 0 },
        },
      ]);
    });

    it('audits a cron-driven sync with no actor', async () => {
      const h = makeHarness();

      await h.service.sync('fake');

      expect(h.prisma.audits[0].actorUserId).toBeNull();
    });

    it('runs the writes inside one transaction', async () => {
      const h = makeHarness();

      await h.service.sync('fake');

      expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('re-sync preservation rules', () => {
    it('preserves an admin enablement and an admin capability override', async () => {
      const h = makeHarness({ provider: fakeWith(['enabled-one', 'overridden']) });
      const enabled = h.prisma.seed({ modelId: 'enabled-one', enabled: true });
      const overridden = h.prisma.seed({
        modelId: 'overridden',
        capabilitySource: 'admin_override',
        capabilities: OVERRIDE,
      });

      const result = await h.service.sync('fake');

      expect(h.prisma.row('enabled-one').enabled).toBe(true);
      expect(h.prisma.row('overridden')).toMatchObject({
        capabilitySource: 'admin_override',
        capabilities: OVERRIDE,
        enabled: false,
      });
      expect(result).toEqual({ added: 0, updated: 0, deprecated: 0, total: 2 });
      expect(h.prisma.row('enabled-one').lastSeenAt.getTime()).toBeGreaterThan(
        enabled.discoveredAt.getTime(),
      );
      expect(h.prisma.row('overridden').lastSeenAt.getTime()).toBeGreaterThan(
        overridden.discoveredAt.getTime(),
      );
    });

    it('never writes `enabled` for a model still listed', async () => {
      const h = makeHarness({ provider: fakeWith(['a']) });
      h.prisma.seed({ modelId: 'a', enabled: true, capabilitySource: 'unclassified', capabilities: EMPTY_AI_MODEL_CAPABILITIES });

      await h.service.sync('fake');

      for (const call of h.prisma.aiModel.update.mock.calls) {
        expect(call[0].data).not.toHaveProperty('enabled');
      }
      expect(h.prisma.row('a').enabled).toBe(true);
    });

    it('refreshes non-override capabilities when the classifier learns a model', async () => {
      const h = makeHarness({ provider: fakeWith(['late']) });
      h.prisma.seed({
        modelId: 'late',
        capabilitySource: 'unclassified',
        capabilities: EMPTY_AI_MODEL_CAPABILITIES,
      });

      const result = await h.service.sync('fake');

      expect(h.prisma.row('late')).toMatchObject({
        capabilitySource: 'catalog',
        capabilities: FAKE_TEXT_MODEL_CAPABILITIES,
        contextWindow: FAKE_TEXT_MODEL_CAPABILITIES.contextWindow,
      });
      expect(result).toMatchObject({ updated: 1 });
    });

    it('does not count an unchanged row as updated, whatever its JSON key order', async () => {
      const reordered = JSON.parse(
        canonicalJson(FAKE_TEXT_MODEL_CAPABILITIES),
      ) as AiModelCapabilities;
      const h = makeHarness({ provider: fakeWith(['same']) });
      h.prisma.seed({ modelId: 'same', capabilities: reordered });

      const result = await h.service.sync('fake');

      expect(result).toMatchObject({ updated: 0 });
      expect(h.prisma.aiModel.update).not.toHaveBeenCalled();
    });
  });

  describe('withdrawn and returning models', () => {
    it('deprecates and force-disables a model the provider no longer lists, without deleting it', async () => {
      const h = makeHarness({ provider: fakeWith(['stays']) });
      h.prisma.seed({ modelId: 'stays', enabled: true });
      h.prisma.seed({ modelId: 'gone', enabled: true });

      const result = await h.service.sync('fake');

      expect(result).toEqual({ added: 0, updated: 0, deprecated: 1, total: 1 });
      expect(h.prisma.rows).toHaveLength(2);
      expect(h.prisma.row('gone').deprecatedAt).toBeInstanceOf(Date);
      expect(h.prisma.row('gone').enabled).toBe(false);
      expect(h.prisma.row('stays').enabled).toBe(true);
    });

    it('keeps the original deprecation date on a later sync, but still forces enabled off', async () => {
      const deprecatedAt = new Date('2026-02-02T00:00:00Z');
      const h = makeHarness({ provider: fakeWith(['stays']) });
      h.prisma.seed({ modelId: 'stays' });
      h.prisma.seed({ modelId: 'gone', deprecatedAt, enabled: true });

      const result = await h.service.sync('fake');

      expect(h.prisma.row('gone').deprecatedAt).toEqual(deprecatedAt);
      expect(h.prisma.row('gone').enabled).toBe(false);
      expect(result).toMatchObject({ deprecated: 0 });
    });

    it('clears deprecatedAt when a model reappears, but leaves it disabled', async () => {
      const h = makeHarness({ provider: fakeWith(['back']) });
      h.prisma.seed({ modelId: 'back', deprecatedAt: new Date('2026-02-02T00:00:00Z') });

      const result = await h.service.sync('fake');

      expect(h.prisma.row('back').deprecatedAt).toBeNull();
      expect(h.prisma.row('back').enabled).toBe(false);
      expect(result).toMatchObject({ updated: 1, deprecated: 0 });
    });

    it('full cycle: disappear then reappear', async () => {
      const h = makeHarness({ provider: fakeWith(['a', 'b']) });
      await h.service.sync('fake');
      h.prisma.row('b').enabled = true; // an administrator enables it

      const shrunk = makeHarness({ provider: fakeWith(['a']) });
      shrunk.prisma.rows = h.prisma.rows;
      await shrunk.service.sync('fake');
      expect(h.prisma.row('b')).toMatchObject({ enabled: false });
      expect(h.prisma.row('b').deprecatedAt).toBeInstanceOf(Date);

      const grown = makeHarness({ provider: fakeWith(['a', 'b']) });
      grown.prisma.rows = h.prisma.rows;
      await grown.service.sync('fake');
      expect(h.prisma.row('b')).toMatchObject({ enabled: false, deprecatedAt: null });
    });

    it('only touches rows of the provider being synced', async () => {
      const h = makeHarness({ provider: fakeWith(['a']) });
      h.prisma.seed({ modelId: 'x', provider: 'openai', enabled: true });

      await h.service.sync('fake');

      expect(h.prisma.row('x')).toMatchObject({ enabled: true, deprecatedAt: null });
    });

    it('refuses an empty listing while live rows exist, leaving the catalog unchanged', async () => {
      const h = makeHarness({ provider: fakeWith([]) });
      h.prisma.seed({ modelId: 'a', enabled: true });

      const error = await h.service.sync('fake').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AiError);
      expect((error as AiError).code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(h.prisma.row('a')).toMatchObject({ enabled: true, deprecatedAt: null });
      expect(h.prisma.audits).toHaveLength(0);
    });

    it('accepts an empty listing when there is nothing live to lose', async () => {
      const h = makeHarness({ provider: fakeWith([]) });

      await expect(h.service.sync('fake')).resolves.toEqual({
        added: 0,
        updated: 0,
        deprecated: 0,
        total: 0,
      } satisfies AiCatalogSyncCounts);
    });
  });

  describe('provider failures', () => {
    it('records a failed usage row and rethrows the AiError, touching no rows', async () => {
      const h = makeHarness({ adminKey: 'rejected-key', provider: new FakeAiProvider({ validKeys: ['other'] }) });
      h.prisma.seed({ modelId: 'fake-model', enabled: true });

      const error = await h.service.sync('fake').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AiError);
      expect((error as AiError).code).toBe('AI_KEY_INVALID');
      expect(h.prisma.usage).toEqual([
        expect.objectContaining({
          status: 'failed',
          errorCode: 'AI_KEY_INVALID',
          keySource: 'admin_discovery',
        }),
      ]);
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
      expect(h.prisma.audits).toHaveLength(0);
    });

    it('wraps a raw adapter error as AI_PROVIDER_UNAVAILABLE', async () => {
      const provider = new FakeAiProvider();
      jest.spyOn(provider, 'listModels').mockRejectedValue(new Error('socket hang up'));
      const h = makeHarness({ provider });

      const error = await h.service.sync('fake').catch((e: unknown) => e);

      expect((error as AiError).code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(h.prisma.usage[0]).toMatchObject({ errorCode: 'AI_PROVIDER_UNAVAILABLE' });
    });

    it('passes a rate limit through as AI_RATE_LIMITED for the handler to defer', async () => {
      const provider = new FakeAiProvider();
      jest
        .spyOn(provider, 'listModels')
        .mockRejectedValue(new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 500 }));
      const h = makeHarness({ provider });

      const error = await h.service.sync('fake').catch((e: unknown) => e);

      expect((error as AiError).code).toBe('AI_RATE_LIMITED');
    });
  });
});

describe('AiCatalogService.enqueueRefresh', () => {
  it('queues ai.catalog.refresh keyed by the provider subject', async () => {
    const h = makeHarness();

    const job = await h.service.enqueueRefresh('openai', 'admin-1');

    expect(job).toEqual({ id: 'job-9' });
    expect(h.enqueue).toHaveBeenCalledWith({
      type: 'ai.catalog.refresh',
      reason: 'rerun',
      subjectType: 'ai_provider',
      subjectId: 'openai',
      payload: { providerId: 'openai', actorUserId: 'admin-1' },
    });
  });

  it('omits the actor when none is given', async () => {
    const h = makeHarness();

    await h.service.enqueueRefresh('openai');

    expect(h.enqueue.mock.calls[0][0].payload).toEqual({ providerId: 'openai' });
  });
});
