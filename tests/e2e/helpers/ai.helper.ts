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

export type FakeFixture =
  | 'cardio-row-wide'
  | 'leg-curl-placard'
  | 'both'
  | 'workout-placard'
  | 'workout-notebook'
  | 'workout-empty'
  | 'body-metric-scale'
  | 'body-metric-smart-scale-report';

export interface FakeRequestRecord {
  model: string | null;
  imageCount: number;
  /** File (PDF) parts in the request (H2, #186). */
  fileCount: number;
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

/**
 * Declare (or withdraw) `file_input` and the `file` input modality on
 * `fake-vision`, so a body-metric PDF (H2, #186) can be read, or is refused
 * with `AI_CAPABILITY_UNSUPPORTED` (`details.capability: 'file_input'`) before
 * any provider call. Call after {@link configureFakeVisionProvider}. The
 * vision capabilities it declares are kept either way, so the image specs are
 * unaffected; a spec that turns it on turns it back off when it is done.
 */
export async function setFakeVisionFileInput(admin: AuthedApi, enabled: boolean): Promise<void> {
  const model = await findFakeModel(admin);
  expect(model, 'fake-vision is not in the catalog; call configureFakeVisionProvider first').toBeTruthy();
  const capabilities = enabled
    ? {
        capabilities: [...VISION_CAPABILITIES.capabilities, 'file_input'],
        inputModalities: [...VISION_CAPABILITIES.inputModalities, 'file'],
        outputModalities: VISION_CAPABILITIES.outputModalities,
      }
    : VISION_CAPABILITIES;
  await admin.patch(`/api/admin/ai/models/${encodeURIComponent(model!.id)}`, { capabilities, enabled: true });
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
  [FAKE_FRONTIER]: ['responses', 'reasoning', 'structured_output', 'tools', 'hosted_tools'],
  [FAKE_FAST]: ['responses', 'reasoning', 'structured_output', 'tools'],
};

/** What `setupFakeAi` changed, so `teardownFakeAi` can put the stack back. */
export interface FakeAiSnapshot {
  enabled: boolean;
  webSearch: boolean;
  openai: { enabled: boolean; baseUrl: string | null; hadAdminKey: boolean };
  /** The stored model assignments (#173), put back verbatim by `teardownFakeAi`. */
  assignments: AiAssignmentsBody;
}

/** `PUT /api/admin/ai/assignments` body: the administrator's model choices (#173). */
interface AiAssignmentsBody {
  default: { provider: string; modelId: string } | null;
  features: Record<string, { provider: string; modelId: string; reasoningEffort?: string | null } | null>;
}

interface AiAssignmentsView {
  assignments: AiAssignmentsBody;
  version: number;
}

async function putAssignments(admin: AuthedApi, assignments: AiAssignmentsBody): Promise<void> {
  const current = await admin.get<AiAssignmentsView>('/api/admin/ai/assignments');
  await admin.request('PUT', '/api/admin/ai/assignments', assignments, { 'If-Match': String(current.version) });
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
    assignments: (await admin.get<AiAssignmentsView>('/api/admin/ai/assignments')).assignments,
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

  // Models are the administrator's choice (#173): assign the fake models to the four training roles.
  await assignFakeTrainingModels(admin);

  return snapshot;
}

/** Put AI back the way `setupFakeAi` found it: prior switch, web search, openai slot; remove the admin key it added. */
export async function teardownFakeAi(admin: AuthedApi, snapshot: FakeAiSnapshot): Promise<void> {
  const current = await admin.get<AdminAiConfigFull>('/api/admin/ai/config');
  await putAssignments(admin, snapshot.assignments);
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
 * As an administrator: assign the fake models to the four training features
 * (`training.<role>`, #173), keeping every other stored assignment. `overrides`
 * swaps a role's model. The assignment is global; the suite is serial and
 * `teardownFakeAi` restores what `setupFakeAi` found.
 */
export async function assignFakeTrainingModels(
  admin: AuthedApi,
  overrides: Partial<Record<TrainingRoleName, { modelId: string; reasoningEffort: 'low' | 'medium' | 'high' }>> = {},
): Promise<void> {
  const current = await admin.get<AiAssignmentsView>('/api/admin/ai/assignments');
  const roles = { ...DEFAULT_ROLE_MODELS, ...overrides };
  await putAssignments(admin, {
    default: current.assignments.default,
    features: {
      ...current.assignments.features,
      ...Object.fromEntries(
        Object.entries(roles).map(([role, choice]) => [`training.${role}`, { provider: OPENAI_PROVIDER_ID, ...choice }]),
      ),
    },
  });
}

/** As the signed-in user: store a fake key for `openai`. The models are the administrator's (`assignFakeTrainingModels`). */
export async function setupFakeAiForUser(api: AuthedApi): Promise<void> {
  await api.put(`/api/ai/keys/${OPENAI_PROVIDER_ID}`, { apiKey: FAKE_RESPONSES_KEY });
}

/** Remove the user's fake key (best effort: the user is disposable anyway). */
export async function teardownFakeAiForUser(api: AuthedApi): Promise<void> {
  await api.del(`/api/ai/keys/${OPENAI_PROVIDER_ID}`).catch(() => undefined);
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

// =============================================================================
// Fake OpenAI-compatible server: quick adaptation and the hotel scan (E6.4)
// =============================================================================
//
// The same server as the scan above (`fake-vision-server.mjs`, service `fake-ai`
// of `infra/compose/fake-ai.compose.yml`, `openai-compatible` provider, keyless,
// Chat Completions), extended with the adaptation scenarios in
// `tests/e2e/support/fake-adaptation-scenarios.mjs`:
//
//   fake-planner, fake-critic   text + structured output (the two adaptation roles)
//   fake-vision                 vision + structured output (the hotel scan)
//   fake-text-only              text + structured output, cannot read photos
//
// The scenario is global to the fake (`useAdaptationScenario`), so the specs that
// use it run serially and must not run beside the other AI specs (they share the
// AI settings and the fake). `E2E_AI=0` skips them; an unreachable or outdated
// fake fails the suite at once with the fix.
// =============================================================================

export const FAKE_PLANNER = 'fake-planner';
export const FAKE_CRITIC = 'fake-critic';
export const FAKE_TEXT_ONLY = 'fake-text-only';

export type AdaptationScenarioName =
  | 'valid'
  | 'critic-revise'
  | 'unknown-exercise'
  | 'over-time'
  | 'over-volume'
  | 'malformed'
  | 'rate-limit'
  | 'slow'
  | 'heavy-tokens'
  | 'scan-hotel'
  | 'scan-empty';

/** The token counts the fake reports for the `valid` scenario (`fake-adaptation-scenarios.mjs`). */
export const SCRIPTED_TOKENS = {
  planner: { input: 1_200, output: 300 },
  critic: { input: 800, output: 120 },
  heavyPlanner: { input: 9_000, output: 3_000 },
} as const;

/** One completion the fake received. `text` is the message text (never image bytes). */
export interface FakeLogEntry {
  seq: number;
  scenario: string;
  schemaName: string | null;
  model: string | null;
  imageCount: number;
  status: number;
  text: string;
}

export const FAKE_ADAPTATION_SKIP_MESSAGE =
  `The fake AI server at ${FAKE_AI_HOST_URL} does not list the adaptation models (fake-planner, fake-critic). ` +
  'Start the stack with the fake-ai.compose.yml overlay ' +
  '(cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml -f fake-ai.compose.yml up), ' +
  `so the API can reach it at ${FAKE_AI_API_BASE_URL}, or set E2E_AI=0 to skip the AI end-to-end suites.`;

/** Fail fast with the exact fix when the fake is not running, or is a version without the adaptation scenarios. */
export async function assertFakeAdaptationReachable(): Promise<void> {
  try {
    const response = await fetch(`${FAKE_AI_HOST_URL}/v1/models`, { signal: AbortSignal.timeout(3_000) });
    const body = (await response.json()) as { data?: Array<{ id: string }> };
    if (response.ok && body.data?.some((model) => model.id === FAKE_PLANNER)) return;
  } catch {
    // Fall through to the actionable message.
  }
  throw new Error(FAKE_ADAPTATION_SKIP_MESSAGE);
}

/** Select the scenario for the next calls (resets the fake's call counters). */
export async function useAdaptationScenario(name: AdaptationScenarioName): Promise<void> {
  const response = await fetch(`${FAKE_AI_HOST_URL}/__control/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(response.ok, `POST /__control/scenario ${name} -> ${response.status}`).toBe(true);
}

/** Every completion since `after` (a `seq`), oldest first. */
export async function fakeLog(after = 0): Promise<FakeLogEntry[]> {
  const response = await fetch(`${FAKE_AI_HOST_URL}/__control/log?after=${after}`);
  expect(response.ok).toBe(true);
  return (await response.json()) as FakeLogEntry[];
}

/** The `seq` of the newest logged completion, so a test can look only at what came after. */
export async function lastLogSeq(): Promise<number> {
  return (await fakeLog()).at(-1)?.seq ?? 0;
}

/** Completions since `after` that carried this structured-output schema name. */
export async function callsSince(after: number, schemaName: string): Promise<FakeLogEntry[]> {
  return (await fakeLog(after)).filter((entry) => entry.schemaName === schemaName);
}

export const PROPOSAL_SCHEMA = 'training_adaptation_proposal';
export const CRITIQUE_SCHEMA = 'training_adaptation_critique';

const TEXT_CAPABILITIES = {
  capabilities: ['responses', 'structured_output'],
  inputModalities: ['text'],
  outputModalities: ['text'],
};

/** What each fake model is classified as (`admin_override`: the keyless catalog refresh does not classify). */
const ADAPTATION_MODELS: Record<string, { capabilities: string[]; inputModalities: string[]; outputModalities: string[] }> = {
  [FAKE_PLANNER]: TEXT_CAPABILITIES,
  [FAKE_CRITIC]: TEXT_CAPABILITIES,
  [FAKE_TEXT_ONLY]: TEXT_CAPABILITIES,
  [FAKE_MODEL_ID]: VISION_CAPABILITIES,
};

interface CompatProviderState {
  enabled: boolean;
  baseUrl: string | null;
  apiStyle: string | null;
  requiresKey: boolean | null;
}

/** What `setupFakeAdaptationAi` changed, so `teardownFakeAdaptationAi` puts the stack back. */
export interface FakeAdaptationSnapshot {
  enabled: boolean;
  keyPolicy: string;
  compat: CompatProviderState;
  /** `enabled` of each fake model before, or null when the catalog had none. */
  models: Record<string, boolean | null>;
  /** The stored admin model assignments, put back verbatim by the teardown. */
  assignments: AiAssignmentsBody;
}

interface AdminAiConfigWithProviders extends AdminAiConfig {
  providers: Array<{ id: string; enabled: boolean; baseUrl: string | null; apiStyle: string | null; requiresKey: boolean | null }>;
}

async function findCompatModel(admin: AuthedApi, modelId: string): Promise<AdminAiModel | undefined> {
  const result = await admin.get<{ items: AdminAiModel[] } | AdminAiModel[]>(
    `/api/admin/ai/models?provider=${FAKE_PROVIDER_ID}&q=${modelId}&pageSize=100`,
  );
  const models = Array.isArray(result) ? result : result.items;
  return models.find((model) => model.modelId === modelId);
}

async function putCompatConfig(
  admin: AuthedApi,
  config: AdminAiConfigWithProviders,
  patch: { enabled: boolean; keyPolicy: string; compat: CompatProviderState },
): Promise<void> {
  await admin.put('/api/admin/ai/config', {
    enabled: patch.enabled,
    keyPolicy: patch.keyPolicy,
    logPromptContent: config.logPromptContent,
    defaults: {
      maxOutputTokensCap: config.defaults.maxOutputTokensCap,
      allowBackgroundRuns: config.defaults.allowBackgroundRuns,
      allowRealtime: config.defaults.allowRealtime,
    },
    providers: {
      [FAKE_PROVIDER_ID]: {
        enabled: patch.compat.enabled,
        baseUrl: patch.compat.baseUrl,
        ...(patch.compat.apiStyle ? { apiStyle: patch.compat.apiStyle } : {}),
        ...(patch.compat.requiresKey !== null ? { requiresKey: patch.compat.requiresKey } : {}),
      },
    },
  });
}

/**
 * Turn AI on against the fake OpenAI-compatible server, as admin, through the
 * same API the settings pages use: AI on, key policy `byok`, the
 * `openai-compatible` slot enabled at the fake's base URL (Chat Completions,
 * keyless), the catalog refreshed, and the four fake models classified
 * (`PATCH /api/admin/ai/models/:id`, an explicit classification, which also
 * covers a keyless refresh that answers `AI_KEY_REQUIRED`) and enabled.
 *
 * Idempotent: it re-applies the configuration and the classification every
 * time, so a stack a previous run left configured ends up the same. It never
 * touches another provider, so a real stored key is never overwritten. Returns
 * the prior state for `teardownFakeAdaptationAi`.
 */
export async function setupFakeAdaptationAi(admin: AuthedApi): Promise<FakeAdaptationSnapshot> {
  await assertFakeAdaptationReachable();
  const before = await admin.get<AdminAiConfigWithProviders>('/api/admin/ai/config');
  const compat = before.providers.find((provider) => provider.id === FAKE_PROVIDER_ID);
  const snapshot: FakeAdaptationSnapshot = {
    enabled: before.enabled,
    keyPolicy: before.keyPolicy,
    compat: {
      enabled: compat?.enabled ?? false,
      baseUrl: compat?.baseUrl ?? null,
      apiStyle: compat?.apiStyle ?? null,
      requiresKey: compat?.requiresKey ?? null,
    },
    models: {},
    assignments: (await admin.get<AiAssignmentsView>('/api/admin/ai/assignments')).assignments,
  };
  for (const modelId of Object.keys(ADAPTATION_MODELS)) {
    snapshot.models[modelId] = (await findCompatModel(admin, modelId))?.enabled ?? null;
  }

  await putCompatConfig(admin, before, {
    enabled: true,
    keyPolicy: 'byok',
    compat: { enabled: true, baseUrl: FAKE_AI_API_BASE_URL, apiStyle: 'chat_completions', requiresKey: false },
  });

  await admin.post('/api/admin/ai/models/refresh', { provider: FAKE_PROVIDER_ID });
  for (const [modelId, declared] of Object.entries(ADAPTATION_MODELS)) {
    let model: AdminAiModel | undefined;
    await expect
      .poll(
        async () => {
          model = await findCompatModel(admin, modelId);
          return Boolean(model) && !model?.deprecatedAt;
        },
        { message: `the catalog refresh never listed ${modelId}`, timeout: 60_000, intervals: [1_000, 2_000] },
      )
      .toBe(true);
    await admin.patch(`/api/admin/ai/models/${encodeURIComponent(model!.id)}`, { capabilities: declared, enabled: true });
  }

  // Models are the administrator's choice (Admin > AI > Model assignments): the planner, the critic
  // and the gym scan (no reasoning effort: the Chat Completions style refuses one).
  const ref = (modelId: string) => ({ provider: FAKE_PROVIDER_ID, modelId });
  await putAssignments(admin, {
    default: snapshot.assignments.default,
    features: {
      ...snapshot.assignments.features,
      'training.planner': { ...ref(FAKE_PLANNER), reasoningEffort: null },
      'training.critic': { ...ref(FAKE_CRITIC), reasoningEffort: null },
      gym_scan: ref(FAKE_MODEL_ID),
    },
  });
  return snapshot;
}

/** Put AI back the way `setupFakeAdaptationAi` found it: the switch, key policy, provider slot and each model's `enabled`. */
export async function teardownFakeAdaptationAi(admin: AuthedApi, snapshot: FakeAdaptationSnapshot): Promise<void> {
  await putAssignments(admin, snapshot.assignments);
  const current = await admin.get<AdminAiConfigWithProviders>('/api/admin/ai/config');
  await putCompatConfig(admin, current, { enabled: snapshot.enabled, keyPolicy: snapshot.keyPolicy, compat: snapshot.compat });
  for (const [modelId, wasEnabled] of Object.entries(snapshot.models)) {
    const model = await findCompatModel(admin, modelId);
    if (model) await admin.patch(`/api/admin/ai/models/${encodeURIComponent(model.id)}`, { enabled: wasEnabled ?? false }).catch(() => undefined);
  }
}

/** Enable or disable one fake model in the admin catalog (a capability-state scenario; put it back in a `finally`). */
export async function setFakeModelEnabled(admin: AuthedApi, modelId: string, enabled: boolean): Promise<void> {
  const model = await findCompatModel(admin, modelId);
  if (!model) throw new Error(`The catalog has no ${modelId}; run setupFakeAdaptationAi first.`);
  await admin.patch(`/api/admin/ai/models/${encodeURIComponent(model.id)}`, { enabled });
}

/** Switch the platform-wide AI switch, keeping every other stored setting (the "AI off" scenario; turn it back on in a `finally`). */
export async function setAdaptationAiEnabled(admin: AuthedApi, enabled: boolean): Promise<void> {
  const current = await admin.get<AdminAiConfigWithProviders>('/api/admin/ai/config');
  const compat = current.providers.find((provider) => provider.id === FAKE_PROVIDER_ID);
  await putCompatConfig(admin, current, {
    enabled,
    keyPolicy: current.keyPolicy,
    compat: {
      enabled: compat?.enabled ?? true,
      baseUrl: compat?.baseUrl ?? FAKE_AI_API_BASE_URL,
      apiStyle: compat?.apiStyle ?? 'chat_completions',
      requiresKey: compat?.requiresKey ?? false,
    },
  });
}

/**
 * As the signed-in user: the per-run token limit (`ai.training.maxRunTokens`,
 * 10,000 at the least; a user setting, unlike the models, which are the
 * administrator's: see `setupFakeAdaptationAi`). `null` clears it.
 */
export async function setAdaptationRunLimitForUser(api: AuthedApi, maxRunTokens: number | null): Promise<void> {
  await api.patch('/api/user-settings', { ai: { training: { maxRunTokens } } });
}

/** Clear the user's run limit (best effort: the user is disposable anyway). */
export async function teardownAdaptationUser(api: AuthedApi): Promise<void> {
  await api.patch('/api/user-settings', { ai: { training: null } }).catch(() => undefined);
}
