import { describe, it, expect, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { TodayReadiness } from '../../../components/today/TodayReadiness';
import { TodayCard } from '../../../components/today/TodayCard';
import { TODAY_CARDS } from '../../../config/todayCards';
import { resetMeasurementCatalogCache } from '../../../hooks/useMeasurementCatalog';
import { mockCheckIn } from '../../mocks/fixtures/checkIns';
import { statefulCheckInApi } from '../../mocks/fixtures/checkInApi';

const readinessCard = TODAY_CARDS.find((c) => c.key === 'readiness')!;

describe('TodayReadiness', () => {
  beforeEach(() => {
    resetMeasurementCatalogCache();
  });

  it('asks how you feel, with a Check in button, when there is no check-in today', async () => {
    statefulCheckInApi();
    render(<TodayReadiness />);
    expect(await screen.findByText('How are you feeling today? Takes a few seconds.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check in' })).toBeEnabled();
  });

  it("shows today's four values and an Edit button; no combined score", async () => {
    statefulCheckInApi([mockCheckIn()]);
    render(<TodayReadiness />);
    const chips = await screen.findByRole('list', { name: 'Scores' });
    expect(within(chips).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Energy 4',
      'Sleep quality 3',
      'Muscle soreness 2',
      'Stress 3',
    ]);
    expect(screen.getByText('Big presentation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit check-in' })).toBeInTheDocument();
    expect(screen.queryByText(/readiness score|\/100|%/i)).toBeNull();
  });

  it('checks in from the card and shows the result', async () => {
    const api = statefulCheckInApi();
    const user = userEvent.setup();
    render(<TodayReadiness />);
    await user.click(await screen.findByRole('button', { name: 'Check in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Daily check-in' });
    const energy = await within(dialog).findByRole('group', { name: /^Energy/ });
    await user.click(within(energy).getByRole('button', { name: '3' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Energy 3')).toBeInTheDocument();
    expect(api.puts[0]).toEqual({
      date: '2026-09-29',
      body: { energy: 3, sleepQuality: null, soreness: null, stress: null, note: null },
    });
  });

  it('returns to the prompt after the check-in is deleted', async () => {
    statefulCheckInApi([mockCheckIn()]);
    const user = userEvent.setup();
    render(<TodayReadiness />);
    await user.click(await screen.findByRole('button', { name: 'Edit check-in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Daily check-in' });
    await within(dialog).findByRole('group', { name: /^Energy/ });
    await user.click(within(dialog).getByRole('button', { name: 'Delete check-in' }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('How are you feeling today? Takes a few seconds.')).toBeInTheDocument();
  });

  it('disables Check in without health_data:write', async () => {
    statefulCheckInApi();
    render(<TodayReadiness />, {
      wrapperOptions: { user: { ...mockUser, permissions: ['health_data:read'] } },
    });
    expect(await screen.findByRole('button', { name: 'Check in' })).toBeDisabled();
  });

  it('shows the unavailable message without health_data:read', () => {
    render(<TodayReadiness />, { wrapperOptions: { user: { ...mockUser, permissions: [] } } });
    expect(screen.getByText('Health data is not available for your account')).toBeInTheDocument();
  });

  it('shows the unavailable message on a 403', async () => {
    server.use(http.get('*/api/check-ins/today', () => HttpResponse.json({ message: 'Forbidden' }, { status: 403 })));
    render(<TodayReadiness />);
    expect(await screen.findByText('Health data is not available for your account')).toBeInTheDocument();
  });

  it('offers Retry after a load failure, and recovers', async () => {
    let fail = true;
    server.use(
      http.get('*/api/check-ins/today', () =>
        fail
          ? HttpResponse.error()
          : HttpResponse.json({ data: { date: '2026-09-29', checkIn: mockCheckIn() } }),
      ),
    );
    const user = userEvent.setup();
    render(<TodayReadiness />);
    expect(await screen.findByText("Could not load today's check-in.")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Energy 4')).toBeInTheDocument();
  });

  it('renders inside the Readiness card, keeping the Open Health link, with no axe violations', async () => {
    statefulCheckInApi([mockCheckIn()]);
    const { container } = render(<TodayCard def={readinessCard} />);
    const card = screen.getByRole('region', { name: 'Readiness' });
    expect(await within(card).findByText('Energy 4')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Open Health' })).toHaveAttribute('href', '/health');
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
