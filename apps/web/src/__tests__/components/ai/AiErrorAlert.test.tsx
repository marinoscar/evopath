import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import {
  AiErrorAlert,
  AI_KEYS_PATH,
  aiErrorCopy,
  formatRetryAfter,
} from '../../../components/ai/AiErrorAlert';
import { AiConfigContext, type UseAiConfigReturn } from '../../../hooks/useAiConfig';
import { mockAiPublicConfigEnabled } from '../../mocks/fixtures/ai';
import { toAiErrorInfo } from '../../../services/aiErrors';
import type { AiErrorInfo } from '../../../services/aiErrors';
import { ApiError } from '../../../services/api';

/**
 * `AiErrorAlert` — issue #434. The single code → copy mapping every AI
 * surface renders through: each code gets its own title, and the two key
 * codes link to `/settings/ai`.
 */

function renderAlert(error: AiErrorInfo, refresh = vi.fn().mockResolvedValue(undefined)) {
  const value: UseAiConfigReturn = {
    config: mockAiPublicConfigEnabled,
    isLoading: false,
    error: null,
    refresh,
  };
  render(
    <AiConfigContext.Provider value={value}>
      <AiErrorAlert error={error} />
    </AiConfigContext.Provider>,
  );
  return { refresh };
}

const CASES: { code: string; title: string; link: boolean }[] = [
  { code: 'AI_KEY_REQUIRED', title: 'Add your API key', link: true },
  { code: 'AI_KEY_INVALID', title: 'Your key was rejected by the provider', link: true },
  { code: 'AI_MODEL_NOT_ENABLED', title: "This model isn't available to you", link: false },
  { code: 'AI_MODEL_NOT_REACHABLE', title: "This model isn't available to you", link: true },
  { code: 'AI_DISABLED', title: 'AI is disabled by your administrator', link: false },
  { code: 'AI_CONTENT_FILTERED', title: 'Blocked by the content filter', link: false },
  { code: 'AI_PROVIDER_UNAVAILABLE', title: 'The provider is unavailable', link: false },
  { code: 'AI_STRUCTURED_OUTPUT_INVALID', title: "The answer didn't match the schema", link: false },
  { code: 'AI_PROVIDER_DISABLED', title: 'This provider is disabled', link: false },
  { code: 'AI_CAPABILITY_UNSUPPORTED', title: "This model can't do that", link: false },
  { code: 'AI_INVALID_REQUEST', title: 'The request was invalid', link: false },
  { code: 'AI_TOOL_DISABLED', title: "This tool isn't enabled", link: false },
  { code: 'AI_STORAGE_UNAVAILABLE', title: "File storage isn't available", link: false },
  { code: 'AI_REALTIME_DISABLED', title: 'Voice sessions are unavailable', link: false },
];

describe('AiErrorAlert', () => {
  it.each(CASES)('renders the specific copy for $code', ({ code, title, link }) => {
    renderAlert({ code, message: 'server message' });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-ai-error-code', code);
    expect(screen.getByText(title)).toBeInTheDocument();

    const action = screen.queryByRole('link');
    if (link) {
      expect(action).toHaveAttribute('href', AI_KEYS_PATH);
    } else {
      expect(action).not.toBeInTheDocument();
    }
  });

  it('turns retryAfterMs into whole seconds for AI_RATE_LIMITED', () => {
    renderAlert({ code: 'AI_RATE_LIMITED', message: 'slow down', retryAfterMs: 12_300 });
    expect(screen.getByText('Provider rate limit — retry in 13 s')).toBeInTheDocument();
  });

  it('says "retry shortly" when the provider gave no back-off hint', () => {
    renderAlert({ code: 'AI_RATE_LIMITED', message: 'slow down' });
    expect(screen.getByText('Provider rate limit — retry shortly')).toBeInTheDocument();
  });

  it('asks the shell to re-read the AI config on AI_DISABLED', () => {
    const { refresh } = renderAlert({ code: 'AI_DISABLED', message: 'AI is disabled' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('says voice sessions are off, and re-reads the AI config, on AI_REALTIME_DISABLED (#449)', () => {
    const { refresh } = renderAlert({ code: 'AI_REALTIME_DISABLED', message: 'Realtime sessions are disabled' });
    expect(screen.getByText('Voice sessions are turned off by your administrator.')).toBeInTheDocument();
    // The re-read is what hides the playground's Voice mode.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not refresh the AI config for any other code', () => {
    const { refresh } = renderAlert({ code: 'AI_KEY_REQUIRED', message: 'x' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('falls back to a generic title plus the server message for an unknown or missing code', () => {
    renderAlert({ code: null, message: 'Network exploded' });
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Network exploded')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveAttribute('data-ai-error-code', 'unknown');
  });

  it('shows the server detail under the mapped copy', () => {
    renderAlert({ code: 'AI_CONTENT_FILTERED', message: 'Flagged: violence' });
    expect(screen.getByText('Flagged: violence')).toBeInTheDocument();
  });

  it('exposes the copy as a pure function', () => {
    expect(aiErrorCopy({ code: 'AI_KEY_REQUIRED', message: '' }).action).toEqual({
      label: 'Add API key',
      to: AI_KEYS_PATH,
    });
  });

  describe('a deployment limit (#450)', () => {
    it('names the limit and says when to retry, with no raw server message', () => {
      renderAlert({
        code: 'AI_RATE_LIMITED',
        message: 'The per-minute AI request limit (20) has been reached.',
        retryAfterMs: 42_100,
        limit: 'perUser.requestsPerMinute',
        max: 20,
        window: 'minute',
      });
      expect(screen.getByText('Limit reached (20 requests per minute)')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Try again in 43 seconds. This limit is set by your administrator.',
      );
      expect(screen.queryByText(/has been reached/)).not.toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });

    it('a daily limit says it resets at midnight UTC, in hours', () => {
      renderAlert({
        code: 'AI_RATE_LIMITED',
        message: 'x',
        retryAfterMs: 5 * 60 * 60 * 1000 - 1,
        limit: 'perUser.requestsPerDay',
        max: 1000,
        window: 'day',
      });
      expect(screen.getByText('Limit reached (1,000 requests per day)')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Try again in 5 hours. Daily limits reset at midnight UTC.',
      );
    });

    it("an organization-key limit offers the user's own key as the way out", () => {
      const copy = aiErrorCopy({
        code: 'AI_RATE_LIMITED',
        message: 'x',
        retryAfterMs: 90_000,
        limit: 'orgKey.tokensPerDayPerUser',
        max: 50_000,
        window: 'day',
      });
      expect(copy.title).toBe("Limit reached (50,000 tokens per day on the organization's key)");
      expect(copy.body).toMatch(/^Try again in 2 minutes\..*Adding your own API key lifts it\.$/);
      expect(copy.action).toEqual({ label: 'Add API key', to: AI_KEYS_PATH });
    });

    it('a per-model limit is worded for the model', () => {
      expect(
        aiErrorCopy({
          code: 'AI_RATE_LIMITED',
          message: 'x',
          limit: 'perModel.requestsPerMinutePerUser',
          max: 1,
        }).title,
      ).toBe('Limit reached (1 request per minute for this model)');
    });

    it('formats the back-off in seconds, minutes or hours, rounding up', () => {
      expect(formatRetryAfter(1)).toBe('1 second');
      expect(formatRetryAfter(89_000)).toBe('89 seconds');
      expect(formatRetryAfter(90_000)).toBe('2 minutes');
      expect(formatRetryAfter(60 * 60_000)).toBe('60 minutes');
      expect(formatRetryAfter(3 * 60 * 60_000)).toBe('3 hours');
    });

    it('toAiErrorInfo reads limit, max and window off a 429', () => {
      const err = new ApiError('The per-minute AI request limit (20) has been reached.', 429, 'TOO_MANY_REQUESTS', {
        reason: 'AI_RATE_LIMITED',
        limit: 'perUser.requestsPerMinute',
        max: 20,
        window: 'minute',
        retryAfterMs: 1_000,
        provider: 'openai',
      });
      expect(toAiErrorInfo(err)).toEqual({
        code: 'AI_RATE_LIMITED',
        message: 'The per-minute AI request limit (20) has been reached.',
        status: 429,
        retryAfterMs: 1_000,
        limit: 'perUser.requestsPerMinute',
        max: 20,
        window: 'minute',
      });
    });
  });
});
