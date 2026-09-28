import { describe, it, expect, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  TELEMETRY_CONFIG_DISABLED,
  TelemetryConfigContext,
  isTelemetryOn,
  useTelemetryConfig,
  useTelemetryFeatures,
  type UseTelemetryConfigReturn,
} from '../../hooks/useTelemetryConfig';
import { useSettingsFeatures } from '../../hooks/useSettingsFeatures';
import { AiConfigContext, type UseAiConfigReturn } from '../../hooks/useAiConfig';
import { RequireTelemetryEnabled } from '../../components/common/RequireTelemetryEnabled';
import { render } from '../utils/test-utils';
import { mockAiPublicConfigEnabled } from '../mocks/fixtures/ai';
import {
  mockTelemetryPublicConfigDisabled,
  mockTelemetryPublicConfigEnabled,
} from '../mocks/fixtures/telemetry';

/**
 * `useTelemetryConfig` / `useTelemetryFeatures` / `RequireTelemetryEnabled`
 * (issue #537, epic #528) — the telemetry feature flag, mirroring the AI one.
 */

function telemetryValue(config = mockTelemetryPublicConfigEnabled): UseTelemetryConfigReturn {
  return { config, isLoading: false, error: null, refresh: vi.fn().mockResolvedValue(undefined) };
}

function withTelemetry(value: UseTelemetryConfigReturn | null) {
  return ({ children }: { children: ReactNode }) =>
    createElement(TelemetryConfigContext.Provider, { value }, children);
}

describe('isTelemetryOn', () => {
  it('needs both a store and collection switched on', () => {
    expect(isTelemetryOn({ available: true, enabled: true, assistantEnabled: false })).toBe(true);
    expect(isTelemetryOn({ available: false, enabled: true, assistantEnabled: true })).toBe(false);
    expect(isTelemetryOn({ available: true, enabled: false, assistantEnabled: true })).toBe(false);
  });
});

describe('useTelemetryConfig — standalone', () => {
  it('starts fail-closed and then fetches GET /telemetry/config', async () => {
    server.use(
      http.get('*/api/telemetry/config', () =>
        HttpResponse.json({ data: mockTelemetryPublicConfigEnabled }),
      ),
    );
    const { result } = renderHook(() => useTelemetryConfig());
    expect(result.current.config).toEqual(TELEMETRY_CONFIG_DISABLED);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.config).toEqual(mockTelemetryPublicConfigEnabled);
  });

  it('stays disabled when the first fetch fails', async () => {
    server.use(
      http.get('*/api/telemetry/config', () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useTelemetryConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.config).toEqual(TELEMETRY_CONFIG_DISABLED);
    expect(result.current.error).toBe('boom');
  });

  it('reads the provider value instead of fetching when one is mounted', () => {
    const value = telemetryValue();
    const { result } = renderHook(() => useTelemetryConfig(), { wrapper: withTelemetry(value) });
    expect(result.current).toBe(value);
  });
});

describe('useTelemetryFeatures / useSettingsFeatures', () => {
  it('answers off with no provider, without fetching', () => {
    const { result } = renderHook(() => useTelemetryFeatures());
    expect(result.current).toEqual({ telemetry: false });
  });

  it('answers on only when the provider says available and enabled', () => {
    const on = renderHook(() => useTelemetryFeatures(), { wrapper: withTelemetry(telemetryValue()) });
    expect(on.result.current.telemetry).toBe(true);
    const off = renderHook(() => useTelemetryFeatures(), {
      wrapper: withTelemetry(telemetryValue(mockTelemetryPublicConfigDisabled)),
    });
    expect(off.result.current.telemetry).toBe(false);
  });

  it('merges ai and telemetry into one stable map', () => {
    const ai: UseAiConfigReturn = {
      config: mockAiPublicConfigEnabled,
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        AiConfigContext.Provider,
        { value: ai },
        createElement(TelemetryConfigContext.Provider, { value: telemetryValue() }, children),
      );
    const { result, rerender } = renderHook(() => useSettingsFeatures(), { wrapper });
    expect(result.current).toEqual({ ai: true, telemetry: true });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe('RequireTelemetryEnabled', () => {
  it('renders its children while telemetry is on', () => {
    render(<RequireTelemetryEnabled>inside</RequireTelemetryEnabled>, {
      wrapperOptions: { telemetryEnabled: true },
    });
    expect(screen.getByText('inside')).toBeInTheDocument();
  });

  it('renders the fallback while telemetry is off', () => {
    render(
      <RequireTelemetryEnabled fallback={<span>fallback</span>}>inside</RequireTelemetryEnabled>,
      { wrapperOptions: { telemetryEnabled: false } },
    );
    expect(screen.getByText('fallback')).toBeInTheDocument();
    expect(screen.queryByText('inside')).not.toBeInTheDocument();
  });

  it('treats an available store with collection off as off', () => {
    render(
      <RequireTelemetryEnabled fallback={<span>fallback</span>}>inside</RequireTelemetryEnabled>,
      { wrapperOptions: { telemetryEnabled: { available: true, enabled: false, assistantEnabled: true } } },
    );
    expect(screen.getByText('fallback')).toBeInTheDocument();
  });
});
