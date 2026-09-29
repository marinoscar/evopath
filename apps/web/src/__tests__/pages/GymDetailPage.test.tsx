/**
 * `/gyms/:gymId` (E3.3): header and edit, equipment grouped by category with
 * the picker, custom equipment and the quantity stepper, and photos with the
 * lightbox. Runs against the stateful MSW gyms API in `fixtures/gyms.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import GymDetailPage from '../../pages/GymDetailPage';
import { clearPhotoUrlCache } from '../../components/intake/StoragePhotoThumb';
import { PHOTOS_UNAVAILABLE } from '../../services/gyms';
import { mockSignedUrl } from '../mocks/fixtures/ai';
import {
  DUMBBELLS,
  ELLIPTICAL,
  LEG_CURL,
  mockEquipment,
  mockGymDetail,
  mockPhoto,
  statefulGymsApi,
} from '../mocks/fixtures/gyms';

const CONTRIBUTOR = { ...mockUser, permissions: [...mockUser.permissions, 'storage:write'] };
const GYM_ID = '00000000-0000-4000-8000-a00000000999';

function renderDetail(options: { user?: typeof mockUser; gymId?: string } = {}) {
  return render(
    <Routes>
      <Route path="/gyms" element={<h1>Gyms list stand-in</h1>} />
      <Route path="/gyms/:gymId" element={<GymDetailPage />} />
    </Routes>,
    { wrapperOptions: { route: `/gyms/${options.gymId ?? GYM_ID}`, user: options.user ?? CONTRIBUTOR } },
  );
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add equipment' }));
  return screen.getByRole('dialog', { name: 'Add equipment' });
}

describe('GymDetailPage', () => {
  beforeEach(() => {
    clearPhotoUrlCache();
  });

  it('renders the header with chips, description and notes', async () => {
    statefulGymsApi([
      mockGymDetail({ id: GYM_ID, name: 'Hotel gym', type: 'hotel', isDefault: false, isTemporary: true, description: 'Floor 2', notes: 'Code 1234' }),
    ]);
    renderDetail();
    expect(await screen.findByRole('heading', { level: 1, name: 'Hotel gym' })).toBeInTheDocument();
    expect(screen.getByText('Hotel')).toBeInTheDocument();
    expect(screen.getByText('Temporary')).toBeInTheDocument();
    expect(screen.getByText('Floor 2')).toBeInTheDocument();
    expect(screen.getByText('Code 1234')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set default' })).toBeInTheDocument();
  });

  it('groups equipment by category and shows origin and verification tags', async () => {
    statefulGymsApi([
      mockGymDetail({
        id: GYM_ID,
        equipment: [
          mockEquipment(ELLIPTICAL, { brand: 'Precor', model: 'EFX 885' }),
          mockEquipment(DUMBBELLS, { origin: 'ai', confidence: 'high', userVerified: true }),
          mockEquipment(LEG_CURL, { origin: 'ai', confidence: 'low', userVerified: false }),
        ],
      }),
    ]);
    renderDetail();

    const headings = (await screen.findAllByRole('heading', { level: 3 })).map((h) => h.textContent);
    expect(headings).toEqual(['Free weights', 'Selectorized', 'Cardio']);

    const elliptical = screen.getByRole('listitem', { name: 'Elliptical' });
    expect(within(elliptical).getByText('Precor EFX 885')).toBeInTheDocument();
    expect(within(elliptical).getByText('Added by you')).toBeInTheDocument();

    const dumbbells = screen.getByRole('listitem', { name: 'Dumbbells' });
    expect(within(dumbbells).getByText('From photo scan')).toBeInTheDocument();
    expect(within(dumbbells).getByText('You verified')).toBeInTheDocument();

    const legCurl = screen.getByRole('listitem', { name: 'Leg curl machine' });
    expect(within(legCurl).getByText('Not yet verified')).toBeInTheDocument();
    expect(within(legCurl).getByText('Low confidence')).toBeInTheDocument();
  });

  it('adds equipment through the picker: search, pick, quantity and brand', async () => {
    const api = statefulGymsApi([mockGymDetail({ id: GYM_ID })]);
    const user = userEvent.setup();
    renderDetail();

    const dialog = await openPicker(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Search equipment' }), 'cross');
    const results = await within(dialog).findByRole('list', { name: 'Search results' });
    await waitFor(() => expect(within(results).getAllByRole('button')).toHaveLength(1));
    await user.click(within(results).getByRole('button', { name: /Elliptical/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Increase quantity' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Brand' }), 'Precor');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const cardio = await screen.findByRole('region', { name: 'Cardio' });
    expect(within(cardio).getByRole('listitem', { name: 'Elliptical' })).toHaveTextContent('Precor');
    expect(api.calls.find((c) => c.path.endsWith('/equipment'))?.body).toEqual({
      equipmentTypeId: ELLIPTICAL.id,
      quantity: 2,
      brand: 'Precor',
    });
  });

  it('adds custom equipment and it joins later searches', async () => {
    const api = statefulGymsApi([mockGymDetail({ id: GYM_ID })]);
    const user = userEvent.setup();
    renderDetail();

    let dialog = await openPicker(user);
    await user.click(within(dialog).getByRole('button', { name: "Can't find it? Add custom equipment" }));
    await user.type(within(dialog).getByRole('textbox', { name: /Equipment name/ }), 'Prowler sled');
    await user.click(within(dialog).getByRole('combobox', { name: 'Category' }));
    await user.click(await screen.findByRole('option', { name: 'Accessories' }));
    await user.click(within(dialog).getByRole('combobox', { name: /What it is used for/ }));
    await user.click(await screen.findByRole('option', { name: 'Farmer carry' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add custom equipment' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const accessories = await screen.findByRole('region', { name: 'Accessories' });
    expect(within(accessories).getByRole('listitem', { name: 'Prowler sled' })).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === '/equipment-types')?.body).toEqual({
      name: 'Prowler sled',
      category: 'accessories',
      capabilityIds: ['c5'],
    });

    dialog = await openPicker(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Search equipment' }), 'prowler');
    expect(await within(dialog).findByRole('button', { name: /Prowler sled/ })).toBeInTheDocument();
  });

  it('the quantity stepper changes the quantity and clamps to 1..99', async () => {
    const api = statefulGymsApi([
      mockGymDetail({
        id: GYM_ID,
        equipment: [mockEquipment(DUMBBELLS, { quantity: 1 }), mockEquipment(ELLIPTICAL, { quantity: 99 })],
      }),
    ]);
    const user = userEvent.setup();
    renderDetail();

    const dumbbells = await screen.findByRole('group', { name: 'Quantity of Dumbbells' });
    expect(within(dumbbells).getByRole('button', { name: 'Decrease quantity of dumbbells' })).toBeDisabled();
    const elliptical = screen.getByRole('group', { name: 'Quantity of Elliptical' });
    expect(within(elliptical).getByRole('button', { name: 'Increase quantity of elliptical' })).toBeDisabled();

    await user.click(within(dumbbells).getByRole('button', { name: 'Increase quantity of dumbbells' }));
    await waitFor(() => expect(within(dumbbells).getByRole('textbox')).toHaveValue('2'));

    // A typed value outside the range snaps back into it.
    const input = within(elliptical).getByRole('textbox');
    await user.clear(input);
    await user.type(input, '0{Enter}');
    await waitFor(() => expect(input).toHaveValue('1'));

    const patches = api.calls.filter((c) => c.method === 'PATCH').map((c) => c.body);
    expect(patches).toEqual([{ quantity: 2 }, { quantity: 1 }]);
  });

  it('edits the gym and the change persists', async () => {
    const api = statefulGymsApi([mockGymDetail({ id: GYM_ID, name: 'Home Gym' })]);
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit gym' });
    const name = within(dialog).getByRole('textbox', { name: /Name/ });
    await user.clear(name);
    await user.type(name, 'Garage gym');
    await user.click(within(dialog).getByRole('switch', { name: /Temporary/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Garage gym' })).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({ name: 'Garage gym', isTemporary: true });
    expect(api.gyms[0].name).toBe('Garage gym');
  });

  it('deletes the gym after confirmation and returns to the list', async () => {
    const api = statefulGymsApi([mockGymDetail({ id: GYM_ID, name: 'Home Gym' })]);
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete gym?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('heading', { name: 'Gyms list stand-in' })).toBeInTheDocument();
    expect(api.gyms).toHaveLength(0);
  });

  it('removes equipment after confirmation', async () => {
    const api = statefulGymsApi([mockGymDetail({ id: GYM_ID, equipment: [mockEquipment(DUMBBELLS)] })]);
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Remove Dumbbells' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Remove equipment?' })).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Dumbbells' })).toBeNull());
    expect(api.gyms[0].equipment).toHaveLength(0);
  });

  it('adds a photo: thumbnail first, then the lightbox opens the full image', async () => {
    const api = statefulGymsApi([mockGymDetail({ id: GYM_ID })]);
    const user = userEvent.setup();
    renderDetail();

    expect(await screen.findByRole('button', { name: 'Add photos' })).toBeEnabled();
    await user.upload(
      screen.getByTestId('gym-photo-input'),
      new File(['png'], 'cardio-row-wide.png', { type: 'image/png' }),
    );

    const open = await screen.findByRole('button', { name: 'Open Photo 1' }, { timeout: 4000 });
    const storageObjectId = api.gyms[0].photos[0].storageObjectId;
    await waitFor(() =>
      expect(within(open).getByRole('img', { name: 'Photo 1' })).toHaveAttribute('src', mockSignedUrl(storageObjectId)),
    );

    await user.click(open);
    const lightbox = screen.getByRole('dialog', { name: 'Gym photo' });
    await waitFor(() =>
      expect(within(lightbox).getByRole('img', { name: 'Gym photo' })).toHaveAttribute('src', mockSignedUrl(storageObjectId)),
    );
  });

  it('rejects a non-image and a file over 20 MiB before uploading', async () => {
    const api = statefulGymsApi([mockGymDetail({ id: GYM_ID })]);
    const user = userEvent.setup({ applyAccept: false });
    renderDetail();

    await screen.findByRole('button', { name: 'Add photos' });
    const big = new File(['x'], 'huge.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    await user.upload(screen.getByTestId('gym-photo-input'), [
      new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' }),
      big,
    ]);

    expect(await screen.findByText('notes.pdf is not an image.')).toBeInTheDocument();
    expect(screen.getByText('huge.jpg is larger than 20 MiB.')).toBeInTheDocument();
    expect(api.calls.filter((c) => c.path.endsWith('/photos'))).toHaveLength(0);
  });

  it('a photo whose file is gone shows a missing tile that can be removed', async () => {
    const photo = mockPhoto();
    const api = statefulGymsApi([mockGymDetail({ id: GYM_ID, photos: [photo] })]);
    server.use(
      http.get(`*/api/storage/objects/${photo.storageObjectId}/download`, () =>
        HttpResponse.json({ message: 'Not found' }, { status: 404 }),
      ),
    );
    const user = userEvent.setup();
    renderDetail();

    expect(await screen.findByRole('img', { name: 'Photo 1: photo removed' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Photo 1' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Remove photo?' })).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByText('No photos yet.')).toBeInTheDocument());
    expect(api.gyms[0].photos).toHaveLength(0);
  });

  it('viewer (no storage:write): manages equipment, but Add photos is hidden with the reason', async () => {
    statefulGymsApi([mockGymDetail({ id: GYM_ID })]);
    renderDetail({ user: mockUser });
    expect(await screen.findByRole('button', { name: 'Add equipment' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add photos' })).toBeNull();
    expect(screen.getByText(PHOTOS_UNAVAILABLE)).toBeInTheDocument();
  });

  it('read-only (no gyms:write): no mutating controls', async () => {
    statefulGymsApi([mockGymDetail({ id: GYM_ID, equipment: [mockEquipment(DUMBBELLS, { quantity: 3 })] })]);
    renderDetail({ user: { ...mockUser, permissions: ['gyms:read', 'storage:write'] } });
    expect(await screen.findByText('Quantity 3')).toBeInTheDocument();
    for (const name of ['Edit', 'Delete', 'Add equipment', 'Add photos', 'Remove Dumbbells']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it("answers a foreign or deleted gym's 404 with a way back", async () => {
    statefulGymsApi([]);
    renderDetail();
    expect(await screen.findByText('This gym does not exist or was deleted.')).toBeInTheDocument();
  });

  it('shows no AI-branded control with AI off', async () => {
    statefulGymsApi([mockGymDetail({ id: GYM_ID, equipment: [mockEquipment(DUMBBELLS)] })]);
    render(
      <Routes>
        <Route path="/gyms/:gymId" element={<GymDetailPage />} />
      </Routes>,
      { wrapperOptions: { route: `/gyms/${GYM_ID}`, user: CONTRIBUTOR, aiEnabled: false } },
    );
    await screen.findByRole('listitem', { name: 'Dumbbells' });
    expect(screen.queryByRole('button', { name: /scan|\bAI\b/i })).toBeNull();
    expect(screen.queryByText(/\bAI\b/)).toBeNull();
  });

  it('has no axe violations', async () => {
    statefulGymsApi([
      mockGymDetail({ id: GYM_ID, equipment: [mockEquipment(DUMBBELLS)], photos: [mockPhoto()] }),
    ]);
    const { container } = renderDetail();
    await screen.findByRole('listitem', { name: 'Dumbbells' });
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
