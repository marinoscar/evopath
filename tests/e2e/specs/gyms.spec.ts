import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { signIn, type AuthedApi } from '../helpers/api.helper';
import { stubAiState } from '../helpers/ai-stub.helper';

/**
 * Gyms, manual path (E3.6): everything a user can do with no AI at all.
 *
 * A Contributor creates a gym, fills its equipment list from the catalog and
 * with a custom item, attaches a photo, and manages which gym is the default.
 * A Viewer holds `gyms:write` but neither `storage:write` nor `ai:use`, so it
 * can list equipment but never upload a photo or start a scan.
 *
 * Every test signs in as its own new user (unique email) and so owns its gyms.
 * AI state is stubbed client side with `page.route()` (see `ai-stub.helper.ts`)
 * so these tests never depend on, or change, the deployment's AI settings.
 * Everything else is the real API and the real storage backend.
 *
 * Needs the same stack as the rest of the suite (see docs/TESTING.md); photo
 * upload needs object storage configured in the running stack.
 */

const PLACARD = path.resolve(__dirname, '../../../docs/examples/gym-scan/leg-curl-placard.jpg');

interface GymDetailBody {
  id: string;
  isDefault: boolean;
  equipment: Array<{ id: string; equipmentType: { name: string }; quantity: number; origin: string }>;
  photos: Array<{ id: string; storageObjectId: string; equipmentIds: string[] }>;
}

async function createGym(api: AuthedApi, name: string): Promise<string> {
  const gym = await api.post<{ id: string }>('/api/gyms', { name, type: 'home' });
  return gym.id;
}

function gymCard(page: Page, name: string) {
  return page.getByRole('region', { name, exact: true });
}

function equipmentRow(page: Page, name: string) {
  return page.getByRole('listitem', { name, exact: true });
}

test.describe('Gyms: manual path', () => {
  test.describe.configure({ timeout: 90_000 });

  test('a Contributor builds a gym by hand: catalog item, custom item, photo, and it all persists', async ({ page }) => {
    await stubAiState(page, { enabled: false });
    const { api } = await signIn(page, 'contributor', 'gyms-manual');

    await page.goto('/gyms');
    await expect(page.getByRole('heading', { name: 'No gyms yet' })).toBeVisible();

    // Create "Home Gym": the first gym a user creates becomes the default.
    await page.getByRole('link', { name: 'Add gym' }).first().click();
    await expect(page).toHaveURL(/\/gyms\/new$/);
    await page.getByRole('textbox', { name: 'Name' }).fill('Home Gym');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page).toHaveURL(/\/gyms$/);
    const card = gymCard(page, 'Home Gym');
    await expect(card).toBeVisible();
    await expect(card.getByText('Default', { exact: true })).toBeVisible();
    await expect(card).toContainText('0 pieces of equipment');

    await card.getByRole('link', { name: 'Open Home Gym' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Home Gym' })).toBeVisible();
    const gymId = page.url().split('/gyms/')[1];

    // Catalog item: search by an alias ("cross trainer"), quantity 2.
    await page.getByRole('button', { name: 'Add equipment' }).click();
    const picker = page.getByRole('dialog', { name: 'Add equipment' });
    await picker.getByRole('textbox', { name: 'Search equipment' }).fill('cross');
    await picker.getByRole('list', { name: 'Search results' }).getByRole('button', { name: /Elliptical/ }).click();
    const details = picker.getByRole('region', { name: 'Details for Elliptical' });
    await details.getByRole('button', { name: 'Increase quantity' }).click();
    await expect(details.getByRole('textbox', { name: 'Quantity' })).toHaveValue('2');
    await picker.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(picker).toBeHidden();

    const elliptical = equipmentRow(page, 'Elliptical');
    await expect(elliptical.getByRole('textbox', { name: 'Quantity of Elliptical' })).toHaveValue('2');
    await expect(elliptical.getByText('Added by you')).toBeVisible();

    // Custom item: not in the catalog, so it becomes a custom type of this user.
    const customName = `Sandbag ${Date.now()}`;
    await page.getByRole('button', { name: 'Add equipment' }).click();
    await picker.getByRole('button', { name: /Add custom equipment/ }).click();
    await picker.getByRole('textbox', { name: 'Equipment name' }).fill(customName);
    await picker.getByRole('button', { name: 'Add custom equipment' }).click();
    await expect(picker).toBeHidden();
    await expect(equipmentRow(page, customName)).toBeVisible();

    // A gym photo (a real upload through the storage API).
    await page.getByTestId('gym-photo-input').setInputFiles(PLACARD);
    const photos = page.getByRole('list', { name: 'Gym photos' });
    await expect(photos.getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });

    // Reload: everything is server state.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Home Gym' })).toBeVisible();
    await expect(equipmentRow(page, 'Elliptical').getByRole('textbox', { name: 'Quantity of Elliptical' })).toHaveValue('2');
    await expect(equipmentRow(page, customName)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Gym photos' }).getByRole('listitem')).toHaveCount(1);

    // ... and the API agrees, with manual provenance.
    const detail = await api.get<GymDetailBody>(`/api/gyms/${gymId}`);
    expect(detail.equipment).toHaveLength(2);
    expect(detail.equipment.every((row) => row.origin === 'manual')).toBe(true);
    expect(detail.equipment.find((row) => row.equipmentType.name === 'Elliptical')?.quantity).toBe(2);
    expect(detail.photos).toHaveLength(1);
  });

  test('the default moves when another gym is chosen, and passes on when the default is deleted', async ({ page }) => {
    await stubAiState(page, { enabled: false });
    const { api } = await signIn(page, 'contributor', 'gyms-default');
    const homeId = await createGym(api, 'Home Gym');
    await createGym(api, 'Office Gym');

    await page.goto('/gyms');
    const home = gymCard(page, 'Home Gym');
    const office = gymCard(page, 'Office Gym');
    await expect(home.getByText('Default', { exact: true })).toBeVisible();
    await expect(office.getByText('Default', { exact: true })).toHaveCount(0);

    // Set: exactly one default at a time.
    await page.getByRole('button', { name: 'Set Office Gym as default' }).click();
    await expect(office.getByText('Default', { exact: true })).toBeVisible();
    await expect(home.getByText('Default', { exact: true })).toHaveCount(0);

    // ... and back, from the gym's own page.
    await home.getByRole('link', { name: 'Open Home Gym' }).click();
    await page.getByRole('button', { name: 'Set default' }).click();
    await expect(page.getByText('Default', { exact: true })).toBeVisible();
    expect((await api.get<GymDetailBody>(`/api/gyms/${homeId}`)).isDefault).toBe(true);
    await page.getByRole('link', { name: 'All gyms' }).click();

    // Clear: deleting the default gym hands the default to the one that is left.
    await home.getByRole('button', { name: 'Delete Home Gym' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete gym?' });
    await expect(confirm).toContainText('Delete "Home Gym"');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(home).toHaveCount(0);
    await expect(office.getByText('Default', { exact: true })).toBeVisible();

    // Delete the last gym: back to the empty state.
    await office.getByRole('button', { name: 'Delete Office Gym' }).click();
    await page.getByRole('dialog', { name: 'Delete gym?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('heading', { name: 'No gyms yet' })).toBeVisible();
  });

  test('with AI off, Scan gym is disabled with the reason and everything else works', async ({ page }) => {
    await stubAiState(page, { enabled: false });
    const { api } = await signIn(page, 'contributor', 'gyms-ai-off');
    const gymId = await createGym(api, 'Garage');

    await page.goto(`/gyms/${gymId}`);
    const scan = page.getByRole('button', { name: 'Scan gym' });
    await expect(scan).toBeDisabled();
    await expect(page.getByText('AI is turned off for this app.')).toBeVisible();
    await expect(scan).toHaveAccessibleDescription('AI is turned off for this app.');

    // The manual path is untouched.
    await expect(page.getByRole('button', { name: 'Add equipment' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Add photos' })).toBeEnabled();
    await page.getByRole('button', { name: 'Add equipment' }).click();
    const picker = page.getByRole('dialog', { name: 'Add equipment' });
    await picker.getByRole('textbox', { name: 'Search equipment' }).fill('dumbbells');
    await picker.getByRole('list', { name: 'Search results' }).getByRole('button', { name: /^Dumbbells/ }).click();
    await picker.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(equipmentRow(page, 'Dumbbells')).toBeVisible();
  });

  test('a Viewer manages equipment but cannot upload photos or scan, and is told why', async ({ page }) => {
    await stubAiState(page, { enabled: true });
    const { api } = await signIn(page, 'viewer', 'gyms-viewer');
    const gymId = await createGym(api, 'Viewer Gym');

    await page.goto(`/gyms/${gymId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Viewer Gym' })).toBeVisible();

    // No upload control; the reason is on the page instead.
    await expect(page.getByRole('button', { name: 'Add photos' })).toHaveCount(0);
    await expect(page.getByTestId('gym-photo-input')).toHaveCount(0);
    await expect(
      page.getByText('Adding photos needs permission to upload files, which your account does not have.'),
    ).toBeVisible();

    // Scan gym is present but disabled, with the missing permission spelled out.
    const scan = page.getByRole('button', { name: 'Scan gym' });
    await expect(scan).toBeDisabled();
    await expect(page.getByText('Scanning needs permission to upload photos, which your account does not have.')).toBeVisible();

    // Typing the scan URL by hand shows the same reason, not the scan flow.
    await page.goto(`/gyms/${gymId}/scan`);
    await expect(page.getByTestId('gym-scan-permission')).toContainText(
      'Scanning needs permission to upload photos, which your account does not have.',
    );
    await expect(page.getByRole('button', { name: 'Scan', exact: true })).toHaveCount(0);
  });
});
