import { test, expect } from '@playwright/test';
import { signIn } from '../helpers/api.helper';

/**
 * Health export — issue #191 (H7): a viewer asks for a JSON export of their
 * health data on the Health page, watches it finish, and downloads it.
 *
 * Against the running stack, like every spec here: the real API, the
 * `health.export` job on the real queue and the real object storage. Each run
 * signs in as a FRESH viewer (Viewers hold `health_data:read`), seeds one
 * weight through the API so the file has a row to carry, and owns its exports,
 * so the three-in-flight limit never trips over a previous run.
 *
 * The Download button opens a fresh signed URL in a new browsing context
 * (`window.open`, `noopener`). Rather than chase that context, the test reads
 * the URL off the `GET /api/health/exports/:id` the click makes and fetches it
 * with the page's request context, then parses the file: a JSON export is
 * `{ schemaVersion: 1, ... }` (`healthExportJsonFileSchema`).
 *
 * Needs object storage configured in the running stack (the export is stored
 * there, like any upload).
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };
const EXPORT_STATUS_PATH = /\/api\/health\/exports\/[0-9a-f-]{36}$/;

interface HealthExportBody {
  data: { id: string; status: string; download: { url: string; expiresAt: string } | null };
}

interface HealthExportJsonFile {
  schemaVersion: number;
  exportedAt: string;
  range: { from: string; to: string };
  includeHistory: boolean;
  profile: unknown;
  datasets: Record<string, Array<Record<string, unknown>>>;
}

test.describe('Health export', () => {
  test('requests a JSON export, waits for it, and downloads a file that parses', async ({ page }) => {
    const { api } = await signIn(page, 'viewer', 'viewer-health-export');
    await api.post('/api/measurements', { readings: [{ metricKey: 'weight', value: 80.4, unit: 'kg' }] });

    await page.setViewportSize(DESKTOP);
    await page.goto('/health');
    const main = page.locator('main');
    await expect(main.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();

    await main.getByRole('button', { name: 'Export health data' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export health data' });
    await expect(dialog.getByText(/No exports yet/)).toBeVisible();

    await dialog.getByRole('radio', { name: /^JSON/ }).check();
    await dialog.getByRole('radio', { name: 'Last 3 months' }).check();
    await dialog.getByRole('button', { name: 'Create export' }).click();

    const status = dialog.getByRole('status');
    await expect(status).toContainText('Preparing your export');
    await expect(status).toHaveText('Your export is ready to download.', { timeout: 60_000 });

    const item = dialog.getByRole('listitem', { name: /^JSON, .* Ready$/ });
    await expect(item).toBeVisible();

    // The click asks the API for a fresh URL; polling has stopped at ready.
    const statusResponse = page.waitForResponse(
      (response) => EXPORT_STATUS_PATH.test(new URL(response.url()).pathname) && response.request().method() === 'GET',
    );
    await item.getByRole('button', { name: /^Download JSON/ }).click();
    const body = (await (await statusResponse).json()) as HealthExportBody;
    expect(body.data.status).toBe('ready');
    expect(body.data.download?.url).toBeTruthy();

    const file = await page.request.get(body.data.download!.url);
    expect(file.ok()).toBe(true);
    expect(file.headers()['content-disposition']).toMatch(/attachment; filename="[a-z0-9-]+\.json"/);
    const parsed = JSON.parse(await file.text()) as HealthExportJsonFile;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.includeHistory).toBe(false);
    expect(parsed.datasets.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ weight_kg: 80.4 })]),
    );

    // Closing and reopening keeps the export in the recent list.
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await main.getByRole('button', { name: 'Export health data' }).click();
    await expect(page.getByRole('dialog', { name: 'Export health data' }).getByRole('listitem', { name: /^JSON, .* Ready$/ })).toBeVisible();
  });

  test('on a phone the dialog is full-screen and Create export is reachable', async ({ page }) => {
    await signIn(page, 'viewer', 'viewer-health-export-phone');
    await page.setViewportSize(PHONE);
    await page.goto('/health');

    await page.locator('main').getByRole('button', { name: 'Export health data' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export health data' });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box?.width).toBe(PHONE.width);
    await expect(dialog.getByRole('button', { name: 'Create export' })).toBeInViewport();
  });
});
