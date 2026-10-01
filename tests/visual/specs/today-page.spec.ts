import { expect, test, type Page } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { GYM_EQUIPMENT_COUNT, GYM_NAME, mockGymsApi } from '../support/gyms';
import { mockHealthApi } from '../support/health';
import { mockWorkoutsApi } from '../support/workouts';

/**
 * The Today page: the app's landing screen and its four cards.
 *
 * Which cards exist comes from the harness's FROZEN list
 * (`apps/web/visual/fixtures/todayCards.tsx`, #222), not the live
 * `TODAY_CARDS`, so adding a Today card to the app moves neither baseline. The
 * cards' bodies are the real components, fed by the mocks below.
 *
 * Two treatments:
 *   - desktop 1440x900, dark (the harness default): the `main` region, the
 *     card grid without the rail;
 *   - phone 390x844, light: the whole page, so the four-tab bottom bar is in
 *     frame.
 *
 * The header reads "<weekday, month day> · Hello, <first name>", so the clock
 * is pinned (`page.clock.setFixedTime`, timers keep running) and so are the
 * time zone and locale the date is formatted in. The harness user is
 * `Visual Harness`, hence "Hello, Visual". The user menu is never open in
 * these shots, which keeps its version line out of every baseline.
 *
 * The Body snapshot card shows real data since #53 (E2.3): its
 * `/api/measurements/*` and `/api/health-profile` calls are answered by
 * `support/health.ts` (the `data` scenario, an imperial user), so the card
 * renders the same three values on every run instead of a failed fetch.
 * The Readiness card shows today's check-in since #56 (E2.4): the same
 * fixture answers `/api/check-ins/today` with four scores and a note.
 * The Your gym card shows the default gym since E3.3: `support/gyms.ts`
 * answers `GET /api/gyms` with one gym ("Home Gym", four pieces of equipment),
 * and the harness grants `gyms:read`, so the card never lands on a loading,
 * error or "unavailable" state.
 * The Today's workout card shows the training summary since E4.6:
 * `support/workouts.ts` answers `GET /api/workouts/summary` with a last workout
 * ("Push day", yesterday, at the same gym, three top lifts) and two workouts
 * this week, and the harness grants `workouts:read` / `workouts:write`.
 */

test.use({ timezoneId: 'UTC', locale: 'en-US' });

const FIXED_NOW = new Date('2026-09-29T12:00:00Z');

const CARDS = ["Today's workout", 'Readiness', 'Body snapshot', 'Your gym'];

async function openToday(page: Page, options: { theme?: 'light' | 'dark' } = {}) {
  await page.clock.setFixedTime(FIXED_NOW);
  await mockHealthApi(page, 'data');
  await mockGymsApi(page);
  await mockWorkoutsApi(page);
  await page.goto(harnessUrl({ route: '/', ...options }));
  await waitForInter(page);

  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  await expect(main.getByText('Tuesday, September 29 · Hello, Visual')).toBeVisible();
  for (const name of CARDS) {
    await expect(main.getByRole('region', { name })).toBeVisible();
  }
  await expect(main.getByRole('region', { name: 'Body snapshot' }).getByText('208.4 lb')).toBeVisible();
  await expect(main.getByRole('region', { name: 'Readiness' }).getByText('Energy 4')).toBeVisible();
  const gym = main.getByRole('region', { name: 'Your gym' });
  await expect(gym.getByText(GYM_NAME)).toBeVisible();
  await expect(gym.getByText(`${GYM_EQUIPMENT_COUNT} pieces of equipment`)).toBeVisible();
  const workout = main.getByRole('region', { name: "Today's workout" });
  await expect(workout.getByText('Push day')).toBeVisible();
  await expect(workout.getByText('This week: 2 workouts')).toBeVisible();
}

test.describe('Today page', () => {
  test('desktop @ 1440x900, dark', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openToday(page);

    await expect(page.locator('main')).toHaveScreenshot('today-page-1440x900-dark-main.png');
  });

  test('phone @ 390x844, light, with the bottom bar', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openToday(page, { theme: 'light' });

    await expect(page).toHaveScreenshot('today-page-390x844-light-page.png');
  });
});
