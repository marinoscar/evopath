import { test, expect } from '@playwright/test';
import { signIn } from '../helpers/api.helper';
import { E2E_AI_DISABLED } from '../helpers/ai.helper';
import {
  assertFakeCoachReachable,
  putCoachSettings,
  setupFakeCoachAi,
  teardownFakeCoachAi,
  withAdmin,
  type FakeCoachSnapshot,
} from '../helpers/coach.helper';
import { loginAsTestUser } from '../helpers/auth.helper';
import { createTrainingGym, seedActivePlan } from '../helpers/training.helper';

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

/**
 * "Meet your coach" (E7.12): once a plan exists, the `ai_plan` step of the Get
 * started checklist stops asking for an AI plan and asks the user to meet the
 * coach instead (no fifth step); it is done when the coach settings have been
 * saved at least once. Needs AI on, so it turns it on against the fake AI
 * server and puts it back; serial and not beside other AI specs. `E2E_AI=0`
 * skips it.
 */
test.describe('Meet your coach', () => {
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

  test('the checklist asks to meet the coach once a plan exists, and it is done after the first save', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'meet-coach');
    await seedActivePlan(api, await createTrainingGym(api, 'Garage Gym'));

    await page.goto('/');
    const card = page.getByRole('region', { name: 'Get started' });
    const step = card.getByTestId('onboarding-step-ai_plan');
    await expect(step).toHaveAttribute('data-status', 'todo');
    await expect(card.getByRole('link', { name: /Meet your coach/ })).toHaveAttribute('href', '/settings/coach');
    await expect(card.getByText('Create an AI training plan')).toHaveCount(0);

    // Saving the coach settings once completes the step; the checklist stays at four steps.
    await putCoachSettings(api, { personaId: 'stoic' });
    await page.reload();
    await expect(card.getByTestId('onboarding-step-ai_plan')).toHaveAttribute('data-status', 'done');
    await expect(card.getByRole('link', { name: /Meet your coach/ })).toHaveCount(0);
    await expect(card.getByRole('listitem')).toHaveCount(4);
  });
});
