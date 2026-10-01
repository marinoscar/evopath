import { expect, test, type Page } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { BIOMARKERS_FIXED_NOW, mockBiomarkersApi } from '../support/biomarkers';

/**
 * The biomarker pages, H5 (#189).
 *
 *   - desktop 1440x900, dark: `/health/biomarkers`, four panels of cards with
 *     flags, previous values and changes (up, down, no change, first result);
 *   - phone 390x844, light: the same list, one column, no horizontal scroll;
 *   - desktop 1440x900, dark: `/health/biomarkers/ldl_cholesterol`, the trend
 *     with a reference band that changes between labs (and a gap for a result
 *     without a range) above the results table;
 *   - phone 390x844, light: the detail page with the results as cards.
 *
 * Data comes from `support/biomarkers.ts` through `page.route()`; the clock,
 * time zone and locale are pinned, and reduced motion skips the chart's entry
 * animation.
 */

test.use({ timezoneId: 'UTC', locale: 'en-US', reducedMotion: 'reduce' });

async function open(page: Page, route: string, theme?: 'light' | 'dark') {
  await page.clock.setFixedTime(BIOMARKERS_FIXED_NOW);
  await mockBiomarkersApi(page);
  await page.goto(harnessUrl({ route, ...(theme ? { theme } : {}) }));
  await waitForInter(page);
}

async function openList(page: Page, theme?: 'light' | 'dark') {
  await open(page, '/health/biomarkers', theme);
  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Biomarkers' })).toBeVisible();
  await expect(main.getByTestId('biomarkers-skeleton')).toHaveCount(0);
  await expect(main.getByTestId('biomarker-card')).toHaveCount(8);
  await expect(main.getByRole('article', { name: 'LDL cholesterol' })).toContainText('142 mg/dL');
}

async function openDetail(page: Page, theme?: 'light' | 'dark') {
  await open(page, '/health/biomarkers/ldl_cholesterol', theme);
  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1, name: 'LDL cholesterol' })).toBeVisible();
  await expect(main.getByRole('img', { name: /^LDL cholesterol, 4 results, latest 142 mg\/dL/ })).toBeVisible();
  await expect(main.getByTestId('reference-band-step')).toHaveCount(3);
  await expect(main.getByTestId('biomarker-result')).toHaveCount(4);
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

test.describe('Biomarkers', () => {
  test('list, desktop @ 1440x900, dark', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openList(page);
    await expect(page).toHaveScreenshot('biomarkers-1440x900-dark-page.png', { fullPage: true });
  });

  test('list, phone @ 390x844, light', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openList(page, 'light');
    await noHorizontalScroll(page);
    await expect(page).toHaveScreenshot('biomarkers-390x844-light.png');
  });

  test('detail, desktop @ 1440x900, dark', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDetail(page);
    await expect(page.locator('main').getByRole('table', { name: 'LDL cholesterol results' })).toBeVisible();
    await expect(page).toHaveScreenshot('biomarker-detail-1440x900-dark-page.png', { fullPage: true });
  });

  test('detail, phone @ 390x844, light, results as cards', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDetail(page, 'light');
    await expect(page.locator('main').getByRole('list', { name: 'LDL cholesterol results' })).toBeVisible();
    await noHorizontalScroll(page);
    await expect(page).toHaveScreenshot('biomarker-detail-390x844-light-page.png', { fullPage: true });
  });
});
