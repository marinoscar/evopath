/**
 * `useResetJob` — the start-and-poll loop shared by the per-user Danger Zone
 * (#202) and the admin factory reset (#211). The pages' own suites cover the
 * wire; this pins the state machine with plain functions and a short interval.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useResetJob, type ResetJobLike } from '../../hooks/useResetJob';

const MESSAGES = { failed: 'job failed', lost: 'lost it', notStarted: 'not started' };

function setup(
  startJob: (confirmation: string) => Promise<{ jobId: string; status: ResetJobLike['status'] }>,
  getJob: (jobId: string) => Promise<ResetJobLike & { result?: Record<string, number> }>,
) {
  return renderHook(() =>
    useResetJob({ startJob, getJob, messages: MESSAGES, pollIntervalMs: 5 }),
  );
}

describe('useResetJob', () => {
  it('starts idle, polls a pending job until it succeeds, and keeps the settled job', async () => {
    const startJob = vi.fn().mockResolvedValue({ jobId: 'j1', status: 'pending' });
    const getJob = vi
      .fn()
      .mockResolvedValueOnce({ jobId: 'j1', status: 'running' })
      .mockResolvedValueOnce({ jobId: 'j1', status: 'succeeded', result: { workouts: 3 } });
    const { result } = setup(startJob, getJob);
    expect(result.current.phase).toBe('idle');

    await act(async () => {
      await result.current.start('PHRASE');
    });
    expect(startJob).toHaveBeenCalledWith('PHRASE');

    await waitFor(() => expect(result.current.phase).toBe('succeeded'));
    expect(getJob).toHaveBeenCalledTimes(2);
    expect(result.current.job).toEqual({ jobId: 'j1', status: 'succeeded', result: { workouts: 3 } });
    expect(result.current.error).toBeNull();
  });

  it('reports a failed job with its own error, or the fallback message', async () => {
    const startJob = vi.fn().mockResolvedValue({ jobId: 'j1', status: 'pending' });
    const getJob = vi.fn().mockResolvedValue({ jobId: 'j1', status: 'failed' });
    const { result } = setup(startJob, getJob);
    await act(async () => {
      await result.current.start('PHRASE');
    });
    await waitFor(() => expect(result.current.phase).toBe('failed'));
    expect(result.current.error).toBe('job failed');
  });

  it('fails with the thrown message when the start is rejected, and reset() returns to idle', async () => {
    const startJob = vi.fn().mockRejectedValue(new Error('wrong phrase'));
    const getJob = vi.fn();
    const { result } = setup(startJob, getJob);
    await act(async () => {
      await result.current.start('nope');
    });
    expect(result.current.phase).toBe('failed');
    expect(result.current.error).toBe('wrong phrase');
    expect(getJob).not.toHaveBeenCalled();

    act(() => result.current.reset());
    expect(result.current.phase).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('fails with the "lost" message when a poll throws without one', async () => {
    const startJob = vi.fn().mockResolvedValue({ jobId: 'j1', status: 'running' });
    const getJob = vi.fn().mockRejectedValue(undefined);
    const { result } = setup(startJob, getJob);
    await act(async () => {
      await result.current.start('PHRASE');
    });
    await waitFor(() => expect(result.current.phase).toBe('failed'));
    expect(result.current.error).toBe('lost it');
  });
});
