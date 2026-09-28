import { expect, test, type Page } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { FIXED_NOW, mockTelemetryDashboard, type DashboardScenario } from '../support/telemetryDashboard';

/**
 * The Telemetry Dashboard — issue #579 (the page itself: #578), epic #576.
 *
 * The dashboard's responsive layout is decided in the page (phone < 600,
 * tablet 600–1199, desktop ≥ 1200), with charts, tables and card lists that
 * jsdom cannot lay out at all — so its pixels are pinned here:
 *
 *   - two data states: a CRITICAL verdict with data in every panel, and
 *     NO_DATA (nothing received: empty timelines, tables and feed);
 *   - at the three sizes the page is designed for (390×844, 820×1180,
 *     1440×900), in the light AND dark themes;
 *   - plus the overlays only phones and tablets have: the phone Filters
 *     dialog, the phone full-screen assistant dialog, and the tablet overlay
 *     assistant drawer (the prefilled question is part of the picture).
 *
 * Data comes from `support/telemetryDashboard.ts` through `page.route()`, and
 * `Date.now()` is pinned to its `FIXED_NOW` (`page.clock.setFixedTime`, timers
 * keep running), so relative times, bars and axis ticks never move. The time
 * zone and locale are pinned too — axis ticks and table times are formatted
 * in local time. `?refresh=off` keeps auto-refresh from refetching mid-shot.
 */

test.use({ timezoneId: 'UTC', locale: 'en-US' });

/** `telemetry:query` is the route's gate, `ai:use` offers the assistant. No `telemetry:read`: no model caption fetch. */
const PERMS = ['system_settings:read', 'users:read', 'telemetry:query', 'ai:use'];

const SIZES = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

const THEMES = ['light', 'dark'] as const;
const SCENARIOS: DashboardScenario[] = ['critical', 'no_data'];

async function openDashboard(
  page: Page,
  options: { scenario: DashboardScenario; theme: 'light' | 'dark'; width: number; height: number },
): Promise<void> {
  await page.clock.setFixedTime(FIXED_NOW);
  await mockTelemetryDashboard(page, options.scenario);
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.goto(
    harnessUrl({ route: '/admin/settings/telemetry/dashboard?refresh=off', perms: PERMS, theme: options.theme }),
  );
  await waitForInter(page);

  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Telemetry Dashboard' })).toBeVisible();
  await expect(page.getByTestId('verdict-banner')).toHaveAttribute('data-level', options.scenario);
  // Every panel settled: no skeleton, no events spinner.
  await expect(page.locator('[data-testid$="-skeleton"]')).toHaveCount(0);
  await expect(page.getByLabel('Loading events')).toHaveCount(0);
  if (options.scenario === 'critical') {
    await expect(main.getByRole('img', { name: /API requests per bucket/ })).toBeVisible();
    await expect(main.getByTestId(/^panel-top/).first().getByText('/api/jobs').first()).toBeVisible();
    await expect(main.getByText('Database connection refused: connect ECONNREFUSED 10.0.3.14:5432').first()).toBeVisible();
  } else {
    await expect(main.getByText('No requests in this window.').first()).toBeVisible();
  }
}

for (const scenario of SCENARIOS) {
  for (const size of SIZES) {
    for (const theme of THEMES) {
      test(`Telemetry Dashboard: ${scenario} @ ${size.width}x${size.height} ${theme}`, async ({ page }) => {
        await openDashboard(page, { scenario, theme, width: size.width, height: size.height });
        await expect(page).toHaveScreenshot(`telemetry-dashboard-${scenario}-${size.name}-${size.width}x${size.height}-${theme}.png`, {
          fullPage: true,
        });
      });
    }
  }
}

test('Telemetry Dashboard: phone Filters dialog', async ({ page }) => {
  await openDashboard(page, { scenario: 'critical', theme: 'light', width: 390, height: 844 });
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Filters' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Apply' })).toBeVisible();
  await expect(page).toHaveScreenshot('telemetry-dashboard-phone-filters-dialog-light.png');
});

test('Telemetry Dashboard: phone assistant dialog, question prefilled', async ({ page }) => {
  await openDashboard(page, { scenario: 'critical', theme: 'light', width: 390, height: 844 });
  await page.getByTestId('panel-api').getByRole('button', { name: 'API requests actions' }).click();
  await page.getByRole('menuitem', { name: 'Ask assistant' }).click();
  const dialog = page.getByRole('dialog', { name: 'Assistant' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Ask the assistant' })).toHaveValue(/^Investigate "API requests"/);
  await expect(page).toHaveScreenshot('telemetry-dashboard-phone-assistant-dialog-light.png');
});

test('Telemetry Dashboard: tablet overlay assistant drawer', async ({ page }) => {
  await openDashboard(page, { scenario: 'critical', theme: 'light', width: 820, height: 1180 });
  await page.getByTestId('panel-top-errors').getByRole('button', { name: 'Ask assistant' }).click();
  const drawer = page.getByRole('dialog', { name: 'Telemetry assistant' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('textbox', { name: 'Ask the assistant' })).toHaveValue(/^Investigate "Top errors"/);
  await expect(page).toHaveScreenshot('telemetry-dashboard-tablet-assistant-drawer-light.png');
});
