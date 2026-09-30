import { test, expect, type Page } from '@playwright/test';
import { loginAsContributor, loginAsViewer } from '../helpers/auth.helper';
import { signIn, type AuthedApi } from '../helpers/api.helper';
import {
  FAKE_VISION_SKIP_MESSAGE,
  configureFakeVisionProvider,
  fakeRequests,
  isFakeVisionReachable,
  resetFake,
  setFakeFixture,
  setFakeVisionFileInput,
} from '../helpers/ai.helper';
import { setUnits } from '../helpers/profile.helper';

/**
 * Read from photo — issue #64 (E2.6): who sees the entry point, and the
 * dialog's shell on a phone, against the running stack.
 *
 * Whether AI is on is deployment-wide state another spec (or an operator) may
 * have changed, so `GET /api/ai/config` and `GET /api/ai/features` are answered
 * here with `page.route()` to make each case deterministic. Everything else is
 * the real API: the intake is really created (and discarded) through
 * `/api/intakes`. No scan runs in these first cases; the review, apply and
 * provenance paths are covered by the web tests (`PhotoReadDialog.test.tsx`)
 * and the API suites. The PDF block at the end (H2, #186) does run a scan,
 * against the fake vision provider.
 *
 * Seeded roles: a Viewer holds `intakes:write` but neither `ai:use` nor
 * `storage:write`, so it never sees the control; a Contributor holds all of
 * them.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };

/** `GET /api/ai/features` (#173): the administrator's assignment for the photo reading, resolved ready. */
const FEATURES = {
  features: [
    {
      featureId: 'body_metric_reading',
      label: 'Body metric photo reading',
      group: 'photo',
      state: 'ready',
      source: 'admin_feature',
      model: { provider: 'openai', modelId: 'gpt-5-mini', displayName: 'GPT-5 mini', keySource: 'user' },
      needs: ['vision_input', 'structured_output'],
      inputModalities: ['image'],
      requestedEffort: null,
      effectiveEffort: null,
      fix: null,
    },
  ],
};

async function stubAi(page: Page, enabled: boolean) {
  await page.route('**/api/ai/config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { enabled, keyPolicy: 'byok', providers: [] } }),
    }),
  );
  await page.route('**/api/ai/features', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: FEATURES }) }),
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

/**
 * PDF reports (H2, #186), end to end with the fake vision provider
 * (`infra/compose/fake-ai.compose.yml`): the API really stores the PDF, checks
 * its magic bytes and pages, gates `file_input` and sends it as a `file` part;
 * the fake answers `body-metric-smart-scale-report` (weight 82.3 kg, body fat
 * 21.4 %) for a request carrying one.
 *
 * The fake's queue and request log are global, like `workout-prefill.spec.ts`
 * and `gym-scan.spec.ts`: run these files with `--workers=1`. Skipped with a
 * message when the fake is not reachable; object storage must be configured.
 * `fake-vision` gets `file_input` for this block and loses it again after.
 */

/** A one-page PDF, small enough to build inline (the page counter reads `/Type /Page`). */
const ONE_PAGE_PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj',
    'trailer << /Root 1 0 R >>',
    '%%EOF',
    '',
  ].join('\n'),
);
const REPORT = { name: 'smart-scale-report.pdf', mimeType: 'application/pdf', buffer: ONE_PAGE_PDF };
const PDF_REFUSAL = "Your AI model can't read PDFs";

async function withAdmin(browser: import('@playwright/test').Browser, baseURL: string | undefined, run: (admin: AuthedApi) => Promise<void>) {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    const { api } = await signIn(page, 'admin', 'photo-pdf-admin');
    await run(api);
  } finally {
    await context.close();
  }
}

/** Sign in a fresh Contributor (metric) and open "Read from photo" on /health. */
async function openPhotoRead(page: Page, prefix: string) {
  const { api } = await signIn(page, 'contributor', prefix);
  await setUnits(api, 'metric');
  await page.setViewportSize(DESKTOP);
  await page.goto('/health');
  await page.locator('main').getByRole('button', { name: 'Read from photo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Read from photo' });
  await expect(dialog.getByRole('button', { name: 'Add photos or PDFs' })).toBeVisible({ timeout: 30_000 });
  return dialog;
}

test.describe('Health: read a PDF report with the fake vision provider', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeAll(async ({ browser, baseURL }) => {
    test.skip(!(await isFakeVisionReachable()), FAKE_VISION_SKIP_MESSAGE);
    await withAdmin(browser, baseURL, async (admin) => {
      await configureFakeVisionProvider(admin);
      await setFakeVisionFileInput(admin, true);
    });
  });

  test.afterAll(async ({ browser, baseURL }) => {
    if (!(await isFakeVisionReachable())) return;
    await withAdmin(browser, baseURL, (admin) => setFakeVisionFileInput(admin, false));
  });

  test.beforeEach(async () => {
    await resetFake();
  });

  test('a PDF uploads as a PDF tile, is read as one file part, and saves its readings', async ({ page }) => {
    const dialog = await openPhotoRead(page, 'photo-pdf');
    await expect(dialog.getByLabel('Add photos or PDFs')).toHaveAttribute('accept', 'image/*,application/pdf');
    await expect(dialog.getByLabel('Take photo')).toHaveAttribute('accept', 'image/*');

    await dialog.getByLabel('Add photos or PDFs').setInputFiles(REPORT);
    const tile = dialog.getByTestId('intake-photo-tile');
    await expect(tile).toHaveAttribute('data-kind', 'pdf');
    await expect(tile.getByRole('img', { name: `${REPORT.name} (PDF)` })).toBeVisible();
    await expect(dialog.getByTestId('image-intake-progress')).toContainText('1 of 1 ready', { timeout: 60_000 });

    await setFakeFixture('body-metric-smart-scale-report');
    await dialog.getByRole('button', { name: 'Read', exact: true }).click();
    const review = dialog.getByTestId('ai-draft-review');
    await expect(review).toBeVisible({ timeout: 90_000 });
    await expect(review.getByTestId('draft-item-row')).toHaveCount(2);

    const requests = await fakeRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ fileCount: 1, imageCount: 0, hasResponseFormat: true });

    await review.getByRole('button', { name: 'Accept all (2)' }).click();
    await dialog.getByRole('button', { name: 'Save to Health', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.locator('main').getByRole('region', { name: 'Weight' })).toContainText('82.3 kg');
  });

  test('a renamed file is refused as not a real PDF and never reaches the model', async ({ page }) => {
    const dialog = await openPhotoRead(page, 'photo-pdf-renamed');
    await dialog.getByLabel('Add photos or PDFs').setInputFiles({
      name: 'not-really.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('These are notes, not a PDF.\n'),
    });
    const tile = dialog.getByTestId('intake-photo-tile');
    await expect(tile).toHaveAttribute('data-stage', 'error', { timeout: 60_000 });
    await expect(tile).toContainText("This file isn't a real PDF.");
    await expect(dialog.getByRole('button', { name: 'Read', exact: true })).toBeDisabled();
    expect(await fakeRequests()).toEqual([]);
  });

  test('a model without file input is refused in words before any provider call', async ({ browser, baseURL, page }) => {
    await withAdmin(browser, baseURL, (admin) => setFakeVisionFileInput(admin, false));
    try {
      const dialog = await openPhotoRead(page, 'photo-pdf-no-file-input');
      await dialog.getByLabel('Add photos or PDFs').setInputFiles(REPORT);
      await expect(dialog.getByTestId('image-intake-progress')).toContainText('1 of 1 ready', { timeout: 60_000 });
      await dialog.getByRole('button', { name: 'Read', exact: true }).click();

      const failure = dialog.getByTestId('photo-read-failure');
      await expect(failure).toContainText(PDF_REFUSAL);
      await expect(failure.getByRole('button', { name: 'Enter manually' })).toBeVisible();
      expect(await fakeRequests()).toEqual([]);
    } finally {
      await withAdmin(browser, baseURL, (admin) => setFakeVisionFileInput(admin, true));
    }
  });
});

