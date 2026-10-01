import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test as base, expect, type Browser, type Page } from '@playwright/test';
import { signIn, type AuthedApi } from '../helpers/api.helper';
import {
  CANARY_BIO,
  CANARY_NAME,
  CANARY_NOTE,
  E2E_AI_DISABLED,
  FAKE_FAST,
  FAKE_FRONTIER,
  assertFakeResponsesReachable,
  fakeResponsesRequests,
  lastRequestSeq,
  resetFakeResponses,
  setAiEnabled,
  setFakeModelHostedTools,
  setupFakeAi,
  setupFakeAiForUser,
  teardownFakeAi,
  teardownFakeAiForUser,
  useScenario,
  type FakeAiSnapshot,
  type ScenarioName,
} from '../helpers/ai.helper';
import { createGymWithEquipment, type CreatedGym } from '../helpers/gym.helper';
import { setBio, setUnits } from '../helpers/profile.helper';

/**
 * Agentic training plans, end to end (browser, SSE, queue job, graph,
 * guardrails, real Postgres) with NO real key, against the fake OpenAI
 * Responses server (`tests/e2e/support/fake-responses-server.mjs`, service
 * `fake-ai-responses` of `infra/compose/fake-ai.compose.yml`).
 *
 * The fake replays the scenario fixtures in
 * `apps/api/test/fixtures/training/scenarios`, the same files the Jest scenario
 * suites (`apps/api/test/training-agents/scenarios`) replay; Jest is the CI
 * gate, this suite is the local proof that the assembled stack works. Start the
 * stack with the overlay, then:
 *
 *   cd tests/e2e && npm test -- training-plans --workers=1
 *
 * `E2E_AI=0` skips it; an unreachable fake fails it at once with the fix.
 * `E2E_ALLOW_DOCKER=1` also runs the kill-and-resume scenario (it restarts the
 * `api` container; `E2E_COMPOSE_FILES` overrides the compose file list).
 *
 * The fake's scenario and request log are global, so the suite runs serially
 * and must not run beside the other AI specs (they share the AI settings). It
 * puts the AI settings back in `afterAll`. Every test signs in as its own new
 * Contributor with its own gym and units, and no test sleeps: assertions wait
 * on what the page shows.
 *
 * The evaluation scenarios (autonomous adaptation with Undo, ask-first approve
 * and reject) assert the outcome through the API, which is verified, and drive
 * the adaptation banner, Undo, Approve and Reject through role and text
 * selectors written against the E5.8 UI before it landed: if the UI wording
 * differs, adjust `ADAPTATION_UI` below, nothing else.
 */

const RUN_URL = /\/train\/plans\/runs\/[0-9a-f-]{36}$/;
const PLAN_TITLE = 'Eight-week dumbbell base';
const REPO_ROOT = path.resolve(__dirname, '../../..');

interface Owner {
  api: AuthedApi;
  email: string;
  gym: CreatedGym;
}

const test = base.extend<{ owner: Owner }>({
  owner: async ({ page }, use) => {
    const { api, email } = await signIn(page, 'contributor', 'plans');
    await setUnits(api, 'imperial');
    const gym = await createGymWithEquipment(api, 'Garage Gym', ['adjustable_dumbbells', 'adjustable_bench']);
    await setupFakeAiForUser(api);
    await use({ api, email, gym });
    await teardownFakeAiForUser(api);
  },
});

/** Sign in as a new admin in a throwaway context and run `fn` with its API client. */
async function withAdmin<T>(browser: Browser, baseURL: string | undefined, fn: (api: AuthedApi) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    const { api } = await signIn(page, 'admin', 'plans-admin');
    return await fn(api);
  } finally {
    await context.close();
  }
}

/** Answer the wizard's four steps with the defaults the scenario fixtures were written for, and stop on Review. */
async function fillWizardToReview(page: Page, opts: { goalText?: string } = {}): Promise<void> {
  await page.goto('/train/plans/new');
  await expect(page.getByRole('heading', { level: 1, name: 'Create a plan with AI' })).toBeVisible();

  // Goal, experience.
  await page.getByRole('radio', { name: 'Fat loss' }).check();
  if (opts.goalText) await page.getByLabel('In your words').fill(opts.goalText);
  await page.getByRole('radio', { name: /^Beginner/ }).check();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Schedule and gym: 3 days, 45 minutes, 8 weeks, the default gym.
  await expect(page.getByRole('combobox', { name: 'Gym' })).toContainText('Garage Gym');
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Limits and preferences: none.
  await expect(page.getByText('This is used to make the plan conservative.')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Review: what will be sent and the estimate are there before Start.
  await expect(page.getByTestId('sent-data-panel')).toBeVisible();
  await expect(page.getByTestId('token-estimate')).toBeVisible();
}

/** Press Start on Review and wait for the live run page. */
async function startFromReview(page: Page): Promise<string> {
  const start = page.getByTestId('wizard-start');
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page).toHaveURL(RUN_URL, { timeout: 30_000 });
  return page.url().split('/').pop()!;
}

/** Scenario, wizard, Start: the run page of a new run. */
async function runFromWizard(page: Page, scenario: ScenarioName): Promise<string> {
  await useScenario(scenario);
  await fillWizardToReview(page);
  return startFromReview(page);
}

async function expectRunStatus(page: Page, label: string, timeout = 90_000): Promise<void> {
  await expect(page.getByTestId('run-status')).toHaveText(label, { timeout });
}

/** The program id the finished run's "Review plan" link points at. */
async function reviewPlanId(page: Page): Promise<string> {
  const link = page.getByRole('link', { name: 'Review plan' });
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  return decodeURIComponent(href!.split('/').pop()!);
}

/** Start a create run through the API (skips the wizard); the intake matches the fixtures. */
async function startRunViaApi(owner: Owner, scenario: ScenarioName, autonomy: 'autonomous' | 'ask_first' = 'autonomous'): Promise<string> {
  await useScenario(scenario);
  const started = await owner.api.post<{ runId: string; status: string }>('/api/ai/training/runs', {
    kind: 'create',
    intake: {
      goal: { type: 'fat_loss', description: 'Lose fat and feel fitter' },
      experience: 'beginner',
      daysPerWeek: 3,
      minutesPerSession: 45,
      durationWeeks: 8,
      gymId: owner.gym.id,
      autonomy,
    },
  });
  return started.runId;
}

interface RunBody {
  status: string;
  programId: string | null;
  result: { programId?: string } | null;
}

/** Wait for a run to end and return the program it created. */
async function programOfRun(api: AuthedApi, runId: string): Promise<string> {
  let run: RunBody | undefined;
  await expect
    .poll(
      async () => {
        run = await api.get<RunBody>(`/api/ai/training/runs/${runId}`);
        return run.status;
      },
      { message: 'the run never succeeded', timeout: 120_000, intervals: [1_000, 2_000] },
    )
    .toBe('succeeded');
  const programId = run!.programId ?? run!.result?.programId;
  expect(programId).toBeTruthy();
  return programId!;
}

test.describe('Training plans with the fake Responses provider', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  test.skip(E2E_AI_DISABLED, 'E2E_AI=0: the AI end-to-end suites are skipped.');

  let snapshot: FakeAiSnapshot | null = null;

  test.beforeAll(async ({ browser, baseURL }) => {
    await assertFakeResponsesReachable();
    snapshot = await withAdmin(browser, baseURL, (admin) => setupFakeAi(admin));
  });

  test.afterAll(async ({ browser, baseURL }) => {
    if (!snapshot) return;
    const prior = snapshot;
    await withAdmin(browser, baseURL, (admin) => teardownFakeAi(admin, prior));
  });

  test.beforeEach(async () => {
    await resetFakeResponses();
  });

  test('happy path: wizard, sent data, live run with stages and sources, evidence chips, edit makes a version, activate', async ({ page, owner }) => {
    void owner;
    const seq = await lastRequestSeq();
    await runFromWizard(page, 'happy');

    await expectRunStatus(page, 'Ready');
    await expect(page.getByTestId('run-stage-context')).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('run-stage-research')).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('run-stage-critique')).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('source-row')).toHaveCount(3);
    await expect(page.getByTestId('draft-row')).toHaveCount(1);
    await expect(page.getByTestId('guardrail-round')).toHaveCount(1);
    await expect(page.getByTestId('critic-scorecard')).toHaveCount(1);
    await expect(page.getByTestId('usage-total')).toBeVisible();

    // What the agents were sent, seen from outside: roles in order, the researcher with web search.
    const requests = await fakeResponsesRequests(seq);
    expect(requests.map((r) => r.agent)).toEqual(['researcher', 'planner', 'critic', 'critic']);
    expect(requests[0]).toMatchObject({ model: FAKE_FRONTIER, reasoningEffort: 'medium', hasSchema: true });
    expect(requests[0].toolTypes).toContain('web_search');
    expect(requests[1]).toMatchObject({ model: FAKE_FRONTIER, reasoningEffort: 'high', hasSchema: true });
    expect(requests[2]).toMatchObject({ model: FAKE_FAST, reasoningEffort: 'low' });

    await page.getByRole('link', { name: 'Review plan' }).click();
    await expect(page.getByRole('heading', { level: 1, name: PLAN_TITLE })).toBeVisible();
    await expect(page.locator('[data-testid^="evidence-chip-"]').first()).toBeVisible();

    // Editing makes a new version.
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Plan name').fill('My dumbbell plan');
    await page.getByTestId('plan-save').click();
    await expect(page.getByRole('heading', { level: 1, name: 'My dumbbell plan' })).toBeVisible();
    await expect(page.getByText('Version 2', { exact: true })).toBeVisible();

    // Activate.
    await page.getByRole('button', { name: 'Activate', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Activate this plan' });
    await dialog.getByRole('button', { name: 'Activate', exact: true }).click();
    await expect(page.getByText('Active', { exact: true })).toBeVisible();
  });

  test('critic rejects once: two critique rounds are visible and the second approves', async ({ page, owner }) => {
    void owner;
    await runFromWizard(page, 'critic-reject-once');

    await expectRunStatus(page, 'Ready');
    await expect(page.getByTestId('critic-scorecard')).toHaveCount(2);
    await expect(page.getByTestId('draft-row')).toHaveCount(2);
    await expect(page.getByTestId('guardrail-round')).toHaveCount(2);
    await page.getByRole('link', { name: 'Review plan' }).click();
    await expect(page.getByRole('heading', { level: 1, name: `${PLAN_TITLE} (revised)` })).toBeVisible();
  });

  test('hostile planner: the repairs are listed and the plan carries none of the hostile content', async ({ page, owner }) => {
    await runFromWizard(page, 'planner-hostile');

    await expectRunStatus(page, 'Ready');
    const round = page.getByTestId('guardrail-round').first();
    await expect(round).toContainText('Repaired');
    await expect(round.getByRole('list', { name: /Repairs in round 1/ })).toBeVisible();
    await expect(round).toContainText('not in the exercise library');

    const programId = await reviewPlanId(page);
    const stored = JSON.stringify(await owner.api.get(`/api/programs/${programId}`));
    for (const bad of ['made-up.example', 'quantum_deadlift', 'Ignore your previous instructions', '"targetLoadKg":500']) {
      expect(stored).not.toContain(bad);
    }
    await page.getByRole('link', { name: 'Review plan' }).click();
    await expect(page.getByText('made-up.example')).toHaveCount(0);
    await expect(page.getByText(/reveal the system prompt/i)).toHaveCount(0);
  });

  test('research with a fabricated URL: the source is absent and the dropped count is shown', async ({ page, owner }) => {
    void owner;
    await runFromWizard(page, 'research-fabricated-url');

    await expectRunStatus(page, 'Ready');
    await expect(page.getByTestId('source-row')).toHaveCount(3);
    await expect(page.locator('a[href*="made-up-journal"]')).toHaveCount(0);
    await expect(page.getByText('1 source could not be verified and was removed')).toBeVisible();
  });

  test('insufficient research: the run fails with guidance and no plan is made', async ({ page, owner }) => {
    void owner;
    await runFromWizard(page, 'research-insufficient');

    await expectRunStatus(page, 'Failed');
    await expect(page.getByTestId('run-failed')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Review plan' })).toHaveCount(0);
  });

  test('reload mid-run replays the same state, and Cancel ends the run cancelled', async ({ page, owner }) => {
    const runId = await startRunViaApi(owner, 'slow');
    await page.goto(`/train/plans/runs/${runId}`);

    await expect(page.getByTestId('run-stage-context')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
    await expect(page.getByTestId('run-status')).not.toHaveText('Ready');

    await page.reload();
    await expect(page.getByTestId('run-stage-context')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
    await expect(page.getByTestId('run-status')).toHaveText(/Queued|Running/);

    await page.getByRole('button', { name: 'Cancel run' }).click();
    await page.getByRole('dialog', { name: 'Cancel this run?' }).getByRole('button', { name: 'Stop the run' }).click();
    await expectRunStatus(page, 'Cancelled', 60_000);
    await expect(page.getByText('No plan was saved from this run.')).toBeVisible();
  });

  test('safety: an urgent symptom shows guidance and the provider receives no request', async ({ page, owner }) => {
    void owner;
    await useScenario('happy');
    const seq = await lastRequestSeq();
    await fillWizardToReview(page);
    // Go back to the goal step and describe the symptom, then return to Review.
    // Scoped to the wizard's action bar: the "Back" limitation chip (body area) has the same name.
    const back = page.getByRole('region', { name: 'Wizard actions' }).getByRole('button', { name: 'Back', exact: true });
    for (let i = 0; i < 3; i += 1) await back.click();
    await page.getByLabel('In your words').fill('I get crushing chest pain and feel faint when I exercise');
    for (let i = 0; i < 3; i += 1) await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByTestId('sent-data-panel')).toBeVisible();

    await page.getByTestId('wizard-start').click();

    await expect(page.getByTestId('safety-guidance')).toBeVisible();
    await expect(page).not.toHaveURL(RUN_URL);
    expect(await fakeResponsesRequests(seq)).toHaveLength(0);
  });

  test('data minimisation: no canary reaches the provider across a whole run', async ({ page, owner }) => {
    await owner.api.patch(`/api/gyms/${owner.gym.id}`, { name: `Garage Gym ${CANARY_NAME}`, notes: CANARY_NOTE });
    await setBio(owner.api, CANARY_BIO);
    const seq = await lastRequestSeq();
    const runId = await startRunViaApi(owner, 'happy');
    await programOfRun(owner.api, runId);
    await page.goto(`/train/plans/runs/${runId}`);
    await expectRunStatus(page, 'Ready');

    const requests = await fakeResponsesRequests(seq);
    expect(requests.length).toBeGreaterThanOrEqual(4);
    expect(requests.reduce((sum, r) => sum + r.canaryHits, 0)).toBe(0);
    expect(requests.every((r) => r.hasAuthorization && r.status === 200)).toBe(true);
  });

  test('a blocked role: no model can search, so the researcher shows the blocker and Start is disabled', async ({ page, owner: _owner, browser, baseURL }) => {
    // Models are the administrator's choice (#173), and a model without hosted tools cannot be assigned to
    // the researcher. The state is reached by the catalog: the only searching model loses `hosted_tools`.
    await withAdmin(browser, baseURL, (admin) => setFakeModelHostedTools(admin, FAKE_FRONTIER, false));
    try {
      await fillWizardToReview(page);

      await expect(page.getByText(/The researcher agent needs a model with web search/)).toBeVisible();
      await expect(page.getByTestId('wizard-start')).toBeDisabled();
    } finally {
      await withAdmin(browser, baseURL, (admin) => setFakeModelHostedTools(admin, FAKE_FRONTIER, true));
    }
  });

  test('Today: start the planned workout, log, finish; Today shows it done', async ({ page, owner }) => {
    const runId = await startRunViaApi(owner, 'happy');
    const programId = await programOfRun(owner.api, runId);
    const todayIso = await putTodayIntoPlan(owner.api, programId);
    await owner.api.post(`/api/programs/${programId}/activate`, { startDate: todayIso });

    await finishTodaysPlannedWorkout(page);

    await page.goto('/');
    await expect(page.getByTestId('today-plan')).toContainText(': done', { timeout: 30_000 });
  });

  test('autonomous adaptation: finishing a workout triggers an evaluation, the plan adapts, the banner shows and Undo restores it', async ({ page, owner }) => {
    const runId = await startRunViaApi(owner, 'happy');
    const programId = await programOfRun(owner.api, runId);
    await activateStartedLastWeek(owner.api, programId);
    await useScenario('evaluator-autonomous');
    const after = await lastRequestSeq();

    await finishTodaysPlannedWorkout(page);

    // The evaluation ran without a question: version 2, one applied AI entry.
    await waitForVersion(owner.api, programId, 2);
    const [entry] = await adaptedEntries(owner.api, programId);
    expect(entry).toMatchObject({ kind: 'adapted', actor: 'ai', status: 'applied', fromVersion: 1, toVersion: 2 });
    const requests = (await fakeResponsesRequests(after)).filter((r) => r.agent === 'evaluator');
    expect(requests).toHaveLength(1);
    expect(requests.every((r) => r.canaryHits === 0 && r.hasSchema)).toBe(true);

    // The banner says so, and Undo (one tap) restores the plan as version 3.
    await page.goto(`/train/plans/${programId}`);
    await expect(page.getByText(ADAPTATION_UI.banner).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: ADAPTATION_UI.undo }).first().click();
    await waitForVersion(owner.api, programId, 3);
    expect((await adaptedEntries(owner.api, programId))[0]).toMatchObject({ id: entry.id, status: 'reverted' });
  });

  test('ask first: the proposal appears and Approve applies it', async ({ page, owner }) => {
    const runId = await startRunViaApi(owner, 'happy', 'ask_first');
    const programId = await programOfRun(owner.api, runId);
    await activateStartedLastWeek(owner.api, programId);
    await useScenario('evaluator-autonomous');

    await finishTodaysPlannedWorkout(page);

    // Paused for the owner: a proposed entry, the plan untouched.
    await evaluateRun(owner.api, programId, 'awaiting_approval');
    expect(await currentVersion(owner.api, programId)).toBe(1);
    expect((await adaptedEntries(owner.api, programId))[0]).toMatchObject({ status: 'proposed', toVersion: null });

    await page.goto(`/train/plans/${programId}`);
    await expect(page.getByText(ADAPTATION_UI.proposal).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: ADAPTATION_UI.approve }).first().click();

    await waitForVersion(owner.api, programId, 2);
    await evaluateRun(owner.api, programId, 'succeeded');
    expect((await adaptedEntries(owner.api, programId))[0]).toMatchObject({ status: 'applied', fromVersion: 1, toVersion: 2 });
  });

  test('ask first: Reject leaves the plan as it was and records the decision', async ({ page, owner }) => {
    const runId = await startRunViaApi(owner, 'happy', 'ask_first');
    const programId = await programOfRun(owner.api, runId);
    await activateStartedLastWeek(owner.api, programId);
    await useScenario('evaluator-autonomous');

    await finishTodaysPlannedWorkout(page);
    await evaluateRun(owner.api, programId, 'awaiting_approval');

    await page.goto(`/train/plans/${programId}`);
    await expect(page.getByText(ADAPTATION_UI.proposal).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: ADAPTATION_UI.reject }).first().click();

    await evaluateRun(owner.api, programId, 'succeeded');
    expect(await currentVersion(owner.api, programId)).toBe(1);
    expect((await adaptedEntries(owner.api, programId))[0]).toMatchObject({ status: 'rejected', toVersion: null });
  });

  test('AI off: AI routes answer 403 and the wizard redirects; the manual builder, Today and the viewer still work', async ({ page, owner, browser, baseURL }) => {
    const manual = await owner.api.post<{ id: string }>('/api/programs', { name: 'Manual plan', goal: 'general' });
    await withAdmin(browser, baseURL, (admin) => setAiEnabled(admin, false));
    try {
      await expect(
        owner.api.post('/api/ai/training/runs', { kind: 'create', intake: { goal: { type: 'general' }, experience: 'beginner', daysPerWeek: 3, minutesPerSession: 45 } }),
      ).rejects.toThrow(/403/);

      await page.goto('/train/plans/new');
      await expect(page).toHaveURL(/\/train\/plans$/);

      await page.goto(`/train/plans/${manual.id}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Manual plan' })).toBeVisible();
      await page.goto('/');
      await expect(page.getByTestId('today-plan')).toBeVisible();
    } finally {
      await withAdmin(browser, baseURL, (admin) => setAiEnabled(admin, true));
    }
  });

  test('kill and resume: restarting the API container mid-run resumes the run', async ({ page, owner }) => {
    test.skip(process.env.E2E_ALLOW_DOCKER !== '1', 'Set E2E_ALLOW_DOCKER=1 to restart the api container mid-run.');
    test.setTimeout(6 * 60_000);

    const runId = await startRunViaApi(owner, 'slow');
    await page.goto(`/train/plans/runs/${runId}`);
    await expect(page.getByTestId('run-stage-context')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });

    const files = (process.env.E2E_COMPOSE_FILES ?? 'base,dev,devdb,fake-ai').split(',').flatMap((name) => ['-f', `${name}.compose.yml`]);
    execFileSync('docker', ['compose', ...files, 'restart', 'api'], { cwd: path.join(REPO_ROOT, 'infra/compose'), stdio: 'inherit' });

    await page.reload();
    await expect
      .poll(
        async () => {
          const resume = page.getByRole('button', { name: 'Resume' });
          if (await resume.isVisible()) await resume.click();
          return page.getByTestId('run-status').innerText();
        },
        { message: 'the run never resumed after the restart', timeout: 4 * 60_000, intervals: [3_000] },
      )
      .toBe('Ready');
  });
});

/** Today's planned workout, started, one set logged, finished from the summary: the `workout.finished` trigger. */
async function finishTodaysPlannedWorkout(page: Page): Promise<void> {
  await page.goto('/');
  const card = page.getByTestId('today-plan');
  await expect(card).toHaveAttribute('data-kind', 'workout', { timeout: 30_000 });
  await card.getByRole('button', { name: 'Start planned workout' }).click();
  await expect(page).toHaveURL(/\/train\/workouts\/[0-9a-f-]{36}$/);

  // Log the first set of the first exercise (a planned workout has several, each with a "Set 1"): fill
  // whatever the planned set leaves empty, then complete it.
  const weight = page.getByLabel('Set 1 weight in lb', { exact: true }).first();
  if ((await weight.count()) > 0 && (await weight.inputValue()) === '') await weight.fill('20');
  const reps = page.getByLabel('Set 1 reps', { exact: true }).first();
  if ((await reps.inputValue()) === '') await reps.fill('10');
  const complete = page.getByRole('button', { name: 'Complete set 1' }).first();
  if ((await complete.getAttribute('aria-pressed')) !== 'true') await complete.click();
  await expect(complete).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  // The other planned sets were prefilled and not touched: "Leave them" (the confirm appears only when some are).
  const confirmFinish = page.getByRole('dialog', { name: 'Finish workout?' });
  const summary = page.getByRole('dialog', { name: 'Workout finished' });
  await expect(confirmFinish.or(summary)).toBeVisible();
  if (await confirmFinish.isVisible()) await confirmFinish.getByRole('button', { name: 'Leave them' }).click();
  await expect(summary).toBeVisible();
  await summary.getByRole('button', { name: 'Done' }).click();
}

/** `YYYY-MM-DD` of the local date `days` from now. */
function localDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString('en-CA');
}

/**
 * A plan with a workout on today's weekday, activated to have started a week
 * ago (the furthest back activation allows): week 1 is entirely past (three
 * sessions due, so the evaluator has data) and today's session is week 2's.
 */
async function activateStartedLastWeek(api: AuthedApi, programId: string): Promise<void> {
  await putTodayIntoPlan(api, programId);
  await api.post(`/api/programs/${programId}/activate`, { startDate: localDate(-7) });
}

interface ProgramBody {
  currentVersion: number;
  autonomy: string;
}

async function currentVersion(api: AuthedApi, programId: string): Promise<number> {
  return (await api.get<ProgramBody>(`/api/programs/${programId}`)).currentVersion;
}

async function waitForVersion(api: AuthedApi, programId: string, version: number): Promise<void> {
  await expect
    .poll(() => currentVersion(api, programId), { message: `the plan never reached version ${version}`, timeout: 120_000, intervals: [1_000, 2_000] })
    .toBe(version);
}

interface ChangeLogEntryBody {
  kind: string;
  actor: string;
  status: string;
  fromVersion: number | null;
  toVersion: number | null;
  id: string;
}

async function adaptedEntries(api: AuthedApi, programId: string): Promise<ChangeLogEntryBody[]> {
  const page = await api.get<{ items: ChangeLogEntryBody[] }>(`/api/programs/${programId}/change-log`);
  return page.items.filter((entry) => entry.kind === 'adapted');
}

/** The newest evaluate run of the plan, once it has reached `status`. */
async function evaluateRun(api: AuthedApi, programId: string, status: string): Promise<{ id: string; status: string }> {
  let found: { id: string; status: string } | undefined;
  await expect
    .poll(
      async () => {
        const list = await api.get<{ items: Array<{ id: string; kind: string; status: string }> }>(
          `/api/ai/training/runs?programId=${programId}&status=${status}`,
        );
        found = list.items.find((run) => run.kind === 'evaluate');
        return found?.status;
      },
      { message: `no evaluate run reached ${status}`, timeout: 120_000, intervals: [1_000, 2_000] },
    )
    .toBe(status);
  return found!;
}

/**
 * UNVERIFIED selectors for the E5.8 adaptation surface (written before the UI
 * landed, role and text based on purpose). Change them here if the wording differs.
 */
const ADAPTATION_UI = {
  banner: /(adjusted|changed|updated) your plan|plan (was|has been) (adjusted|changed|updated)/i,
  undo: /^Undo/,
  proposal: /suggest(ed|s)?|proposal|proposed change/i,
  approve: /^Approve/,
  reject: /^(Reject|Decline|Not now)/,
};

/** ISO weekday (1 Monday .. 7 Sunday) of a local date. */
function isoWeekday(date: Date): number {
  return ((date.getDay() + 6) % 7) + 1;
}

interface TreeExercise extends Record<string, unknown> {
  exercise?: unknown;
  exerciseUnavailable?: unknown;
}
interface TreeWorkout extends Record<string, unknown> {
  weekday: number | null;
  exercises: TreeExercise[];
}
interface Tree {
  blocks: Array<{ weeks: Array<{ workouts: TreeWorkout[] }> } & Record<string, unknown>>;
}

/**
 * Edit the plan (the manual path, so the same as a user editing it) so a
 * workout falls on today's weekday in every week, and return today's date as
 * `YYYY-MM-DD` for the activation. A resolver rule, not a workaround: a
 * planned workout only occurs on its own weekday.
 */
async function putTodayIntoPlan(api: AuthedApi, programId: string): Promise<string> {
  const now = new Date();
  const weekday = isoWeekday(now);
  const program = await api.get<{ currentVersion: number; tree: Tree }>(`/api/programs/${programId}`);
  const tree: Tree = JSON.parse(JSON.stringify(program.tree));
  for (const block of tree.blocks) {
    for (const week of block.weeks) {
      if (!week.workouts.some((w) => w.weekday === weekday)) week.workouts[0].weekday = weekday;
      for (const workout of week.workouts) {
        // The view carries the resolved exercise; the write shape does not.
        for (const exercise of workout.exercises) {
          delete exercise.exercise;
          delete exercise.exerciseUnavailable;
        }
      }
    }
  }
  await api.request('PUT', `/api/programs/${programId}/structure`, tree, { 'If-Match': String(program.currentVersion) });
  return now.toLocaleDateString('en-CA');
}
