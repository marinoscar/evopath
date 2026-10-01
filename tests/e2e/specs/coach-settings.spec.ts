import { test as base, expect } from '@playwright/test';
import { signIn, type AuthedApi } from '../helpers/api.helper';
import { E2E_AI_DISABLED } from '../helpers/ai.helper';
import {
  assertFakeCoachReachable,
  getCoachSettings,
  setCoachPolicy,
  setupFakeCoachAi,
  teardownFakeCoachAi,
  withAdmin,
  type FakeCoachSnapshot,
} from '../helpers/coach.helper';

/**
 * Coach settings (E7.3) end to end: pick a persona, read its sample lines, and
 * the adult-language journey for Sarge at level 3 (E7.2 unlock rules), against
 * the real stack and the fake OpenAI-compatible server. No model is called by
 * this page (sample lines are static), but the coach is only visible while AI
 * is on, so the suite turns it on against the fake.
 *
 * Profanity needs four things: the deployment allows it
 * (`/admin/settings/coach`), the user confirms they are 18 or older, the
 * persona has an adult level and that level is chosen. Turning the deployment
 * flag off re-locks it. The tripwire that no profane text can be produced
 * while locked is `apps/api/test/coach/coach-profanity-unlock.spec.ts`.
 *
 * Global state (AI settings, the coach policy): serial, and not beside other AI
 * specs. `E2E_AI=0` skips it.
 *
 *   cd tests/e2e && npm test -- coach-settings --workers=1
 */

const test = base.extend<{ owner: { api: AuthedApi; email: string } }>({
  owner: async ({ page }, use) => {
    const { api, email } = await signIn(page, 'contributor', 'coach-settings');
    await use({ api, email });
  },
});

test.describe.configure({ mode: 'serial' });
test.skip(E2E_AI_DISABLED, 'E2E_AI=0');

let snapshot: FakeCoachSnapshot;

test.beforeAll(async ({ browser }, testInfo) => {
  await assertFakeCoachReachable();
  snapshot = await withAdmin(browser, testInfo.project.use.baseURL, async (admin) => {
    const taken = await setupFakeCoachAi(admin);
    await setCoachPolicy(admin, { allowProfanePersonas: false });
    return taken;
  });
});

test.afterAll(async ({ browser }, testInfo) => {
  await withAdmin(browser, testInfo.project.use.baseURL, (admin) => teardownFakeCoachAi(admin, snapshot));
});

test('pick a persona, read its sample lines and save', async ({ page, owner }) => {
  await page.goto('/settings/coach');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  const stoic = page.getByTestId('persona-card-stoic');
  await expect(stoic).toBeVisible();

  // Sample lines are fixed examples: expanding them never calls a model.
  await stoic.getByRole('button', { name: /Sample lines/ }).click();
  await expect(stoic.getByRole('term').first()).toBeVisible();
  await expect(stoic.getByRole('definition').first()).not.toBeEmpty();

  await stoic.getByRole('button', { name: 'Choose The Stoic' }).click();
  await expect(stoic.getByRole('button', { name: 'The Stoic selected' })).toHaveAttribute('aria-pressed', 'true');
  await expect(stoic.getByText('Selected, not saved')).toBeVisible();

  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(stoic.getByText('Active')).toBeVisible();
  await expect.poll(async () => (await getCoachSettings(owner.api)).settings.personaId).toBe('stoic');

  // Saved means it survives a reload.
  await page.reload();
  await expect(page.getByTestId('persona-card-stoic').getByText('Active')).toBeVisible();
});

test('Sarge at level 3 stays locked until the deployment allows it and the user confirms 18+; the flag re-locks it', async ({ page, browser }, testInfo) => {
  const { api } = await signIn(page, 'contributor', 'coach-profanity');
  const baseURL = testInfo.project.use.baseURL;

  // 1. The deployment has adult language off: Sarge is chosen, the section says why, nothing unlocks.
  await page.goto('/settings/coach');
  const sarge = page.getByTestId('persona-card-drill_sergeant');
  await sarge.getByRole('button', { name: 'Choose Sarge' }).click();
  await expect(page.getByTestId('profanity-policy-off')).toBeVisible();
  await expect(page.getByLabel('Adult language (18+)')).toHaveCount(0);
  expect((await getCoachSettings(api)).effective.register.profane).toBe(false);

  // 2. The administrator allows it; the user still has to confirm they are an adult.
  await withAdmin(browser, baseURL, (admin) => setCoachPolicy(admin, { allowProfanePersonas: true }));
  await page.goto('/settings/coach');
  await page.getByTestId('persona-card-drill_sergeant').getByRole('button', { name: 'Choose Sarge' }).click();
  await page.getByRole('slider', { name: 'Intensity' }).focus();
  await page.keyboard.press('End');
  await expect(page.getByText(/Level 3: Unhinged/)).toBeVisible();

  await page.getByLabel('Adult language (18+)').check();
  const dialog = page.getByRole('dialog', { name: 'Turn on adult language?' });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole('button', { name: 'Turn on adult language' });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'I confirm I am 18 or older' }).check();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page.getByTestId('profanity-status')).toContainText('On. Your coach may swear at this level.');
  await expect
    .poll(async () => {
      const view = await getCoachSettings(api);
      return { personaId: view.settings.personaId, intensity: view.settings.intensity, profane: view.effective.register.profane, attested: view.settings.adultConfirmedAt !== null };
    })
    .toEqual({ personaId: 'drill_sergeant', intensity: 3, profane: true, attested: true });

  // 3. Turning the deployment flag off re-locks it, whatever the user chose.
  await withAdmin(browser, baseURL, (admin) => setCoachPolicy(admin, { allowProfanePersonas: false }));
  const relocked = await getCoachSettings(api);
  expect(relocked.effective.register).toEqual({ profane: false, reason: 'system_disabled' });
  expect(relocked.effective.intensity).toBe(2);

  await page.reload();
  await expect(page.getByTestId('profanity-policy-off')).toBeVisible();
});
