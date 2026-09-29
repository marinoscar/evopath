import { test, expect } from '../fixtures/auth.fixture';

test.describe('Admin functionality', () => {
  test('admin can access user management', async ({ adminPage }) => {
    await adminPage.goto('/admin/users');

    // /admin/users redirects to the Users settings page
    await expect(adminPage).toHaveURL('/admin/settings/users');
    await expect(adminPage.locator('h1, h2, h3, h4, h5, h6').first()).toBeVisible();
  });

  test('admin can access system settings', async ({ adminPage }) => {
    await adminPage.goto('/admin/settings');

    // Verify we're on the settings page
    await expect(adminPage).toHaveURL('/admin/settings');
  });
});

test.describe('Role-based access', () => {
  test('viewer cannot access admin users page', async ({ viewerPage }) => {
    await viewerPage.goto('/admin/users');

    // /admin/users -> /admin/settings/users -> RequirePermission fallback to the Today page
    await expect(viewerPage).toHaveURL('/');
  });

  test('contributor can access regular pages', async ({ contributorPage }) => {
    await contributorPage.goto('/settings');

    // Should be able to access user settings
    await expect(contributorPage).toHaveURL('/settings');
  });
});

test.describe('Today page', () => {
  test('shows the heading and the four cards for an authenticated user', async ({ viewerPage }) => {
    await viewerPage.goto('/');

    await expect(viewerPage.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    for (const name of ["Today's workout", 'Readiness', 'Body snapshot', 'Your gym']) {
      await expect(viewerPage.getByRole('region', { name })).toBeVisible();
    }
  });
});
