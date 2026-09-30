/**
 * `useVisionAvailability(featureId)` against the MSW network (#173): the
 * server resolves the model; the hook maps `GET /api/ai/features` to a status
 * for ONE photo feature, and a failed check is its own `error` state, never
 * `no_key`.
 */
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { mockAiPublicConfigDisabled, mockAiPublicConfigEnabled } from '../mocks/fixtures/ai';
import { mockAiFeaturesView, mockBlockedFeatureView, mockFeatureView } from '../mocks/fixtures/aiFeatures';
import { ThemeContextProvider } from '../../contexts/ThemeContext';
import { useVisionAvailability, visionStatusOf } from '../../hooks/useVisionAvailability';
import type { AiFeaturesView } from '../../services/aiAssignments';

const wrapper = ({ children }: { children: ReactNode }) => <ThemeContextProvider>{children}</ThemeContextProvider>;

function scenario(options: { enabled?: boolean; features?: AiFeaturesView | (() => Response) }) {
  let calls = 0;
  server.use(
    http.get('*/api/ai/config', () =>
      HttpResponse.json({ data: options.enabled === false ? mockAiPublicConfigDisabled : mockAiPublicConfigEnabled }),
    ),
    http.get('*/api/ai/features', () => {
      calls += 1;
      const features = options.features ?? mockAiFeaturesView();
      return typeof features === 'function' ? features() : HttpResponse.json({ data: features });
    }),
  );
  return { calls: () => calls };
}

describe('visionStatusOf', () => {
  it('maps runnable states to ready and passes blocking states through', () => {
    const model = { provider: 'openai', modelId: 'm', displayName: 'M', keySource: 'user' as const };
    expect(visionStatusOf({ state: 'ready', model })).toBe('ready');
    expect(visionStatusOf({ state: 'auto', model })).toBe('ready');
    expect(visionStatusOf({ state: 'no_key' })).toBe('no_key');
    expect(visionStatusOf({ state: 'missing_capability' })).toBe('missing_capability');
    // A runnable state without a model is a contract breach, not a key problem.
    expect(visionStatusOf({ state: 'ready' })).toBe('error');
  });
});

describe('useVisionAvailability', () => {
  it('starts loading', () => {
    scenario({});
    const { result } = renderHook(() => useVisionAvailability('gym_scan'), { wrapper });
    expect(result.current.status).toBe('loading');
  });

  it('is ai_disabled when AI is off, and asks the API nothing', async () => {
    const api = scenario({ enabled: false });
    const { result } = renderHook(() => useVisionAvailability('gym_scan'), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ai_disabled'));
    expect(result.current.model).toBeNull();
    expect(api.calls()).toBe(0);
  });

  it('is ready with the administrator’s model for its own feature', async () => {
    scenario({
      features: mockAiFeaturesView({
        workout_prefill: mockFeatureView('workout_prefill', {
          model: { provider: 'anthropic', modelId: 'eye-2', displayName: 'Eye Two', keySource: 'org' },
          source: 'admin_default',
        }),
      }),
    });
    const { result } = renderHook(() => useVisionAvailability('workout_prefill'), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.model).toEqual({ provider: 'anthropic', modelId: 'eye-2', displayName: 'Eye Two', keySource: 'org' });
    expect(result.current.source).toBe('admin_default');
    expect(result.current.fix).toBeNull();
  });

  it('is ready for an automatic pick, and says so', async () => {
    scenario({ features: mockAiFeaturesView({ gym_scan: mockFeatureView('gym_scan', { state: 'auto', source: 'auto' }) }) });
    const { result } = renderHook(() => useVisionAvailability('gym_scan'), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.source).toBe('auto');
  });

  it.each([
    ['no_key', 'keys'],
    ['no_models', 'admin'],
    ['missing_capability', 'admin'],
    ['missing_capability', 'keys'],
  ] as const)('passes %s (fix %s) through with no model', async (state, fix) => {
    scenario({ features: mockAiFeaturesView({ body_metric_reading: mockBlockedFeatureView('body_metric_reading', state, fix) }) });
    const { result } = renderHook(() => useVisionAvailability('body_metric_reading'), { wrapper });
    await waitFor(() => expect(result.current.status).toBe(state));
    expect(result.current.fix).toBe(fix);
    expect(result.current.model).toBeNull();
  });

  it('is error — never no_key — when the check itself fails, and recovers on refresh', async () => {
    let fail = true;
    scenario({
      features: () =>
        fail
          ? HttpResponse.json({ statusCode: 500, code: 'INTERNAL', message: 'boom' }, { status: 500 })
          : HttpResponse.json({ data: mockAiFeaturesView() }),
    });
    const { result } = renderHook(() => useVisionAvailability('gym_scan'), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.fix).toBeNull();

    fail = false;
    await act(() => result.current.refresh());
    expect(result.current.status).toBe('ready');
  });

  it('is ai_disabled when the API answers AI_DISABLED', async () => {
    scenario({
      features: () =>
        HttpResponse.json(
          { statusCode: 403, code: 'FORBIDDEN', message: 'AI is disabled', details: { reason: 'AI_DISABLED' } },
          { status: 403 },
        ),
    });
    const { result } = renderHook(() => useVisionAvailability('gym_scan'), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ai_disabled'));
  });
});
