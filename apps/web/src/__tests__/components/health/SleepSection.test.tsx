/** The Health page's Sleep section (#283 scope update): range, nights, stage bars, empty state. */
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, within } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { SleepSection } from '../../../components/health/SleepSection';
import { localDateIn } from '../../../utils/localDates';
import { addDays } from '../../../utils/goalFormat';
import { mockSleepSession } from '../../mocks/fixtures/sleep';

describe('SleepSection', () => {
  it('asks for the last 14 nights ending today in the profile time zone', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      http.get('*/api/sleep', ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json({ data: [] });
      }),
    );
    render(<SleepSection timeZone="America/Costa_Rica" />);
    expect(await screen.findByText(/No sleep recorded in the last 14 nights/)).toBeInTheDocument();
    const today = localDateIn('America/Costa_Rica');
    expect(seen[0].get('to')).toBe(today);
    expect(seen[0].get('from')).toBe(addDays(today, -13));
  });

  it('renders each night with its duration, stage bar and the Health Connect label', async () => {
    const synced = mockSleepSession();
    const manual = mockSleepSession({
      id: 'slp22222-0000-4000-8000-000000000002',
      localDate: '2026-09-28',
      durationMinutes: 400,
      awakeMinutes: null,
      lightMinutes: null,
      deepMinutes: null,
      remMinutes: null,
      origin: 'manual',
      provider: null,
    });
    server.use(http.get('*/api/sleep', () => HttpResponse.json({ data: [synced, manual] })));
    render(<SleepSection timeZone={null} />);

    const list = await screen.findByRole('list', { name: 'Sleep, last 14 nights' });
    const first = within(list).getByTestId(`sleep-${synced.id}`);
    expect(first).toHaveTextContent('7h 30m asleep');
    expect(within(first).getByTestId('health-connect-chip')).toHaveTextContent('Health Connect');
    const bar = within(first).getByRole('img');
    expect(bar).toHaveAccessibleName('Stages: Awake 30m, Light 4h, Deep 1h 30m, REM 2h');
    const segments = bar.querySelectorAll('[data-stage]');
    expect(Array.from(segments).map((s) => s.getAttribute('data-stage'))).toEqual(['awake', 'light', 'deep', 'rem']);

    const second = within(list).getByTestId(`sleep-${manual.id}`);
    expect(second).toHaveTextContent('6h 40m asleep');
    expect(within(second).queryByTestId('health-connect-chip')).toBeNull();
    expect(within(second).queryByRole('img')).toBeNull();
  });

  it('offers a retry when the request fails', async () => {
    server.use(
      http.get('*/api/sleep', () =>
        HttpResponse.json({ statusCode: 500, message: 'Boom' }, { status: 500 }),
      ),
    );
    render(<SleepSection timeZone={null} />);
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
