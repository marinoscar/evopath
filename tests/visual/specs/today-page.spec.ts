import { expect, test, type Page } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { mockHealthApi } from '../support/health';

/**
 * The Today page: the app's landing screen and its four cards.
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
 */

test.use({ timezoneId: 'UTC', locale: 'en-US' });

const FIXED_NOW = new Date('2026-09-29T12:00:00Z');

const CARDS = ["Today's workout", 'Readiness', 'Body snapshot', 'Your gym'];

async function openToday(page: Page, options: { theme?: 'light' | 'dark' } = {}) {
  await page.clock.setFixedTime(FIXED_NOW);
  await mockHealthApi(page, 'data');
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
