/**
 * `/gyms` (E3.3): the gym list replaces the E1 placeholder. Runs against the
 * stateful MSW gyms API in `fixtures/gyms.ts`.
 */
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../utils/test-utils';
import GymsPage from '../../pages/GymsPage';
import GymNewPage from '../../pages/GymNewPage';
import { comingInLabel } from '../../config/roadmap';
import { GYMS_UNAVAILABLE } from '../../services/gyms';
import { mockGymDetail, mockPhoto, statefulGymsApi } from '../mocks/fixtures/gyms';

function renderGyms(options: { route?: string; permissions?: string[] } = {}) {
  const user = options.permissions ? { ...mockUser, permissions: options.permissions } : mockUser;
  return render(
    <Routes>
      <Route path="/gyms" element={<GymsPage />} />
      <Route path="/gyms/new" element={<GymNewPage />} />
      <Route path="/gyms/:gymId" element={<h1>Gym detail stand-in</h1>} />
    </Routes>,
    { wrapperOptions: { route: options.route ?? '/gyms', user } },
  );
}

describe('GymsPage', () => {
  it('renders the h1 and no placeholder or roadmap chip', async () => {
    statefulGymsApi();
    renderGyms();
    expect(screen.getByRole('heading', { level: 1, name: 'Gyms' })).toBeInTheDocument();
    await screen.findByRole('heading', { name: 'No gyms yet' });
    expect(screen.queryByText(comingInLabel('gyms'))).toBeNull();
    expect(screen.queryByText(/Photo recognition and location are optional/)).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('shows an empty state that explains gyms and offers Add gym', async () => {
    statefulGymsApi();
    renderGyms();
    await screen.findByRole('heading', { name: 'No gyms yet' });
    expect(screen.getByText(/A gym is anywhere you train/)).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Add gym' });
    expect(links.every((l) => l.getAttribute('href') === '/gyms/new')).toBe(true);
  });

  it('creates a gym through /gyms/new and shows it in the list with the Default chip', async () => {
    const api = statefulGymsApi();
    const user = userEvent.setup();
    renderGyms({ route: '/gyms/new' });

    expect(screen.getByRole('heading', { level: 1, name: 'Add gym' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /Name/ }), 'Home Gym');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const card = await screen.findByRole('region', { name: 'Home Gym' });
    expect(within(card).getByText('Default')).toBeInTheDocument();
    expect(within(card).getByText('Home')).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Home Gym',
      type: 'home',
      description: null,
      notes: null,
      isTemporary: false,
    });
  });

  it('sends an optional location set on /gyms/new with the new gym', async () => {
    const api = statefulGymsApi();
    const user = userEvent.setup();
    renderGyms({ route: '/gyms/new' });

    await user.type(screen.getByRole('textbox', { name: /Name/ }), 'Home Gym');
    expect(screen.getByText('No location set')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Latitude' }), '9.934');
    await user.type(screen.getByRole('textbox', { name: 'Longitude' }), '-84.08');
    await user.click(screen.getByRole('button', { name: 'Set location' }));
    expect(screen.getByText('Location: 9.93400, -84.08000')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('region', { name: 'Home Gym' });
    expect(api.calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      name: 'Home Gym',
      latitude: 9.934,
      longitude: -84.08,
    });
  });

  it('refuses to save a blank name', async () => {
    const api = statefulGymsApi();
    const user = userEvent.setup();
    renderGyms({ route: '/gyms/new' });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a name.')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('lists gyms with type, Default and Temporary chips, counts and a cover photo', async () => {
    const photo = mockPhoto();
    statefulGymsApi([
      mockGymDetail({ name: 'Home Gym', isDefault: true, photos: [photo] }),
      mockGymDetail({ name: 'Hotel gym', type: 'hotel', isDefault: false, isTemporary: true }),
    ]);
    renderGyms();

    const home = await screen.findByRole('region', { name: 'Home Gym' });
    expect(within(home).getByText('Default')).toBeInTheDocument();
    expect(within(home).getByText('0 pieces of equipment · 1 photo')).toBeInTheDocument();
    expect(await within(home).findByRole('img', { name: 'Home Gym cover photo' })).toBeInTheDocument();
    expect(within(home).queryByRole('button', { name: /Set .* as default/ })).toBeNull();

    const hotel = screen.getByRole('region', { name: 'Hotel gym' });
    expect(within(hotel).getByText('Temporary')).toBeInTheDocument();
    expect(within(hotel).getByText('Hotel')).toBeInTheDocument();
    expect(within(hotel).queryByText('Default')).toBeNull();
    expect(within(hotel).getByRole('link', { name: 'Open Hotel gym' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/gyms\//),
    );
  });

  it('moves the Default chip with Set default', async () => {
    const api = statefulGymsApi([
      mockGymDetail({ name: 'Home Gym', isDefault: true }),
      mockGymDetail({ name: 'Hotel gym', isDefault: false }),
    ]);
    const user = userEvent.setup();
    renderGyms();

    await user.click(await screen.findByRole('button', { name: 'Set Hotel gym as default' }));
    await waitFor(() =>
      expect(within(screen.getByRole('region', { name: 'Hotel gym' })).getByText('Default')).toBeInTheDocument(),
    );
    expect(within(screen.getByRole('region', { name: 'Home Gym' })).queryByText('Default')).toBeNull();
    expect(api.calls.some((c) => c.method === 'POST' && c.path.endsWith('/default'))).toBe(true);
  });

  it('asks for confirmation before deleting; Cancel keeps the gym, Delete promotes the other', async () => {
    const api = statefulGymsApi([
      mockGymDetail({ name: 'Hotel gym', isDefault: true }),
      mockGymDetail({ name: 'Home Gym', isDefault: false }),
    ]);
    const user = userEvent.setup();
    renderGyms();

    await user.click(await screen.findByRole('button', { name: 'Delete Hotel gym' }));
    let dialog = screen.getByRole('dialog', { name: 'Delete gym?' });
    expect(within(dialog).getByText(/Delete "Hotel gym"/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Delete Hotel gym' }));
    dialog = screen.getByRole('dialog', { name: 'Delete gym?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Hotel gym' })).toBeNull());
    expect(within(screen.getByRole('region', { name: 'Home Gym' })).getByText('Default')).toBeInTheDocument();
  });

  it('hides mutations without gyms:write', async () => {
    statefulGymsApi([mockGymDetail({ name: 'Home Gym' })]);
    renderGyms({ permissions: ['gyms:read'] });
    const card = await screen.findByRole('region', { name: 'Home Gym' });
    expect(within(card).getByRole('link', { name: 'Open Home Gym' })).toBeInTheDocument();
    expect(within(card).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add gym' })).toBeNull();
  });

  it('explains when the account has no gyms:read', () => {
    statefulGymsApi();
    renderGyms({ permissions: ['user_settings:read'] });
    expect(screen.getByText(GYMS_UNAVAILABLE)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    statefulGymsApi([mockGymDetail({ name: 'Home Gym' })]);
    const { container } = renderGyms();
    await screen.findByRole('region', { name: 'Home Gym' });
    // jsdom cannot resolve colour contrast.
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
