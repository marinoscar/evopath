import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  AI_CONFIG_DISABLED,
  AiConfigContext,
  useAiConfig,
  useAiFeatures,
  type UseAiConfigReturn,
} from '../../hooks/useAiConfig';
import { AiConfigProvider } from '../../contexts/AiConfigContext';
import { getAiConfig } from '../../services/ai';
import { ApiError } from '../../services/api';
import { mockAiPublicConfigEnabled } from '../mocks/fixtures/ai';

/**
 * `useAiConfig` — issue #425, epic #419. Mirrors `useNotificationConfig`'s
 * suite, plus the three things that differ: it fails CLOSED (config is never
 * null, and is AI-disabled until known), a refresh does not flip `isLoading`,
 * and it reads the shell provider's single fetch when one is mounted.
 */

vi.mock('../../services/ai', () => ({
  getAiConfig: vi.fn(),
}));

const mockGetAiConfig = vi.mocked(getAiConfig);

function withValue(value: UseAiConfigReturn | null) {
  return ({ children }: { children: ReactNode }) =>
    createElement(AiConfigContext.Provider, { value }, children);
}

describe('useAiConfig — standalone (no provider)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts loading with the fail-closed config, not null', () => {
    mockGetAiConfig.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useAiConfig());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.config).toEqual(AI_CONFIG_DISABLED);
    expect(result.current.config.enabled).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('populates the config from GET /ai/config', async () => {
    mockGetAiConfig.mockResolvedValue(mockAiPublicConfigEnabled);

    const { result } = renderHook(() => useAiConfig());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.config).toEqual(mockAiPublicConfigEnabled);
    expect(result.current.error).toBeNull();
    expect(mockGetAiConfig).toHaveBeenCalledTimes(1);
  });

  it('fails closed: a failed first fetch leaves AI disabled and reports the ApiError message', async () => {
    mockGetAiConfig.mockRejectedValue(new ApiError('Server exploded', 500));

    const { result } = renderHook(() => useAiConfig());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.config.enabled).toBe(false);
    expect(result.current.error).toBe('Server exploded');
  });

  it('uses a generic message for a non-ApiError failure', async () => {
    mockGetAiConfig.mockRejectedValue(new TypeError('Failed to fetch'));

    const { result } = renderHook(() => useAiConfig());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('Failed to load AI configuration');
    expect(result.current.config.enabled).toBe(false);
  });

  it('refresh re-reads without flipping isLoading back on', async () => {
    mockGetAiConfig.mockResolvedValueOnce(AI_CONFIG_DISABLED);
    const { result } = renderHook(() => useAiConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let resolveSecond!: (value: typeof mockAiPublicConfigEnabled) => void;
    mockGetAiConfig.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSecond = resolve;
      }),
    );

    let refreshing!: Promise<void>;
    act(() => {
      refreshing = result.current.refresh();
    });
    // A route guarded on this value must not unmount its page mid-refresh.
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      resolveSecond(mockAiPublicConfigEnabled);
      await refreshing;
    });
    expect(result.current.config.enabled).toBe(true);
  });

  it('keeps the last known answer when a refresh fails', async () => {
    mockGetAiConfig.mockResolvedValueOnce(mockAiPublicConfigEnabled);
    const { result } = renderHook(() => useAiConfig());
    await waitFor(() => expect(result.current.config.enabled).toBe(true));

    mockGetAiConfig.mockRejectedValueOnce(new ApiError('Blip', 502));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.config.enabled).toBe(true);
    expect(result.current.error).toBe('Blip');
  });

  it('does not update state after unmount', async () => {
    let resolve!: (value: typeof mockAiPublicConfigEnabled) => void;
    mockGetAiConfig.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = renderHook(() => useAiConfig());
    unmount();
    await act(async () => {
      resolve(mockAiPublicConfigEnabled);
    });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('useAiConfig — under a provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the provider value and does not fetch', () => {
    const value: UseAiConfigReturn = {
      config: mockAiPublicConfigEnabled,
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    };

    const { result } = renderHook(() => useAiConfig(), { wrapper: withValue(value) });

    expect(result.current).toBe(value);
    expect(mockGetAiConfig).not.toHaveBeenCalled();
  });

  it('AiConfigProvider fetches ONCE for every consumer below it', async () => {
    mockGetAiConfig.mockResolvedValue(mockAiPublicConfigEnabled);

    const { result } = renderHook(
      () => ({ a: useAiConfig(), b: useAiConfig(), features: useAiFeatures() }),
      { wrapper: ({ children }) => createElement(AiConfigProvider, null, children) },
    );

    await waitFor(() => expect(result.current.a.isLoading).toBe(false));
    expect(result.current.a.config.enabled).toBe(true);
    expect(result.current.b).toBe(result.current.a);
    expect(result.current.features).toEqual({ ai: true });
    expect(mockGetAiConfig).toHaveBeenCalledTimes(1);
  });
});

describe('useAiFeatures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers AI off with no provider, and never fetches', () => {
    const { result } = renderHook(() => useAiFeatures());

    expect(result.current).toEqual({ ai: false });
    expect(mockGetAiConfig).not.toHaveBeenCalled();
  });

  it('follows the provider’s enabled flag', () => {
    const on = renderHook(() => useAiFeatures(), {
      wrapper: withValue({
        config: mockAiPublicConfigEnabled,
        isLoading: false,
        error: null,
        refresh: vi.fn(),
      }),
    });
    expect(on.result.current).toEqual({ ai: true });

    const off = renderHook(() => useAiFeatures(), {
      wrapper: withValue({
        config: AI_CONFIG_DISABLED,
        isLoading: false,
        error: null,
        refresh: vi.fn(),
      }),
    });
    expect(off.result.current).toEqual({ ai: false });
  });
});
