import { expect, type Browser } from '@playwright/test';
import { signIn, type AuthedApi } from './api.helper';
import {
  FAKE_AI_HOST_URL,
  FAKE_COACH,
  FAKE_PROVIDER_ID,
  FAKE_RESPONSES_API_BASE_URL,
  FAKE_RESPONSES_HOST_URL,
  FAKE_RESPONSES_KEY,
  OPENAI_PROVIDER_ID,
  findModel,
  putAssignments,
  putConfig,
  setupFakeAdaptationAi,
  teardownFakeAdaptationAi,
  type AdminAiConfigFull,
  type AiAssignmentsView,
  type FakeAdaptationSnapshot,
} from './ai.helper';

/**
 * AI Coach helpers (E7.13): the fake providers, the coach's own settings and
 * timeline, with no real key.
 *
 * Text goes through the fake OpenAI-compatible server (`fake-ai`, port 4010:
 * `coach.decision` and `coach.chat` on the `fake-coach` model; nudges, the
 * weekly review and the chat tool loop are answered by
 * `tests/e2e/support/fake-coach-scenarios.mjs`). Speech goes through the fake
 * Responses server (`fake-ai-responses`, port 4011, the `openai` provider:
 * `coach.voice` on `fake-tts`), because only that provider speaks.
 *
 * The AI settings, the coach policy and the fakes are global: suites that use
 * them run serially, one at a time, and put everything back in `afterAll`.
 */

export const FAKE_TTS = 'fake-tts';

/** Fail fast, with the fix, when the fakes are missing or predate the coach answers (E7.13). */
export async function assertFakeCoachReachable(): Promise<void> {
  const models = async (url: string, headers: Record<string, string> = {}): Promise<string[]> => {
    try {
      const response = await fetch(`${url}/v1/models`, { headers, signal: AbortSignal.timeout(3_000) });
      return ((await response.json()) as { data?: Array<{ id: string }> }).data?.map((model) => model.id) ?? [];
    } catch {
      return [];
    }
  };
  const text = await models(FAKE_AI_HOST_URL);
  const speech = await models(FAKE_RESPONSES_HOST_URL, { authorization: `Bearer ${FAKE_RESPONSES_KEY}` });
  if (!text.includes(FAKE_COACH) || !speech.includes(FAKE_TTS)) {
    throw new Error(
      `The fake AI servers do not serve the coach models (${FAKE_COACH} at ${FAKE_AI_HOST_URL}, ${FAKE_TTS} at ${FAKE_RESPONSES_HOST_URL}). ` +
        'Start the stack with the fake-ai.compose.yml overlay (restart fake-ai and fake-ai-responses if they predate E7.13), ' +
        'or set E2E_AI=0 to skip the AI end-to-end suites.',
    );
  }
}

export type NudgeMode = 'send' | 'decline';
export type SpeechMode = 'ok' | 'fail' | 'refuse';

export interface CoachSystemSettings {
  enabled: boolean;
  allowProfanePersonas: boolean;
  allowAudio: boolean;
  maxNudgesPerDayCeiling: number;
  audioRetentionDays: number;
  autoSilenceAfterIgnored: number;
  inactiveStopDays: number;
}

export interface FakeCoachSnapshot {
  adaptation: FakeAdaptationSnapshot;
  coachPolicy: CoachSystemSettings;
  /** Set once `setupFakeCoachVoice` ran. */
  voice?: { openai: { enabled: boolean; baseUrl: string | null; hadAdminKey: boolean }; assignments: AiAssignmentsView['assignments'] };
}

/** The coach policy, as stored. */
export function coachPolicy(admin: AuthedApi): Promise<CoachSystemSettings> {
  return admin.get<CoachSystemSettings>('/api/admin/coach/settings');
}

/** Change the deployment's coach policy (a subset; the rest keeps its value). */
export async function setCoachPolicy(admin: AuthedApi, patch: Partial<CoachSystemSettings>): Promise<CoachSystemSettings> {
  return admin.put<CoachSystemSettings>('/api/admin/coach/settings', patch);
}

/**
 * As admin: AI on against the fake OpenAI-compatible server, `fake-coach`
 * classified and enabled, `coach.decision` and `coach.chat` assigned to it,
 * and the coach switched on in the deployment policy. Returns what to put back.
 */
export async function setupFakeCoachAi(admin: AuthedApi): Promise<FakeCoachSnapshot> {
  const adaptation = await setupFakeAdaptationAi(admin);
  const policy = await coachPolicy(admin);
  if (!policy.enabled) await setCoachPolicy(admin, { enabled: true });

  const current = await admin.get<AiAssignmentsView>('/api/admin/ai/assignments');
  const ref = { provider: FAKE_PROVIDER_ID, modelId: FAKE_COACH };
  await putAssignments(admin, {
    default: current.assignments.default,
    features: { ...current.assignments.features, 'coach.decision': ref, 'coach.chat': ref },
  });
  return { adaptation, coachPolicy: policy };
}

/**
 * As admin: also let the coach speak. Enables the `openai` slot at the fake
 * Responses server, classifies `fake-tts` as a speech model, assigns
 * `coach.voice` to it and allows audio in the coach policy. The user still
 * needs a key for the slot (`setupFakeAiForUser`, key policy `byok`).
 */
export async function setupFakeCoachVoice(admin: AuthedApi, snapshot: FakeCoachSnapshot): Promise<void> {
  const before = await admin.get<AdminAiConfigFull>('/api/admin/ai/config');
  const openai = before.providers.find((provider) => provider.id === OPENAI_PROVIDER_ID);
  snapshot.voice = {
    openai: { enabled: openai?.enabled ?? false, baseUrl: openai?.baseUrl ?? null, hadAdminKey: openai?.keyStatus.configured ?? false },
    assignments: (await admin.get<AiAssignmentsView>('/api/admin/ai/assignments')).assignments,
  };

  await putConfig(admin, before, { enabled: before.enabled, webSearch: before.hostedTools.web_search, openai: { enabled: true, baseUrl: FAKE_RESPONSES_API_BASE_URL } });
  await admin.put(`/api/admin/ai/providers/${OPENAI_PROVIDER_ID}/key`, { apiKey: FAKE_RESPONSES_KEY });
  await admin.post('/api/admin/ai/models/refresh', { provider: OPENAI_PROVIDER_ID });

  let model: Awaited<ReturnType<typeof findModel>>;
  await expect
    .poll(
      async () => {
        model = await findModel(admin, FAKE_TTS);
        return Boolean(model) && !model?.deprecatedAt;
      },
      { message: `the catalog refresh never listed ${FAKE_TTS}; restart fake-ai-responses so it serves the coach speech model`, timeout: 60_000, intervals: [1_000, 2_000] },
    )
    .toBe(true);
  await admin.patch(`/api/admin/ai/models/${encodeURIComponent(model!.id)}`, {
    capabilities: { capabilities: ['audio_speech'], inputModalities: ['text'], outputModalities: ['audio'], voices: ['alloy', 'ash', 'coral', 'echo', 'nova', 'onyx'] },
    enabled: true,
  });

  const current = await admin.get<AiAssignmentsView>('/api/admin/ai/assignments');
  await putAssignments(admin, {
    default: current.assignments.default,
    features: { ...current.assignments.features, 'coach.voice': { provider: OPENAI_PROVIDER_ID, modelId: FAKE_TTS } },
  });
  await setCoachPolicy(admin, { allowAudio: true });
}

/** Put AI and the coach policy back the way `setupFakeCoachAi` (and the voice setup) found them. */
export async function teardownFakeCoachAi(admin: AuthedApi, snapshot: FakeCoachSnapshot): Promise<void> {
  await setCoachPolicy(admin, snapshot.coachPolicy).catch(() => undefined);
  if (snapshot.voice) {
    const current = await admin.get<AdminAiConfigFull>('/api/admin/ai/config');
    await putConfig(admin, current, { enabled: current.enabled, webSearch: current.hostedTools.web_search, openai: snapshot.voice.openai });
    if (!snapshot.voice.openai.hadAdminKey) {
      await admin.request('DELETE', `/api/admin/ai/providers/${OPENAI_PROVIDER_ID}/key`, { confirmation: 'REMOVE' }).catch(() => undefined);
    }
  }
  await teardownFakeAdaptationAi(admin, snapshot.adaptation);
}

/** Switch the fake coach's behaviour: `nudge` send or decline, `speech` ok, fail or refuse. */
export async function setFakeCoachMode(modes: { nudge?: NudgeMode; speech?: SpeechMode }): Promise<void> {
  if (modes.nudge) {
    const response = await fetch(`${FAKE_AI_HOST_URL}/__control/coach`, { method: 'POST', body: JSON.stringify({ nudge: modes.nudge }) });
    expect(response.ok, 'the fake vision server has no /__control/coach: restart fake-ai').toBe(true);
  }
  if (modes.speech) {
    const response = await fetch(`${FAKE_RESPONSES_HOST_URL}/__control/speech`, { method: 'POST', body: JSON.stringify({ mode: modes.speech }) });
    expect(response.ok, 'the fake Responses server has no /__control/speech: restart fake-ai-responses').toBe(true);
  }
}

// ---- the user's side -----------------------------------------------------------

export interface CoachSettingsBody {
  enabled?: boolean;
  personaId?: string;
  intensity?: number;
  profanity?: boolean;
  confirmAdult?: true;
  audio?: { enabled?: boolean; voice?: string | null; speed?: number };
  quietHours?: { start?: string; end?: string };
  maxNudgesPerDay?: number;
  lockScreenSafe?: boolean;
}

export interface CoachSettingsView {
  settings: { personaId: string; intensity: number; profanity: boolean; adultConfirmedAt: string | null; audio: { enabled: boolean } };
  effective: { register: { profane: boolean; reason: string | null }; intensity: number };
  policy: { enabled: boolean; allowProfanePersonas: boolean; allowAudio: boolean };
}

export function putCoachSettings(api: AuthedApi, body: CoachSettingsBody): Promise<CoachSettingsView> {
  return api.put<CoachSettingsView>('/api/coach/settings', body);
}

export function getCoachSettings(api: AuthedApi): Promise<CoachSettingsView> {
  return api.get<CoachSettingsView>('/api/coach/settings');
}

/**
 * A quiet-hours window of one hour that is at least five hours away from now
 * (UTC, the coach's zone for a user with no Health Profile time zone), so a
 * test never runs inside quiet hours.
 */
export function quietHoursAwayFromNow(now = new Date()): { start: string; end: string } {
  const hour = now.getUTCHours();
  const pad = (value: number) => `${String((value + 24) % 24).padStart(2, '0')}:00`;
  return { start: pad(hour + 6), end: pad(hour + 8) };
}

export interface CoachMessageView {
  id: string;
  role: 'coach' | 'user' | 'system';
  kind: string;
  moment: string | null;
  title: string;
  body: string;
  audioStatus: 'none' | 'pending' | 'ready' | 'failed';
  audioStorageObjectId: string | null;
  data: unknown;
  createdAt: string;
}

export async function coachMessages(api: AuthedApi): Promise<CoachMessageView[]> {
  return (await api.get<{ items: CoachMessageView[] }>('/api/coach/messages?limit=50')).items;
}

/** Poll the timeline until `find` matches a message (a queue job writes it); returns it. */
export async function waitForCoachMessage(
  api: AuthedApi,
  find: (message: CoachMessageView) => boolean,
  options: { message?: string; timeout?: number } = {},
): Promise<CoachMessageView> {
  let found: CoachMessageView | undefined;
  await expect
    .poll(
      async () => {
        found = (await coachMessages(api)).find(find);
        return found !== undefined;
      },
      { message: options.message ?? 'the coach message never appeared', timeout: options.timeout ?? 90_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe(true);
  return found!;
}

/** Sign in as a new admin in a throwaway context and run `fn` with its API client. */
export async function withAdmin<T>(browser: Browser, baseURL: string | undefined, fn: (api: AuthedApi) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    const { api } = await signIn(page, 'admin', 'coach-admin');
    return await fn(api);
  } finally {
    await context.close();
  }
}
