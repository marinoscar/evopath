import { expect, test, type Page } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { FIXED_NOW, mockHealthApi, type HealthScenario } from '../support/health';

/**
 * The Health page — issue #53 (E2.3): the latest-value tiles; issue #56
 * (E2.4): the Daily check-in section and its dialog.
 *
 * Three treatments, the first two as `today-page.spec.ts`:
 *   - desktop 1440x900, dark (the harness default): the whole page, with
 *     every tile filled (imperial user, so pounds and inches), a method chip,
 *     neutral deltas, "no change", the 128/84 pair and the calculated BMI;
 *     plus today's check-in (four chips and a note), the recent list, and
 *     the Trend and History sections. A `fullPage` capture, as the other
 *     tall pages (`telemetry-dashboard.spec.ts`, `admin-hub.spec.ts`): the
 *     window is the scroller and the AppBar is sticky, so a screenshot of a
 *     `main` taller than the viewport scrolls and gets the bar painted over
 *     its top;
 *   - phone 390x844, light: the whole page with nothing logged yet, so the
 *     one-column empty tiles and the bottom bar are in frame;
 *   - phone 375x812, light: the check-in dialog, full-screen, prefilled from
 *     today's check-in: five buttons per score on one line, Save in view.
 *
 * Issue #60 (E2.5) adds the Trend section on its own, in the same two
 * treatments, with twelve weights over four weeks from two methods ("Scale",
 * "Smart scale": two series, two legend entries and the mixed-methods note)
 * and one edited entry. Reduced motion is emulated so the chart skips its
 * entry animation (`skipAnimation`) and renders its final frame at once.
 *
 * Data comes from `support/health.ts` through `page.route()`, and the clock,
 * time zone and locale are pinned so "Today" / "3 days ago" never move.
 */

test.use({ timezoneId: 'UTC', locale: 'en-US', reducedMotion: 'reduce' });

async function openHealth(page: Page, scenario: HealthScenario, options: { theme?: 'light' | 'dark' } = {}) {
  await page.clock.setFixedTime(FIXED_NOW);
  await mockHealthApi(page, scenario);
  await page.goto(harnessUrl({ route: '/health', ...options }));
  await waitForInter(page);

  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
  await expect(page.getByTestId('latest-measurements-skeleton')).toHaveCount(0);
  await expect(main.getByRole('region', { name: 'Weight' })).toBeVisible();
  if (scenario === 'data') {
    await expect(main.getByRole('region', { name: 'Weight' })).toContainText('208.4 lb');
    await expect(main.getByRole('region', { name: 'BMI' })).toBeVisible();
    await expect(main.getByRole('img', { name: /^Weight, last 90 days, 12 readings, latest 208\.4 lb/ })).toBeVisible();
    await expect(main.getByTestId('history-entry').first()).toContainText('208.4 lb');
  } else {
    await expect(main.getByText('No data yet')).toHaveCount(5);
    await expect(main.getByText('No weight readings in the last 90 days')).toBeVisible();
  }
  const checkIn = main.getByRole('region', { name: 'Daily check-in' });
  if (scenario === 'data') {
    await expect(checkIn.getByRole('list', { name: 'Scores' })).toContainText('Energy 4');
    await expect(checkIn.getByRole('list', { name: 'Recent check-ins' }).getByRole('listitem')).toHaveCount(4);
  } else {
    await expect(checkIn.getByText('Not done today')).toBeVisible();
  }
  await expect(page.getByTestId('measurement-trend-skeleton')).toHaveCount(0);
  await expect(page.getByTestId('measurement-history-skeleton')).toHaveCount(0);
}

/** The Trend section with its chart drawn: the two legend entries and the note. */
async function trendSection(page: Page) {
  const trend = page.locator('main').getByRole('region', { name: 'Trend' });
  await expect(trend.getByText('This range mixes measurement methods (Scale, Smart scale).', { exact: false })).toBeVisible();
  await expect(trend.getByText('Smart scale', { exact: true }).first()).toBeVisible();
  return trend;
}

test.describe('Health page', () => {
  test('desktop @ 1440x900, dark, with data', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHealth(page, 'data');

    await expect(page).toHaveScreenshot('health-page-1440x900-dark-page.png', { fullPage: true });
  });

  test('phone @ 390x844, light, empty, with the bottom bar', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHealth(page, 'empty', { theme: 'light' });

    await expect(page).toHaveScreenshot('health-page-390x844-light-page.png');
  });

  test('phone @ 375x812, light, the check-in dialog full-screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openHealth(page, 'data', { theme: 'light' });

    await page.getByRole('button', { name: 'Edit check-in' }).click();
    const dialog = page.getByRole('dialog', { name: 'Daily check-in' });
    await expect(dialog.getByRole('group', { name: /^Energy/ }).getByRole('button', { name: '4' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect((await dialog.boundingBox())?.width).toBe(375);
    // Each score row is one line of five buttons.
    for (const name of [/^Energy/, /^Sleep quality/, /^Muscle soreness/, /^Stress/]) {
      const tops = await dialog
        .getByRole('group', { name })
        .getByRole('button')
        .evaluateAll((buttons) => buttons.map((b) => Math.round(b.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeInViewport();

    await expect(page).toHaveScreenshot('health-page-375x812-light-check-in-dialog.png');
  });

  test('Trend section, desktop @ 1440x900, dark, two methods', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHealth(page, 'data');

    const trend = await trendSection(page);
    await expect(trend).toHaveScreenshot('health-trend-1440x900-dark.png');
  });

  test('Trend section, phone @ 390x844, light, two methods', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHealth(page, 'data', { theme: 'light' });

    const trend = await trendSection(page);
    // The chart fits the phone: no horizontal page scroll.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(trend).toHaveScreenshot('health-trend-390x844-light.png');
  });
});
