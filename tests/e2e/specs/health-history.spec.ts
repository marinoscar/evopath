import { test, expect, type Page } from '@playwright/test';
import { loginAsViewer } from '../helpers/auth.helper';

/**
 * History and trends — issue #60 (E2.5): a viewer logs two weights (one
 * backdated with Details → Date and time), sees both in History and the
 * Trend chart, edits one (Edited chip, tile and chart follow), deletes the
 * other after a confirmation that names it, and the result survives a reload.
 *
 * Against the running stack, like every spec here, with a FRESH viewer per
 * run (unique test-login email): no health profile (metric units) and no
 * earlier readings, so nothing depends on a previous run.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };

/** `YYYY-MM-DDTHH:mm` in the browser's zone, `days` ago at 08:00. */
function localDateTime(daysAgo: number): string {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T08:00`;
}

async function logWeight(page: Page, value: string, options: { daysAgo?: number } = {}) {
  await page.locator('main').getByRole('button', { name: 'Log measurement' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Log measurement' });
  await dialog.getByRole('textbox', { name: 'Weight' }).fill(value);
  if (options.daysAgo !== undefined) {
    await dialog.getByRole('button', { name: 'Details' }).click();
    await dialog.getByLabel('Date and time').fill(localDateTime(options.daysAgo));
  }
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

test.describe('Health history and trends', () => {
  test('log two weights, edit one, delete one; the chart and tile follow and it persists', async ({ page }) => {
    await loginAsViewer(page, `viewer-health-history-${Date.now()}@test.local`);
    await page.setViewportSize(DESKTOP);
    await page.goto('/health');

    const main = page.locator('main');
    const trend = main.getByRole('region', { name: 'Trend' });
    const history = main.getByRole('region', { name: 'History' });
    const weightTile = main.getByRole('region', { name: 'Weight' });
    await expect(history.getByText('No entries yet')).toBeVisible();

    await logWeight(page, '81.0', { daysAgo: 2 });
    await expect(trend.getByText('Log at least two readings to see a trend')).toBeVisible();
    await logWeight(page, '80.4');

    const rows = history.getByTestId('history-entry');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('80.4 kg');
    await expect(rows.nth(1)).toContainText('81.0 kg');
    await expect(trend.getByRole('img', { name: /^Weight, last 90 days, 2 readings, latest 80\.4 kg/ })).toBeVisible();
    await expect(weightTile).toContainText('80.4 kg');

    // Edit the newest: 80.4 → 80.9 kg. The API keeps the old row as a revision.
    await rows.first().getByRole('button', { name: /^Edit weight entry from/ }).click();
    const edit = page.getByRole('dialog', { name: 'Edit entry' });
    const weight = edit.getByRole('textbox', { name: 'Weight' });
    await expect(weight).toHaveValue('80.4');
    await weight.fill('80.9');
    await expect(edit.getByText('Was 80.4 kg')).toBeVisible();
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(edit).toBeHidden();

    await expect(rows.first()).toContainText('80.9 kg');
    await expect(rows.first().getByText('Edited')).toBeVisible();
    await expect(weightTile).toContainText('80.9 kg');
    await expect(trend.getByRole('img', { name: /latest 80\.9 kg/ })).toBeVisible();

    // Delete the older one; Cancel first changes nothing.
    await rows.nth(1).getByRole('button', { name: /^Delete weight entry from/ }).click();
    let confirm = page.getByRole('dialog', { name: 'Delete entry?' });
    await expect(confirm).toContainText('Weight 81.0 kg from');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(rows).toHaveCount(2);

    await rows.nth(1).getByRole('button', { name: /^Delete weight entry from/ }).click();
    confirm = page.getByRole('dialog', { name: 'Delete entry?' });
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByText('Entry deleted')).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(trend.getByText('Log at least two readings to see a trend')).toBeVisible();

    await page.reload();
    await expect(page.locator('main').getByRole('region', { name: 'History' }).getByTestId('history-entry')).toHaveCount(1);
    await expect(page.locator('main').getByRole('region', { name: 'Weight' })).toContainText('80.9 kg');
  });

  test('on a phone the chart fits without horizontal scroll and actions are 44px targets', async ({ page }) => {
    await loginAsViewer(page, `viewer-health-history-phone-${Date.now()}@test.local`);
    await page.setViewportSize(PHONE);
    await page.goto('/health');

    await logWeight(page, '81.0', { daysAgo: 3 });
    await logWeight(page, '80.4');

    const main = page.locator('main');
    await expect(main.getByRole('region', { name: 'Trend' }).getByRole('img', { name: /^Weight, last 90 days/ })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    const edit = main.getByTestId('history-entry').first().getByRole('button', { name: /^Edit weight entry/ });
    const box = await edit.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  });
});
