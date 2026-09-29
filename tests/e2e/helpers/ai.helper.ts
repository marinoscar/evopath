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

export type FakeFixture = 'cardio-row-wide' | 'leg-curl-placard' | 'both';

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
