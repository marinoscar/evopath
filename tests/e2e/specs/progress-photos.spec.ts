import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../helpers/api.helper';
import { fakeLog, isFakeVisionReachable, lastLogSeq } from '../helpers/ai.helper';

/**
 * Progress photos (E7.9) end to end: add two photos of one pose, see them in the
 * gallery, compare them with the before/after slider, delete one.
 *
 * A photo is stored like any upload (it needs object storage configured on the
 * stack, as the gym-scan spec does) and is NEVER sent to a model: when the fake
 * AI server is reachable the spec also proves no completion carried an image
 * while it ran (the unit-level proof is `apps/api/test/coach/coach-photo-privacy.spec.ts`).
 * No AI settings are touched, so this spec may run beside the others.
 *
 *   cd tests/e2e && npm test -- progress-photos
 */

const FIXTURES = path.resolve(__dirname, '../fixtures');
const PHOTO_ONE = path.join(FIXTURES, 'hotel-gym-1.jpg');
const PHOTO_TWO = path.join(FIXTURES, 'hotel-gym-2.jpg');

/** `YYYY-MM-DD`, `days` days before today in the browser's zone (the dialog's own `max` is today there). */
async function daysAgo(page: Page, days: number): Promise<string> {
  return page.evaluate((n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, days);
}

async function addPhoto(page: Page, file: string, note: string, date?: string): Promise<void> {
  await page.getByRole('button', { name: 'Add photo' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add progress photo' });
  await expect(dialog).toBeVisible();

  await dialog.getByTestId('progress-photo-file-input').setInputFiles(file);
  await expect(dialog.getByTestId('progress-photo-chosen')).toContainText(path.basename(file));
  if (date) await dialog.getByLabel('Date').fill(date);
  await dialog.getByLabel('Note (optional)').fill(note);
  await dialog.getByRole('button', { name: 'Save photo' }).click();

  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText('Photo added.')).toBeVisible();
}

test('add two photos, see the ghost overlay, compare them, delete one', async ({ page }) => {
  const aiBefore = (await isFakeVisionReachable()) ? await lastLogSeq() : null;
  await signIn(page, 'contributor', 'photos');
  await page.goto('/health/progress-photos');

  await expect(page.getByText('No progress photos yet')).toBeVisible();

  // The first photo is a week old; with no earlier photo of the pose there is no ghost to show.
  await page.getByRole('button', { name: 'Add photo' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Add progress photo' }).getByText(/No earlier front photo yet/)).toBeVisible();
  await page.getByRole('dialog', { name: 'Add progress photo' }).getByRole('button', { name: 'Cancel' }).click();
  await addPhoto(page, PHOTO_ONE, 'week one', await daysAgo(page, 7));
  await expect(page.getByTestId('progress-photo-tile')).toHaveCount(1);

  // The second photo of the same pose gets the first as a ghost overlay to line the framing up.
  await page.getByRole('button', { name: 'Add photo' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add progress photo' });
  await expect(dialog.getByLabel('Show ghost overlay')).toBeChecked();
  await expect(dialog.getByTestId('ghost-overlay')).toBeVisible();
  await dialog.getByLabel('Show ghost overlay').uncheck();
  await expect(dialog.getByTestId('ghost-overlay')).toHaveCount(0);
  await dialog.getByLabel('Show ghost overlay').check();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await addPhoto(page, PHOTO_TWO, 'week two');

  const tiles = page.getByTestId('progress-photo-tile');
  await expect(tiles).toHaveCount(2);
  await expect(tiles.filter({ hasText: 'week one' })).toHaveCount(1);
  await expect(tiles.filter({ hasText: 'week two' })).toHaveCount(1);

  // Compare: oldest against newest by default; the divider is a keyboard-operable slider.
  await page.getByRole('button', { name: 'Compare' }).click();
  const compare = page.getByRole('dialog', { name: 'Compare photos' });
  await compare.getByRole('button', { name: 'Slider', exact: true }).click();
  await expect(compare.getByTestId('compare-slider-frame')).toBeVisible();
  await expect(compare.getByText(/^Before ·/)).toBeVisible();
  await expect(compare.getByText(/^After ·/)).toBeVisible();
  const slider = compare.getByRole('slider', { name: 'Before and after divider' });
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  await page.keyboard.press('End');
  await expect(slider).toHaveAttribute('aria-valuenow', '100');
  await compare.getByRole('button', { name: 'Side by side' }).click();
  await expect(compare.getByTestId('compare-side-by-side')).toBeVisible();
  await compare.getByRole('button', { name: 'Close' }).click();

  // Delete one photo; the gallery keeps the other.
  await page.getByRole('button', { name: /^Delete front photo from/ }).first().click();
  const confirm = page.getByRole('dialog', { name: 'Delete photo?' });
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Photo deleted.')).toBeVisible();
  await expect(tiles).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId('progress-photo-tile')).toHaveCount(1);

  // Nothing here reached a model: no completion the fake logged carried an image.
  if (aiBefore !== null) {
    const calls = await fakeLog(aiBefore);
    expect(calls.filter((entry) => entry.imageCount > 0)).toEqual([]);
  }
});
