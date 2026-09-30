import { test, expect, type Locator, type Page } from '@playwright/test';
import { signIn, type AuthedApi } from '../helpers/api.helper';
import { stubAiState } from '../helpers/ai-stub.helper';
import { createDumbbellGym } from '../helpers/gym.helper';
import { setUnits } from '../helpers/profile.helper';
import {
  KG_TOLERANCE,
  addExerciseWithSets,
  expectStatus,
  getWorkout,
  lbToKg,
  seedCompletedWorkout,
  startWorkout,
  type WorkoutBody,
} from '../helpers/workout.helper';

/**
 * Exercise library and workout logging, manual path (E4.7): everything a user
 * can do with no AI at all, end to end through the real UI, API and database.
 *
 * Every test signs in as its own new user (unique email) and creates its own
 * gym through the API, so nothing depends on ordering or on what an earlier
 * run left behind. Every test sets the Health Profile units first, so the
 * pounds it types and reads are deterministic; the API stores kilograms, and
 * each scenario reads the workout back through the API instead of trusting the
 * DOM alone.
 *
 * AI state is stubbed client side where a test asserts the AI-off copy
 * (`ai-stub.helper.ts`), so this spec never depends on, or changes, the
 * deployment's AI settings. The prefill itself is `workout-prefill.spec.ts`.
 *
 * No fixed sleeps: web-first assertions and `expect.poll` only.
 */

const BENCH = 'Dumbbell bench press';
const BENCH_SLUG = 'dumbbell_bench_press';
const WORKOUT_URL = /\/train\/workouts\/[0-9a-f-]{36}$/;

test.describe('Workouts: manual logging', () => {
  test.describe.configure({ timeout: 90_000 });

  /** Type a set with the keyboard: weight, Enter, reps, Enter (which marks it done). */
  async function logSet(page: Page, n: number, weight: string, reps: string): Promise<void> {
    const weightField = page.getByLabel(`Set ${n} weight in lb`, { exact: true });
    await weightField.fill(weight);
    await weightField.press('Enter');
    await expect(page.getByLabel(`Set ${n} reps`, { exact: true })).toBeFocused();
    await page.keyboard.type(reps);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: `Complete set ${n}` })).toHaveAttribute('aria-pressed', 'true');
  }

  function setRow(page: Page, n: number): Locator {
    return page.getByTestId(`set-row-${n}`);
  }

  /** Start a workout for the current user through the API and open it. */
  async function openNewWorkout(
    page: Page,
    api: AuthedApi,
    gymId?: string,
  ): Promise<WorkoutBody> {
    const workout = await startWorkout(api, gymId ? { gymId } : {});
    await page.goto(`/train/workouts/${workout.id}`);
    await expect(page.getByRole('heading', { level: 1, name: workout.name })).toBeVisible();
    return workout;
  }

  test('logs a workout from Today: gym-filtered picker, keyboard entry, summary, history, stored kilograms', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'wk-log');
    await setUnits(api, 'imperial');
    const gym = await createDumbbellGym(api);

    // Today's workout card -> Start workout.
    await page.goto('/');
    const card = page.getByTestId('today-card-workout');
    await expect(card.getByRole('heading', { name: "Today's workout" })).toBeVisible();
    await card.getByRole('button', { name: 'Start workout' }).click();
    const start = page.getByRole('dialog', { name: 'Start workout' });
    await expect(start).toContainText(`${gym.name} (default)`);
    await start.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page).toHaveURL(WORKOUT_URL);
    const workoutId = page.url().split('/train/workouts/')[1];
    await expect(page.getByText('Add an exercise to start logging sets.')).toBeVisible();

    // Add exercise: the gym filter hides the leg press until Show all, which explains what it needs.
    await page.getByRole('button', { name: 'Add exercise', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add exercises' });
    await expect(picker.getByRole('checkbox', { name: BENCH, exact: true })).toBeVisible();
    await expect(picker.getByRole('checkbox', { name: 'Leg press', exact: true })).toHaveCount(0);

    await picker.getByRole('button', { name: 'Show all' }).click();
    await picker.getByLabel('Search exercises').fill('Leg press');
    const legPressRow = picker
      .getByRole('list', { name: 'Exercises to add' })
      .getByRole('listitem')
      .filter({ has: page.getByRole('checkbox', { name: 'Leg press', exact: true }) });
    await expect(legPressRow).toBeVisible();
    await expect(legPressRow).toContainText('Needs:');

    await picker.getByLabel('Search exercises').fill(BENCH);
    await picker.getByRole('checkbox', { name: BENCH, exact: true }).check();
    await picker.getByRole('button', { name: 'Add exercise', exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(page.getByRole('heading', { level: 2, name: BENCH })).toBeVisible();

    // 70 lb x 10, 10, 9, typed with the keyboard. Completing a row adds the next one.
    await logSet(page, 1, '70', '10');
    await logSet(page, 2, '70', '10');
    await logSet(page, 3, '70', '9');

    // Finish: the summary, then the history row.
    await page.getByRole('button', { name: 'Finish', exact: true }).click();
    const summary = page.getByRole('dialog', { name: 'Workout finished' });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(/Exercises\s*1/);
    await expect(summary).toContainText(/Sets\s*3/);
    await expect(summary).toContainText(/Volume\s*2,?030 lb/);
    await summary.getByRole('button', { name: 'Done' }).click();

    await page.goto('/train');
    const history = page.getByRole('list', { name: 'Workout history' });
    await expect(history.getByRole('listitem')).toHaveCount(1);
    await expect(history).toContainText(gym.name);
    await expect(history).toContainText(/1 exercise · 3 sets · 2,?030 lb/);

    // Reload keeps everything.
    await page.goto(`/train/workouts/${workoutId}`);
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();
    await expect(page.getByLabel('Set 3 weight in lb', { exact: true })).toHaveValue('70');
    await page.reload();
    await expect(page.getByLabel('Set 1 weight in lb', { exact: true })).toHaveValue('70');

    // Stored: kilograms, all three sets completed, and no leftover empty row.
    const stored = await getWorkout(api, workoutId);
    expect(stored.status).toBe('completed');
    expect(stored.exercises).toHaveLength(1);
    const sets = stored.exercises[0].sets;
    expect(sets).toHaveLength(3);
    for (const set of sets) {
      expect(Math.abs((set.weightKg ?? 0) - 31.751)).toBeLessThanOrEqual(KG_TOLERANCE);
      expect(set.completed).toBe(true);
    }
    expect(sets.map((set) => set.reps)).toEqual([10, 10, 9]);
    expect(sets.map((set) => set.setNumber)).toEqual([1, 2, 3]);
  });

  test('units are display only: metric shows 31.75, imperial 70, the stored kilograms never change', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'wk-units');
    await setUnits(api, 'imperial');
    const gym = await createDumbbellGym(api);
    const workout = await seedCompletedWorkout(api, {
      gymId: gym.id,
      slug: BENCH_SLUG,
      sets: [
        { weightKg: lbToKg(70), reps: 10 },
        { weightKg: lbToKg(70), reps: 10 },
        { weightKg: lbToKg(70), reps: 9 },
      ],
    });

    await page.goto(`/train/workouts/${workout.id}`);
    await expect(page.getByLabel('Set 1 weight in lb', { exact: true })).toHaveValue('70');

    await setUnits(api, 'metric');
    await page.reload();
    await expect(page.getByLabel('Set 1 weight in kg', { exact: true })).toHaveValue('31.75');
    await expect(page.getByLabel('Set 3 weight in kg', { exact: true })).toHaveValue('31.75');

    await setUnits(api, 'imperial');
    await page.reload();
    await expect(page.getByLabel('Set 1 weight in lb', { exact: true })).toHaveValue('70');

    // Showing a value in another unit never re-saves it.
    const stored = await getWorkout(api, workout.id);
    for (const set of stored.exercises[0].sets) {
      expect(Math.abs((set.weightKg ?? 0) - 31.751)).toBeLessThanOrEqual(KG_TOLERANCE);
    }
  });

  test('shows last time, and flags weight, est. 1RM and rep PRs but not a warm-up', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'wk-prs');
    await setUnits(api, 'imperial');
    const gym = await createDumbbellGym(api);

    // The earlier workout the same day, backdated so the order is unambiguous.
    await seedCompletedWorkout(api, {
      gymId: gym.id,
      hoursAgo: 2,
      slug: BENCH_SLUG,
      sets: [
        { weightKg: lbToKg(70), reps: 10 },
        { weightKg: lbToKg(70), reps: 10 },
        { weightKg: lbToKg(70), reps: 9 },
      ],
    });

    const workout = await startWorkout(api, { gymId: gym.id });
    await addExerciseWithSets(api, workout.id, BENCH_SLUG, [{}]);
    await page.goto(`/train/workouts/${workout.id}`);

    const lastTime = page.getByTestId('last-time');
    await expect(lastTime).toContainText('Last time');
    await expect(lastTime).toContainText('70.0 lb × 10, 10, 9');

    // 75 x 8: heavier than ever (Weight PR) and a better estimated 1RM.
    await logSet(page, 1, '75', '8');
    await expect(setRow(page, 1).getByTestId('pr-chip-weight')).toContainText('Weight PR');
    await expect(setRow(page, 1).getByTestId('pr-chip-e1rm')).toContainText('Est. 1RM PR');

    // 70 x 11: more reps at this weight or heavier than ever (Rep PR).
    await logSet(page, 2, '70', '11');
    await expect(setRow(page, 2).getByTestId('pr-chip-reps')).toContainText('Rep PR');

    // A warm-up 100 x 1 is heavier than everything, and earns no chip.
    await page.getByRole('button', { name: 'More for set 3' }).click();
    const more = page.getByRole('dialog', { name: 'More for set 3' });
    await more.getByLabel('Warm-up').click();
    await page.keyboard.press('Escape');
    await expect(more).toBeHidden();
    await logSet(page, 3, '100', '1');
    await expect(setRow(page, 3).getByRole('list', { name: 'Personal records' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Finish', exact: true }).click();
    const summary = page.getByRole('dialog', { name: 'Workout finished' });
    await expect(summary).toContainText('Personal records');
    await expect(summary).toContainText(/Weight PR 75\.0 lb \(set 1\)/);
    await expect(summary).toContainText(/Est\. 1RM PR/);
    await expect(summary).toContainText(/Rep PR 11 reps \(set 2\)/);
    await summary.getByRole('button', { name: 'Done' }).click();

    // Reload keeps the chips: they are computed by the API on read.
    await page.reload();
    await expect(setRow(page, 1).getByTestId('pr-chip-weight')).toBeVisible();
    await expect(setRow(page, 1).getByTestId('pr-chip-e1rm')).toBeVisible();
    await expect(setRow(page, 2).getByTestId('pr-chip-reps')).toBeVisible();
    await expect(setRow(page, 3).getByRole('list', { name: 'Personal records' })).toHaveCount(0);

    const stored = await getWorkout(api, workout.id);
    const [first, second, warmup] = stored.exercises[0].sets;
    expect(first.prs.map((pr) => pr.type)).toEqual(expect.arrayContaining(['weight', 'e1rm']));
    expect(second.prs.map((pr) => pr.type)).toContain('reps');
    expect(warmup.isWarmup).toBe(true);
    expect(warmup.prs).toEqual([]);
    expect(Math.abs((first.weightKg ?? 0) - lbToKg(75))).toBeLessThanOrEqual(KG_TOLERANCE);
  });

  test('edits a completed workout: change a weight, add a set, delete a set, delete the workout', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'wk-edit');
    await setUnits(api, 'imperial');
    const gym = await createDumbbellGym(api);
    const workout = await seedCompletedWorkout(api, {
      gymId: gym.id,
      name: 'Bench day',
      slug: BENCH_SLUG,
      sets: [
        { weightKg: lbToKg(70), reps: 10 },
        { weightKg: lbToKg(70), reps: 10 },
        { weightKg: lbToKg(70), reps: 9 },
      ],
    });

    await page.goto(`/train/workouts/${workout.id}`);
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();

    // Change a weight: saved on blur, converted to kilograms.
    const weight = page.getByLabel('Set 1 weight in lb', { exact: true });
    await weight.fill('72.5');
    await weight.press('Tab');
    await expect
      .poll(async () => (await getWorkout(api, workout.id)).exercises[0].sets[0].weightKg ?? 0, {
        message: 'the edited weight was never stored',
      })
      .toBeCloseTo(lbToKg(72.5), 3);

    // Add a set (a fourth row appears), then delete the second: numbers stay dense.
    await page.getByRole('button', { name: `Add set to ${BENCH}` }).click();
    await expect(setRow(page, 4)).toBeVisible();

    await page.getByRole('button', { name: 'More for set 2' }).click();
    await page.getByRole('dialog', { name: 'More for set 2' }).getByRole('button', { name: 'Delete set 2' }).click();
    await expect(setRow(page, 4)).toHaveCount(0);
    await expect(setRow(page, 3)).toBeVisible();
    await expect
      .poll(async () => (await getWorkout(api, workout.id)).exercises[0].sets.map((set) => set.setNumber))
      .toEqual([1, 2, 3]);

    // The deleted set was the second 70 x 10: what is left is 72.5 x 10, then 70 x 9, then the new row.
    const edited = await getWorkout(api, workout.id);
    expect(edited.exercises[0].sets.map((set) => set.reps).slice(0, 2)).toEqual([10, 9]);

    // Delete the workout, with the confirmation.
    await page.getByRole('button', { name: 'Delete workout' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete workout?' });
    await expect(confirm).toContainText('Bench day');
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page).toHaveURL(/\/train$/);
    await expect(page.getByText('No workouts yet. Start one, log sets in a few taps.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Workout history' })).toHaveCount(0);

    await expectStatus(() => getWorkout(api, workout.id), 404);
  });

  test('creates a custom exercise from the picker, logs a distance set, and lists it as Custom', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'wk-custom');
    await setUnits(api, 'imperial');
    const gym = await createDumbbellGym(api);
    const workout = await openNewWorkout(page, api, gym.id);

    await page.getByRole('button', { name: 'Add exercise', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add exercises' });
    await picker.getByRole('button', { name: 'Create custom exercise' }).click();

    const create = page.getByRole('dialog', { name: 'New custom exercise' });
    await create.getByRole('textbox', { name: /Name/ }).fill('Sled push');
    await create.getByRole('combobox', { name: /Primary muscles/ }).click();
    await page.getByRole('option', { name: 'Quads' }).click();
    await create.getByRole('combobox', { name: /Movement pattern/ }).click();
    await page.getByRole('option', { name: 'Carry' }).click();
    await create.getByRole('combobox', { name: /Tracking/ }).click();
    await page.getByRole('option', { name: 'Distance and time' }).click();
    await create.getByRole('button', { name: 'Create' }).click();
    await expect(create).toBeHidden();

    // The new exercise is picked at once.
    await expect(picker.getByRole('button', { name: 'Add exercise', exact: true })).toBeEnabled();
    await picker.getByRole('button', { name: 'Add exercise', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Sled push' })).toBeVisible();

    // A distance set: 0.1 mi in 1:00. Imperial users read miles.
    const distance = page.getByLabel('Set 1 distance in mi', { exact: true });
    await distance.fill('0.1');
    await distance.press('Enter');
    await expect(page.getByLabel('Set 1 time (minutes:seconds)', { exact: true })).toBeFocused();
    await page.keyboard.type('1:00');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Complete set 1' })).toHaveAttribute('aria-pressed', 'true');

    const stored = await getWorkout(api, workout.id);
    const entry = stored.exercises[0];
    expect(entry.exercise).toMatchObject({ name: 'Sled push', isCustom: true, trackingMode: 'distance_time' });
    expect(entry.sets[0].completed).toBe(true);
    expect(entry.sets[0].durationSeconds).toBe(60);
    expect(Math.abs((entry.sets[0].distanceMeters ?? 0) - 160.93)).toBeLessThanOrEqual(0.01);

    // In the library it is marked Custom.
    await page.goto('/train/exercises');
    await page.getByLabel('Search exercises').fill('Sled push');
    const row = page.getByRole('list', { name: 'Exercises' }).getByRole('listitem').filter({ hasText: 'Sled push' });
    await expect(row).toHaveCount(1);
    await expect(row.getByText('Custom', { exact: true })).toBeVisible();

    const custom = await api.get<Array<{ name: string; isCustom: boolean }>>('/api/exercises?custom=true');
    expect(custom.map((exercise) => exercise.name)).toContain('Sled push');
  });

  test('allows one workout in progress: Today offers Resume and a second start returns the same one', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'wk-resume');
    await setUnits(api, 'imperial');
    const gym = await createDumbbellGym(api);
    const workout = await startWorkout(api, { gymId: gym.id, name: 'Already running' });
    expect(workout.existing).toBe(false);

    await page.goto('/');
    const card = page.getByTestId('today-card-workout');
    await expect(card.getByRole('link', { name: 'Resume workout' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Start workout' })).toHaveCount(0);
    await card.getByRole('link', { name: 'Resume workout' }).click();
    await expect(page).toHaveURL(new RegExp(`/train/workouts/${workout.id}$`));

    // A second start through the API is not a second workout.
    const again = await startWorkout(api, { gymId: gym.id, name: 'Another one' });
    expect(again.id).toBe(workout.id);
    expect(again.existing).toBe(true);

    const list = await api.get<{ items: Array<{ id: string; status: string }> }>('/api/workouts?status=in_progress');
    expect(list.items.map((item) => item.id)).toEqual([workout.id]);
  });

  test('a discomfort flag on a set survives a reload and is stored', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'wk-pain');
    await setUnits(api, 'imperial');
    const gym = await createDumbbellGym(api);
    const workout = await startWorkout(api, { gymId: gym.id });
    await addExerciseWithSets(api, workout.id, BENCH_SLUG, [{}]);
    await page.goto(`/train/workouts/${workout.id}`);

    const flag = page.getByRole('button', { name: 'Flag discomfort on set 1' });
    await expect(flag).toHaveAttribute('aria-pressed', 'false');
    await flag.click();
    await expect(flag).toHaveAttribute('aria-pressed', 'true');
    await expect(setRow(page, 1).getByText('Discomfort flagged')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('button', { name: 'Flag discomfort on set 1' })).toHaveAttribute('aria-pressed', 'true');
    await expect(setRow(page, 1).getByText('Discomfort flagged')).toBeVisible();

    const stored = await getWorkout(api, workout.id);
    expect(stored.exercises[0].sets[0].painFlag).toBe(true);
  });

  test('with AI switched off, Prefill from photo is disabled with the reason and logging still works', async ({ page }) => {
    await stubAiState(page, { enabled: false });
    const { api } = await signIn(page, 'contributor', 'wk-ai-off');
    await setUnits(api, 'imperial');
    const gym = await createDumbbellGym(api);
    const workout = await openNewWorkout(page, api, gym.id);

    const prefill = page.getByTestId('prefill-from-photo');
    await expect(prefill).toContainText('AI is turned off for this app.');
    await expect(prefill.getByRole('button', { name: 'Prefill from photo' })).toBeDisabled();
    await expect(page.getByRole('link', { name: 'Prefill from photo' })).toHaveCount(0);

    // The manual path is untouched.
    await page.getByRole('button', { name: 'Add exercise', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add exercises' });
    await picker.getByRole('checkbox', { name: BENCH, exact: true }).check();
    await picker.getByRole('button', { name: 'Add exercise', exact: true }).click();
    await logSet(page, 1, '65', '12');

    await expect
      .poll(async () => (await getWorkout(api, workout.id)).exercises[0]?.sets[0]?.completed)
      .toBe(true);
  });

  test('a Viewer can log a workout by hand; Prefill from photo says why it is unavailable', async ({ page }) => {
    // A Viewer holds workouts:write and gyms:write, but neither ai:use nor storage:write.
    const { api } = await signIn(page, 'viewer', 'wk-viewer');
    const gym = await createDumbbellGym(api);
    const workout = await openNewWorkout(page, api, gym.id);

    const prefill = page.getByTestId('prefill-from-photo');
    await expect(prefill.getByRole('button', { name: 'Prefill from photo' })).toBeDisabled();
    await expect(prefill).toContainText(/Prefilling needs permission|Your account cannot use AI features/);

    await page.getByRole('button', { name: 'Add exercise', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add exercises' });
    await picker.getByRole('checkbox', { name: BENCH, exact: true }).check();
    await picker.getByRole('button', { name: 'Add exercise', exact: true }).click();

    // Viewers have no Health Profile unit set, so weights read in kilograms.
    const weight = page.getByLabel('Set 1 weight in kg', { exact: true });
    await weight.fill('40');
    await weight.press('Enter');
    await page.keyboard.type('8');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Complete set 1' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Finish', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Workout finished' })).toBeVisible();

    const stored = await getWorkout(api, workout.id);
    expect(stored.status).toBe('completed');
    expect(stored.exercises[0].sets[0]).toMatchObject({ weightKg: 40, reps: 8, completed: true });
  });
});
