import path from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { signIn, type AuthedApi } from '../helpers/api.helper';
import {
  FAKE_MODEL_ID,
  FAKE_VISION_SKIP_MESSAGE,
  configureFakeVisionProvider,
  fakeRequests,
  isFakeVisionReachable,
  resetFake,
  setFakeFixture,
  type FakeFixture,
} from '../helpers/ai.helper';
import { stubAiState } from '../helpers/ai-stub.helper';
import { createDumbbellGym } from '../helpers/gym.helper';
import { setUnits } from '../helpers/profile.helper';
import { KG_TOLERANCE, getWorkout, lbToKg, startWorkout, type WorkoutBody } from '../helpers/workout.helper';

/**
 * "Prefill from photo" (E4.7), end to end through the real UI, API, storage,
 * job queue and AI gate, with deterministic model output.
 *
 * The provider is the fake OpenAI-compatible vision server, started by the
 * `infra/compose/fake-ai.compose.yml` overlay; this spec switches AI on and
 * points the platform at it through the admin API (`configureFakeVisionProvider`),
 * then drives the Prefill page of a workout. The web client downscales images
 * with a canvas, so the bytes the fake receives differ from the committed
 * files; the fake therefore picks its answer from the control endpoint
 * (`setFakeFixture`), not from the image. The fixtures are
 * `apps/api/test/fixtures/workout-prefill/*.model-output.json`.
 *
 * The fake's queue and request log are global, so the fixture tests run
 * serially, and this file must not run at the same time as `gym-scan.spec.ts`
 * (which shares the queue): run both with `--workers=1`. Every test signs in as
 * its own new Contributor, sets its own units and creates its own gym and
 * workout. A prefill job is given up to 90 s.
 *
 * Skipped with a message when the fake server is not reachable. It needs
 * object storage configured on the stack, like any photo upload. The "no
 * vision model" scenario stubs the AI reads client side and needs neither.
 */

const EXAMPLES = path.resolve(__dirname, '../../../docs/examples/gym-scan');
const LEG_CURL_PLACARD = path.join(EXAMPLES, 'leg-curl-placard.jpg');
// The fake ignores pixels, so any small photo stands in for a notebook page.
const NOTEBOOK_STAND_IN = path.join(EXAMPLES, 'cardio-row-wide.jpg');

const UNIT_NOTE = 'Unit not written; assumed lb.';

interface IntakeItemBody {
  status: string;
  userVerified: boolean;
  value: { exerciseSlug: string | null; name: string; sets: Array<{ weightKg: number | null }> };
  originalAiValue: { sets: Array<{ weightKg: number | null }> } | null;
}

interface IntakeBody {
  id: string;
  status: string;
  items: IntakeItemBody[];
}

/** A workout with a gym, opened on its Prefill page. */
async function openPrefill(page: Page, api: AuthedApi): Promise<WorkoutBody> {
  await setUnits(api, 'imperial');
  const gym = await createDumbbellGym(api);
  const workout = await startWorkout(api, { gymId: gym.id });
  await page.goto(`/train/workouts/${workout.id}/prefill`);
  await expect(page.getByRole('heading', { level: 1, name: 'Prefill from photo' })).toBeVisible();
  return workout;
}

/** Add the photo and wait until it is uploaded and attached to the intake. */
async function addPhoto(page: Page, file: string): Promise<void> {
  await expect(page.getByTestId('prefill-photos')).toBeVisible({ timeout: 30_000 });
  await page.locator('input[type="file"][aria-label="Add photos"]').setInputFiles(file);
  await expect(page.getByTestId('image-intake-progress')).toContainText('1 of 1 ready', { timeout: 60_000 });
}

/** Choose the canned answer, press Analyze and wait for the review. */
async function analyze(page: Page, fixture: FakeFixture): Promise<Locator> {
  await setFakeFixture(fixture);
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  const review = page.getByTestId('prefill-review');
  await expect(review).toBeVisible({ timeout: 90_000 });
  return review;
}

function draftRows(review: Locator): Locator {
  return review.getByRole('list', { name: 'Draft items' }).getByTestId('draft-item-row');
}

/** The draft row whose exercise name is exactly `name`. */
function rowNamed(review: Locator, name: string): Locator {
  return draftRows(review).filter({
    has: review.page().getByTestId('exercise-draft-value').getByText(name, { exact: true }),
  });
}

/**
 * A handle on one draft row that survives editing: while a row is edited its
 * value view is replaced by the editor, so a locator that finds it by name
 * would stop matching. The row's item id does not change.
 */
async function pinnedRow(review: Locator, name: string): Promise<Locator> {
  const itemId = await rowNamed(review, name).getAttribute('data-item-id');
  expect(itemId, `no draft row named ${name}`).toBeTruthy();
  return review.locator(`[data-testid="draft-item-row"][data-item-id="${itemId}"]`);
}

function workoutUrl(workout: WorkoutBody): RegExp {
  return new RegExp(`/train/workouts/${workout.id}$`);
}

test.describe('Prefill from photo with the fake vision provider', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeAll(async ({ browser, baseURL }) => {
    const reachable = await isFakeVisionReachable();
    test.skip(!reachable, FAKE_VISION_SKIP_MESSAGE);

    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      const { api } = await signIn(page, 'admin', 'prefill-admin');
      await configureFakeVisionProvider(api);
    } finally {
      await context.close();
    }
  });

  test.beforeEach(async () => {
    await resetFake();
  });

  test('example A: the machine placard drafts one high-confidence exercise with no sets', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'prefill-placard');
    const workout = await openPrefill(page, api);

    await page.getByRole('radio', { name: 'Machine placard' }).check();
    await addPhoto(page, LEG_CURL_PLACARD);
    await expect(page.getByTestId('ai-vision-disclosure')).toContainText(FAKE_MODEL_ID);
    const review = await analyze(page, 'workout-placard');

    await expect(draftRows(review)).toHaveCount(1);
    const row = await pinnedRow(review, 'Leg curl');
    await expect(row.getByText('High confidence')).toBeVisible();
    await expect(row.getByText('AI guess', { exact: true })).toBeVisible();
    await expect(row.getByTestId('exercise-draft-raw')).toHaveText('read as: LEG CURL');
    await expect(row.getByTestId('exercise-draft-sets')).toContainText('No sets');

    const requests = await fakeRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: FAKE_MODEL_ID, imageCount: 1 });

    // Edit nothing: accept and apply.
    await row.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(row.getByText('Accepted', { exact: true })).toBeVisible();
    await review.getByRole('button', { name: 'Add to workout' }).click();

    await expect(page).toHaveURL(workoutUrl(workout), { timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 2, name: 'Leg curl' })).toBeVisible();
    await expect(page.getByTestId('set-row-1')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Photos' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Workout photos' }).getByRole('listitem')).toHaveCount(1);

    // Stored: the exercise with zero sets, and the photo kept on the workout.
    const stored = await getWorkout(api, workout.id);
    expect(stored.exercises).toHaveLength(1);
    expect(stored.exercises[0].exercise.slug).toBe('leg_curl');
    expect(stored.exercises[0].sets).toEqual([]);
    expect(stored.photos).toHaveLength(1);
  });

  test('example B: the notebook drafts five exercises; edit, reject and add, then apply keeps provenance', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'prefill-notebook');
    const workout = await openPrefill(page, api);

    await page.getByRole('radio', { name: 'Notebook' }).check();
    await addPhoto(page, NOTEBOOK_STAND_IN);
    const review = await analyze(page, 'workout-notebook');

    await expect(draftRows(review)).toHaveCount(5);
    await expect(review.getByTestId('prefill-suggested-name')).toContainText('Push day');

    // Uncertainty is visible: the unreadable line, low confidence, in the main list.
    const unreadable = rowNamed(review, 'Unreadable cable exercise');
    await expect(unreadable).toBeVisible();
    await expect(unreadable.getByText('Low confidence')).toBeVisible();
    await expect(unreadable.getByTestId('exercise-draft-raw')).toHaveText('read as: Cbl r? 25x12');
    await expect(unreadable.getByText('New custom exercise')).toBeVisible();

    // A weight with no written unit is read in the profile unit, and says so. Plank has no weight.
    for (const name of ['Barbell bench press', 'Incline dumbbell press', 'Triceps pushdown', 'Unreadable cable exercise']) {
      await expect(rowNamed(review, name).getByTestId('draft-item-uncertainty')).toContainText(UNIT_NOTE);
    }
    await expect(rowNamed(review, 'Plank').getByTestId('draft-item-uncertainty')).toHaveCount(0);
    await expect(rowNamed(review, 'Barbell bench press').getByTestId('exercise-draft-sets')).toContainText(
      '135 lb × 10, 10, 8',
    );

    // Edit: the bench was 135 lb, it was 140. The row keeps what the AI read.
    const bench = await pinnedRow(review, 'Barbell bench press');
    await bench.getByRole('button', { name: 'Edit' }).click();
    for (const n of [1, 2, 3]) {
      await bench.getByLabel(`Set ${n} weight`, { exact: true }).fill('140');
    }
    await bench.getByRole('button', { name: 'Save' }).click();
    await expect(bench.getByText('You verified')).toBeVisible();
    await expect(bench.getByTestId('exercise-draft-sets').first()).toContainText('140 lb × 10, 10, 8');
    await expect(bench.getByTestId('draft-item-ai-said')).toContainText('135 lb × 10, 10, 8');

    // Reject the plank: it leaves the main list for "Rejected".
    await rowNamed(review, 'Plank').getByRole('button', { name: 'Reject' }).click();
    await expect(rowNamed(review, 'Plank')).toHaveCount(0);
    await expect(review.getByText('Rejected (1)')).toBeVisible();

    // Add a missing exercise by hand.
    await review.getByRole('button', { name: 'Add missing item' }).click();
    const add = review.getByTestId('draft-item-add');
    await add.getByRole('combobox', { name: 'Exercise', exact: true }).fill('Cable row');
    await page.getByRole('option', { name: 'Cable row', exact: true }).click();
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(rowNamed(review, 'Cable row')).toBeVisible();
    await expect(rowNamed(review, 'Cable row').getByText('You added')).toBeVisible();

    // Accept all: the low-confidence item asks first.
    await review.getByRole('button', { name: /^Accept all \(\d+\)$/ }).click();
    await page
      .getByRole('dialog', { name: /^Accept all \d+ items\?$/ })
      .getByRole('button', { name: 'Accept all', exact: true })
      .click();
    const applyButton = review.getByRole('button', { name: 'Add to workout' });
    await expect(applyButton).toBeEnabled();
    await applyButton.click();

    await expect(page).toHaveURL(workoutUrl(workout), { timeout: 30_000 });
    const benchCard = page.getByRole('region', { name: 'Barbell bench press' });
    await expect(benchCard).toBeVisible();
    await expect(benchCard.getByLabel('Set 1 weight in lb', { exact: true })).toHaveValue('140');
    await expect(page.getByRole('heading', { level: 2, name: 'Plank' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Cable row' })).toBeVisible();

    // Stored: kilograms, nothing marked done, no plank, the manual row and the new custom exercise.
    const stored = await getWorkout(api, workout.id);
    const names = stored.exercises.map((entry) => entry.exercise.name);
    expect(names).toHaveLength(5);
    expect(names).toEqual(
      expect.arrayContaining([
        'Barbell bench press',
        'Incline dumbbell press',
        'Triceps pushdown',
        'Unreadable cable exercise',
        'Cable row',
      ]),
    );
    expect(names).not.toContain('Plank');
    expect(stored.exercises.find((entry) => entry.exercise.name === 'Unreadable cable exercise')?.exercise.isCustom).toBe(true);

    const storedBench = stored.exercises.find((entry) => entry.exercise.slug === 'barbell_bench_press');
    expect(storedBench?.sets).toHaveLength(3);
    for (const set of storedBench!.sets) {
      expect(Math.abs((set.weightKg ?? 0) - lbToKg(140))).toBeLessThanOrEqual(KG_TOLERANCE);
      expect(Math.abs((set.weightKg ?? 0) - 63.503)).toBeLessThanOrEqual(KG_TOLERANCE);
    }
    for (const entry of stored.exercises) {
      for (const set of entry.sets) expect(set.completed).toBe(false);
    }

    // The intake keeps every item for provenance: the edited bench still holds what the AI read.
    const applied = await api.get<Array<{ id: string }>>(
      `/api/intakes?kind=workout_prefill&subjectId=${workout.id}&status=applied`,
    );
    expect(applied).toHaveLength(1);
    const intake = await api.get<IntakeBody>(`/api/intakes/${applied[0].id}`);
    const benchItem = intake.items.find((item) => item.value.exerciseSlug === 'barbell_bench_press');
    expect(benchItem?.userVerified).toBe(true);
    expect(Math.abs((benchItem?.originalAiValue?.sets[0].weightKg ?? 0) - 61.235)).toBeLessThanOrEqual(KG_TOLERANCE);
    expect(Math.abs((benchItem?.value.sets[0].weightKg ?? 0) - 63.503)).toBeLessThanOrEqual(KG_TOLERANCE);
    expect(intake.items.find((item) => item.value.name === 'Plank')?.status).toBe('rejected');
  });

  test('nothing recognized: says so and offers Continue manually', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'prefill-empty');
    const workout = await openPrefill(page, api);

    await addPhoto(page, NOTEBOOK_STAND_IN);
    const review = await analyze(page, 'workout-empty');

    const nothing = review.getByTestId('prefill-nothing');
    await expect(nothing).toContainText('Nothing recognized');
    await expect(draftRows(review)).toHaveCount(0);
    await expect(review.getByRole('button', { name: 'Add to workout' })).toBeDisabled();

    await nothing.getByRole('button', { name: 'Continue manually' }).click();
    await expect(page).toHaveURL(workoutUrl(workout));
    await expect(page.getByRole('dialog', { name: 'Add exercises' })).toBeVisible();

    const stored = await getWorkout(api, workout.id);
    expect(stored.exercises).toEqual([]);
  });
});

test.describe('Prefill from photo without a usable vision model', () => {
  test.describe.configure({ timeout: 90_000 });

  test('the page says so, Continue manually opens the picker, and logging still works', async ({ page }) => {
    // AI on, but the caller has no model at all: the "add a key" notice.
    await stubAiState(page, { enabled: true, models: [] });
    const { api } = await signIn(page, 'contributor', 'prefill-no-model');
    await setUnits(api, 'imperial');
    const gym = await createDumbbellGym(api);
    const workout = await startWorkout(api, { gymId: gym.id });

    // On the workout the button is disabled and gives the reason.
    await page.goto(`/train/workouts/${workout.id}`);
    const prefill = page.getByTestId('prefill-from-photo');
    await expect(prefill).toContainText('Add your own AI key in Settings → AI');
    await expect(prefill.getByRole('button', { name: 'Prefill from photo' })).toBeDisabled();

    // The page itself explains and offers the manual way on.
    await page.goto(`/train/workouts/${workout.id}/prefill`);
    await expect(page.getByText('Add your own AI key in Settings → AI')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Analyze', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Continue manually' }).click();

    await expect(page).toHaveURL(workoutUrl(workout));
    const picker = page.getByRole('dialog', { name: 'Add exercises' });
    await expect(picker).toBeVisible();
    await picker.getByRole('checkbox', { name: 'Dumbbell bench press', exact: true }).check();
    await picker.getByRole('button', { name: 'Add exercise', exact: true }).click();

    const weight = page.getByLabel('Set 1 weight in lb', { exact: true });
    await weight.fill('60');
    await weight.press('Enter');
    await page.keyboard.type('10');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Complete set 1' })).toHaveAttribute('aria-pressed', 'true');

    await expect
      .poll(async () => {
        const stored = await getWorkout(api, workout.id);
        return stored.exercises[0]?.sets[0]?.completed ?? false;
      })
      .toBe(true);
    const stored = await getWorkout(api, workout.id);
    expect(Math.abs((stored.exercises[0].sets[0].weightKg ?? 0) - lbToKg(60))).toBeLessThanOrEqual(KG_TOLERANCE);
  });
});
