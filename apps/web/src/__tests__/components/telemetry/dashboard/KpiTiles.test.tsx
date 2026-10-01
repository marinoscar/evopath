/**
 * `KpiTiles` — the `unknownRoutes` tile (issue #258): an unknown value is
 * "—", never 0; the summary's `unknownRoutes` block adds the app/anonymous
 * caption and, while the application itself called an unknown route, the
 * warning highlight.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import { render } from '../../../utils/test-utils';
import { resetViewportWidth, setViewportWidth } from '../../../setup';
import { KpiTiles } from '../../../../components/telemetry/dashboard/KpiTiles';
import type { DashboardTile, DashboardUnknownRoutes } from '../../../../services/telemetryDashboard';

const tile = (value: number | null, previous: number | null): DashboardTile => ({
  key: 'unknownRoutes',
  label: 'Unknown API routes',
  value,
  previous,
  unit: 'count',
  sparkline: [],
});

const block = (overrides: Partial<DashboardUnknownRoutes> = {}): DashboardUnknownRoutes => ({
  requests: 15,
  bearer: 3,
  anonymous: 12,
  previousRequests: 10,
  previousBearer: 0,
  topRoutes: [],
  truncated: false,
  ...overrides,
});

describe('KpiTiles: unknown API routes (#258)', () => {
  afterEach(() => act(() => resetViewportWidth()));

  it('shows an unknown value as "—", not 0, with no caption or highlight', () => {
    render(<KpiTiles tiles={[tile(null, null)]} />);
    const card = screen.getByTestId('tile-unknownRoutes');
    expect(card).toHaveTextContent('Unknown API routes');
    expect(card).toHaveTextContent('—');
    expect(card).not.toHaveTextContent('0');
    expect(card).not.toHaveAttribute('data-highlight');
    expect(screen.queryByTestId('tile-unknownRoutes-caption')).not.toBeInTheDocument();
  });

  it('formats the count, compares it with the previous window and treats up as bad', () => {
    render(<KpiTiles tiles={[tile(1500, 1000)]} />);
    const card = screen.getByTestId('tile-unknownRoutes');
    expect(card).toHaveTextContent('1,500');
    expect(within(card).getByLabelText('Up 50% vs previous window')).toBeInTheDocument();
  });

  it('highlights the tile and splits the count when the app called an unknown route', () => {
    render(<KpiTiles tiles={[tile(15, 10)]} unknownRoutes={block()} />);
    const card = screen.getByTestId('tile-unknownRoutes');
    expect(card).toHaveAttribute('data-highlight', 'warning');
    expect(screen.getByTestId('tile-unknownRoutes-caption')).toHaveTextContent('3 from the app · 12 anonymous');
  });

  it('keeps anonymous-only traffic neutral, still captioned', () => {
    render(<KpiTiles tiles={[tile(12, 30)]} unknownRoutes={block({ requests: 12, bearer: 0, anonymous: 12 })} />);
    expect(screen.getByTestId('tile-unknownRoutes')).not.toHaveAttribute('data-highlight');
    expect(screen.getByTestId('tile-unknownRoutes-caption')).toHaveTextContent('0 from the app · 12 anonymous');
  });

  it('has no caption when nothing was counted', () => {
    render(<KpiTiles tiles={[tile(0, 0)]} unknownRoutes={block({ requests: 0, bearer: 0, anonymous: 0 })} />);
    expect(screen.getByTestId('tile-unknownRoutes')).not.toHaveAttribute('data-highlight');
    expect(screen.queryByTestId('tile-unknownRoutes-caption')).not.toBeInTheDocument();
  });

  it('shortens the caption on phones', () => {
    act(() => setViewportWidth(390));
    render(<KpiTiles tiles={[tile(15, 10)]} unknownRoutes={block()} />);
    expect(screen.getByTestId('tile-unknownRoutes-caption')).toHaveTextContent('3 app · 12 anon.');
  });

  it('captions only the unknown-routes tile', () => {
    render(
      <KpiTiles
        tiles={[{ ...tile(5, 5), key: 'errorLogs', label: 'Error logs' }, tile(15, 10)]}
        unknownRoutes={block()}
      />,
    );
    expect(screen.getByTestId('tile-errorLogs')).not.toHaveAttribute('data-highlight');
    expect(screen.getAllByTestId(/-caption$/)).toHaveLength(1);
  });
});
