import path from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { signIn, type AuthedApi } from '../helpers/api.helper';
import {
  FAKE_MODEL_ID,
  FAKE_VISION_SKIP_MESSAGE,
  configureFakeVisionProvider,
  fakeRequests,
  isFakeVisionReachable,
  resetFake,
  setFakeFixture,
  type FakeFixture,
} from '../helpers/ai.helper';
import { stubAiState } from '../helpers/ai-stub.helper';

/**
 * AI "Scan gym" (E3.6), end to end through the real UI, API, storage, job
 * queue and AI gate, with deterministic model output.
 *
 * The provider is the fake OpenAI-compatible vision server (E3.4), started by
 * the `infra/compose/fake-ai.compose.yml` overlay; this spec switches AI on
 * and points the platform at it through the admin API
 * (`configureFakeVisionProvider`), then drives the two reference photos in
 * `docs/examples/gym-scan/` through the Scan page. The web client downscales
 * images with a canvas, so the bytes the fake receives differ from the
 * committed files; the fake therefore picks its answer from the control
 * endpoint (`setFakeFixture`), not from the image. The expected drafts are
 * `apps/api/test/fixtures/gym-scan/*.expected-drafts.json`.
 *
 * The fake's queue and request log are global, so the fixture tests run
 * serially. Every test signs in as its own new Contributor and creates its own
 * gym. The job poll interval is about 2 s; a scan is given up to 90 s.
 *
 * Skipped with a message when the fake server is not reachable. It needs
 * object storage configured on the stack, like any photo upload.
 */

const EXAMPLES = path.resolve(__dirname, '../../../docs/examples/gym-scan');
const CARDIO_ROW = path.join(EXAMPLES, 'cardio-row-wide.jpg');
const LEG_CURL = path.join(EXAMPLES, 'leg-curl-placard.jpg');

const LOW_NAME = 'Unidentified machine (partly out of frame)';

interface GymDetailBody {
  id: string;
  equipment: Array<{
    id: string;
    equipmentType: { name: string };
    quantity: number;
    brand: string | null;
    origin: string;
    userVerified: boolean;
    originalAiValue: { quantity?: number; brand?: string | null } | null;
  }>;
  photos: Array<{ id: string; storageObjectId: string; equipmentIds: string[] }>;
}

async function createGym(api: AuthedApi, name: string): Promise<string> {
  return (await api.post<{ id: string }>('/api/gyms', { name, type: 'home' })).id;
}

/** Open the Scan page and add the photos; wait until every photo is uploaded and attached. */
async function addPhotos(page: Page, gymId: string, files: string[]): Promise<void> {
  await page.goto(`/gyms/${gymId}/scan`);
  await expect(page.getByTestId('gym-scan-photos')).toBeVisible({ timeout: 30_000 });
  await page.locator('input[type="file"][aria-label="Add photos"]').setInputFiles(files);
  await expect(page.getByTestId('image-intake-progress')).toContainText(`${files.length} of ${files.length} ready`, {
    timeout: 60_000,
  });
}

/** Choose the canned answer, press Scan and wait for the review. */
async function scan(page: Page, fixture: FakeFixture): Promise<Locator> {
  await setFakeFixture(fixture);
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
  const review = page.getByTestId('gym-scan-review');
  await expect(review).toBeVisible({ timeout: 90_000 });
  return review;
}

function draftRows(review: Locator): Locator {
  return review.getByRole('list', { name: 'Draft items' }).getByTestId('draft-item-row');
}

/** The draft row whose equipment name is exactly `name`. */
function rowNamed(review: Locator, name: string): Locator {
  return draftRows(review).filter({
    has: review.page().getByTestId('equipment-draft-value').getByText(name, { exact: true }),
  });
}

/**
 * A handle on one draft row that survives editing: while a row is being
 * edited its value view is replaced by the editor, so a locator that finds it
 * by its equipment name would stop matching. The row's item id does not change.
 */
async function pinnedRow(review: Locator, name: string): Promise<Locator> {
  const itemId = await rowNamed(review, name).getAttribute('data-item-id');
  expect(itemId, `no draft row named ${name}`).toBeTruthy();
  return review.locator(`[data-testid="draft-item-row"][data-item-id="${itemId}"]`);
}

async function acceptAllAndApply(page: Page, review: Locator): Promise<void> {
  // Callers reject the low-confidence item first, so no "Accept all?" warning appears.
  await review.getByRole('button', { name: /^Accept all \(\d+\)$/ }).click();
  const apply = review.getByRole('button', { name: 'Apply to gym' });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page).toHaveURL(/\/gyms\/[0-9a-f-]{36}$/, { timeout: 30_000 });
}

function equipmentRow(page: Page, name: string): Locator {
  return page.getByRole('listitem', { name, exact: true });
}

test.describe('Gym scan with the fake vision provider', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeAll(async ({ browser, baseURL }) => {
    const reachable = await isFakeVisionReachable();
    test.skip(!reachable, FAKE_VISION_SKIP_MESSAGE);

    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      const { api } = await signIn(page, 'admin', 'gym-scan-admin');
      await configureFakeVisionProvider(api);
    } finally {
      await context.close();
    }
  });

  test.beforeEach(async () => {
    await resetFake();
  });

  test('example 1: the wide cardio photo yields the documented drafts, uncertainty visible', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'scan-cardio');
    const gymId = await createGym(api, 'Cardio Room');

    await addPhotos(page, gymId, [CARDIO_ROW]);
    await expect(page.getByTestId('ai-vision-disclosure')).toContainText(FAKE_MODEL_ID);
    const review = await scan(page, 'cardio-row-wide');

    await expect(draftRows(review)).toHaveCount(4);

    const elliptical = rowNamed(review, 'Elliptical');
    await expect(elliptical.getByTestId('equipment-draft-quantity')).toContainText('×3');
    await expect(elliptical.getByText('count uncertain')).toBeVisible();
    await expect(elliptical.getByText('Medium confidence')).toBeVisible();
    await expect(elliptical.getByText('AI guess', { exact: true })).toBeVisible();

    const bikes = rowNamed(review, 'Stationary bike');
    await expect(bikes).toHaveCount(2);
    await expect(bikes.getByTestId('equipment-draft-brand').filter({ hasText: /^Matrix/ })).toHaveCount(1);
    await expect(bikes.getByTestId('equipment-draft-brand').filter({ hasText: /^Precor/ })).toHaveCount(1);

    // The low-confidence item is in the main list, not collapsed away.
    const unidentified = rowNamed(review, LOW_NAME);
    await expect(unidentified).toBeVisible();
    await expect(unidentified.getByText('Low confidence')).toBeVisible();
    await expect(unidentified.getByTestId('draft-item-uncertainty')).toBeVisible();

    // Background objects the model was told to ignore are not rows.
    await expect(review.getByText(/fire extinguisher|window blinds/i)).toHaveCount(0);

    const requests = await fakeRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: FAKE_MODEL_ID, imageCount: 1 });
  });

  test('example 1: edit, reject and add persist with provenance, and the AI value is kept', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'scan-edit');
    const gymId = await createGym(api, 'Edit Room');

    await addPhotos(page, gymId, [CARDIO_ROW]);
    const review = await scan(page, 'cardio-row-wide');
    await expect(draftRows(review)).toHaveCount(4);

    // Edit: elliptical 3 -> 4. The row keeps what the AI said.
    const elliptical = await pinnedRow(review, 'Elliptical');
    await elliptical.getByRole('button', { name: 'Edit' }).click();
    await elliptical.getByRole('button', { name: 'Increase quantity' }).click();
    await elliptical.getByRole('button', { name: 'Save' }).click();
    await expect(elliptical.getByTestId('equipment-draft-quantity').first()).toContainText('×4');
    await expect(elliptical.getByTestId('draft-item-ai-said')).toContainText('×3');

    // Reject the unidentified machine: it leaves the main list for "Rejected".
    await rowNamed(review, LOW_NAME).getByRole('button', { name: 'Reject' }).click();
    await expect(rowNamed(review, LOW_NAME)).toHaveCount(0);
    await expect(review.getByText('Rejected (1)')).toBeVisible();

    // Add a missing item by hand.
    await review.getByRole('button', { name: 'Add missing item' }).click();
    const add = review.getByTestId('draft-item-add');
    await add.getByRole('combobox', { name: 'Equipment' }).fill('Dumbbells');
    await page.getByRole('option', { name: 'Dumbbells', exact: true }).click();
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(rowNamed(review, 'Dumbbells')).toBeVisible();
    await expect(rowNamed(review, 'Dumbbells').getByText('You added')).toBeVisible();

    await acceptAllAndApply(page, review);
    await expect(page.getByRole('alert').filter({ hasText: '4 added' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Photos saved to this gym.' })).toBeVisible();

    // The gym page: Elliptical x4, verified, with the AI's original one click away.
    const row = equipmentRow(page, 'Elliptical');
    await expect(row.getByRole('textbox', { name: 'Quantity of Elliptical' })).toHaveValue('4');
    await expect(row.getByText('You verified')).toBeVisible();
    await row.getByRole('button', { name: 'AI said…' }).click();
    await expect(page.getByRole('dialog', { name: 'What the AI proposed' })).toContainText(/AI said:.*×3/);
    await page.keyboard.press('Escape');
    await expect(equipmentRow(page, 'Dumbbells').getByText('Added by you')).toBeVisible();
    await expect(equipmentRow(page, LOW_NAME)).toHaveCount(0);

    // Persistence.
    await page.reload();
    await expect(equipmentRow(page, 'Elliptical').getByRole('textbox', { name: 'Quantity of Elliptical' })).toHaveValue('4');
    await expect(equipmentRow(page, 'Elliptical').getByText('You verified')).toBeVisible();

    const detail = await api.get<GymDetailBody>(`/api/gyms/${gymId}`);
    const ell = detail.equipment.find((r) => r.equipmentType.name === 'Elliptical');
    expect(ell).toMatchObject({ origin: 'ai', userVerified: true, quantity: 4 });
    expect(ell?.originalAiValue?.quantity).toBe(3);
    const dumbbells = detail.equipment.find((r) => r.equipmentType.name === 'Dumbbells');
    expect(dumbbells?.origin).toBe('manual');
    expect(detail.equipment).toHaveLength(4);

    // The scan photo became a gym photo, linked to the ellipticals it shows.
    expect(detail.photos).toHaveLength(1);
    expect(detail.photos[0].equipmentIds).toContain(ell!.id);
  });

  test('example 2: the placard photo yields one high-confidence row; a brand edit keeps the AI value', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'scan-placard');
    const gymId = await createGym(api, 'Placard Room');

    await addPhotos(page, gymId, [LEG_CURL]);
    const review = await scan(page, 'leg-curl-placard');

    await expect(draftRows(review)).toHaveCount(1);
    const row = await pinnedRow(review, 'Leg curl machine');
    await expect(row.getByText('High confidence')).toBeVisible();
    await expect(row.getByTestId('equipment-draft-brand')).toHaveText(/^Precor/);
    await expect(row).toContainText('seated, selectorized');
    await expect(row.getByRole('group', { name: 'Capabilities' }).getByText('Leg curl', { exact: true })).toBeVisible();
    await expect(row).toContainText('Targets hamstrings');

    const requests = await fakeRequests();
    expect(requests[0]).toMatchObject({ imageCount: 1 });

    await row.getByRole('button', { name: 'Edit' }).click();
    await row.getByRole('textbox', { name: 'Brand' }).fill('Precor Icarian');
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(row.getByTestId('draft-item-ai-said')).toContainText('Precor');

    await acceptAllAndApply(page, review);

    const gymRow = equipmentRow(page, 'Leg curl machine');
    await expect(gymRow).toContainText('Precor Icarian');
    await expect(gymRow.getByText('You verified')).toBeVisible();

    await page.reload();
    await expect(equipmentRow(page, 'Leg curl machine')).toContainText('Precor Icarian');

    const detail = await api.get<GymDetailBody>(`/api/gyms/${gymId}`);
    expect(detail.equipment).toHaveLength(1);
    const [leg] = detail.equipment;
    expect(leg).toMatchObject({ origin: 'ai', userVerified: true, brand: 'Precor Icarian' });
    expect(leg.originalAiValue?.brand).toBe('Precor');

    // The placard photo is in the gym's Photos and linked to the machine.
    expect(detail.photos).toHaveLength(1);
    expect(detail.photos[0].equipmentIds).toEqual([leg.id]);
    await page.getByRole('button', { name: 'Open Photo 1' }).click();
    const lightbox = page.getByRole('dialog', { name: 'Gym photo' });
    await expect(lightbox.getByRole('combobox', { name: 'Equipment in this photo' })).toBeVisible();
    await expect(lightbox.getByRole('button', { name: 'Leg curl machine' })).toBeVisible();
  });

  test('both photos in one request give five rows', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'scan-both');
    const gymId = await createGym(api, 'Both Room');

    await addPhotos(page, gymId, [CARDIO_ROW, LEG_CURL]);
    const review = await scan(page, 'both');

    await expect(draftRows(review)).toHaveCount(5);
    await expect(rowNamed(review, 'Leg curl machine')).toBeVisible();
    await expect(rowNamed(review, 'Elliptical')).toBeVisible();

    const requests = await fakeRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].imageCount).toBe(2);
  });

  test('rejecting the leg curl and applying keeps the photo but adds no equipment', async ({ page }) => {
    const { api } = await signIn(page, 'contributor', 'scan-delete');
    const gymId = await createGym(api, 'Delete Room');

    await addPhotos(page, gymId, [LEG_CURL]);
    const review = await scan(page, 'leg-curl-placard');
    await rowNamed(review, 'Leg curl machine').getByRole('button', { name: 'Reject' }).click();
    await expect(draftRows(review)).toHaveCount(0);

    const apply = review.getByRole('button', { name: 'Apply to gym' });
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(page).toHaveURL(/\/gyms\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    await expect(page.getByText('Nothing listed yet.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Gym photos' }).getByRole('listitem')).toHaveCount(1);

    await page.reload();
    await expect(page.getByText('Nothing listed yet.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Gym photos' }).getByRole('listitem')).toHaveCount(1);

    const detail = await api.get<GymDetailBody>(`/api/gyms/${gymId}`);
    expect(detail.equipment).toEqual([]);
    expect(detail.photos).toHaveLength(1);
  });
});

test.describe('Gym scan without a usable vision model', () => {
  test('the scan page says so and offers Continue manually', async ({ page }) => {
    // AI on, but the caller has no model at all: the "add a key" notice.
    await stubAiState(page, { enabled: true, models: [] });
    const { api } = await signIn(page, 'contributor', 'scan-no-model');
    const gymId = await createGym(api, 'No Model Room');

    await page.goto(`/gyms/${gymId}/scan`);
    await expect(page.getByText('Add your own AI key in Settings → AI')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Scan', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Continue manually' }).click();
    await expect(page).toHaveURL(new RegExp(`/gyms/${gymId}$`));
    await expect(page.getByRole('dialog', { name: 'Add equipment' })).toBeVisible();
  });

  test('AI switched off shows the off notice and the manual way on', async ({ page }) => {
    await stubAiState(page, { enabled: false });
    const { api } = await signIn(page, 'contributor', 'scan-ai-off');
    const gymId = await createGym(api, 'AI Off Room');

    await page.goto(`/gyms/${gymId}/scan`);
    await expect(page.getByText('AI is turned off for this app')).toBeVisible();
    await page.getByRole('button', { name: 'Continue manually' }).click();
    await expect(page.getByRole('dialog', { name: 'Add equipment' })).toBeVisible();
  });
});
