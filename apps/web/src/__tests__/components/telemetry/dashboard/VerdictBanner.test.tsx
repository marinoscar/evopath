/**
 * `VerdictBanner` (issue #578, epic #576): every level carries an icon AND a
 * word, never colour alone, in a polite live region.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../utils/test-utils';
import { VerdictBanner } from '../../../../components/telemetry/dashboard/VerdictBanner';
import type { DashboardVerdictLevel } from '../../../../services/telemetryDashboard';

const CASES: [DashboardVerdictLevel, string, string][] = [
  ['healthy', 'Healthy', 'CheckCircleOutlined'],
  ['degraded', 'Degraded', 'WarningAmber'],
  ['critical', 'Critical', 'ErrorOutlineOutlined'],
  ['no_data', 'No telemetry received', 'CloudOffOutlined'],
];

describe('VerdictBanner', () => {
  it.each(CASES)('renders %s with an icon and a text label in a live region', (level, label, icon) => {
    render(<VerdictBanner verdict={{ level, reasons: level === 'healthy' ? [] : ['a reason'] }} />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner).toHaveAttribute('data-level', level);
    expect(banner).toHaveTextContent(label);
    expect(banner.querySelector(`[data-testid="${icon}Icon"]`)).not.toBeNull();
  });

  it('lists every reason on wide screens', () => {
    render(<VerdictBanner verdict={{ level: 'critical', reasons: ['first', 'second'] }} />);
    expect(screen.getByText('first')).toBeVisible();
    expect(screen.getByText('second')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('collapses to one line when compact and expands on tap', async () => {
    const user = userEvent.setup();
    render(<VerdictBanner compact verdict={{ level: 'degraded', reasons: ['first', 'second'] }} />);
    const toggle = screen.getByRole('button', { expanded: false });
    expect(toggle).toHaveTextContent('Degraded · first');
    expect(screen.getByText('second')).not.toBeVisible();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('second')).toBeVisible();
  });

  it('shows a skeleton while loading and the error with Retry on failure', async () => {
    const { rerender } = render(<VerdictBanner verdict={null} isLoading />);
    expect(screen.getByTestId('verdict-skeleton')).toBeInTheDocument();
    let retried = 0;
    rerender(
      <VerdictBanner
        verdict={null}
        error={{ message: 'boom', code: null, reason: 'TELEMETRY_QUERY_FAILED', status: 400, sqlState: null, timeoutMs: null }}
        onRetry={() => (retried += 1)}
      />,
    );
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.getByText('TELEMETRY_QUERY_FAILED')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(retried).toBe(1);
  });

  it('renders an optional action button (#579 "Explain this")', async () => {
    let clicked = 0;
    render(
      <VerdictBanner
        compact
        verdict={{ level: 'critical', reasons: ['first'] }}
        action={{ label: 'Explain this', onClick: () => (clicked += 1) }}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Explain this' }));
    expect(clicked).toBe(1);
  });
});
