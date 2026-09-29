/**
 * `/train/exercises` (E4.1): browse, search, filter and create against the
 * stateful MSW exercises API in `fixtures/exercises.ts`.
 */
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../utils/test-utils';
import TrainExercisesPage from '../../pages/TrainExercisesPage';
import { EXERCISES_UNAVAILABLE } from '../../services/exercises';
import { statefulExercisesApi } from '../mocks/fixtures/exercises';
import { DUMBBELLS } from '../mocks/fixtures/gyms';

function renderPage(options: { permissions?: string[] } = {}) {
  const user = options.permissions ? { ...mockUser, permissions: options.permissions } : mockUser;
  return render(
    <Routes>
      <Route path="/train/exercises" element={<TrainExercisesPage />} />
      <Route path="/train" element={<h1>Train stand-in</h1>} />
    </Routes>,
    { wrapperOptions: { route: '/train/exercises', user } }
  );
}

const withoutPermission = (perm: string) => mockUser.permissions.filter((p) => p !== perm);

async function listItems() {
  const list = await screen.findByRole('list', { name: 'Exercises' });
  return within(list).getAllByRole('button');
}

describe('TrainExercisesPage', () => {
  it('renders the h1, a link back to Train and the library', async () => {
    statefulExercisesApi();
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Exercise library' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Train' })).toHaveAttribute('href', '/train');
    expect(await listItems()).toHaveLength(6);
    expect(screen.getByText('Barbell bench press')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('searches by name: "bench" finds four exercises', async () => {
    const api = statefulExercisesApi();
    const user = userEvent.setup();
    renderPage();
    await listItems();

    await user.type(screen.getByRole('searchbox', { name: 'Search exercises' }), 'bench');
    await waitFor(async () => expect(await listItems()).toHaveLength(4));
    expect(screen.queryByText('Dumbbell curl')).toBeNull();
    expect(api.calls.some((c) => c.path.includes('q=bench'))).toBe(true);
  });

  it('searches by alias', async () => {
    statefulExercisesApi();
    const user = userEvent.setup();
    renderPage();
    await listItems();
    await user.type(screen.getByRole('searchbox', { name: 'Search exercises' }), 'press-up');
    await waitFor(async () => expect(await listItems()).toHaveLength(1));
    expect(screen.getByText('Push-up')).toBeInTheDocument();
  });

  it('filters by a muscle chip and clears it with All muscles', async () => {
    const api = statefulExercisesApi();
    const user = userEvent.setup();
    renderPage();
    await listItems();

    const chips = screen.getByRole('group', { name: 'Filter by muscle' });
    const biceps = within(chips).getByRole('button', { name: 'Biceps' });
    await user.click(biceps);
    await waitFor(async () => expect(await listItems()).toHaveLength(1));
    expect(screen.getByText('Dumbbell curl')).toBeInTheDocument();
    expect(biceps).toHaveAttribute('aria-pressed', 'true');
    expect(api.calls.some((c) => c.path.includes('muscle=biceps'))).toBe(true);

    await user.click(within(chips).getByRole('button', { name: 'All muscles' }));
    await waitFor(async () => expect(await listItems()).toHaveLength(6));
  });

  it('shows an empty state for Custom only when there are none', async () => {
    const api = statefulExercisesApi();
    const user = userEvent.setup();
    renderPage();
    await listItems();
    await user.click(screen.getByRole('switch', { name: 'Custom only' }));
    expect(
      await screen.findByRole('heading', { name: 'No custom exercises yet' })
    ).toBeInTheDocument();
    expect(api.calls.some((c) => c.path.includes('custom=true'))).toBe(true);
  });

  it('opens a detail drawer with the requirement groups', async () => {
    statefulExercisesApi();
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Barbell bench press/ }));

    const drawer = await screen.findByRole('dialog', { name: 'Barbell bench press' });
    const reqs = await within(drawer).findByRole('list', { name: 'Requirements' });
    expect(within(reqs).getByText(/Barbell/)).toBeInTheDocument();
    expect(within(reqs).getByText(/One of: Flat bench, Adjustable bench/)).toBeInTheDocument();
    expect(within(drawer).getByText('Chest')).toBeInTheDocument();
    expect(within(drawer).getByText('Horizontal push')).toBeInTheDocument();

    await user.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Barbell bench press' })).toBeNull()
    );
  });

  it('says a bodyweight exercise needs no equipment', async () => {
    statefulExercisesApi();
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Push-up/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Push-up' });
    expect(await within(drawer).findByText('Needs no equipment.')).toBeInTheDocument();
    expect(within(drawer).getByText('Also called')).toBeInTheDocument();
  });

  it('creates a custom exercise that then appears with a Custom chip', async () => {
    const api = statefulExercisesApi();
    const user = userEvent.setup();
    renderPage();
    await listItems();

    await user.click(screen.getByRole('button', { name: 'New custom exercise' }));
    const dialog = screen.getByRole('dialog', { name: 'New custom exercise' });
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Sled push');

    await user.click(within(dialog).getByRole('combobox', { name: /Primary muscles/ }));
    await user.click(await screen.findByRole('option', { name: 'Quads' }));

    await user.click(within(dialog).getByRole('combobox', { name: /Movement pattern/ }));
    await user.click(await screen.findByRole('option', { name: 'Carry' }));

    await user.click(within(dialog).getByRole('combobox', { name: /Tracking/ }));
    await user.click(await screen.findByRole('option', { name: 'Distance and time' }));

    await user.click(within(dialog).getByRole('combobox', { name: /Needs equipment/ }));
    await user.click(await screen.findByRole('option', { name: DUMBBELLS.name }));

    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'New custom exercise' })).toBeNull()
    );
    const row = await screen.findByRole('button', { name: /Sled push/ });
    expect(within(row).getByText('Custom')).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Sled push',
      primaryMuscles: ['quads'],
      secondaryMuscles: [],
      movementPattern: 'carry',
      trackingMode: 'distance_time',
      isUnilateral: false,
      isBodyweight: false,
      notes: null,
      requirements: [{ equipmentTypeIds: [DUMBBELLS.id] }],
    });
  });

  it('refuses to create without a name, a primary muscle and a pattern', async () => {
    const api = statefulExercisesApi();
    const user = userEvent.setup();
    renderPage();
    await listItems();
    await user.click(screen.getByRole('button', { name: 'New custom exercise' }));
    const dialog = screen.getByRole('dialog', { name: 'New custom exercise' });
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeInTheDocument();
    expect(within(dialog).getByText('Pick at least one primary muscle.')).toBeInTheDocument();
    expect(within(dialog).getByText('Pick a movement pattern.')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('does not offer create without exercises:write', async () => {
    statefulExercisesApi();
    renderPage({ permissions: withoutPermission('exercises:write') });
    await listItems();
    expect(screen.queryByRole('button', { name: 'New custom exercise' })).toBeNull();
  });

  it('explains the library is unavailable without exercises:read', () => {
    renderPage({ permissions: withoutPermission('exercises:read') });
    expect(screen.getByText(EXERCISES_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('has no axe violations', async () => {
    statefulExercisesApi();
    const { container } = renderPage();
    await listItems();
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
