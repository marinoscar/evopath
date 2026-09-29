import { test, expect, type Locator, type Page } from '@playwright/test';
import { loginAsViewer } from '../helpers/auth.helper';

/**
 * Daily check-in — issue #56 (E2.4): a viewer checks in from the Health page,
 * sees the scores on Today's Readiness card, edits the same day (still one
 * check-in), and the result survives a reload; then deletes it.
 *
 * Against the running stack, like every spec here. Each run signs in as a
 * FRESH viewer (a unique test-login email), so there is no earlier check-in
 * and no health profile: "today" is the UTC day the server computes.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };

function score(dialog: Locator, name: RegExp, value: number): Locator {
  return dialog.getByRole('group', { name }).getByRole('button', { name: String(value), exact: true });
}

async function openDialog(page: Page, button: 'Check in' | 'Edit check-in'): Promise<Locator> {
  const section = page.locator('main').getByRole('region', { name: 'Daily check-in' });
  await section.getByRole('button', { name: button }).click();
  const dialog = page.getByRole('dialog', { name: 'Daily check-in' });
  await expect(dialog.getByRole('group', { name: /^Energy/ })).toBeVisible();
  return dialog;
}

test.describe('Daily check-in', () => {
  test('checks in from Health, shows on Today, edits the same day and persists', async ({ page }) => {
    await loginAsViewer(page, `viewer-checkin-${Date.now()}@test.local`);
    await page.setViewportSize(DESKTOP);
    await page.goto('/health');

    const section = page.locator('main').getByRole('region', { name: 'Daily check-in' });
    await expect(section.getByText('Not done today')).toBeVisible();

    const dialog = await openDialog(page, 'Check in');
    const save = dialog.getByRole('button', { name: 'Save' });
    await expect(save).toBeDisabled();
    await score(dialog, /^Energy/, 4).click();
    await score(dialog, /^Sleep quality/, 3).click();
    await score(dialog, /^Muscle soreness/, 2).click();
    await score(dialog, /^Stress/, 3).click();
    await expect(score(dialog, /^Energy/, 4)).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('textbox', { name: 'Note' }).fill('Big presentation');
    await save.click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText('Check-in saved')).toBeVisible();
    const chips = section.getByRole('list', { name: 'Scores' });
    await expect(chips).toContainText('Energy 4');
    await expect(chips).toContainText('Stress 3');
    await expect(section.getByText('Big presentation')).toBeVisible();

    await page.goto('/');
    const readiness = page.getByRole('region', { name: 'Readiness' });
    await expect(readiness).toContainText('Energy 4');
    await expect(readiness).toContainText('Sleep quality 3');
    await readiness.getByRole('link', { name: 'Open Health' }).click();
    await expect(page).toHaveURL('/health');

    // Edit: clear Stress, raise Energy. Still one check-in for today.
    const edit = await openDialog(page, 'Edit check-in');
    await score(edit, /^Stress/, 3).click();
    await expect(score(edit, /^Stress/, 3)).toHaveAttribute('aria-pressed', 'false');
    await score(edit, /^Energy/, 5).click();
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(edit).toBeHidden();

    await page.reload();
    await expect(section.getByRole('list', { name: 'Scores' })).toContainText('Energy 5');
    await expect(section.getByRole('list', { name: 'Scores' })).not.toContainText('Stress');
    await expect(section.getByRole('list', { name: 'Recent check-ins' }).getByRole('listitem')).toHaveCount(1);

    // Delete: the section and Today return to the prompt.
    const again = await openDialog(page, 'Edit check-in');
    await again.getByRole('button', { name: 'Delete check-in' }).click();
    await again.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(again).toBeHidden();
    await expect(section.getByText('Not done today')).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Readiness' })).toContainText(
      'How are you feeling today? Takes a few seconds.',
    );
  });

  test('clearing every score disables Save', async ({ page }) => {
    await loginAsViewer(page, `viewer-checkin-clear-${Date.now()}@test.local`);
    await page.setViewportSize(DESKTOP);
    await page.goto('/health');

    const dialog = await openDialog(page, 'Check in');
    const save = dialog.getByRole('button', { name: 'Save' });
    await score(dialog, /^Energy/, 2).click();
    await expect(save).toBeEnabled();
    await score(dialog, /^Energy/, 2).click();
    await expect(save).toBeDisabled();
  });

  test('on a phone the dialog is full-screen, each score fits one line, Save is reachable', async ({ page }) => {
    await loginAsViewer(page, `viewer-checkin-phone-${Date.now()}@test.local`);
    await page.setViewportSize(PHONE);
    await page.goto('/health');

    const dialog = await openDialog(page, 'Check in');
    expect((await dialog.boundingBox())?.width).toBe(PHONE.width);
    for (const name of [/^Energy/, /^Sleep quality/, /^Muscle soreness/, /^Stress/]) {
      const tops = await dialog
        .getByRole('group', { name })
        .getByRole('button')
        .evaluateAll((buttons) => buttons.map((b) => Math.round(b.getBoundingClientRect().top)));
      expect(tops).toHaveLength(5);
      expect(new Set(tops).size).toBe(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeInViewport();
  });
});
