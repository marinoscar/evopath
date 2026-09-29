/**
 * `useGymScanIntake` (E3.4): resolves the scan's intake once (no second
 * create under StrictMode's double effect), only while enabled, and retries.
 */
import { StrictMode, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useGymScanIntake } from '../../hooks/useGymScanIntake';
import { statefulIntakeApi } from '../mocks/fixtures/intakes';

const GYM = '00000000-0000-4000-8000-a00000000666';
const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

describe('useGymScanIntake', () => {
  it('creates exactly one intake under StrictMode', async () => {
    const api = statefulIntakeApi();
    const { result } = renderHook(() => useGymScanIntake(GYM, true), { wrapper: strict });
    await waitFor(() => expect(result.current.intakeId).not.toBeNull());
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(result.current.intakeId).toBe(api.intakes[0].id);
    expect(result.current.isLoading).toBe(false);
  });

  it('does nothing while disabled', async () => {
    const api = statefulIntakeApi();
    const { result } = renderHook(() => useGymScanIntake(GYM, false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.calls).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('reports a failure and retries', async () => {
    const api = statefulIntakeApi();
    server.use(
      http.get('*/api/intakes', () => HttpResponse.json({ statusCode: 404, message: 'Gym not found' }, { status: 404 }), {
        once: true,
      }),
    );
    const { result } = renderHook(() => useGymScanIntake(GYM, true));
    await waitFor(() => expect(result.current.error?.message).toBe('Gym not found'));
    result.current.retry();
    await waitFor(() => expect(result.current.intakeId).toBe(api.intakes[0]?.id));
    expect(result.current.error).toBeNull();
  });
});
