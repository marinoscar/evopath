/**
 * The app's telemetry adapters (marinoscar/EnterpriseAppBase#719, `platform/telemetryAdapters.ts`): the
 * packaged telemetry pages see this app's AI switch, its model catalogue (as
 * the four fields the picker shows) and its spinner. Also pins the one type
 * the slice no longer takes from the app: the deploy job's status set is the
 * queue's (`services/jobs.ts`).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { TelemetryStackDeployStatus } from '@marinoscar/platform-contract/telemetry';
import { useTelemetryWebAdapters } from '@marinoscar/platform-web/telemetry/headless';

import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { appTelemetryAdapters, toAssistantModelOption } from '../../platform/telemetryAdapters';
import type { JobStatusName } from '../../services/jobs';
import { mockAiModels } from '../mocks/fixtures/ai';
import { createWrapper, mockAdminUser } from '../utils/test-utils';

function wrapper(options: Parameters<typeof createWrapper>[0]) {
  const Wrapper = createWrapper(options);
  return ({ children }: { children: ReactNode }) => <Wrapper>{children}</Wrapper>;
}

describe('toAssistantModelOption', () => {
  it('keeps the id, provider and model id, labels by display name, and reads tool calling', () => {
    expect(toAssistantModelOption(mockAiModels[0]!)).toEqual({
      id: 'model-1',
      provider: 'openai',
      modelId: 'gpt-5-mini',
      label: 'GPT-5 mini',
      supportsToolCalling: true,
    });
  });

  it('falls back to the model id and to no tool calling for an unclassified model', () => {
    expect(toAssistantModelOption(mockAiModels[2]!)).toMatchObject({ label: 'ft:custom-model', supportsToolCalling: false });
  });
});

describe('appTelemetryAdapters', () => {
  it('is what the shell hands the telemetry pages (the test wrapper mounts it like App.tsx)', () => {
    const { result } = renderHook(() => useTelemetryWebAdapters(), { wrapper: wrapper({ user: mockAdminUser }) });
    expect(result.current).toBe(appTelemetryAdapters);
    expect(result.current.Spinner).toBe(LoadingSpinner);
  });

  it("useAiEnabled reads the shell's AI config", () => {
    const on = renderHook(() => appTelemetryAdapters.useAiEnabled(), { wrapper: wrapper({ aiEnabled: true }) });
    expect(on.result.current).toEqual({ enabled: true, isLoading: false });
    const off = renderHook(() => appTelemetryAdapters.useAiEnabled(), { wrapper: wrapper({ aiEnabled: false }) });
    expect(off.result.current.enabled).toBe(false);
  });

  it('useAssistantModels lists the enabled catalogue models', async () => {
    const { result } = renderHook(() => appTelemetryAdapters.useAssistantModels(), {
      wrapper: wrapper({ user: mockAdminUser }),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.models.length).toBeGreaterThan(0);
    expect(result.current.models[0]).toEqual(
      expect.objectContaining({ provider: expect.any(String), modelId: expect.any(String), label: expect.any(String) }),
    );
  });
});

describe('the deploy status set', () => {
  it("is the queue's own JobStatusName", () => {
    expectTypeOf<TelemetryStackDeployStatus>().toEqualTypeOf<JobStatusName>();
  });
});
