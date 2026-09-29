/**
 * `StartWorkoutDialog` (E4.3): default gym preselected, "No gym", the
 * read-only readiness card (present only with a check-in, never blocking),
 * and the `existing: true` path.
 */
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { StartWorkoutDialog } from '../../../components/train/StartWorkoutDialog';
import { mockGymDetail, toSummary } from '../../mocks/fixtures/gyms';
import { mockCheckIn, MOCK_CHECK_IN_TODAY } from '../../mocks/fixtures/checkIns';
import { mockWorkout, statefulWorkoutsApi } from '../../mocks/fixtures/workouts';

const home = mockGymDetail({ name: 'Home Gym', isDefault: true });
const hotel = mockGymDetail({ name: 'Hotel', isDefault: false });
const gymRefs = [home, hotel].map((g) => ({ id: g.id, name: g.name }));

function serveGyms(gyms = [home, hotel]) {
  server.use(http.get('*/api/gyms', () => HttpResponse.json({ data: gyms.map(toSummary) })));
}

function serveCheckIn(withCheckIn: boolean) {
  server.use(
    http.get('*/api/check-ins/today', () =>
      HttpResponse.json({ data: { date: MOCK_CHECK_IN_TODAY, checkIn: withCheckIn ? mockCheckIn() : null } }),
    ),
  );
}

function renderDialog() {
  const onStarted = vi.fn();
  const onClose = vi.fn();
  render(<StartWorkoutDialog open onClose={onClose} onStarted={onStarted} />);
  return { onStarted, onClose };
}

describe('StartWorkoutDialog', () => {
  it('preselects the default gym and starts there', async () => {
    serveGyms();
    serveCheckIn(false);
    const api = statefulWorkoutsApi([], { gyms: gymRefs, defaultGymId: home.id });
    const user = userEvent.setup();
    const { onStarted } = renderDialog();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Gym' })).toHaveTextContent('Home Gym'));
    await user.type(screen.getByRole('textbox', { name: 'Name (optional)' }), 'Push day');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(api.calls[0].body).toEqual({ name: 'Push day', gymId: home.id });
    expect(onStarted.mock.calls[0][0]).toMatchObject({ existing: false, gymId: home.id });
  });

  it('"No gym / bodyweight" clears the default the API applied', async () => {
    serveGyms();
    serveCheckIn(false);
    const api = statefulWorkoutsApi([], { gyms: gymRefs, defaultGymId: home.id });
    const user = userEvent.setup();
    const { onStarted } = renderDialog();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Gym' })).toHaveTextContent('Home Gym'));
    await user.click(screen.getByRole('combobox', { name: 'Gym' }));
    await user.click(screen.getByRole('option', { name: 'No gym / bodyweight' }));
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(api.calls[0].body).toEqual({});
    expect(api.calls[1]).toMatchObject({ method: 'PATCH', body: { gymId: null } });
    expect(onStarted.mock.calls[0][0]).toMatchObject({ gymId: null });
  });

  it('shows today\'s readiness read-only, and Start still works', async () => {
    serveGyms();
    serveCheckIn(true);
    statefulWorkoutsApi([], { gyms: gymRefs });
    const user = userEvent.setup();
    const { onStarted } = renderDialog();
    const card = await screen.findByRole('region', { name: 'Readiness' });
    expect(card).toHaveTextContent('Energy 4/5 · Sleep 3/5 · Soreness 2/5 · Stress 3/5');
    expect(card).toHaveTextContent('Big presentation');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
  });

  it('has no readiness card without a check-in', async () => {
    serveGyms();
    serveCheckIn(false);
    renderDialog();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Gym' })).toHaveTextContent('Home Gym'));
    expect(screen.queryByRole('region', { name: 'Readiness' })).toBeNull();
  });

  it('with a workout already running, answers with it (existing: true)', async () => {
    serveGyms();
    serveCheckIn(false);
    const running = mockWorkout({ name: 'Morning' });
    statefulWorkoutsApi([running], { gyms: gymRefs });
    const user = userEvent.setup();
    const { onStarted } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(onStarted.mock.calls[0][0]).toMatchObject({ id: running.id, existing: true });
  });

  it('without gyms offers "Add a gym" but never requires one', async () => {
    serveGyms([]);
    serveCheckIn(false);
    renderDialog();
    expect(await screen.findByRole('link', { name: 'Add a gym' })).toHaveAttribute('href', '/gyms');
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
  });

  it('has no axe violations', async () => {
    serveGyms();
    serveCheckIn(true);
    renderDialog();
    await screen.findByRole('region', { name: 'Readiness' });
    const results = await axe(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
