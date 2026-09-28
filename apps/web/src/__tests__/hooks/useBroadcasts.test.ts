/**
 * `useBroadcastActions`'s `resume` (issue #459, epic #319).
 *
 * `BroadcastsPage.test.tsx` covers `resume` through the page, with the hook
 * mocked out — this file is the hook's own suite, in the shape
 * `__tests__/hooks/useJobs.test.ts` establishes: the service call is mocked at
 * the module boundary, and what is asserted is the hook's OWN contract —
 * resolves a boolean, never throws, shares `isWorking`/`error` with the rest
 * of the action set, and turns a 403/409 into the sentence the page renders.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../services/broadcasts', async () => {
  const actual = await vi.importActual<typeof import('../../services/broadcasts')>(
    '../../services/broadcasts',
  );
  return {
    ...actual,
    resumeBroadcast: vi.fn(),
    cancelBroadcast: vi.fn(),
  };
});

import { cancelBroadcast, resumeBroadcast } from '../../services/broadcasts';
import { ApiError } from '../../services/api';
import { useBroadcastActions } from '../../hooks/useBroadcasts';

const mockResumeBroadcast = vi.mocked(resumeBroadcast);
const mockCancelBroadcast = vi.mocked(cancelBroadcast);

describe('useBroadcastActions.resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports success as true and re-reads the list afterwards', async () => {
    mockResumeBroadcast.mockResolvedValue({ id: 'b-1', status: 'sending' } as never);
    const onChanged = vi.fn();
    const { result } = renderHook(() => useBroadcastActions(onChanged));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.resume('b-1');
    });

    expect(ok).toBe(true);
    expect(mockResumeBroadcast).toHaveBeenCalledWith('b-1');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it('names a 403 as a permission problem rather than echoing the API', async () => {
    mockResumeBroadcast.mockRejectedValue(new ApiError('Forbidden resource', 403));
    const { result } = renderHook(() => useBroadcastActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.resume('b-1');
    });

    expect(ok).toBe(false);
    await waitFor(() =>
      expect(result.current.error).toBe('You do not have permission to manage broadcasts'),
    );
  });

  it('passes a 409 through verbatim — another admin already resumed or cancelled it', async () => {
    mockResumeBroadcast.mockRejectedValue(
      new ApiError('Broadcast b-1 is \'sent\' and cannot be resumed (only failed broadcasts can)', 409),
    );
    const onChanged = vi.fn();
    const { result } = renderHook(() => useBroadcastActions(onChanged));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.resume('b-1');
    });

    expect(ok).toBe(false);
    await waitFor(() =>
      expect(result.current.error).toBe(
        "Broadcast b-1 is 'sent' and cannot be resumed (only failed broadcasts can)",
      ),
    );
    // Nothing changed, so nothing is re-read.
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('falls back to a generic message for a non-ApiError failure', async () => {
    mockResumeBroadcast.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useBroadcastActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.resume('b-1');
    });

    expect(ok).toBe(false);
    await waitFor(() => expect(result.current.error).toBe('Failed to resume broadcast'));
  });

  it('raises isWorking for the duration of the call, sharing the flag with the other writes', async () => {
    let resolveResume!: (value: unknown) => void;
    mockResumeBroadcast.mockReturnValue(
      new Promise((resolve) => {
        resolveResume = resolve;
      }) as never,
    );
    const { result } = renderHook(() => useBroadcastActions());

    expect(result.current.isWorking).toBe(false);

    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.resume('b-1');
    });
    await waitFor(() => expect(result.current.isWorking).toBe(true));

    await act(async () => {
      resolveResume({ id: 'b-1', status: 'sending' });
      await pending;
    });

    expect(result.current.isWorking).toBe(false);
  });

  it('clears a prior error at the start of a new resume call', async () => {
    mockResumeBroadcast.mockRejectedValueOnce(new ApiError('Boom', 500));
    const { result } = renderHook(() => useBroadcastActions());

    await act(async () => {
      await result.current.resume('b-1');
    });
    expect(result.current.error).toBe('Boom');

    mockResumeBroadcast.mockResolvedValueOnce({ id: 'b-1', status: 'sending' } as never);
    await act(async () => {
      await result.current.resume('b-1');
    });

    expect(result.current.error).toBeNull();
  });

  it('shares isWorking with cancel — a resume cannot run while a cancel is in flight and vice versa', async () => {
    // Not literally concurrent (the hook has no queue), but the two callbacks
    // are built from the SAME `run()` closure and the SAME `isWorking` state,
    // which is what this asserts by exercising both back to back.
    mockCancelBroadcast.mockResolvedValue({ id: 'b-2', status: 'canceled' } as never);
    mockResumeBroadcast.mockResolvedValue({ id: 'b-1', status: 'sending' } as never);
    const { result } = renderHook(() => useBroadcastActions());

    await act(async () => {
      await result.current.cancel('b-2');
    });
    expect(result.current.isWorking).toBe(false);

    await act(async () => {
      await result.current.resume('b-1');
    });
    expect(result.current.isWorking).toBe(false);
    expect(mockCancelBroadcast).toHaveBeenCalledWith('b-2');
    expect(mockResumeBroadcast).toHaveBeenCalledWith('b-1');
  });
});
