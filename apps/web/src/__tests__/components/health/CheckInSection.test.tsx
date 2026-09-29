import { describe, it, expect, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { CheckInSection } from '../../../components/health/CheckInSection';
import { resetMeasurementCatalogCache } from '../../../hooks/useMeasurementCatalog';
import { NO_WRITE_PERMISSION_TOOLTIP } from '../../../components/health/LogMeasurementButton';
import { mockCheckIn } from '../../mocks/fixtures/checkIns';
import { statefulCheckInApi } from '../../mocks/fixtures/checkInApi';

const section = () => screen.getByRole('region', { name: 'Daily check-in' });

describe('CheckInSection', () => {
  beforeEach(() => {
    resetMeasurementCatalogCache();
  });

  it('shows "Not done today", a Check in button and an empty recent list', async () => {
    statefulCheckInApi();
    render(<CheckInSection canWrite />);
    expect(await within(section()).findByText('Not done today')).toBeInTheDocument();
    expect(within(section()).getByRole('button', { name: 'Check in' })).toBeEnabled();
    expect(await screen.findByText('No check-ins in the last 14 days.')).toBeInTheDocument();
  });

  it("shows today's scores as chips with the note, and the recent days inline", async () => {
    statefulCheckInApi([
      mockCheckIn(),
      mockCheckIn({ date: '2026-09-28', energy: 2, sleepQuality: null, soreness: 4, stress: null, note: null }),
    ]);
    render(<CheckInSection canWrite />);
    const chips = await within(section()).findByRole('list', { name: 'Scores' });
    expect(within(chips).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Energy 4',
      'Sleep quality 3',
      'Muscle soreness 2',
      'Stress 3',
    ]);
    expect(within(section()).getByText('Big presentation')).toBeInTheDocument();
    expect(within(section()).getByRole('button', { name: 'Edit check-in' })).toBeInTheDocument();

    const recent = await screen.findByRole('list', { name: 'Recent check-ins' });
    const rows = within(recent).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Today');
    expect(rows[0]).toHaveTextContent('Energy 4 · Sleep quality 3 · Muscle soreness 2 · Stress 3');
    expect(rows[1]).toHaveTextContent('Yesterday');
    expect(rows[1]).toHaveTextContent('Energy 2 · Muscle soreness 4');
  });

  it('checks in, then edits the same day: still one check-in', async () => {
    const api = statefulCheckInApi();
    const user = userEvent.setup();
    render(<CheckInSection canWrite />);

    await user.click(await within(section()).findByRole('button', { name: 'Check in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Daily check-in' });
    await within(dialog).findByRole('group', { name: /^Energy/ });
    const pick = (name: RegExp, n: number) =>
      within(within(dialog).getByRole('group', { name })).getByRole('button', { name: String(n) });
    await user.click(pick(/^Energy/, 4));
    await user.click(pick(/^Sleep quality/, 3));
    await user.click(pick(/^Muscle soreness/, 2));
    await user.click(pick(/^Stress/, 3));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await within(section()).findByText('Energy 4')).toBeInTheDocument();
    expect(api.puts).toEqual([
      { date: '2026-09-29', body: { energy: 4, sleepQuality: 3, soreness: 2, stress: 3, note: null } },
    ]);

    await user.click(within(section()).getByRole('button', { name: 'Edit check-in' }));
    const again = await screen.findByRole('dialog', { name: 'Daily check-in' });
    const energy = within(again).getByRole('group', { name: /^Energy/ });
    expect(within(energy).getByRole('button', { name: '4' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(energy).getByRole('button', { name: '5' }));
    await user.click(within(again).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await within(section()).findByText('Energy 5')).toBeInTheDocument();
    expect(api.days.size).toBe(1);
    const recent = await screen.findByRole('list', { name: 'Recent check-ins' });
    await waitFor(() => expect(within(recent).getAllByRole('listitem')).toHaveLength(1));
    expect(within(recent).getByRole('listitem')).toHaveTextContent('Energy 5');
  });

  it('deletes the day after confirming and returns to "Not done today"', async () => {
    const api = statefulCheckInApi([mockCheckIn()]);
    const user = userEvent.setup();
    render(<CheckInSection canWrite />);
    await user.click(await within(section()).findByRole('button', { name: 'Edit check-in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Daily check-in' });
    await within(dialog).findByRole('group', { name: /^Energy/ });
    await user.click(within(dialog).getByRole('button', { name: 'Delete check-in' }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await within(section()).findByText('Not done today')).toBeInTheDocument();
    expect(api.deletes).toEqual(['2026-09-29']);
    expect(await screen.findByText('No check-ins in the last 14 days.')).toBeInTheDocument();
  });

  it('reloads after a 409 and keeps the dialog open with the message', async () => {
    const api = statefulCheckInApi([mockCheckIn()]);
    const user = userEvent.setup();
    render(<CheckInSection canWrite />);
    await user.click(await within(section()).findByRole('button', { name: 'Edit check-in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Daily check-in' });
    await within(dialog).findByRole('group', { name: /^Energy/ });

    // Another device saves first.
    api.days.set('2026-09-29', mockCheckIn({ energy: 1, updatedAt: '2026-09-29T10:00:00.000Z' }));
    api.failNextPut = 409;
    const energy = within(dialog).getByRole('group', { name: /^Energy/ });
    await user.click(within(energy).getByRole('button', { name: '5' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText(/This check-in was updated elsewhere/)).toBeInTheDocument();
    await waitFor(() => expect(within(energy).getByRole('button', { name: '1' })).toHaveAttribute('aria-pressed', 'true'));
    // Behind the open dialog, the section shows the reloaded day too.
    const behind = screen.getByRole('region', { name: 'Daily check-in', hidden: true });
    expect(await within(behind).findByText('Energy 1')).toBeInTheDocument();
  });

  it('disables Check in with a tooltip without health_data:write', async () => {
    statefulCheckInApi();
    const user = userEvent.setup();
    render(<CheckInSection canWrite={false} />, {
      wrapperOptions: { user: { ...mockUser, permissions: ['health_data:read'] } },
    });
    const button = await within(section()).findByRole('button', { name: 'Check in' });
    expect(button).toBeDisabled();
    await user.hover(button.parentElement!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(NO_WRITE_PERMISSION_TOOLTIP);
  });

  it('offers Retry when today cannot be loaded', async () => {
    server.use(http.get('*/api/check-ins/today', () => HttpResponse.error()));
    render(<CheckInSection canWrite />);
    expect(await screen.findByText("Could not load today's check-in.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows the unavailable message on a 403', async () => {
    server.use(http.get('*/api/check-ins/today', () => HttpResponse.json({ message: 'Forbidden' }, { status: 403 })));
    render(<CheckInSection canWrite />);
    expect(await screen.findByText('Health data is not available for your account')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check in' })).toBeNull();
  });

  it('has no axe violations', async () => {
    statefulCheckInApi([mockCheckIn(), mockCheckIn({ date: '2026-09-27' })]);
    const { container } = render(<CheckInSection canWrite />);
    await screen.findByRole('list', { name: 'Recent check-ins' });
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
