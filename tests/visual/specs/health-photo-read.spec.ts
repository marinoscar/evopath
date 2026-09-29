import { expect, test, type Page } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { FIXED_NOW, mockHealthApi } from '../support/health';
import { mockPhotoReadApi, PHOTO_READ_PERMS, type PhotoReadScenario } from '../support/photoRead';

/**
 * "Read from photo" on the Health page — issue #64 (E2.6).
 *
 * The harness mounts the real `AiConfigProvider` (`?ai=on`) and the user holds
 * exactly what the control needs (`PHOTO_READ_PERMS`); `support/photoRead.ts`
 * answers AI, intakes and photos on top of `support/health.ts`.
 *
 * Four treatments, all NEW baselines (the existing `health-page.spec.ts`
 * baselines are untouched: without `?ai=on` the control is not rendered):
 *   - desktop 1440x900, dark: the page header, "Read from photo" beside
 *     "Log measurement";
 *   - desktop 1440x900, dark: History with the "Read from photo", "You
 *     edited" and "View photo" provenance on two AI-read entries above a
 *     manual one;
 *   - phone 390x844, light: the photo step, full-screen (picker, helper text,
 *     the disclosure naming provider, model and key);
 *   - phone 375x812, light: a blood-pressure cuff reading under review,
 *     full-screen, with the unsure pulse, the pending count on Save, and
 *     nothing hidden behind the bottom bar or off to the side.
 */

test.use({ timezoneId: 'UTC', locale: 'en-US', reducedMotion: 'reduce' });

async function openHealth(page: Page, scenario: PhotoReadScenario, options: { theme?: 'light' | 'dark' } = {}) {
  await page.clock.setFixedTime(FIXED_NOW);
  await mockHealthApi(page, 'data');
  await mockPhotoReadApi(page, scenario);
  await page.goto(harnessUrl({ route: '/health', perms: PHOTO_READ_PERMS, ai: true, ...options }));
  await waitForInter(page);

  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
  await expect(page.getByTestId('latest-measurements-skeleton')).toHaveCount(0);
  await expect(main.getByRole('button', { name: 'Read from photo' })).toBeVisible();
  await expect(page.getByTestId('measurement-history-skeleton')).toHaveCount(0);
  return main;
}

async function openDialog(page: Page) {
  await page.locator('main').getByRole('button', { name: 'Read from photo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Read from photo' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Health: read from photo', () => {
  test('header @ 1440x900, dark: Read from photo beside Log measurement', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const main = await openHealth(page, 'draft');

    const header = main.getByRole('heading', { level: 1, name: 'Health' }).locator('xpath=../..');
    await expect(header.getByRole('button', { name: 'Log measurement' })).toBeVisible();
    await expect(header).toHaveScreenshot('health-photo-read-header-1440x900-dark.png');
  });

  test('History @ 1440x900, dark: photo provenance chips and View photo', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const main = await openHealth(page, 'draft');

    const history = main.getByRole('region', { name: 'History' });
    const entries = history.getByTestId('history-entry');
    await expect(entries).toHaveCount(3);
    await expect(entries.nth(0)).toContainText('209.4 lb');
    await expect(entries.nth(0).getByText('Read from photo')).toBeVisible();
    await expect(entries.nth(0).getByText('You edited')).toBeVisible();
    await expect(entries.nth(1)).toContainText('128/84 mmHg');
    await expect(entries.nth(1).getByText('You edited')).toHaveCount(0);
    await expect(entries.nth(2).getByText('Manual')).toBeVisible();
    await expect(history.getByRole('button', { name: /^View photo/ })).toHaveCount(2);

    await expect(history).toHaveScreenshot('health-history-photo-provenance-1440x900-dark.png');
  });

  test('photo step @ 390x844, light, full-screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHealth(page, 'draft', { theme: 'light' });
    const dialog = await openDialog(page);

    await expect(dialog.getByText('Photograph the display so every digit is sharp and in the frame')).toBeVisible();
    await expect(dialog.getByTestId('ai-vision-disclosure')).toContainText('openai');
    await expect(dialog.getByLabel('Take photo')).toHaveAttribute('capture', 'environment');
    expect((await dialog.boundingBox())?.width).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Read' })).toBeInViewport();

    await expect(page).toHaveScreenshot('health-photo-read-390x844-light-photo-step.png');
  });

  test('cuff review @ 375x812, light, full-screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openHealth(page, 'review', { theme: 'light' });
    const dialog = await openDialog(page);

    const rows = dialog.getByTestId('draft-item-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Blood pressure: systolic 128 mmHg');
    await expect(rows.nth(2)).toContainText('Pulse from a blood-pressure cuff may not be a resting rate');
    const save = dialog.getByRole('button', { name: /Save to Health/ });
    await expect(save).toContainText('(2 pending)');
    await expect(save).toBeDisabled();
    // Full-screen over the bottom bar: the actions are in view, nothing scrolls sideways.
    expect((await dialog.boundingBox())?.width).toBe(375);
    await expect(save).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await expect(page).toHaveScreenshot('health-photo-read-375x812-light-review.png');
  });
});
