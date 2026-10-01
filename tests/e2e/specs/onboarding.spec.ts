import { test, expect } from '@playwright/test';
import { loginAsTestUser } from '../helpers/auth.helper';

/**
 * First-run onboarding (#203). A never-seen email makes `/testing/login`
 * create a fresh user, whose `onboarding.welcomeSeenAt` is unset, so the
 * welcome dialog opens on the first page. The email is unique per run so the
 * account is always new.
 */
test.describe('First login onboarding', () => {
  test('welcome dialog, then the Get started card on Today', async ({ page }) => {
    const email = `onboarding-${Date.now()}@test.local`;
    await loginAsTestUser(page, { email, role: 'viewer', displayName: 'Nova Fresh', keepWelcome: true });

    const dialog = page.getByRole('dialog', { name: 'Welcome, Nova' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Strength' }).click();
    await dialog.getByRole('button', { name: 'Get started' }).click();
    await expect(dialog).toBeHidden();

    await expect(page).toHaveURL('/');
    const card = page.getByRole('region', { name: 'Get started' });
    await expect(card).toBeVisible();
    await expect(card.getByText(/\d of \d done/)).toBeVisible();
    await expect(card.getByRole('link', { name: /Add your gym/ })).toHaveAttribute('href', '/gyms/new');

    // The welcome is once-only: a reload does not bring it back.
    await page.reload();
    await expect(page.getByRole('region', { name: 'Get started' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
