import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { signIn, type AuthedApi } from '../helpers/api.helper';
import {
  FAKE_VISION_SKIP_MESSAGE,
  configureFakeVisionProvider,
  fakeRequests,
  isFakeVisionReachable,
  resetFake,
  setFakeVisionFileInput,
} from '../helpers/ai.helper';
import { setUnits } from '../helpers/profile.helper';

/**
 * Import a lab report, H4 (#188), end to end with the fake vision provider
 * (`infra/compose/fake-ai.compose.yml`): the API really stores the PDF, runs
 * `ai.health.lab_report` and matches and converts each result; the fake
 * answers every `lab_report` request with `lab-report-panel`
 * (`apps/api/test/fixtures/lab-report/lipid-glucose-panel.model-output.json`):
 * collected 2026-09-15, four lipids, an unmatched "Lipoprotein (a)", glucose
 * 5.4 mmol/L (drafted as 97.2973 mg/dL) and HbA1c.
 *
 * The fake's queue and request log are global, like `health-photo-read.spec.ts`
 * and `gym-scan.spec.ts`: run these files with `--workers=1`. Skipped with a
 * message when the fake is not reachable; object storage must be configured.
 * `fake-vision` gets `file_input` for this file and loses it again after.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };
const TITLE = 'Import lab report';

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
const REPORT = { name: 'lipid-glucose-panel.pdf', mimeType: 'application/pdf', buffer: ONE_PAGE_PDF };

async function withAdmin(browser: Browser, baseURL: string | undefined, run: (admin: AuthedApi) => Promise<void>) {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    const { api } = await signIn(page, 'admin', 'lab-report-admin');
    await run(api);
  } finally {
    await context.close();
  }
}

/** Open "Import lab report" on /health, add the PDF and Read; resolves with the review. */
async function importReport(page: Page) {
  await page.locator('main').getByRole('button', { name: TITLE }).click();
  const dialog = page.getByRole('dialog', { name: TITLE });
  await expect(dialog.getByRole('button', { name: 'Add photos or PDFs' })).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole('checkbox', { name: /Keep this file in .* after processing/ })).toBeChecked();

  await dialog.getByLabel('Add photos or PDFs').setInputFiles(REPORT);
  await expect(dialog.getByTestId('intake-photo-tile')).toHaveAttribute('data-kind', 'pdf');
  await expect(dialog.getByTestId('image-intake-progress')).toContainText('1 of 1 ready', { timeout: 60_000 });
  await dialog.getByRole('button', { name: 'Read', exact: true }).click();

  const review = dialog.getByTestId('lab-report-review');
  await expect(review).toBeVisible({ timeout: 90_000 });
  return { dialog, review };
}

/** Reject the unmatched row, accept the rest; Save to Health is then enabled. */
async function resolveAndAccept(dialog: Locator) {
  const lpa = dialog.locator('[data-testid="lab-result-row"][data-unresolved="true"]');
  await expect(lpa).toHaveCount(1);
  await lpa.getByRole('button', { name: 'Reject' }).click();
  await expect(dialog.locator('[data-testid="lab-result-row"][data-unresolved="true"]')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Accept all (6)' }).click();
  await expect(dialog.getByRole('button', { name: 'Save to Health', exact: true })).toBeEnabled();
}

test.describe('Health: import a lab report with the fake vision provider', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

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

  test('a PDF is read into a review by panel; the unmatched row blocks saving; a re-import warns about duplicates', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'lab-report');
    await setUnits(api, 'metric');
    await page.setViewportSize(DESKTOP);
    await page.goto('/health');

    const { dialog, review } = await importReport(page);
    const requests = await fakeRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ fileCount: 1, imageCount: 0, hasResponseFormat: true });

    // Seven results, grouped by panel; the report's own details are filled in.
    await expect(review.getByTestId('lab-result-row')).toHaveCount(7);
    await expect(review.getByTestId('lab-panel')).toHaveCount(2);
    await expect(review.getByRole('heading', { name: 'Lipids (5)' })).toBeVisible();
    await expect(review.getByRole('heading', { name: 'Glycemic (2)' })).toBeVisible();
    await expect(dialog.getByLabel('Collection date')).toHaveValue('2026-09-15');
    await expect(dialog.getByRole('textbox', { name: 'Laboratory' })).toHaveValue('Acme Clinical Laboratories');

    // Glucose was converted to the canonical unit; the printed value is kept.
    const glucose = review.getByTestId('lab-result-row').filter({ hasText: 'Saved as Fasting glucose' });
    await expect(glucose).toContainText('97.2973 mg/dL');
    await expect(glucose.getByTestId('lab-result-original')).toContainText('Printed 5.4 mmol/L');

    // The unmatched row is highlighted and blocks saving until it is resolved.
    const lpa = review.getByTestId('lab-result-row').filter({ hasText: 'Lipoprotein (a)' });
    await expect(lpa).toHaveAttribute('data-attention', 'true');
    await expect(lpa).toHaveAttribute('data-unresolved', 'true');
    await expect(dialog.getByTestId('lab-report-save-hint')).toContainText('not in the lab catalog');

    await resolveAndAccept(dialog);
    await dialog.getByRole('button', { name: 'Save to Health', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText('Saved 6 lab results to Health')).toBeVisible();

    // The same report again: the duplicate warning, and an explicit Save anyway.
    await resetFake();
    const again = await importReport(page);
    const warning = again.dialog.getByTestId('lab-report-duplicates');
    await expect(warning).toBeVisible({ timeout: 30_000 });
    await expect(warning).toContainText('Total cholesterol');
    await resolveAndAccept(again.dialog);
    await again.dialog.getByRole('button', { name: 'Save to Health', exact: true }).click();
    await expect(again.dialog).toBeVisible();
    await warning.getByRole('button', { name: 'Save anyway' }).click();
    await expect(again.dialog).toBeHidden({ timeout: 30_000 });
  });

  test('on a phone the dialog is full screen with no horizontal scroll', async ({ page }) => {
    await signIn(page, 'contributor', 'lab-report-phone');
    await page.setViewportSize(PHONE);
    await page.goto('/health');

    await page.locator('main').getByRole('button', { name: TITLE }).click();
    const dialog = page.getByRole('dialog', { name: TITLE });
    await expect(dialog.getByRole('button', { name: 'Add photos or PDFs' })).toBeVisible({ timeout: 30_000 });
    expect((await dialog.boundingBox())?.width).toBe(PHONE.width);
    await expect(dialog.getByRole('button', { name: 'Read', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await dialog.getByRole('button', { name: 'Discard' }).click();
    await expect(dialog).toBeHidden();
  });
});
