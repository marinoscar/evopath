import path from 'node:path';
import { test as base, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { signIn, type AuthedApi } from '../helpers/api.helper';
import {
  CANARY_BIO,
  CANARY_NAME,
  CANARY_NOTE,
  CRITIQUE_SCHEMA,
  E2E_AI_DISABLED,
  FAKE_MODEL_ID,
  PROPOSAL_SCHEMA,
  SCRIPTED_TOKENS,
  assertFakeAdaptationReachable,
  callsSince,
  fakeLog,
  lastLogSeq,
  resetFake,
  setAdaptationAiEnabled,
  setFakeModelEnabled,
  setAdaptationRunLimitForUser,
  setupFakeAdaptationAi,
  teardownAdaptationUser,
  teardownFakeAdaptationAi,
  useAdaptationScenario,
  type AdaptationScenarioName,
  type FakeAdaptationSnapshot,
} from '../helpers/ai.helper';
import { setBio, setUnits } from '../helpers/profile.helper';
import {
  PLANNED_TOTAL_SETS,
  UPPER_A_SLUGS,
  adaptedEntries,
  programVersion,
  seedActivePlan,
  seedCheckIn,
  settledAdaptation,
  startAdaptationViaApi,
  createTrainingGym,
  type SeededTraining,
} from '../helpers/training.helper';
import { expectStatus, getWorkout, type WorkoutBody } from '../helpers/workout.helper';

/**
 * Quick workout adaptation and hotel workouts, end to end (browser, SSE, queue
 * job, graph, guardrails, storage, real Postgres) with NO real key, against the
 * fake OpenAI-compatible server (`tests/e2e/support/fake-vision-server.mjs`
 * plus `fake-adaptation-scenarios.mjs`, service `fake-ai` of
 * `infra/compose/fake-ai.compose.yml`).
 *
 * The fake computes the planner's answer from the `<context-json>` block of the
 * request (exercise keys are generated at seed time), picks a scenario per
 * process (`useAdaptationScenario`) or per request (`SCENARIO:<name>` in the
 * free text), and logs every completion (`fakeLog`: schema name, image count
 * and message text, never image bytes), which is how the suite proves data
 * minimisation from outside the API: no canary, no gym name, no photo in an
 * adaptation call, and only the fixture photos in the scan call.
 *
 * Jest is the CI gate (the graph, the guardrails, the contract with the fake
 * in `apps/api/test/ai/adaptation-fake-server-contract.spec.ts`); the e2e tier
 * is not in CI. Start the stack with the overlay, then:
 *
 *   cd tests/e2e && npm test -- training-adaptation --workers=1
 *
 * `E2E_AI=0` skips it; an unreachable or outdated fake fails it at once with
 * the fix. The scenario, the request log and the AI settings are global, so the
 * suite runs serially and must not run beside the other AI specs. It puts the
 * AI settings back in `afterAll`. Every test signs in as its own new
 * Contributor with its own gym, plan and check-in, and no test sleeps except
 * where it must prove that something did NOT happen (cancel).
 *
 * The hotel path uploads photos, so it needs object storage configured on the
 * stack, like the "Scan gym" spec.
 */

const FIXTURES = path.resolve(__dirname, '../fixtures');
const HOTEL_PHOTOS = [path.join(FIXTURES, 'hotel-gym-1.jpg'), path.join(FIXTURES, 'hotel-gym-2.jpg')];
const SHEET_TITLE = "Adjust today's workout";
const ADAPT_URL = /\/train\/adapt\/[0-9a-f-]{36}$/;
const WORKOUT_URL = /\/train\/workouts\/[0-9a-f-]{36}$/;
/** The gym is named after a canary: its name must never reach a model. */
const GYM_NAME = `Garage ${CANARY_NAME}`;

interface Owner {
  api: AuthedApi;
  email: string;
  training: SeededTraining;
}

const test = base.extend<{ owner: Owner }>({
  owner: async ({ page }, use) => {
    const { api, email } = await signIn(page, 'contributor', 'adapt');
    await setUnits(api, 'imperial');
    await setBio(api, `Trains hard. ${CANARY_BIO}`);
    const gym = await createTrainingGym(api, GYM_NAME);
    const training = await seedActivePlan(api, gym);
    await seedCheckIn(api, training.today, { note: `Slept badly ${CANARY_NOTE}` });
    await use({ api, email, training });
    await teardownAdaptationUser(api);
  },
});

/** Sign in as a new admin in a throwaway context and run `fn` with its API client. */
async function withAdmin<T>(browser: Browser, baseURL: string | undefined, fn: (api: AuthedApi) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    const { api } = await signIn(page, 'admin', 'adapt-admin');
    return await fn(api);
  } finally {
    await context.close();
  }
}

/** Today's page with the planned workout card ready. */
async function openToday(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('today-plan')).toHaveAttribute('data-kind', 'workout', { timeout: 30_000 });
}

/** Today's page, then the "Adjust today's workout" sheet. */
async function openSheet(page: Page): Promise<Locator> {
  await openToday(page);
  await page.getByRole('button', { name: SHEET_TITLE }).click();
  const dialog = page.getByRole('dialog', { name: SHEET_TITLE });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 30 minutes, sore chest (mild), only the dumbbells and the bench. */
async function chooseThirtySoreOnlyDumbbells(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: '30 minutes', exact: true }).click();
  await dialog.getByRole('button', { name: "I'm sore", exact: true }).click();
  await dialog.getByRole('button', { name: 'Chest', exact: true }).click();
  await dialog.getByRole('button', { name: 'Mild', exact: true }).click();
  await dialog.getByRole('button', { name: 'Only these', exact: true }).click();
  await dialog.getByRole('button', { name: 'Adjustable dumbbells', exact: true }).click();
  await dialog.getByRole('button', { name: 'Adjustable bench', exact: true }).click();
}

/** Press Adjust workout and wait for the adaptation page. Returns the adaptation id. */
async function submitSheet(page: Page, dialog: Locator): Promise<string> {
  const button = dialog.getByRole('button', { name: 'Adjust workout', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page).toHaveURL(ADAPT_URL, { timeout: 30_000 });
  return page.url().split('/').pop()!;
}

async function expectReview(page: Page): Promise<Locator> {
  const review = page.getByTestId('adaptation-review');
  await expect(review).toBeVisible({ timeout: 120_000 });
  return review;
}

/** Log the first set of the open workout and finish it from the summary dialog. Returns the summary. */
async function finishWorkoutFromLogger(page: Page): Promise<Locator> {
  // The first exercise's first set (an adjusted workout has several exercises).
  const weight = page.getByLabel('Set 1 weight in lb', { exact: true }).first();
  await expect(weight).toBeVisible();
  if ((await weight.inputValue()) === '') await weight.fill('20');
  const reps = page.getByLabel('Set 1 reps', { exact: true }).first();
  if ((await reps.inputValue()) === '') await reps.fill('10');
  const complete = page.getByRole('button', { name: 'Complete set 1' }).first();
  if ((await complete.getAttribute('aria-pressed')) !== 'true') await complete.click();
  await expect(complete).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  // Prefilled sets nobody touched: "Leave them" (the confirm appears only when some are valued and not done).
  const confirmFinish = page.getByRole('dialog', { name: 'Finish workout?' });
  const summary = page.getByRole('dialog', { name: 'Workout finished' });
  await expect(confirmFinish.or(summary)).toBeVisible();
  if (await confirmFinish.isVisible()) await confirmFinish.getByRole('button', { name: 'Leave them' }).click();
  await expect(summary).toBeVisible();
  return summary;
}

/** The exercise slugs of the plan's session in week 1 (the week that starts today). */
async function plannedSessionExerciseCount(api: AuthedApi, programId: string): Promise<number> {
  const program = await api.get<{ tree: { blocks: Array<{ weeks: Array<{ weekNumber: number; workouts: Array<{ exercises: unknown[] }> }> }> } }>(
    `/api/programs/${programId}`,
  );
  const week = program.tree.blocks[0].weeks.find((w) => w.weekNumber === 1)!;
  return week.workouts[0].exercises.length;
}

/** What the models must never receive, whatever the scenario. */
function expectMinimised(entries: Array<{ text: string; imageCount: number }>, extraForbidden: string[] = []): void {
  for (const entry of entries) {
    for (const secret of [CANARY_BIO, CANARY_NOTE, CANARY_NAME, ...extraForbidden]) {
      expect(entry.text, `a model request carried "${secret}"`).not.toContain(secret);
    }
    expect(entry.imageCount, 'an adaptation call carried a photo').toBe(0);
  }
}

test.describe('Quick adaptation and hotel workouts with the fake provider', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  test.skip(E2E_AI_DISABLED, 'E2E_AI=0: the AI end-to-end suites are skipped.');

  let snapshot: FakeAdaptationSnapshot | null = null;

  test.beforeAll(async ({ browser, baseURL }) => {
    await assertFakeAdaptationReachable();
    snapshot = await withAdmin(browser, baseURL, (admin) => setupFakeAdaptationAi(admin));
  });

  test.afterAll(async ({ browser, baseURL }) => {
    if (!snapshot) return;
    const prior = snapshot;
    await withAdmin(browser, baseURL, (admin) => teardownFakeAdaptationAi(admin, prior));
    await useAdaptationScenario('valid').catch(() => undefined);
  });

  test.beforeEach(async () => {
    await resetFake();
    await useAdaptationScenario('valid');
  });

  // ---------------------------------------------------------------------------
  // 1. Happy path
  // ---------------------------------------------------------------------------
  test('adjusts today for 30 minutes, sore chest, dumbbells only, and uses it for today only', async ({ page, owner }) => {
    // `slow` answers exactly like `valid` but takes 3 s per call, so the stages are on screen long enough to assert.
    await useAdaptationScenario('slow');
    const since = await lastLogSeq();
    const versionBefore = await programVersion(owner.api, owner.training.programId);

    const dialog = await openSheet(page);
    await chooseThirtySoreOnlyDumbbells(dialog);

    // "What will be sent": rendered from the same object the API sends, PII free.
    const summary = dialog.getByTestId('sent-data-summary');
    await summary.getByRole('button', { name: 'What will be sent' }).click();
    const sentList = summary.getByRole('list', { name: 'Sent to the AI' });
    await expect(sentList).toBeVisible({ timeout: 30_000 });
    await expect(summary).toContainText('Never sent:');
    for (const secret of [CANARY_BIO, CANARY_NOTE, CANARY_NAME, GYM_NAME]) {
      await expect(summary).not.toContainText(secret);
    }

    await submitSheet(page, dialog);

    // Progress shows the stages while the job runs.
    await expect(page.getByTestId('adaptation-progress')).toBeVisible({ timeout: 30_000 });
    for (const stage of ['context', 'plan', 'guardrails', 'critique']) {
      await expect(page.getByTestId(`adapt-stage-${stage}`)).toBeVisible();
    }

    // The review: AI badge, the diff, the rationale and the usage panel.
    const review = await expectReview(page);
    await expect(review.getByLabel('Made by AI')).toBeVisible();
    await expect(review.getByText('Draft, not medical advice.')).toBeVisible();
    await expect(review.getByTestId('diff-kept').first()).toBeVisible();
    await expect(review.getByTestId('diff-dropped').filter({ hasText: 'Reason: Equipment' })).toHaveCount(1);
    await expect(review.getByRole('heading', { name: 'Why' })).toBeVisible();
    await expect(review.getByTestId('critic-verdict')).toContainText('Critic: accepted');
    await expect(review.getByTestId('adapt-minutes')).toContainText('you asked for 30 min');

    const usage = page.getByTestId('agent-usage-panel');
    await expect(usage).toBeVisible();
    await expect(usage.getByTestId('agent-usage-row')).toHaveCount(2);
    const fmt = (n: number) => n.toLocaleString('en-US');
    await expect(usage.getByTestId('agent-usage-row').filter({ hasText: 'Adapting' })).toContainText(fmt(SCRIPTED_TOKENS.planner.input));
    await expect(usage.getByTestId('agent-usage-row').filter({ hasText: 'Adapting' })).toContainText(fmt(SCRIPTED_TOKENS.planner.output));
    await expect(usage.getByTestId('agent-usage-row').filter({ hasText: 'Critic review' })).toContainText(fmt(SCRIPTED_TOKENS.critic.input));
    await expect(usage.getByTestId('agent-usage-row').filter({ hasText: 'Critic review' })).toContainText(fmt(SCRIPTED_TOKENS.critic.output));
    await expect(usage.getByTestId('agent-usage-total')).toContainText(fmt(SCRIPTED_TOKENS.planner.input + SCRIPTED_TOKENS.critic.input));
    await expect(usage).toContainText(/keyless server/i);

    // Use for today only: the logger opens prefilled, the plan is unchanged.
    await review.getByRole('button', { name: 'Use for today only' }).click();
    await page.getByRole('dialog', { name: 'Use for today only?' }).getByRole('button', { name: 'Start adjusted workout' }).click();
    await expect(page).toHaveURL(WORKOUT_URL, { timeout: 30_000 });
    const workoutId = page.url().split('/').pop()!;
    const workout: WorkoutBody = await getWorkout(owner.api, workoutId);
    expect(workout.exercises.length).toBeGreaterThan(0);
    const setCount = workout.exercises.reduce((sum, e) => sum + e.sets.length, 0);
    expect(setCount).toBeLessThan(PLANNED_TOTAL_SETS);
    expect(await programVersion(owner.api, owner.training.programId)).toBe(versionBefore);

    // What the models saw: one planner call, one critic call, nothing personal, no photo.
    const proposals = await callsSince(since, PROPOSAL_SCHEMA);
    const critiques = await callsSince(since, CRITIQUE_SCHEMA);
    expect(proposals).toHaveLength(1);
    expect(critiques).toHaveLength(1);
    expect(proposals[0].text).toContain('<context-json>');
    expectMinimised(await fakeLog(since), [GYM_NAME]);
  });

  // ---------------------------------------------------------------------------
  // 2. Update my plan, then one-tap revert
  // ---------------------------------------------------------------------------
  test('updates the plan with a new version and a change-log entry, and Undo restores the previous version', async ({ page, owner }) => {
    const { api, training } = owner;
    const versionBefore = await programVersion(api, training.programId);
    expect(await plannedSessionExerciseCount(api, training.programId)).toBe(UPPER_A_SLUGS.length);

    const adaptationId = await startAdaptationViaApi(api, { minutes: 30 });
    await page.goto(`/train/adapt/${adaptationId}`);
    const review = await expectReview(page);

    await review.getByRole('button', { name: 'Update my plan', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Update my plan?' });
    await confirm.getByRole('button', { name: 'Update my plan', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Plan updated' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('dialog', { name: 'Plan updated' }).getByRole('button', { name: 'Not now' }).click();

    expect(await programVersion(api, training.programId)).toBe(versionBefore + 1);
    expect(await plannedSessionExerciseCount(api, training.programId)).toBeLessThan(UPPER_A_SLUGS.length);
    const entries = await adaptedEntries(api, training.programId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: 'ai', status: 'applied', toVersion: versionBefore + 1 });

    // One tap: Undo on the plan's history restores the previous session as a new version.
    await page.goto(`/train/plans/${training.programId}/history`);
    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    await expect.poll(() => programVersion(api, training.programId), { timeout: 30_000 }).toBe(versionBefore + 2);
    expect(await plannedSessionExerciseCount(api, training.programId)).toBe(UPPER_A_SLUGS.length);
  });

  // ---------------------------------------------------------------------------
  // 3. Critic revise
  // ---------------------------------------------------------------------------
  test('critic-revise makes exactly two planner calls and one critic call (no third pass, no second review)', async ({ owner }) => {
    await useAdaptationScenario('critic-revise');
    const since = await lastLogSeq();

    const view = await settledAdaptation(owner.api, await startAdaptationViaApi(owner.api, { minutes: 45 }));

    expect(view.status).toBe('ready');
    // The graph revises once and never asks the critic again (`routes.ts`): two planner passes, one critic round.
    expect(view.criticReport).toMatchObject({ verdict: 'revise', rounds: 1 });
    expect(await callsSince(since, PROPOSAL_SCHEMA)).toHaveLength(2);
    expect(await callsSince(since, CRITIQUE_SCHEMA)).toHaveLength(1);
    // The second pass carried the critic's notes.
    expect((await callsSince(since, PROPOSAL_SCHEMA))[1].text).toContain('<critic-notes>');
  });

  // ---------------------------------------------------------------------------
  // 4. Guardrails
  // ---------------------------------------------------------------------------
  const GUARDRAIL_CASES: Array<{ scenario: AdaptationScenarioName; code: RegExp }> = [
    { scenario: 'unknown-exercise', code: /^unknown_exercise_removed$/ },
    { scenario: 'over-time', code: /^time_/ },
    { scenario: 'over-volume', code: /^(escalation_|sets_clamped)/ },
  ];

  for (const { scenario, code } of GUARDRAIL_CASES) {
    test(`guardrails repair or reject ${scenario} and the review says so`, async ({ page, owner }) => {
      await useAdaptationScenario(scenario);
      const adaptationId = await startAdaptationViaApi(owner.api, { minutes: 30 });
      const view = await settledAdaptation(owner.api, adaptationId);

      expect(view.status).toBe('ready');
      const codes = [...(view.guardrailReport?.repairs ?? []), ...(view.guardrailReport?.rejected ?? [])].map((finding) => finding.code);
      expect(codes.some((c) => code.test(c)), `${scenario}: no ${code} in ${codes.join(', ')}`).toBe(true);
      expect(view.proposal!.exercises.map((e) => e.exerciseKey)).not.toContain('ghost_lift_9000');
      expect(view.guardrailReport!.estimatedMinutes).toBeLessThanOrEqual(30);
      expect(view.guardrailReport!.fitsRequest).toBe(true);
      expect(view.proposal!.estimatedMinutes).toBeLessThanOrEqual(30);

      await page.goto(`/train/adapt/${adaptationId}`);
      const review = await expectReview(page);
      await expect(review.getByRole('heading', { name: 'Checks made these changes' })).toBeVisible();
      await expect(review.getByText('Ghost lift', { exact: false })).toHaveCount(0);
    });
  }

  // ---------------------------------------------------------------------------
  // 5. Malformed answer: failed state, then a retry succeeds
  // ---------------------------------------------------------------------------
  test('a malformed answer fails with Try again and Start the planned workout instead; a retry succeeds', async ({ page, owner }) => {
    await useAdaptationScenario('malformed');
    const adaptationId = await startAdaptationViaApi(owner.api, { minutes: 30 });
    expect((await settledAdaptation(owner.api, adaptationId)).status).toBe('failed');

    await page.goto(`/train/adapt/${adaptationId}`);
    const failed = page.getByTestId('adapt-failed');
    await expect(failed).toBeVisible({ timeout: 30_000 });
    await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(failed.getByRole('link', { name: 'Start the planned workout instead' })).toBeVisible();

    await useAdaptationScenario('valid');
    await failed.getByRole('button', { name: 'Try again' }).click();
    const dialog = page.getByRole('dialog', { name: SHEET_TITLE });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Adjust workout', exact: true }).click();
    await expect(page).not.toHaveURL(new RegExp(`${adaptationId}$`), { timeout: 30_000 });
    await expectReview(page);
  });

  // ---------------------------------------------------------------------------
  // 6. Hotel path
  // ---------------------------------------------------------------------------
  test('a hotel gym: scan the photos, confirm, adapt, finish, then Save gym; a second one stays Temporary on Not now', async ({ page, owner }) => {
    const { api } = owner;
    const hotelName = 'Hotel Aurora';

    const dialog = await openSheet(page);
    await dialog.getByRole('combobox', { name: 'Gym' }).click();
    await page.getByRole('option', { name: /^Different place/ }).click();

    const step = dialog.getByTestId('hotel-gym-step');
    await expect(step).toBeVisible();
    await step.getByLabel('Name').fill(hotelName);
    await step.getByRole('button', { name: 'Take photos' }).click();

    // The photos go to the scan call, and only those.
    await useAdaptationScenario('scan-hotel');
    const scanSince = await lastLogSeq();
    await dialog.locator('input[type="file"][aria-label="Add photos"]').setInputFiles(HOTEL_PHOTOS);
    await expect(dialog.getByTestId('image-intake-progress')).toContainText('2 of 2 ready', { timeout: 60_000 });
    await dialog.getByRole('button', { name: 'Scan', exact: true }).click();
    const scanReview = dialog.getByTestId('gym-scan-review');
    await expect(scanReview).toBeVisible({ timeout: 90_000 });
    await scanReview.getByRole('button', { name: /^Accept all \(\d+\)$/ }).click();
    await scanReview.getByRole('button', { name: 'Apply to gym' }).click();

    const scans = await callsSince(scanSince, 'gym_equipment_scan');
    expect(scans).toHaveLength(1);
    expect(scans[0].imageCount).toBe(HOTEL_PHOTOS.length);

    // Confirm the equipment, continue, adapt.
    const confirm = dialog.getByTestId('hotel-confirm');
    await expect(confirm).toBeVisible({ timeout: 30_000 });
    for (const name of ['Dumbbells', 'Adjustable bench', 'Cable machine', 'Treadmill']) {
      await expect(confirm.getByRole('list', { name: 'Equipment' })).toContainText(name);
    }
    await confirm.getByRole('button', { name: 'Continue', exact: true }).click();
    await useAdaptationScenario('valid');
    const adaptSince = await lastLogSeq();
    await dialog.getByRole('button', { name: '30 minutes', exact: true }).click();
    await submitSheet(page, dialog);
    const review = await expectReview(page);
    await review.getByRole('button', { name: 'Use for today only' }).click();
    await page.getByRole('dialog', { name: 'Use for today only?' }).getByRole('button', { name: 'Start adjusted workout' }).click();
    await expect(page).toHaveURL(WORKOUT_URL, { timeout: 30_000 });

    // The adaptation calls never carried the hotel's name or a photo.
    expectMinimised(await fakeLog(adaptSince), [hotelName, GYM_NAME]);

    // Finish: "Save this gym for future use?" -> Save gym -> permanent.
    const summary = await finishWorkoutFromLogger(page);
    await expect(summary.getByText(`Save ${hotelName} for future use?`)).toBeVisible();
    await summary.getByRole('button', { name: 'Save gym' }).click();
    await summary.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(summary.getByText(/saved/i).first()).toBeVisible({ timeout: 30_000 });
    await summary.getByRole('button', { name: 'Done' }).click();

    await page.goto('/gyms');
    await expect(page.getByRole('link', { name: new RegExp(hotelName) }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('temporary-gyms').filter({ hasText: hotelName })).toHaveCount(0);
    const saved = (await api.get<Array<{ name: string; isTemporary: boolean }>>('/api/gyms')).find((g) => g.name === hotelName);
    expect(saved?.isTemporary).toBe(false);

    // A second hotel (made through the API, so the run stays short): Not now leaves it Temporary.
    const secondName = 'Hotel Borealis';
    const second = await api.post<{ id: string }>('/api/gyms', { name: secondName, type: 'hotel', isTemporary: true });
    const equipment = await api.get<Array<{ id: string; slug: string }>>('/api/equipment-types?limit=200');
    await api.post(`/api/gyms/${second.id}/equipment`, {
      equipmentTypeId: equipment.find((e) => e.slug === 'adjustable_dumbbells')!.id,
      quantity: 1,
    });
    const secondAdaptation = await startAdaptationViaApi(api, { minutes: 30, gymId: second.id });
    expect((await settledAdaptation(api, secondAdaptation)).status).toBe('ready');
    await page.goto(`/train/adapt/${secondAdaptation}`);
    const secondReview = await expectReview(page);
    await secondReview.getByRole('button', { name: 'Use for today only' }).click();
    await page.getByRole('dialog', { name: 'Use for today only?' }).getByRole('button', { name: 'Start adjusted workout' }).click();
    await expect(page).toHaveURL(WORKOUT_URL, { timeout: 30_000 });
    const secondSummary = await finishWorkoutFromLogger(page);
    await expect(secondSummary.getByText(`Save ${secondName} for future use?`)).toBeVisible();
    await secondSummary.getByRole('button', { name: 'Not now' }).click();
    await secondSummary.getByRole('button', { name: 'Done' }).click();

    await page.goto('/gyms');
    await expect(page.getByTestId('temporary-gyms')).toContainText(secondName, { timeout: 30_000 });
    const stillTemporary = (await api.get<Array<{ name: string; isTemporary: boolean }>>('/api/gyms')).find((g) => g.name === secondName);
    expect(stillTemporary?.isTemporary).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 7. Safety
  // ---------------------------------------------------------------------------
  test('"chest pain and dizzy" shows the guidance and makes no provider request', async ({ page, owner }) => {
    void owner; // the fixture signs the page in and seeds the plan
    const since = await lastLogSeq();
    const dialog = await openSheet(page);
    await dialog.getByRole('button', { name: '30 minutes', exact: true }).click();
    await dialog.getByLabel('Anything else? (optional)').fill('chest pain and dizzy');
    await expect(dialog.getByTestId('adapt-blocked')).toBeVisible({ timeout: 30_000 });

    await dialog.getByRole('button', { name: 'Adjust workout', exact: true }).click();
    await expect(page).toHaveURL(ADAPT_URL, { timeout: 30_000 });
    const guidance = page.getByTestId('adapt-guidance');
    await expect(guidance).toBeVisible({ timeout: 30_000 });
    await expect(guidance).toContainText('Stopped for safety');

    expect(await fakeLog(since)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 8. AI off
  // ---------------------------------------------------------------------------
  test('with AI off the entry explains, the API answers 403 AI_DISABLED, and the planned workout still starts', async ({ page, owner, browser, baseURL }) => {
    await withAdmin(browser, baseURL, (admin) => setAdaptationAiEnabled(admin, false));
    try {
      await openToday(page);
      await expect(page.getByTestId('adjust-unavailable')).toContainText('AI is off');
      await expect(page.getByRole('button', { name: SHEET_TITLE })).toHaveCount(0);

      const refusal = await owner.api
        .post('/api/ai/training/adaptations', { minutes: 30, useReadiness: true, baseWorkout: 'planned' })
        .then(
          () => null,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      expect(refusal).toContain(' failed: 403 ');
      expect(refusal).toContain('AI_DISABLED');
      await expectStatus(() => owner.api.post('/api/ai/training/adaptations/context-preview', { minutes: 30 }), 403);

      await page.getByTestId('today-plan').getByRole('button', { name: 'Start planned workout' }).click();
      await expect(page).toHaveURL(WORKOUT_URL, { timeout: 30_000 });
    } finally {
      await withAdmin(browser, baseURL, (admin) => setAdaptationAiEnabled(admin, true));
    }
  });

  // ---------------------------------------------------------------------------
  // 9. Capability state
  // ---------------------------------------------------------------------------
  test('without a vision model the hotel step says so and offers the manual equipment path', async ({ page, owner, browser, baseURL }) => {
    void owner; // the fixture signs the page in and seeds the plan
    // The gym-scan assignment points at a disabled model, so nothing can read photos (the text models still run).
    await withAdmin(browser, baseURL, (admin) => setFakeModelEnabled(admin, FAKE_MODEL_ID, false));
    try {
      const dialog = await openSheet(page);
      await dialog.getByRole('combobox', { name: 'Gym' }).click();
      await page.getByRole('option', { name: /^Different place/ }).click();

      const step = dialog.getByTestId('hotel-gym-step');
      await expect(step.getByText(/administrator hasn't assigned an AI model that can read photos|None of your available models can read images/)).toBeVisible({ timeout: 30_000 });
      await expect(step.getByRole('button', { name: 'Take photos' })).toHaveCount(0);
      await step.getByRole('button', { name: 'Continue manually' }).click();

      // The manual alternative: the confirm step, with the equipment picker already open on top.
      const picker = page.getByRole('dialog', { name: 'Add equipment' });
      await expect(picker).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press('Escape');
      await expect(picker).toBeHidden();
      const confirm = dialog.getByTestId('hotel-confirm');
      await expect(confirm).toBeVisible();
      await expect(confirm.getByRole('button', { name: 'Add equipment' })).toBeVisible();
      await expect(confirm.getByRole('button', { name: 'Bodyweight only' })).toBeVisible();
      await expect(confirm.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
    } finally {
      await withAdmin(browser, baseURL, (admin) => setFakeModelEnabled(admin, FAKE_MODEL_ID, true));
    }
  });

  // ---------------------------------------------------------------------------
  // 10. Token cap
  // ---------------------------------------------------------------------------
  test('a small per-run limit with heavy-tokens skips the critic and says why', async ({ page, owner }) => {
    await setAdaptationRunLimitForUser(owner.api, 10_000);
    await useAdaptationScenario('heavy-tokens');
    const since = await lastLogSeq();

    const adaptationId = await startAdaptationViaApi(owner.api, { minutes: 30 });
    const view = await settledAdaptation(owner.api, adaptationId);
    expect(view.status).toBe('ready');
    expect(view.criticReport?.skipped).toBe('token_cap');
    expect(await callsSince(since, CRITIQUE_SCHEMA)).toHaveLength(0);

    await page.goto(`/train/adapt/${adaptationId}`);
    const review = await expectReview(page);
    await expect(review.getByTestId('critic-verdict')).toContainText('Not reviewed by the critic');
    await expect(review.getByTestId('critic-skipped-token-cap')).toContainText('your token limit (10,000) was reached');
    const meter = page.getByTestId('token-cap-meter');
    await expect(meter).toBeVisible({ timeout: 30_000 });
    await expect(meter.getByTestId('token-cap-text')).toContainText('of 10,000 tokens used');
    await expect(meter.getByTestId('token-cap-text')).toContainText('limit reached');
  });

  // ---------------------------------------------------------------------------
  // 11. Monthly usage
  // ---------------------------------------------------------------------------
  test('/settings/ai shows the month by role matching the adjustments just made', async ({ page, owner }) => {
    for (let run = 0; run < 2; run += 1) {
      const view = await settledAdaptation(owner.api, await startAdaptationViaApi(owner.api, { minutes: 30 + run * 15 }));
      expect(view.status).toBe('ready');
    }

    const report = await owner.api.get<{ totals: { inputTokens: number; outputTokens: number }; byRole: Array<{ role: string; inputTokens: number; outputTokens: number }> }>(
      '/api/ai/training/usage',
    );
    const planner = report.byRole.find((row) => row.role === 'planner')!;
    const critic = report.byRole.find((row) => row.role === 'critic')!;
    expect(planner).toMatchObject({ inputTokens: 2 * SCRIPTED_TOKENS.planner.input, outputTokens: 2 * SCRIPTED_TOKENS.planner.output });
    expect(critic).toMatchObject({ inputTokens: 2 * SCRIPTED_TOKENS.critic.input, outputTokens: 2 * SCRIPTED_TOKENS.critic.output });

    await page.goto('/settings/ai');
    const section = page.getByTestId('monthly-agent-usage');
    await expect(section).toBeVisible({ timeout: 30_000 });
    const byRole = section.getByTestId('agent-usage-by-role');
    await expect(byRole).toContainText((2 * SCRIPTED_TOKENS.planner.input).toLocaleString('en-US'));
    await expect(byRole).toContainText((2 * SCRIPTED_TOKENS.critic.input).toLocaleString('en-US'));
    await expect(section.getByTestId('agent-usage-by-kind')).toContainText('Workout adjustments');
    await expect(section.getByTestId('agent-usage-by-key')).toContainText(/keyless server/i);
  });

  // ---------------------------------------------------------------------------
  // 12. Cancel
  // ---------------------------------------------------------------------------
  test('Cancel ends a slow run as cancelled and no later call arrives', async ({ page, owner }) => {
    await useAdaptationScenario('slow');
    const since = await lastLogSeq();

    const dialog = await openSheet(page);
    await dialog.getByRole('button', { name: '30 minutes', exact: true }).click();
    await submitSheet(page, dialog);
    await expect(page.getByTestId('adaptation-progress')).toBeVisible({ timeout: 30_000 });

    // The first planner call is in flight (it answers after 3 s): cancel now.
    await expect.poll(async () => (await callsSince(since, PROPOSAL_SCHEMA)).length, { timeout: 60_000, intervals: [500] }).toBe(1);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('alert').or(page.getByText('Cancelled', { exact: true })).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Nothing was changed.')).toBeVisible({ timeout: 60_000 });

    const adaptationId = page.url().split('/').pop()!;
    expect((await owner.api.get<{ status: string }>(`/api/ai/training/adaptations/${adaptationId}`)).status).toBe('cancelled');

    // Prove a negative: after two more slow-call periods nothing else was asked.
    await page.waitForTimeout(7_000);
    expect(await callsSince(since, CRITIQUE_SCHEMA)).toHaveLength(0);
    expect((await callsSince(since, PROPOSAL_SCHEMA)).length).toBeLessThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // 13. Rate limit: deferral, then success
  // ---------------------------------------------------------------------------
  test('a 429 with Retry-After defers the run and it then succeeds', async ({ owner }) => {
    await useAdaptationScenario('rate-limit');
    const since = await lastLogSeq();

    const view = await settledAdaptation(owner.api, await startAdaptationViaApi(owner.api, { minutes: 30 }));

    expect(view.status).toBe('ready');
    const proposals = await callsSince(since, PROPOSAL_SCHEMA);
    expect(proposals[0].status).toBe(429);
    expect(proposals.at(-1)!.status).toBe(200);
  });
});
