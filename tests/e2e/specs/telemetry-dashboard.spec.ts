import { test, expect } from '../fixtures/auth.fixture';
import type { Page } from '@playwright/test';

/**
 * Telemetry Dashboard drill-down — issue #579, epic #576.
 *
 * Against the running stack, like every spec here. It needs telemetry to be
 * deployed AND switched on (`telemetry.compose.yml`, then Console → Telemetry
 * → collection on): otherwise the dashboard route redirects home and each test
 * skips with that reason rather than failing. The stack's own API traffic —
 * including this spec's logins and page loads — is what fills the dashboard,
 * so the steps that need data (a timeline bar, a second service) skip when a
 * fresh store has none yet.
 *
 * The assistant step additionally needs AI configured and the Telemetry
 * assistant switched on; it skips when "Ask assistant" is not offered.
 */

const DASHBOARD = '/admin/settings/telemetry/dashboard';
const EXPLORER = '/admin/settings/telemetry/explorer';

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 820, height: 1180 };
const DESKTOP = { width: 1440, height: 900 };

/** Open the dashboard, or skip the test when telemetry is not on in this stack. */
async function openDashboard(page: Page, search = ''): Promise<void> {
  await page.goto(`${DASHBOARD}${search}`);
  // The app may hold a transient redirect at start (auth refresh) before
  // settling on the dashboard, so wait for the heading itself rather than
  // just "left the dashboard path" — that momentary state resolves too. Only
  // when the heading never shows up AND we're not on the dashboard path do we
  // treat this as the feature gate redirecting home. (Not `networkidle`: the
  // shell may hold a server-sent-events connection open.)
  const heading = page.getByRole('heading', { level: 1, name: 'Telemetry Dashboard' });
  await heading.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  test.skip(
    !page.url().includes(DASHBOARD),
    'Telemetry is not deployed and switched on in this stack (the dashboard route redirected).',
  );
  await expect(heading).toBeVisible();
  await expect(page.getByTestId('verdict-banner')).toBeVisible({ timeout: 15_000 });
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

/** Every telemetry query POST from here on — the explorer must not run a handed statement. */
function recordQueryRuns(page: Page): string[] {
  const runs: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/admin/telemetry/query')) runs.push(request.url());
  });
  return runs;
}

test.describe('Telemetry Dashboard on a phone', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('opens from the Console and shows the verdict', async ({ adminPage: page }) => {
    await page.goto('/admin/settings');
    // At this (compact, `down('sm')`) width, SettingsHub renders cards as a
    // `List` of `ListItemButton`s (role "button"), not the `Card`/
    // `CardActionArea` grid it uses from `sm` up — so the accessible role
    // here is "button", not "link".
    const card = page.getByRole('button', { name: /Telemetry Dashboard/ }).first();
    // The hub renders after permissions/features load, so give the card a
    // real chance to appear before deciding it's genuinely absent.
    await card.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    test.skip(!(await card.isVisible().catch(() => false)), 'The Telemetry Dashboard card is hidden: telemetry is off.');
    await card.click();
    await expect(page).toHaveURL(new RegExp(`${DASHBOARD}`));
    await expect(page.getByTestId('verdict-banner')).toBeVisible({ timeout: 15_000 });
  });

  test('tapping a timeline bar zooms into it', async ({ adminPage: page }) => {
    await openDashboard(page);
    const panel = page.getByTestId('panel-api');
    // Let the panel finish its own fetch before judging whether it drew any
    // bars — checking `count()` right after the heading appears can catch it
    // mid-load and mistake "not fetched yet" for "no data".
    await panel.getByTestId('panel-api-skeleton').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    const brush = panel.getByTestId('zoom-brush');
    test.skip((await brush.count()) === 0, 'No API requests in the last hour to draw bars for.');

    await brush.tap();
    await expect(page).toHaveURL(/[?&]from=/);
    await expect(page).toHaveURL(/[?&]to=/);
    await expect(page.getByRole('button', { name: 'Reset zoom' })).toBeVisible();
  });

  test('Filters → service → Apply puts the service in the URL', async ({ adminPage: page }) => {
    await openDashboard(page);
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Filters' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('combobox', { name: 'Service' }).click();
    const services = page.getByRole('option').filter({ hasNotText: 'All services' });
    test.skip((await services.count()) === 0, 'No service has reported telemetry yet.');
    const service = (await services.first().textContent())?.trim() ?? '';
    await services.first().click();
    await dialog.getByRole('button', { name: 'Apply' }).click();

    await expect.poll(() => new URL(page.url()).searchParams.get('service')).toBe(service);
  });

  test('Top problems ⋮ → Open in Explorer loads the SQL without running it', async ({ adminPage: page }) => {
    await openDashboard(page);
    const panel = page.getByTestId('panel-top');
    await panel.getByRole('button', { name: 'Top problems actions' }).click();
    const item = page.getByRole('menuitem', { name: 'Open in Explorer' });
    await expect(item).toBeEnabled({ timeout: 15_000 });

    const runs = recordQueryRuns(page);
    await item.click();
    await expect(page).toHaveURL(new RegExp(`${EXPLORER}$`));
    await expect(page.getByTestId('handoff-notice')).toContainText('Query loaded from the Telemetry Dashboard');
    await expect(page.locator('.cm-content')).toContainText(/SELECT/i);

    await page.waitForTimeout(1000);
    expect(runs).toHaveLength(0);
    await expect(page.getByTestId('query-status')).toHaveCount(0);
  });
});

test.describe('Telemetry Dashboard on a desktop', () => {
  test.use({ viewport: DESKTOP });

  test('Ask assistant opens the docked drawer with the question prefilled', async ({ adminPage: page }) => {
    await openDashboard(page);
    const ask = page.getByTestId('panel-api').getByRole('button', { name: 'Ask assistant' });
    test.skip(
      (await ask.count()) === 0,
      'The telemetry assistant is not available (AI off, no ai:use, or the assistant is switched off).',
    );
    await expect(ask).toBeEnabled({ timeout: 15_000 });
    await ask.click();

    const drawer = page.getByLabel('Telemetry assistant');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('textbox', { name: 'Ask the assistant' })).toHaveValue(
      /^Investigate "API requests" for the last hour/,
    );
    // Docked, not modal: the page stays usable beside it.
    await expect(page.getByRole('heading', { level: 1, name: 'Telemetry Dashboard' })).toBeVisible();
  });

  test('cross-links: Dashboard → Explorer → Dashboard', async ({ adminPage: page }) => {
    await openDashboard(page);
    await page.getByRole('link', { name: 'Explorer', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${EXPLORER}$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Telemetry Explorer' })).toBeVisible();
    await expect(page.getByTestId('handoff-notice')).toHaveCount(0);

    await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${DASHBOARD}$`));
    await expect(page.getByTestId('verdict-banner')).toBeVisible({ timeout: 15_000 });
  });

  test('the Telemetry settings page links to the dashboard', async ({ adminPage: page }) => {
    await openDashboard(page);
    await page.goto('/admin/settings/telemetry');
    await page.getByRole('link', { name: 'Open dashboard' }).click();
    await expect(page).toHaveURL(new RegExp(`${DASHBOARD}$`));
  });
});

for (const [name, viewport] of Object.entries({ phone: PHONE, tablet: TABLET, desktop: DESKTOP })) {
  test.describe(`Telemetry Dashboard at ${name} width`, () => {
    test.use({ viewport });

    test('never scrolls horizontally', async ({ adminPage: page }) => {
      await openDashboard(page);
      // Let the panels fill in: the widest content (tables, charts) arrives with data.
      await expect(page.locator('[data-testid$="-skeleton"]')).toHaveCount(0, { timeout: 15_000 });
      await expectNoHorizontalScroll(page);
    });
  });
}
