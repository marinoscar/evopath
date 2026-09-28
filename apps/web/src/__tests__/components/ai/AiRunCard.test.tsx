import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { AiRunCard, type AiRunCardProps } from '../../../components/ai/AiRunCard';
import { AiConfigContext, type UseAiConfigReturn } from '../../../hooks/useAiConfig';
import { mockAiPublicConfigEnabled, mockAiRun } from '../../mocks/fixtures/ai';
import type { AiRun } from '../../../services/ai';

/**
 * `AiRunCard` — stale status rendering, issue #509. A failed status READ must
 * not look like a failed RUN: while the hook retries, the card shows a quiet
 * "Reconnecting…" hint and a "(last known)" chip, never an error banner.
 */

const pending: AiRun = { ...mockAiRun, status: 'pending', output: null, completedAt: null };

function renderCard(props: Partial<AiRunCardProps> = {}) {
  const value: UseAiConfigReturn = {
    config: mockAiPublicConfigEnabled,
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  render(
    <AiConfigContext.Provider value={value}>
      <AiRunCard
        prompt="make a picture"
        run={pending}
        error={null}
        isStarting={false}
        isCancelling={false}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
        {...props}
      />
    </AiConfigContext.Provider>,
  );
}

describe('AiRunCard — stale status (#509)', () => {
  it('shows the live status with no hint when not stale', () => {
    renderCard();
    expect(screen.getByTestId('run-status')).toHaveTextContent(/^Queued$/);
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
  });

  it('shows a reconnecting hint and a last-known chip, and no error banner, while stale', () => {
    renderCard({ stale: true });
    expect(screen.getByTestId('run-status')).toHaveTextContent('Queued (last known)');
    expect(screen.getByRole('status')).toHaveTextContent(/Reconnecting… the status shown may be out of date/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeInTheDocument();
  });

  it('once polling gives up, shows the error beside a last-known chip, not a live one', () => {
    renderCard({
      stale: true,
      error: { code: null, message: "Lost contact with the server while checking this run's status." },
    });
    expect(screen.getByTestId('run-status')).toHaveTextContent('Queued (last known)');
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
    expect(screen.getByText(/Lost contact with the server/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('renders a genuinely failed run through its errorCode, unchanged', () => {
    renderCard({ run: { ...pending, status: 'failed', errorCode: 'AI_RATE_LIMITED', errorMessage: 'slow down' } });
    expect(screen.getByTestId('run-status')).toHaveTextContent(/^Failed$/);
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
    expect(screen.getByText(/rate limit/i)).toBeInTheDocument();
  });
});
