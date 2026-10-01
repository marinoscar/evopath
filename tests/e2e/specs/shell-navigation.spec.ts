import { test, expect } from '../fixtures/auth.fixture';
import { E2E_AI_DISABLED } from '../helpers/ai.helper';
import { assertFakeCoachReachable, setupFakeCoachAi, teardownFakeCoachAi, withAdmin, type FakeCoachSnapshot } from '../helpers/coach.helper';

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

test.describe('Desktop rail', () => {
  test('lists the product destinations, Settings and Console', async ({ adminPage }) => {
    await adminPage.setViewportSize(DESKTOP);
    await adminPage.goto('/');

    const rail = adminPage.getByRole('navigation', { name: 'Main navigation' });
    for (const name of ['Today', 'Train', 'Health', 'Gyms', 'User Settings', 'Console']) {
      await expect(rail.getByRole('link', { name })).toBeVisible();
    }
    await expect(rail.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
  });

  for (const [name, path] of [
    ['Train', '/train'],
    ['Health', '/health'],
    ['Gyms', '/gyms'],
  ] as const) {
    test(`${name} navigates to ${path} and becomes current`, async ({ adminPage }) => {
      await adminPage.setViewportSize(DESKTOP);
      await adminPage.goto('/');

      const rail = adminPage.getByRole('navigation', { name: 'Main navigation' });
      await rail.getByRole('link', { name }).click();

      await expect(adminPage).toHaveURL(path);
      await expect(adminPage.getByRole('heading', { level: 1, name })).toBeVisible();
      await expect(rail.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    });
  }
});

test.describe('Phone bottom bar', () => {
  test('has no rail and exactly the four primary destinations', async ({ adminPage }) => {
    await adminPage.setViewportSize(PHONE);
    await adminPage.goto('/');

    await expect(adminPage.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);

    // The bar items are buttons (the rail's are links), so exactly four buttons carry these names.
    const tabs = adminPage.getByRole('button', { name: /^(Today|Train|Health|Gyms)$/ });
    await expect(tabs).toHaveCount(4);
    for (const name of ['Today', 'Train', 'Health', 'Gyms']) {
      await expect(adminPage.getByRole('button', { name, exact: true })).toBeVisible();
    }
  });

  test('Health navigates to /health', async ({ adminPage }) => {
    await adminPage.setViewportSize(PHONE);
    await adminPage.goto('/');

    await adminPage.getByRole('button', { name: 'Health' }).click();

    await expect(adminPage).toHaveURL('/health');
    await expect(adminPage.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
  });
});

test.describe('Phone user menu', () => {
  test('admin reaches User Settings, Console and Logout; Console opens the admin hub', async ({
    adminPage,
  }) => {
    await adminPage.setViewportSize(PHONE);
    await adminPage.goto('/');

    await adminPage.locator('button[aria-haspopup="true"]').click();
    const menu = adminPage.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'User Settings' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Console' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Logout' })).toBeVisible();

    await menu.getByRole('menuitem', { name: 'Console' }).click();
    await expect(adminPage).toHaveURL('/admin/settings');
  });

  test('viewer has User Settings and Logout but no Console', async ({ viewerPage }) => {
    await viewerPage.setViewportSize(PHONE);
    await viewerPage.goto('/');

    await viewerPage.locator('button[aria-haspopup="true"]').click();
    const menu = viewerPage.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'User Settings' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Logout' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Console' })).toHaveCount(0);
  });
});

// =============================================================================
// AI on (E7.8, E7.13): Coach takes the fourth primary slot, Gyms stays reachable
// =============================================================================
//
// The tests above assume AI is OFF (Gyms holds the fourth slot). Whether AI is
// on is deployment-wide state, so this block turns it on against the fake AI
// server (`fake-ai.compose.yml`) and puts it back; run it on its own, beside no
// other AI spec:
//
//   cd tests/e2e && npm test -- shell-navigation --workers=1
//
// `E2E_AI=0` skips it.

test.describe('AI on', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(E2E_AI_DISABLED, 'E2E_AI=0');

  let snapshot: FakeCoachSnapshot;

  test.beforeAll(async ({ browser }, testInfo) => {
    await assertFakeCoachReachable();
    snapshot = await withAdmin(browser, testInfo.project.use.baseURL, setupFakeCoachAi);
  });

  test.afterAll(async ({ browser }, testInfo) => {
    await withAdmin(browser, testInfo.project.use.baseURL, (admin) => teardownFakeCoachAi(admin, snapshot));
  });

  test('Coach is the fourth bottom tab on a phone; Gyms is not a tab', async ({ adminPage }) => {
    await adminPage.setViewportSize(PHONE);
    await adminPage.goto('/');

    await expect(adminPage.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
    const tabs = adminPage.getByRole('button', { name: /^(Today|Train|Health|Coach|Gyms)$/ });
    await expect(tabs).toHaveCount(4);
    for (const name of ['Today', 'Train', 'Health', 'Coach']) {
      await expect(adminPage.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await expect(adminPage.getByRole('button', { name: 'Gyms', exact: true })).toHaveCount(0);

    await adminPage.getByRole('button', { name: 'Coach', exact: true }).click();
    await expect(adminPage).toHaveURL('/coach');
  });

  test('Gyms moves to the phone user menu', async ({ adminPage }) => {
    await adminPage.setViewportSize(PHONE);
    await adminPage.goto('/');

    await adminPage.locator('button[aria-haspopup="true"]').click();
    await adminPage.getByRole('menu').getByRole('menuitem', { name: 'Gyms' }).click();
    await expect(adminPage).toHaveURL('/gyms');
  });

  test('the desktop rail lists both Coach and Gyms', async ({ adminPage }) => {
    await adminPage.setViewportSize(DESKTOP);
    await adminPage.goto('/');

    const rail = adminPage.getByRole('navigation', { name: 'Main navigation' });
    for (const name of ['Today', 'Train', 'Health', 'Coach', 'Gyms', 'User Settings', 'Console']) {
      await expect(rail.getByRole('link', { name })).toBeVisible();
    }
    await rail.getByRole('link', { name: 'Coach' }).click();
    await expect(adminPage).toHaveURL('/coach');
    await expect(rail.getByRole('link', { name: 'Coach' })).toHaveAttribute('aria-current', 'page');
  });
});
