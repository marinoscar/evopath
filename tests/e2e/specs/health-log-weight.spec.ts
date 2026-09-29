import { test, expect } from '@playwright/test';
import { loginAsViewer } from '../helpers/auth.helper';

/**
 * Quick entry — issue #53 (E2.3): a viewer logs a weight on the Health page,
 * sees it on the tile and on Today's Body snapshot, and it survives a reload.
 *
 * Against the running stack, like every spec here. Each run signs in as a
 * FRESH viewer (a unique test-login email; the test login creates the user
 * and bypasses the allowlist), so the account has no health profile (metric
 * units, no BMI) and no earlier readings: no soft warning, no delta, and the
 * assertions do not depend on what a previous run left behind.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };

test.describe('Health quick entry', () => {
  test('logs a weight with type + Enter; the tile and Today show it, and it persists', async ({ page }) => {
    await loginAsViewer(page, `viewer-health-${Date.now()}@test.local`);
    await page.setViewportSize(DESKTOP);
    await page.goto('/health');

    const main = page.locator('main');
    await expect(main.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
    const weightTile = main.getByRole('region', { name: 'Weight' });
    await expect(weightTile).toContainText('No data yet');
    await expect(main.getByRole('region', { name: 'BMI' })).toHaveCount(0);

    await main.getByRole('button', { name: 'Log measurement' }).click();
    const dialog = page.getByRole('dialog', { name: 'Log measurement' });
    const weight = dialog.getByRole('textbox', { name: 'Weight' });
    await expect(weight).toBeFocused();
    await expect(dialog.getByText('Using metric units.')).toBeVisible();

    await page.keyboard.type('80.4');
    await page.keyboard.press('Enter');

    await expect(dialog).toBeHidden();
    await expect(weightTile).toContainText('80.4 kg');
    await expect(weightTile).toContainText('Today');

    await page.goto('/');
    const snapshot = page.getByRole('region', { name: 'Body snapshot' });
    await expect(snapshot).toContainText('80.4 kg');
    await snapshot.getByRole('link', { name: 'Open Health' }).click();
    await expect(page).toHaveURL('/health');

    await page.reload();
    await expect(page.locator('main').getByRole('region', { name: 'Weight' })).toContainText('80.4 kg');
  });

  test('validation blocks an out-of-range weight and nothing is saved', async ({ page }) => {
    await loginAsViewer(page, `viewer-health-bounds-${Date.now()}@test.local`);
    await page.setViewportSize(DESKTOP);
    await page.goto('/health');

    await page.getByRole('button', { name: 'Log measurement' }).click();
    const dialog = page.getByRole('dialog', { name: 'Log measurement' });
    await dialog.getByRole('textbox', { name: 'Weight' }).fill('5');
    await page.keyboard.press('Enter');
    await expect(dialog.getByText('Enter a value between 20 and 500 kg')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('region', { name: 'Weight' })).toContainText('No data yet');
  });

  test('on a phone the dialog is full-screen and Save is visible', async ({ page }) => {
    await loginAsViewer(page, `viewer-health-phone-${Date.now()}@test.local`);
    await page.setViewportSize(PHONE);
    await page.goto('/health');

    await page.getByRole('button', { name: 'Log measurement' }).click();
    const dialog = page.getByRole('dialog', { name: 'Log measurement' });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box?.width).toBe(PHONE.width);
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeInViewport();
  });
});
