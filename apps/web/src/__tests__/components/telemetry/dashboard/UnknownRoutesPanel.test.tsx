/**
 * `UnknownRoutesPanel` and its helpers (issue #258).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddIcon from '@mui/icons-material/Add';
import { render } from '../../../utils/test-utils';
import { resetViewportWidth, setViewportWidth } from '../../../setup';
import { UnknownRoutesPanel } from '../../../../components/telemetry/dashboard/UnknownRoutesPanel';
import {
  hasUnknownRoutes,
  isUnknownRoutesReason,
  unknownRoutesSql,
} from '../../../../components/telemetry/dashboard/unknownRoutes';
import {
  mockDashboardSummary,
  mockUnknownRoutesTopSql,
  mockUnknownRoutesTotalsSql,
} from '../../../mocks/fixtures/telemetryDashboard';

const unknownRoutes = mockDashboardSummary.unknownRoutes!;

describe('UnknownRoutesPanel', () => {
  afterEach(() => act(() => resetViewportWidth()));

  it('lists METHOD + route, the count and where the requests came from', () => {
    render(<UnknownRoutesPanel unknownRoutes={unknownRoutes} sql={[mockUnknownRoutesTopSql]} />);
    const panel = screen.getByRole('region', { name: 'Unknown API routes' });
    expect(within(panel).getByTestId('unknown-routes-summary')).toHaveTextContent(
      '15 requests to routes this API does not have: 3 from the app, 12 anonymous.',
    );
    const items = within(within(panel).getByRole('list', { name: 'Unknown API routes' })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('GET /api/coach/messages');
    expect(within(items[0]).getByTestId('unknown-route-source')).toHaveTextContent('app');
    expect(within(items[0]).getByLabelText('3 requests')).toBeInTheDocument();
    expect(items[1]).toHaveTextContent('GET /api/.env');
    expect(within(items[1]).getByTestId('unknown-route-source')).toHaveTextContent('anonymous');
    expect(within(items[1]).getByLabelText('12 requests')).toBeInTheDocument();
    expect(screen.queryByText(/most-hit are listed/)).not.toBeInTheDocument();
  });

  it('explains a version skew only when the app made such requests', () => {
    const { rerender } = render(<UnknownRoutesPanel unknownRoutes={unknownRoutes} sql={[]} />);
    expect(screen.getByTestId('unknown-routes-summary')).toHaveTextContent(/web and API versions differ/);
    rerender(
      <UnknownRoutesPanel
        unknownRoutes={{ ...unknownRoutes, bearer: 0, anonymous: 15, topRoutes: [unknownRoutes.topRoutes[1]] }}
        sql={[]}
      />,
    );
    expect(screen.getByTestId('unknown-routes-summary')).not.toHaveTextContent(/versions differ/);
  });

  it('says when the list was cut short', () => {
    render(<UnknownRoutesPanel unknownRoutes={{ ...unknownRoutes, truncated: true }} sql={[]} />);
    expect(screen.getByText(/most-hit are listed/)).toBeInTheDocument();
  });

  it('hands its SQL to the header actions, folded into ⋮ on phones', async () => {
    act(() => setViewportWidth(390));
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <UnknownRoutesPanel
        unknownRoutes={unknownRoutes}
        sql={[mockUnknownRoutesTopSql, mockUnknownRoutesTotalsSql]}
        actions={[{ key: 'x', label: 'Open in Explorer', icon: <AddIcon />, onClick }]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Unknown API routes actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Open in Explorer' }));
    expect(onClick).toHaveBeenCalledWith([mockUnknownRoutesTopSql, mockUnknownRoutesTotalsSql]);
  });
});

describe('unknownRoutes helpers', () => {
  it('selects the unknown-route statements of the summary, per-route list first', () => {
    expect(unknownRoutesSql(mockDashboardSummary.sql)).toEqual([mockUnknownRoutesTopSql, mockUnknownRoutesTotalsSql]);
    expect(unknownRoutesSql(['SELECT 1', 'SELECT 2'])).toEqual([]);
    expect(unknownRoutesSql(undefined)).toEqual([]);
  });

  it('shows the panel only for a present block that counted a request', () => {
    expect(hasUnknownRoutes(unknownRoutes)).toBe(true);
    expect(hasUnknownRoutes({ ...unknownRoutes, requests: 0 })).toBe(false);
    expect(hasUnknownRoutes(undefined)).toBe(false);
  });

  it('recognizes the verdict reason about unknown routes', () => {
    expect(isUnknownRoutesReason('3 requests to unknown API routes (GET /api/coach/messages)')).toBe(true);
    expect(isUnknownRoutesReason('1 request to unknown API routes')).toBe(true);
    expect(isUnknownRoutesReason('5xx rate 3.2% on GET /api/users/:id')).toBe(false);
  });
});
