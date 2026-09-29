import { describe, it, expect, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { TodayBodySnapshot } from '../../../components/today/TodayBodySnapshot';
import { TodayCard } from '../../../components/today/TodayCard';
import { TODAY_CARDS } from '../../../config/todayCards';
import { resetMeasurementCatalogCache } from '../../../hooks/useMeasurementCatalog';
import { mockHealthProfileSaved } from '../../mocks/fixtures/health';
import { mockLatest, mockMeasurement } from '../../mocks/fixtures/measurements';

const bodyCard = TODAY_CARDS.find((c) => c.key === 'body')!;

function withLatest(items: ReturnType<typeof mockLatest>) {
  server.use(http.get('*/api/measurements/latest', () => HttpResponse.json({ data: { items } })));
}

describe('TodayBodySnapshot', () => {
  beforeEach(() => {
    resetMeasurementCatalogCache();
    server.use(http.get('*/api/health-profile', () => HttpResponse.json({ data: mockHealthProfileSaved })));
  });

  it('shows the latest weight, body fat and waist with their dates, in the user units', async () => {
    const today = new Date().toISOString();
    withLatest(
      mockLatest({
        weight: { latest: mockMeasurement('weight', 94.5327, { measuredAt: today }) },
        body_fat_pct: { latest: mockMeasurement('body_fat_pct', 27.8, { measuredAt: today }) },
        waist_circumference: { latest: mockMeasurement('waist_circumference', 81.28, { measuredAt: today }) },
        resting_hr: { latest: mockMeasurement('resting_hr', 58) },
      }),
    );
    render(<TodayBodySnapshot />);
    expect(await screen.findByText('208.4 lb')).toBeInTheDocument();
    expect(screen.getByText('27.8%')).toBeInTheDocument();
    expect(screen.getByText('32.0 in')).toBeInTheDocument();
    expect(screen.getAllByText('Today')).toHaveLength(3);
    // Only the three body values.
    expect(screen.queryByText(/bpm/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Log measurement' })).toBeEnabled();
  });

  it('shows only the metrics that have a reading', async () => {
    withLatest(mockLatest({ weight: { latest: mockMeasurement('weight', 94.5327) } }));
    render(<TodayBodySnapshot />);
    expect(await screen.findByText('208.4 lb')).toBeInTheDocument();
    expect(screen.queryByText('Body fat')).toBeNull();
  });

  it('offers "Log your first weight" with nothing logged, opening the dialog and refreshing on save', async () => {
    let items = mockLatest();
    server.use(http.get('*/api/measurements/latest', () => HttpResponse.json({ data: { items } })));
    const user = userEvent.setup();
    render(<TodayBodySnapshot />);

    await user.click(await screen.findByRole('button', { name: 'Log your first weight' }));
    const weight = await screen.findByRole('textbox', { name: 'Weight' });
    await waitFor(() => expect(weight).toHaveFocus());

    items = mockLatest({ weight: { latest: mockMeasurement('weight', 94.5327) } });
    await user.keyboard('208.4{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('208.4 lb')).toBeInTheDocument();
  });

  it('disables Log without health_data:write', async () => {
    render(<TodayBodySnapshot />, {
      wrapperOptions: { user: { ...mockUser, permissions: ['health_data:read'] } },
    });
    expect(await screen.findByRole('button', { name: 'Log your first weight' })).toBeDisabled();
  });

  it('shows the unavailable message without health_data:read', () => {
    render(<TodayBodySnapshot />, { wrapperOptions: { user: { ...mockUser, permissions: [] } } });
    expect(screen.getByText('Health data is not available for your account')).toBeInTheDocument();
  });

  it('shows the unavailable message on a 403', async () => {
    server.use(
      http.get('*/api/measurements/latest', () => HttpResponse.json({ message: 'Forbidden' }, { status: 403 })),
    );
    render(<TodayBodySnapshot />);
    expect(await screen.findByText('Health data is not available for your account')).toBeInTheDocument();
  });

  it('offers Retry after a load failure', async () => {
    let fail = true;
    server.use(
      http.get('*/api/measurements/latest', () =>
        fail ? HttpResponse.error() : HttpResponse.json({ data: { items: mockLatest() } }),
      ),
    );
    const user = userEvent.setup();
    render(<TodayBodySnapshot />);
    expect(await screen.findByText('Could not load your measurements.')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Log your first weight' })).toBeInTheDocument();
  });

  it('keeps the TodayCard frame and its Open Health link', async () => {
    const { container } = render(<TodayCard def={bodyCard} />);
    const region = screen.getByRole('region', { name: 'Body snapshot' });
    expect(region).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Health' })).toHaveAttribute('href', '/health');
    await screen.findByRole('button', { name: 'Log your first weight' });
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
