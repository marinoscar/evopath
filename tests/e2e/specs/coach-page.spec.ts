import { test as base, expect, type Page } from '@playwright/test';
import { signIn, type AuthedApi } from '../helpers/api.helper';
import {
  E2E_AI_DISABLED,
  callsSince,
  fakeLog,
  lastLogSeq,
  setupFakeAiForUser,
  teardownFakeAiForUser,
} from '../helpers/ai.helper';
import {
  assertFakeCoachReachable,
  coachMessages,
  putCoachSettings,
  quietHoursAwayFromNow,
  setFakeCoachMode,
  setupFakeCoachAi,
  setupFakeCoachVoice,
  teardownFakeCoachAi,
  waitForCoachMessage,
  withAdmin,
  type FakeCoachSnapshot,
} from '../helpers/coach.helper';
import { createTrainingGym, seedActivePlan } from '../helpers/training.helper';

/**
 * The AI Coach page and chat (E7.8, E7.7), nudge delivery (E7.5) and spoken
 * messages (E7.6), end to end with NO real key. The AI-on navigation (Coach as the
 * fourth tab, Gyms in the user menu and the rail) is in `shell-navigation.spec.ts`.
 *
 * Text comes from the fake OpenAI-compatible server (`fake-ai`, port 4010), speech
 * from the fake Responses server (`fake-ai-responses`, port 4011); see
 * `tests/e2e/support/fake-coach-scenarios.mjs` for what each answers and
 * `infra/compose/fake-ai.compose.yml` to start them.
 *
 * THE NUDGE. The hourly sweep is a cron and no test hook exists (a
 * production-only backdoor is not allowed), so the nudge is the one a user flow
 * triggers: activating a plan enqueues the coach kickoff (`ai.coach.nudge`,
 * moment `kickoff`, E7.12), and the test polls the timeline for it (job
 * completion, never a fixed sleep). Quiet hours are set to a window five hours
 * away first, so the kickoff is sent now and not deferred. The sweep's own
 * rules (missed two sessions, quiet hours, caps, the weekly review at Sunday
 * 18:00) need a controlled clock and are proven by the real-Postgres suites
 * `coach-sweep.db.spec.ts` and `coach-weekly-review.db.spec.ts`.
 *
 * Global state (AI settings, the coach policy, the fakes): serial, not beside
 * other AI specs. `E2E_AI=0` skips it.
 *
 *   cd tests/e2e && npm test -- coach-page --workers=1
 */

interface Owner {
  api: AuthedApi;
  email: string;
}

const test = base.extend<{ owner: Owner }>({
  owner: async ({ page }, use) => {
    const { api, email } = await signIn(page, 'contributor', 'coach-page');
    await putCoachSettings(api, { quietHours: quietHoursAwayFromNow() });
    await use({ api, email });
    await teardownFakeAiForUser(api);
  },
});

test.describe.configure({ mode: 'serial' });
test.skip(E2E_AI_DISABLED, 'E2E_AI=0');

let snapshot: FakeCoachSnapshot;

test.beforeAll(async ({ browser }, testInfo) => {
  await assertFakeCoachReachable();
  snapshot = await withAdmin(browser, testInfo.project.use.baseURL, async (admin) => {
    const taken = await setupFakeCoachAi(admin);
    await setupFakeCoachVoice(admin, taken);
    return taken;
  });
});

test.afterAll(async ({ browser }, testInfo) => {
  await setFakeCoachMode({ nudge: 'send', speech: 'ok' }).catch(() => undefined);
  await withAdmin(browser, testInfo.project.use.baseURL, (admin) => teardownFakeCoachAi(admin, snapshot));
});

/** A gym and an active plan: gives the coach signals to read, and queues the kickoff nudge. */
async function seedPlan(api: AuthedApi): Promise<void> {
  const gym = await createTrainingGym(api, 'Garage Gym');
  await seedActivePlan(api, gym);
}

/** The coach's articles on the page: the user's own bubbles are labelled `You` (aria-label). */
const coachArticles = (page: Page) => page.getByRole('article', { name: /^(?!You\b)/ });

test.describe('nudge', () => {
  test('activating a plan makes the coach send the kickoff nudge, which appears in /coach', async ({ page, owner }) => {
    await page.goto('/coach');
    await expect(page.getByTestId('coach-empty')).toBeVisible();

    const before = await lastLogSeq();
    await seedPlan(owner.api);

    const kickoff = await waitForCoachMessage(owner.api, (m) => m.role === 'coach' && m.moment === 'kickoff', {
      message: 'the kickoff nudge never reached the timeline (is the job queue running, and is coach.decision assigned to fake-coach?)',
    });
    expect(kickoff.title).toBe('Your plan is live');
    expect(kickoff.audioStatus).toBe('none');
    expect((await callsSince(before, 'coach_nudge')).length).toBeGreaterThan(0);

    await page.reload();
    const card = page.getByRole('article', { name: /Your plan is live/ });
    await expect(card).toBeVisible();
    await expect(card).toContainText('when will you train');
    await expect(page.getByTestId('coach-empty')).toHaveCount(0);
    // One kickoff per program, however many times the sweep or the listener runs.
    expect((await coachMessages(owner.api)).filter((m) => m.moment === 'kickoff')).toHaveLength(1);
  });
});

test.describe('chat', () => {
  test('"How am I doing?" answers from the signals tool, and the figures equal /api/training/signals', async ({ page, owner }) => {
    await seedPlan(owner.api);
    await page.goto('/coach');

    const before = await lastLogSeq();
    await page.getByRole('group', { name: 'Quick replies' }).getByRole('button', { name: 'How am I doing?' }).click();

    // The user's own bubble shows at once; the reply is the guarded text, streamed in chunks.
    await expect(page.getByRole('article', { name: /^You/ }).filter({ hasText: 'How am I doing?' })).toBeVisible();
    const signals = await owner.api.get<{ adherence: { totals: { planned: number; completed: number } } }>('/api/training/signals');
    const { planned, completed } = signals.adherence.totals;
    await expect(coachArticles(page).filter({ hasText: `completed ${completed} of ${planned} planned sessions` })).toBeVisible({ timeout: 60_000 });

    // The fake saw the tool loop: a first completion that asked for the tool, a second that answered.
    await expect.poll(async () => (await fakeLog(before)).filter((entry) => entry.schemaName === null && entry.text.includes('How am I doing?')).length).toBeGreaterThanOrEqual(2);

    // The reply is persisted: a reload shows it again.
    await page.reload();
    await expect(coachArticles(page).filter({ hasText: `completed ${completed} of ${planned} planned sessions` })).toBeVisible();
  });

  test('a typed message gets a direct answer', async ({ page, owner }) => {
    await page.goto('/coach');

    await page.getByRole('textbox', { name: 'Message your coach' }).fill('Can we talk about Thursday?');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByRole('article', { name: /^You/ }).filter({ hasText: 'Can we talk about Thursday?' })).toBeVisible();
    await expect(coachArticles(page).filter({ hasText: 'I am here whenever you want to talk through your plan' })).toBeVisible({ timeout: 60_000 });
    expect((await coachMessages(owner.api)).filter((m) => m.kind === 'chat')).toHaveLength(2);
  });

  test('a message about self-harm gets the supportive reply and never reaches a model', async ({ page, owner }) => {
    await page.goto('/coach');
    const before = await lastLogSeq();

    await page.getByRole('textbox', { name: 'Message your coach' }).fill('I want to end my life');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(coachArticles(page).filter({ hasText: 'someone you trust' })).toBeVisible({ timeout: 30_000 });
    const reply = (await coachMessages(owner.api)).find((m) => m.role === 'coach' && m.kind === 'chat');
    expect(reply?.body).toContain('mental health professional');
    expect(await fakeLog(before)).toHaveLength(0);
  });
});

test.describe('spoken nudges', () => {
  test('with audio on, the kickoff arrives as text plus a playable, labelled audio element', async ({ page, owner }) => {
    await setFakeCoachMode({ speech: 'ok' });
    await setupFakeAiForUser(owner.api);
    await putCoachSettings(owner.api, { audio: { enabled: true } });
    await seedPlan(owner.api);

    const kickoff = await waitForCoachMessage(owner.api, (m) => m.moment === 'kickoff' && m.audioStatus !== 'pending', {
      message: 'the kickoff never settled its audio',
      timeout: 150_000,
    });
    expect(kickoff.audioStatus).toBe('ready');
    expect(kickoff.audioStorageObjectId).not.toBeNull();
    expect(kickoff.body.length).toBeGreaterThan(0);

    await page.goto('/coach');
    const card = page.getByRole('article', { name: /Your plan is live/ });
    await expect(card).toContainText('when will you train');
    await expect(card.getByText('AI-generated audio')).toBeVisible();
    await expect(card.locator('audio')).toHaveCount(1);
  });

  for (const mode of ['fail', 'refuse'] as const) {
    test(`when the speech model ${mode === 'fail' ? 'fails' : 'refuses'}, the message is text only and the failure is recorded`, async ({ page, owner }) => {
      await setFakeCoachMode({ speech: mode });
      await setupFakeAiForUser(owner.api);
      await putCoachSettings(owner.api, { audio: { enabled: true } });
      await seedPlan(owner.api);

      const kickoff = await waitForCoachMessage(owner.api, (m) => m.moment === 'kickoff' && m.audioStatus !== 'pending', {
        message: 'the kickoff never settled its audio',
        timeout: 150_000,
      });
      expect(kickoff.audioStatus).toBe('failed');
      expect(kickoff.audioStorageObjectId).toBeNull();

      await page.goto('/coach');
      const card = page.getByRole('article', { name: /Your plan is live/ });
      await expect(card).toContainText('when will you train');
      await expect(card.locator('audio')).toHaveCount(0);
      await expect(card.getByText('AI-generated audio')).toHaveCount(0);
    });
  }
});
