// =============================================================================
// A wired AI runtime for unit tests (issue #432). TEST-ONLY.
//
// The REAL `AiService`, `AiConfigService`, `AiKeyResolver`,
// `UsableModelsService`, `AiUsageRecorder` and `AiRunsService`, over:
//
//   - `FakeAiProvider` registered as `openai` (the only id the settings
//     schema has a slot for), recording every call and the key it carried,
//     with its embeddings, images, audio and realtime ports on and classifying each model
//     exactly as the catalog row below does;
//   - the REAL `AiStorageInputResolver` and `AiOutputWriter` (#437) over the
//     in-memory object storage from `in-memory-ai-storage.ts`;
//   - the in-memory key/model tables from `in-memory-ai-keys-prisma.ts`,
//     extended with `user_settings`, `ai_usage_events` and `ai_runs`;
//   - a stubbed settings row, org credential and job queue.
//
// So a gate test exercises the same code path production does, and "the
// org key was never used" is a fact about the fake's recorded calls rather
// than about a mock's expectations. Reusable by the HTTP surface (#433).
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { Job } from '@prisma/client';

import { AiConfigService, type AiPolicy, type AiProviderPolicy } from '../config/ai-config.service';
import type { AiModelCapabilities } from '../core/capabilities';
import { AiProviderRegistry } from '../core/provider-registry';
import { AiKeyResolver } from '../keys/ai-key-resolver.service';
import { UsableModelsService } from '../keys/usable-models.service';
import { AiService } from '../runtime/ai.service';
import { AiLimitsService, type AiLimitsClock } from '../runtime/ai-limits.service';
import { AiRunsService } from '../runtime/ai-runs.service';
import { AiUsageRecorder } from '../runtime/ai-usage.recorder';
import { AiOutputWriter } from '../storage/ai-output-writer';
import { AiStorageInputResolver } from '../storage/ai-storage-input.resolver';
import {
  FAKE_EMBEDDING_MODEL_CAPABILITIES,
  FAKE_IMAGE_MODEL_CAPABILITIES,
  FAKE_REALTIME_MODEL_CAPABILITIES,
  FAKE_SPEECH_MODEL_CAPABILITIES,
  FAKE_TEXT_MODEL_CAPABILITIES,
  FAKE_TRANSCRIPTION_MODEL_CAPABILITIES,
  FakeAiProvider,
  type FakeAiProviderOptions,
} from './fake-ai-provider';
import { createInMemoryAiKeysPrisma } from './in-memory-ai-keys-prisma';
import { createInMemoryAiStorage } from './in-memory-ai-storage';

export const HARNESS_USER = '11111111-1111-4111-8111-111111111111';
export const HARNESS_OTHER_USER = '22222222-2222-4222-8222-222222222222';
export const HARNESS_USER_KEY = 'sk-user-own-key-1111';
export const HARNESS_ORG_KEY = 'sk-org-admin-key-9999';
export const HARNESS_PROVIDER = 'openai';
export const HARNESS_MODEL = 'fake-model';
/** The default catalog's embedding model (`FAKE_EMBEDDING_MODEL_CAPABILITIES`). */
export const HARNESS_EMBEDDING_MODEL = 'fake-embedding-model';
/** The default catalog's image model (`FAKE_IMAGE_MODEL_CAPABILITIES`: generate + edit). */
export const HARNESS_IMAGE_MODEL = 'fake-image-model';
/** The default catalog's transcription model (`FAKE_TRANSCRIPTION_MODEL_CAPABILITIES`). */
export const HARNESS_TRANSCRIPTION_MODEL = 'fake-transcription-model';
/** The default catalog's speech model (`FAKE_SPEECH_MODEL_CAPABILITIES`: voices alloy, echo). */
export const HARNESS_SPEECH_MODEL = 'fake-speech-model';
/** The default catalog's realtime model (`FAKE_REALTIME_MODEL_CAPABILITIES`: voices marin, alloy). */
export const HARNESS_REALTIME_MODEL = 'fake-realtime-model';

export interface HarnessModel {
  modelId: string;
  capabilities?: AiModelCapabilities;
  enabled?: boolean;
  deprecatedAt?: Date | null;
}

export interface AiRuntimeHarnessOptions {
  /** Merged over an enabled, byok, openai-on, no-cap policy. */
  policy?: Partial<Omit<AiPolicy, 'providers' | 'defaults' | 'hostedTools'>> & {
    /** Merged over every hosted tool switched off. */
    hostedTools?: Partial<AiPolicy['hostedTools']>;
    providerEnabled?: boolean;
    baseUrl?: string;
    /**
     * Extra settings on the fake's (`openai`) slot — the #448 fields
     * (`apiStyle`, `requiresKey`, ...), which the runtime reads generically
     * off whichever slot a provider has.
     */
    providerSlot?: Omit<AiProviderPolicy, 'enabled' | 'baseUrl'>;
    defaults?: Partial<AiPolicy['defaults']>;
  };
  /** Whether `HARNESS_USER` has a key. Default true. */
  userKey?: boolean;
  /** Models the user's key reaches. Default: every catalog model. */
  reachable?: string[];
  /** Whether an org key is stored. Default false. */
  orgKey?: boolean;
  /**
   * Catalog rows. Default: a fully capable `fake-model`, `fake-embedding-model`,
   * `fake-image-model`, `fake-transcription-model`, `fake-speech-model` and
   * `fake-realtime-model`.
   */
  models?: HarnessModel[];
  fake?: FakeAiProviderOptions;
  /** `HARNESS_USER`'s `ai.defaultModel` setting. Default none. */
  defaultModel?: { provider: string; modelId: string } | null;
  /** Register the fake provider at all. Default true. */
  registerProvider?: boolean;
  /**
   * The clock `AiLimitsService` reads and usage rows are stamped with (#450).
   * Default: the real `Date.now`.
   */
  clock?: AiLimitsClock;
}

export interface StoredAiRun {
  id: string;
  userId: string | null;
  jobId: string | null;
  status: string;
  provider: string;
  modelId: string;
  request: unknown;
  output: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

type Where = Record<string, any>;

function matchesRun(row: StoredAiRun, where: Where = {}): boolean {
  for (const [key, expected] of Object.entries(where)) {
    const actual = (row as unknown as Record<string, unknown>)[key];

    if (expected && typeof expected === 'object' && 'in' in expected) {
      if (!(expected.in as unknown[]).includes(actual)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }

  return true;
}

/**
 * The `ai_usage_events` filters `AiLimitsService` uses: equality, `{ in }`,
 * and `{ gt }` / `{ gte }` on a Date column.
 */
function matchesUsage(row: Record<string, any>, where: Where = {}): boolean {
  for (const [key, expected] of Object.entries(where)) {
    const actual = row[key];

    if (expected instanceof Date) {
      if (!(actual instanceof Date) || actual.getTime() !== expected.getTime()) return false;
    } else if (expected && typeof expected === 'object') {
      if ('in' in expected && !(expected.in as unknown[]).includes(actual)) return false;
      if ('gte' in expected && !(actual instanceof Date && actual.getTime() >= (expected.gte as Date).getTime())) {
        return false;
      }
      if ('gt' in expected && !(actual instanceof Date && actual.getTime() > (expected.gt as Date).getTime())) {
        return false;
      }
      if ('not' in expected && actual === expected.not) return false;
    } else if (actual !== expected) {
      return false;
    }
  }

  return true;
}

function pick(row: object, select?: Record<string, boolean>): Record<string, unknown> {
  const source = row as Record<string, unknown>;

  if (!select) return { ...source };

  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, source[k]]));
}

export function createAiRuntimeHarness(opts: AiRuntimeHarnessOptions = {}) {
  const db = createInMemoryAiKeysPrisma();
  const usageEvents: Array<Record<string, any>> = [];
  const clock: AiLimitsClock = opts.clock ?? (() => Date.now());
  const runRows: StoredAiRun[] = [];
  const enqueued: Array<Record<string, any>> = [];
  const settings = new Map<string, unknown>();

  const models = opts.models ?? [
    { modelId: HARNESS_MODEL },
    { modelId: HARNESS_EMBEDDING_MODEL, capabilities: FAKE_EMBEDDING_MODEL_CAPABILITIES },
    { modelId: HARNESS_IMAGE_MODEL, capabilities: FAKE_IMAGE_MODEL_CAPABILITIES },
    { modelId: HARNESS_TRANSCRIPTION_MODEL, capabilities: FAKE_TRANSCRIPTION_MODEL_CAPABILITIES },
    { modelId: HARNESS_SPEECH_MODEL, capabilities: FAKE_SPEECH_MODEL_CAPABILITIES },
    { modelId: HARNESS_REALTIME_MODEL, capabilities: FAKE_REALTIME_MODEL_CAPABILITIES },
  ];

  for (const model of models) {
    db.addModel({
      provider: HARNESS_PROVIDER,
      modelId: model.modelId,
      capabilities: model.capabilities ?? FAKE_TEXT_MODEL_CAPABILITIES,
      enabled: model.enabled ?? true,
      deprecatedAt: model.deprecatedAt ?? null,
    });
  }

  const addUserKey = (userId: string, secret: string, reachable: string[]) => {
    db.keys.push({
      id: randomUUID(),
      userId,
      provider: HARNESS_PROVIDER,
      secret,
      hint: null,
      verifiedAt: new Date(),
      lastErrorCode: null,
      reachableModelIds: reachable,
      reachableCheckedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  };

  if (opts.userKey ?? true) {
    addUserKey(HARNESS_USER, HARNESS_USER_KEY, opts.reachable ?? models.map((m) => m.modelId));
  }

  if (opts.defaultModel) {
    settings.set(HARNESS_USER, { theme: 'system', ai: { defaultModel: opts.defaultModel } });
  }

  const p = opts.policy ?? {};
  const policy: AiPolicy = {
    enabled: p.enabled ?? true,
    keyPolicy: p.keyPolicy ?? 'byok',
    providers: {
      openai: {
        enabled: p.providerEnabled ?? true,
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        ...(p.providerSlot ?? {}),
      } as AiPolicy['providers']['openai'],
      anthropic: { enabled: false },
      gemini: { enabled: false },
      'azure-openai': { enabled: false },
      'openai-compatible': { enabled: false },
    },
    defaults: { allowBackgroundRuns: true, allowRealtime: false, ...(p.defaults ?? {}) },
    logPromptContent: p.logPromptContent ?? false,
    usageRetentionDays: 180,
    hostedTools: {
      web_search: false,
      file_search: false,
      code_interpreter: false,
      image_generation: false,
      mcp: false,
      mcpAllowedHosts: [],
      ...(p.hostedTools ?? {}),
    },
    limits: p.limits ?? {},
  };

  let orgKey: string | null = opts.orgKey ? HARNESS_ORG_KEY : null;
  const getSecret = jest.fn(async () => orgKey);
  const describe_ = jest.fn(async () => (orgKey ? { hint: '••••9999' } : null));

  const storage = createInMemoryAiStorage();

  const prisma = {
    ...db.prisma,
    ...storage.prisma,
    userSettings: {
      findUnique: jest.fn(async (args: { where: { userId: string } }) => {
        const value = settings.get(args.where.userId);
        return value === undefined ? null : { value };
      }),
    },
    aiUsageEvent: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        const row = { id: randomUUID(), createdAt: new Date(clock()), ...args.data };
        usageEvents.push(row);
        return row;
      }),
      // The reads `AiLimitsService` makes (#450).
      count: jest.fn(
        async (args: { where?: Where } = {}) => usageEvents.filter((r) => matchesUsage(r, args.where)).length,
      ),
      findMany: jest.fn(
        async (
          args: {
            where?: Where;
            orderBy?: { createdAt: 'asc' | 'desc' };
            skip?: number;
            take?: number;
            select?: Record<string, boolean>;
          } = {},
        ) => {
          const rows = usageEvents.filter((r) => matchesUsage(r, args.where));

          if (args.orderBy?.createdAt) {
            const dir = args.orderBy.createdAt === 'asc' ? 1 : -1;
            rows.sort((a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime()));
          }

          const skip = args.skip ?? 0;
          const page = rows.slice(skip, args.take === undefined ? undefined : skip + args.take);

          return page.map((r) => pick(r, args.select));
        },
      ),
      aggregate: jest.fn(async (args: { where?: Where; _sum?: Record<string, boolean> }) => {
        const rows = usageEvents.filter((r) => matchesUsage(r, args.where));
        const _sum: Record<string, number | null> = {};

        for (const field of Object.keys(args._sum ?? {})) {
          const values = rows.map((r) => r[field]).filter((v): v is number => typeof v === 'number');
          _sum[field] = values.length > 0 ? values.reduce((a, b) => a + b, 0) : null;
        }

        return { _sum };
      }),
    },
    aiRun: {
      create: jest.fn(async (args: { data: Partial<StoredAiRun>; select?: Record<string, boolean> }) => {
        const now = new Date();
        const row: StoredAiRun = {
          id: randomUUID(),
          userId: null,
          jobId: null,
          status: 'pending',
          provider: '',
          modelId: '',
          request: null,
          output: null,
          errorCode: null,
          errorMessage: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          ...args.data,
        };
        runRows.push(row);
        return pick(row, args.select);
      }),
      update: jest.fn(async (args: { where: { id: string }; data: Partial<StoredAiRun> }) => {
        const row = runRows.find((r) => r.id === args.where.id);
        if (!row) throw new Error('aiRun.update: not found');
        Object.assign(row, args.data, { updatedAt: new Date() });
        return { ...row };
      }),
      updateMany: jest.fn(async (args: { where: Where; data: Partial<StoredAiRun> }) => {
        const rows = runRows.filter((r) => matchesRun(r, args.where));
        for (const row of rows) Object.assign(row, args.data, { updatedAt: new Date() });
        return { count: rows.length };
      }),
      findFirst: jest.fn(async (args: { where: Where; select?: Record<string, boolean> }) => {
        const row = runRows.find((r) => matchesRun(r, args.where));
        return row ? pick(row, args.select) : null;
      }),
      findUnique: jest.fn(async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
        const row = runRows.find((r) => r.id === args.where.id);
        return row ? pick(row, args.select) : null;
      }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prisma)),
  };

  const jobs = {
    enqueueWithin: jest.fn(async (_tx: unknown, input: Record<string, any>) => {
      const job = { id: randomUUID(), status: 'pending', ...input } as unknown as Job;
      enqueued.push(job as unknown as Record<string, any>);
      return job;
    }),
  };

  const registry = new AiProviderRegistry();
  const catalogCapabilities = new Map(
    models.map((m) => [m.modelId, m.capabilities ?? FAKE_TEXT_MODEL_CAPABILITIES] as const),
  );
  const fake = new FakeAiProvider({
    id: HARNESS_PROVIDER,
    models: models.map((m) => m.modelId),
    classify: (modelId) => catalogCapabilities.get(modelId) ?? null,
    embeddingsPort: true,
    imagesPort: true,
    audioPort: true,
    realtimePort: true,
    ...opts.fake,
  });

  if (opts.registerProvider ?? true) {
    registry.register(fake);
  }

  const aiConfig = new AiConfigService(
    { getAiPolicy: jest.fn(async () => policy) } as never,
    { getSecret, describe: describe_ } as never,
    registry,
  );
  const userKeys = {
    getDecrypted: jest.fn(async (userId: string, provider: string) =>
      db.keys.find((k) => k.userId === userId && k.provider === provider)?.secret ?? null,
    ),
  };
  const resolver = new AiKeyResolver(userKeys as never, aiConfig);
  const usableModels = new UsableModelsService(prisma as never, aiConfig, registry, resolver);
  const recorder = new AiUsageRecorder(prisma as never);
  const runs = new AiRunsService(prisma as never, jobs as never);
  const inputs = new AiStorageInputResolver(prisma as never, storage.provider);
  const outputs = new AiOutputWriter(prisma as never, storage.provider, storage.storageConfig as never);
  const limits = new AiLimitsService(prisma as never, aiConfig, clock);
  const ai = new AiService(
    aiConfig,
    registry,
    usableModels,
    resolver,
    prisma as never,
    recorder,
    runs,
    inputs,
    outputs,
    limits,
  );

  return {
    ai,
    fake,
    registry,
    aiConfig,
    resolver,
    usableModels,
    recorder,
    runs,
    inputs,
    outputs,
    limits,
    storage,
    prisma,
    jobs,
    policy,
    usageEvents,
    runRows,
    enqueued,
    getSecret,
    userKeys,
    addUserKey,
    /** Remove every key `userId` has stored. */
    removeUserKeys(userId: string) {
      for (let i = db.keys.length - 1; i >= 0; i -= 1) {
        if (db.keys[i].userId === userId) db.keys.splice(i, 1);
      }
    },
    /** Change the policy; the config cache is dropped so the next call sees it. */
    setPolicy(patch: Partial<AiPolicy>) {
      Object.assign(policy, patch);
      aiConfig.invalidateCache();
    },
    setOrgKey(value: string | null) {
      orgKey = value;
    },
    setDefaultModel(userId: string, value: { provider: string; modelId: string } | null) {
      settings.set(userId, { theme: 'system', ai: { defaultModel: value } });
    },
  };
}

export type AiRuntimeHarness = ReturnType<typeof createAiRuntimeHarness>;
