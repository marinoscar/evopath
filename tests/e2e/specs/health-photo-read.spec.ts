import { test, expect, type Page } from '@playwright/test';
import { loginAsContributor, loginAsViewer } from '../helpers/auth.helper';

/**
 * Read from photo — issue #64 (E2.6): who sees the entry point, and the
 * dialog's shell on a phone, against the running stack.
 *
 * Whether AI is on is deployment-wide state another spec (or an operator) may
 * have changed, so `GET /api/ai/config` and `GET /api/ai/models` are answered
 * here with `page.route()` to make each case deterministic. Everything else is
 * the real API: the intake is really created (and discarded) through
 * `/api/intakes`. No scan runs: this stack has no vision model and the
 * story's canned fake-vision answers depend on E3.4's fake server, which is
 * not merged yet; the review, apply and provenance paths are covered by the
 * web tests (`PhotoReadDialog.test.tsx`) and the API suites.
 *
 * Seeded roles: a Viewer holds `intakes:write` but neither `ai:use` nor
 * `storage:write`, so it never sees the control; a Contributor holds all of
 * them.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };

const VISION_MODEL = {
  provider: 'openai',
  modelId: 'gpt-5-mini',
  displayName: 'GPT-5 mini',
  capabilities: {
    capabilities: ['responses', 'vision_input', 'structured_output'],
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
  },
  keySource: 'user',
};

async function stubAi(page: Page, enabled: boolean) {
  await page.route('**/api/ai/config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { enabled, keyPolicy: 'byok', providers: [] } }),
    }),
  );
  await page.route('**/api/ai/models', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [VISION_MODEL] }) }),
  );
}

/** Every `/api/intakes` and upload request the page makes. */
function watchIntakeRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/intakes') || path.startsWith('/api/storage/objects')) {
      seen.push(`${request.method()} ${path}`);
    }
  });
  return seen;
}

test.describe('Health: read from photo', () => {
  test('a Viewer never sees it, even with AI on, and manual entry is unchanged', async ({ page }) => {
    await stubAi(page, true);
    const intakeRequests = watchIntakeRequests(page);
    await loginAsViewer(page, `viewer-photo-${Date.now()}@test.local`);
    await page.setViewportSize(DESKTOP);
    await page.goto('/health');

    const main = page.locator('main');
    await expect(main.getByRole('button', { name: 'Log measurement' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Read from photo' })).toHaveCount(0);

    await main.getByRole('button', { name: 'Log measurement' }).click();
    const dialog = page.getByRole('dialog', { name: 'Log measurement' });
    await expect(dialog.getByRole('textbox', { name: 'Weight' })).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Read from photo' })).toHaveCount(0);
    await page.keyboard.type('80.4');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(main.getByRole('region', { name: 'Weight' })).toContainText('80.4 kg');

    expect(intakeRequests).toEqual([]);
  });

  test('with AI off a Contributor does not see it and no intake request is made', async ({ page }) => {
    await stubAi(page, false);
    const intakeRequests = watchIntakeRequests(page);
    await loginAsContributor(page, `contributor-photo-off-${Date.now()}@test.local`);
    await page.setViewportSize(DESKTOP);
    await page.goto('/health');

    await expect(page.locator('main').getByRole('button', { name: 'Log measurement' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Read from photo' })).toHaveCount(0);
    await page.locator('main').getByRole('button', { name: 'Log measurement' }).click();
    await expect(page.getByRole('dialog', { name: 'Log measurement' }).getByRole('button', { name: 'Read from photo' })).toHaveCount(0);
    expect(intakeRequests).toEqual([]);
  });

  test('on a phone a Contributor gets a full-screen dialog with the OS camera; Discard and Enter manually work', async ({ page }) => {
    await stubAi(page, true);
    const intakeRequests = watchIntakeRequests(page);
    await loginAsContributor(page, `contributor-photo-${Date.now()}@test.local`);
    await page.setViewportSize(PHONE);
    await page.goto('/health');

    await page.locator('main').getByRole('button', { name: 'Read from photo' }).click();
    const dialog = page.getByRole('dialog', { name: 'Read from photo' });
    await expect(dialog.getByText('Photograph the display so every digit is sharp and in the frame')).toBeVisible();
    expect((await dialog.boundingBox())?.width).toBe(PHONE.width);
    await expect(dialog.getByLabel('Take photo')).toHaveAttribute('capture', 'environment');
    await expect(dialog.getByTestId('ai-vision-disclosure')).toContainText('GPT-5 mini');
    await expect(dialog.getByRole('button', { name: 'Read' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Read' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(intakeRequests).toContain('POST /api/intakes');

    // Discard deletes the (empty) intake and closes.
    await dialog.getByRole('button', { name: 'Discard' }).click();
    await expect(dialog).toBeHidden();
    expect(intakeRequests.some((r) => /^DELETE \/api\/intakes\/[^/]+$/.test(r))).toBe(true);

    // Enter manually hands over to the quick-entry dialog.
    await page.locator('main').getByRole('button', { name: 'Read from photo' }).click();
    await expect(dialog.getByText('Photograph the display so every digit is sharp and in the frame')).toBeVisible();
    await dialog.getByRole('button', { name: 'Enter manually' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Log measurement' })).toBeVisible();
  });
});
