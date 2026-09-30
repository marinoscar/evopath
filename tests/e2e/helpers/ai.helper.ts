import { expect } from '@playwright/test';
import type { AuthedApi } from './api.helper';

/**
 * Fake vision provider helpers for the "Scan gym" e2e (gym-scan.spec.ts).
 *
 * The provider is `tests/e2e/support/fake-vision-server.mjs`, started by the
 * `infra/compose/fake-ai.compose.yml` overlay. The API reaches it inside the
 * Compose network as `fake-ai:4010`; the test runner reaches it on the host at
 * `localhost:4010`. Both are overridable for other topologies.
 */

export const FAKE_AI_HOST_URL = process.env.FAKE_AI_URL ?? 'http://localhost:4010';
export const FAKE_AI_API_BASE_URL = process.env.FAKE_AI_API_BASE_URL ?? 'http://fake-ai:4010/v1';
export const FAKE_PROVIDER_ID = 'openai-compatible';
export const FAKE_MODEL_ID = 'fake-vision';

export type FakeFixture = 'cardio-row-wide' | 'leg-curl-placard' | 'both' | 'workout-placard' | 'workout-notebook' | 'workout-empty';

export interface FakeRequestRecord {
  model: string | null;
  imageCount: number;
  hasResponseFormat: boolean;
}

/** Whether the fake server answers. Used to `test.skip` the scan spec with a clear message. */
export async function isFakeVisionReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${FAKE_AI_HOST_URL}/v1/models`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export const FAKE_VISION_SKIP_MESSAGE =
  `The fake vision server is not reachable at ${FAKE_AI_HOST_URL}/v1/models. ` +
  'Start the stack with the fake-ai.compose.yml overlay (see docs/TESTING.md) to run the scan e2e.';

/** Choose the canned answer for the NEXT completion (one-shot). */
export async function setFakeFixture(name: FakeFixture): Promise<void> {
  const response = await fetch(`${FAKE_AI_HOST_URL}/__control/next`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixture: name }),
  });
  expect(response.ok, `POST /__control/next ${name} -> ${response.status}`).toBe(true);
}

/** What the fake received per completion: image counts only, never bytes. */
export async function fakeRequests(): Promise<FakeRequestRecord[]> {
  const response = await fetch(`${FAKE_AI_HOST_URL}/__control/requests`);
  expect(response.ok).toBe(true);
  return (await response.json()) as FakeRequestRecord[];
}

/** Forget the queued fixture and the request log. */
export async function resetFake(): Promise<void> {
  const response = await fetch(`${FAKE_AI_HOST_URL}/__control/reset`, { method: 'POST' });
  expect(response.ok).toBe(true);
}

interface AdminAiConfig {
  enabled: boolean;
  keyPolicy: string;
  logPromptContent: boolean;
  defaults: { maxOutputTokensCap: number | null; allowBackgroundRuns: boolean; allowRealtime: boolean };
}

interface AdminAiModel {
  id: string;
  provider: string;
  modelId: string;
  enabled: boolean;
  deprecatedAt: string | null;
  capabilities: { capabilities: string[]; inputModalities: string[] } | null;
}

const VISION_CAPABILITIES = {
  capabilities: ['responses', 'structured_output', 'vision_input'],
  inputModalities: ['text', 'image'],
  outputModalities: ['text'],
};

async function findFakeModel(admin: AuthedApi): Promise<AdminAiModel | undefined> {
  const result = await admin.get<{ items: AdminAiModel[] } | AdminAiModel[]>(
    `/api/admin/ai/models?provider=${FAKE_PROVIDER_ID}&q=${FAKE_MODEL_ID}&pageSize=100`,
  );
  const models = Array.isArray(result) ? result : result.items;
  return models.find((model) => model.modelId === FAKE_MODEL_ID);
}

/**
 * Turn AI on and make `fake-vision` a usable vision model, through the same
 * admin API the settings pages use (`ai-admin.controller.ts`):
 *
 *   1. `PUT   /api/admin/ai/config`        AI on, key policy `byok`, the
 *      OpenAI-compatible provider enabled at the fake's base URL,
 *      `apiStyle: chat_completions`, `requiresKey: false`
 *   2. `POST  /api/admin/ai/models/refresh` discover `fake-vision`
 *      (only when it is not in the catalog yet), then poll the catalog
 *   3. `PATCH /api/admin/ai/models/:id`    declare `responses`,
 *      `structured_output`, `vision_input` (text + image in) and enable it
 *
 * Idempotent: it reads the stored configuration and re-sends it with the
 * provider block set, so running it twice, or against a stack a previous run
 * already configured, changes nothing. Providers and settings it does not
 * name keep their stored values.
 */
export async function configureFakeVisionProvider(admin: AuthedApi): Promise<void> {
  const config = await admin.get<AdminAiConfig>('/api/admin/ai/config');

  await admin.put('/api/admin/ai/config', {
    enabled: true,
    keyPolicy: 'byok',
    logPromptContent: config.logPromptContent,
    defaults: {
      maxOutputTokensCap: config.defaults.maxOutputTokensCap,
      allowBackgroundRuns: config.defaults.allowBackgroundRuns,
      allowRealtime: config.defaults.allowRealtime,
    },
    providers: {
      [FAKE_PROVIDER_ID]: {
        enabled: true,
        baseUrl: FAKE_AI_API_BASE_URL,
        apiStyle: 'chat_completions',
        requiresKey: false,
      },
    },
  });

  let model = await findFakeModel(admin);
  if (!model || model.deprecatedAt) {
    await admin.post('/api/admin/ai/models/refresh', { provider: FAKE_PROVIDER_ID });
    await expect
      .poll(async () => {
        model = await findFakeModel(admin);
        return Boolean(model) && !model?.deprecatedAt;
      }, { message: 'the catalog refresh never listed fake-vision', timeout: 60_000, intervals: [1_000, 2_000] })
      .toBe(true);
  }

  const known = model!.capabilities;
  const alreadyDeclared =
    known !== null &&
    VISION_CAPABILITIES.capabilities.every((c) => known.capabilities.includes(c)) &&
    known.inputModalities.includes('image');

  if (!alreadyDeclared || !model!.enabled) {
    await admin.patch(`/api/admin/ai/models/${encodeURIComponent(model!.id)}`, {
      ...(alreadyDeclared ? {} : { capabilities: VISION_CAPABILITIES }),
      enabled: true,
    });
  }
}

// =============================================================================
// Fake OpenAI Responses server (agentic training plans)
// =============================================================================
//
// `tests/e2e/support/fake-responses-server.mjs`, service `fake-ai-responses` of
// the same overlay. The API reaches it inside the Compose network at
// `fake-ai-responses:4011`; the test runner reaches it at `localhost:4011`.
// It replays the scenario fixtures in `apps/api/test/fixtures/training/scenarios`
// (the files the Jest scenario suites replay), selected with `useScenario`.
//
// It accepts any bearer token of 8 or more characters, so it says nothing about
// key validation (the AI platform's own suites cover that).
// =============================================================================

export const FAKE_RESPONSES_HOST_URL = process.env.FAKE_RESPONSES_URL ?? 'http://localhost:4011';
export const FAKE_RESPONSES_API_BASE_URL = process.env.FAKE_RESPONSES_API_BASE_URL ?? 'http://fake-ai-responses:4011/v1';
export const FAKE_RESPONSES_KEY = 'sk-fake-e2e-0000';
export const FAKE_FRONTIER = 'fake-frontier';
export const FAKE_FAST = 'fake-fast';
export const OPENAI_PROVIDER_ID = 'openai';

/** The canary strings the overlay's `CANARY_TOKENS` counts. Plant them in user data, then assert zero hits. */
export const CANARY_BIO = 'E2E-CANARY-BIO-7f3a';
export const CANARY_NOTE = 'E2E-CANARY-NOTE-9c1d';
export const CANARY_NAME = 'E2E-CANARY-NAME-4b2e';

/** `E2E_AI=0` skips every suite that needs the fake Responses server. */
export const E2E_AI_DISABLED = process.env.E2E_AI === '0';

export const FAKE_RESPONSES_SKIP_MESSAGE =
  `The fake Responses server is not reachable at ${FAKE_RESPONSES_HOST_URL}/v1/models. ` +
  'Start the stack with the fake-ai.compose.yml overlay ' +
  '(cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml -f fake-ai.compose.yml up), ' +
  'or set E2E_AI=0 to skip the AI end-to-end suites.';

export type ScenarioName =
  | 'happy'
  | 'critic-reject-once'
  | 'critic-exhausted'
  | 'planner-hostile'
  | 'research-fabricated-url'
  | 'research-insufficient'
  | 'research-page-injection'
  | 'urgent-symptom'
  | 'budget-tight'
  | 'rate-limit-once'
  | 'slow'
  | 'evaluator-no-change'
  | 'evaluator-autonomous'
  | 'evaluator-structural'
  | 'evaluator-hostile'
  | 'evaluator-pain-response'
  | 'evaluator-regenerate';

/** One request the fake received: names, counts and flags only, never a key, prompt or body. */
export interface FakeResponsesRequest {
  seq: number;
  time: string;
  scenario: string;
  path: string;
  status: number;
  agent: string | null;
  node: string | null;
  round: number | null;
  model: string | null;
  reasoningEffort: string | null;
  toolTypes: string[];
  hasSchema: boolean;
  inputChars: number;
  canaryHits: number;
  hasAuthorization: boolean;
}

export async function isFakeResponsesReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${FAKE_RESPONSES_HOST_URL}/v1/models`, {
      headers: { authorization: `Bearer ${FAKE_RESPONSES_KEY}` },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Fail fast with the exact fix when the fake is not running (the suite's beforeAll). */
export async function assertFakeResponsesReachable(): Promise<void> {
  if (!(await isFakeResponsesReachable())) throw new Error(FAKE_RESPONSES_SKIP_MESSAGE);
}

/** Select the scenario for the next runs (resets the fake's call counters). */
export async function useScenario(name: ScenarioName): Promise<void> {
  const response = await fetch(`${FAKE_RESPONSES_HOST_URL}/__control/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(response.ok, `POST /__control/scenario ${name} -> ${response.status}`).toBe(true);
}

export async function fakeResponsesRequests(after = 0): Promise<FakeResponsesRequest[]> {
  const response = await fetch(`${FAKE_RESPONSES_HOST_URL}/__control/requests?after=${after}`);
  expect(response.ok).toBe(true);
  return (await response.json()) as FakeResponsesRequest[];
}

/** The `seq` of the newest request, so a test can look only at what came after. */
export async function lastRequestSeq(): Promise<number> {
  const all = await fakeResponsesRequests();
  return all.at(-1)?.seq ?? 0;
}

export async function resetFakeResponses(): Promise<void> {
  const response = await fetch(`${FAKE_RESPONSES_HOST_URL}/__control/reset`, { method: 'POST' });
  expect(response.ok).toBe(true);
}

const RESPONSES_MODEL_CAPABILITIES = {
  inputModalities: ['text'],
  outputModalities: ['text'],
  reasoningEfforts: ['low', 'medium', 'high'],
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
};

/**
 * `fake-frontier` can search (hosted tools); `fake-fast` cannot, which is how
 * the "blocked researcher" scenario is set up without touching global state.
 */
const MODEL_CAPABILITIES: Record<string, string[]> = {
  [FAKE_FRONTIER]: ['responses', 'reasoning', 'structured_output', 'hosted_tools'],
  [FAKE_FAST]: ['responses', 'reasoning', 'structured_output'],
};

/** What `setupFakeAi` changed, so `teardownFakeAi` can put the stack back. */
export interface FakeAiSnapshot {
  enabled: boolean;
  webSearch: boolean;
  openai: { enabled: boolean; baseUrl: string | null; hadAdminKey: boolean };
}

interface AdminAiConfigFull extends AdminAiConfig {
  hostedTools: Record<string, unknown> & { web_search: boolean };
  providers: Array<{ id: string; enabled: boolean; baseUrl: string | null; keyStatus: { configured: boolean } }>;
}

async function findModel(admin: AuthedApi, modelId: string): Promise<AdminAiModel | undefined> {
  const result = await admin.get<{ items: AdminAiModel[] } | AdminAiModel[]>(
    `/api/admin/ai/models?provider=${OPENAI_PROVIDER_ID}&q=${modelId}&pageSize=100`,
  );
  const models = Array.isArray(result) ? result : result.items;
  return models.find((model) => model.modelId === modelId);
}

/** Send the whole `ai` namespace back with the openai slot (and web search) set. */
async function putConfig(
  admin: AuthedApi,
  config: AdminAiConfigFull,
  patch: { enabled: boolean; webSearch: boolean; openai: { enabled: boolean; baseUrl: string | null } },
): Promise<void> {
  await admin.put('/api/admin/ai/config', {
    enabled: patch.enabled,
    keyPolicy: 'byok',
    logPromptContent: config.logPromptContent,
    defaults: {
      maxOutputTokensCap: config.defaults.maxOutputTokensCap,
      allowBackgroundRuns: config.defaults.allowBackgroundRuns,
      allowRealtime: config.defaults.allowRealtime,
    },
    hostedTools: { ...config.hostedTools, web_search: patch.webSearch },
    providers: { [OPENAI_PROVIDER_ID]: { enabled: patch.openai.enabled, baseUrl: patch.openai.baseUrl } },
  });
}

/**
 * Turn AI on against the fake Responses server, as admin, through the same API
 * the settings pages use: AI enabled with key policy `byok`, the `openai` slot
 * enabled at the fake's base URL with a fake admin key, hosted web search on,
 * the catalog refreshed, and `fake-frontier` and `fake-fast` classified
 * (`responses`, `reasoning`, `structured_output`, efforts low to high; only
 * `fake-frontier` adds `hosted_tools`) and enabled.
 *
 * Idempotent: it re-applies the configuration, the classification and the key
 * every time, so a stack a previous run left configured (or half configured)
 * ends up the same. Returns the prior state for `teardownFakeAi`.
 */
export async function setupFakeAi(admin: AuthedApi): Promise<FakeAiSnapshot> {
  await assertFakeResponsesReachable();
  const before = await admin.get<AdminAiConfigFull>('/api/admin/ai/config');
  const openai = before.providers.find((provider) => provider.id === OPENAI_PROVIDER_ID);
  const snapshot: FakeAiSnapshot = {
    enabled: before.enabled,
    webSearch: before.hostedTools.web_search,
    openai: { enabled: openai?.enabled ?? false, baseUrl: openai?.baseUrl ?? null, hadAdminKey: openai?.keyStatus.configured ?? false },
  };

  await putConfig(admin, before, { enabled: true, webSearch: true, openai: { enabled: true, baseUrl: FAKE_RESPONSES_API_BASE_URL } });
  // The key is verified against the provider (the fake lists its models), so the base URL is saved first.
  await admin.put(`/api/admin/ai/providers/${OPENAI_PROVIDER_ID}/key`, { apiKey: FAKE_RESPONSES_KEY });

  await admin.post('/api/admin/ai/models/refresh', { provider: OPENAI_PROVIDER_ID });
  for (const modelId of Object.keys(MODEL_CAPABILITIES)) {
    let model: AdminAiModel | undefined;
    await expect
      .poll(
        async () => {
          model = await findModel(admin, modelId);
          return Boolean(model) && !model?.deprecatedAt;
        },
        { message: `the catalog refresh never listed ${modelId}`, timeout: 60_000, intervals: [1_000, 2_000] },
      )
      .toBe(true);
    await admin.patch(`/api/admin/ai/models/${encodeURIComponent(model!.id)}`, {
      capabilities: { ...RESPONSES_MODEL_CAPABILITIES, capabilities: MODEL_CAPABILITIES[modelId] },
      enabled: true,
    });
  }

  return snapshot;
}

/** Put AI back the way `setupFakeAi` found it: prior switch, web search, openai slot; remove the admin key it added. */
export async function teardownFakeAi(admin: AuthedApi, snapshot: FakeAiSnapshot): Promise<void> {
  const current = await admin.get<AdminAiConfigFull>('/api/admin/ai/config');
  await putConfig(admin, current, { enabled: snapshot.enabled, webSearch: snapshot.webSearch, openai: snapshot.openai });
  if (!snapshot.openai.hadAdminKey) {
    await admin.request('DELETE', `/api/admin/ai/providers/${OPENAI_PROVIDER_ID}/key`, { confirmation: 'REMOVE' });
  }
}

export type TrainingRoleName = 'researcher' | 'planner' | 'critic' | 'evaluator';

/** The fake model each role uses unless a test overrides it. */
const DEFAULT_ROLE_MODELS: Record<TrainingRoleName, { modelId: string; reasoningEffort: 'low' | 'medium' | 'high' }> = {
  researcher: { modelId: FAKE_FRONTIER, reasoningEffort: 'medium' },
  planner: { modelId: FAKE_FRONTIER, reasoningEffort: 'high' },
  critic: { modelId: FAKE_FAST, reasoningEffort: 'low' },
  evaluator: { modelId: FAKE_FAST, reasoningEffort: 'medium' },
};

/**
 * As the signed-in user: store a fake key for `openai` and choose the fake
 * models for the four roles (`ai.taskModels`). `overrides` swaps a role's model.
 */
export async function setupFakeAiForUser(
  api: AuthedApi,
  overrides: Partial<Record<TrainingRoleName, { modelId: string; reasoningEffort: 'low' | 'medium' | 'high' }>> = {},
): Promise<void> {
  await api.put(`/api/ai/keys/${OPENAI_PROVIDER_ID}`, { apiKey: FAKE_RESPONSES_KEY });
  const roles = { ...DEFAULT_ROLE_MODELS, ...overrides };
  await api.patch('/api/user-settings', {
    ai: {
      taskModels: Object.fromEntries(
        Object.entries(roles).map(([role, choice]) => [role, { provider: OPENAI_PROVIDER_ID, ...choice }]),
      ),
    },
  });
}

/** Remove the user's fake key and role choices (best effort: the user is disposable anyway). */
export async function teardownFakeAiForUser(api: AuthedApi): Promise<void> {
  await api.del(`/api/ai/keys/${OPENAI_PROVIDER_ID}`).catch(() => undefined);
  await api.patch('/api/user-settings', { ai: { taskModels: null } }).catch(() => undefined);
}

/**
 * Switch the platform-wide AI switch, keeping every other setting as stored.
 * Used by the "AI off" scenario, which must turn it back on in a `finally`.
 */
export async function setAiEnabled(admin: AuthedApi, enabled: boolean): Promise<void> {
  const current = await admin.get<AdminAiConfigFull>('/api/admin/ai/config');
  const openai = current.providers.find((provider) => provider.id === OPENAI_PROVIDER_ID);
  await putConfig(admin, current, {
    enabled,
    webSearch: current.hostedTools.web_search,
    openai: { enabled: openai?.enabled ?? true, baseUrl: openai?.baseUrl ?? FAKE_RESPONSES_API_BASE_URL },
  });
}
