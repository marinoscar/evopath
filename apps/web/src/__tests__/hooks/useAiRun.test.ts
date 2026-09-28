import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { aiErrorBody, mockAiResponse, mockAiRun } from '../mocks/fixtures/ai';
import {
  AI_RUN_MAX_POLL_FAILURES,
  AI_RUN_POLL_INTERVAL_MS,
  isAiRunTerminal,
  useAiRun,
} from '../../hooks/useAiRun';
import type { AiRun, AiRunStatus } from '../../services/ai';

/**
 * `useAiRun` — issue #434. Real timers with a 10 ms interval: short enough to
 * be fast, and it exercises the same timeout chain the 2 s default does.
 */

const FAST = 10;

function runWith(status: AiRunStatus, extra: Partial<AiRun> = {}): AiRun {
  return {
    ...mockAiRun,
    status,
    output: status === 'succeeded' ? mockAiResponse : null,
    completedAt: isAiRunTerminal(status) ? mockAiRun.completedAt : null,
    ...extra,
  };
}

/** Answer successive GET /ai/runs/:id with `statuses`, repeating the last. */
function scriptRun(statuses: AiRunStatus[]) {
  const reads: string[] = [];
  server.use(
    http.get('*/api/ai/runs/:id', ({ params }) => {
      reads.push(String(params.id));
      const status = statuses[Math.min(reads.length - 1, statuses.length - 1)];
      return HttpResponse.json({ data: runWith(status, { id: String(params.id) }) });
    }),
  );
  return reads;
}

describe('useAiRun', () => {
  it('defaults to a 2 s poll interval', () => {
    expect(AI_RUN_POLL_INTERVAL_MS).toBe(2000);
  });

  it('starts a run, polls until it settles, then stops polling', async () => {
    let startBody: unknown = null;
    server.use(
      http.post('*/api/ai/runs', async ({ request }) => {
        startBody = await request.json();
        return HttpResponse.json({ data: { runId: 'run_9', jobId: 'job_9' } }, { status: 202 });
      }),
    );
    const reads = scriptRun(['pending', 'running', 'succeeded']);
    const onSettled = vi.fn();
    const { result } = renderHook(() => useAiRun({ intervalMs: FAST, onSettled }));

    let id: string | null = null;
    await act(async () => {
      id = await result.current.start({ model: 'gpt-5-mini', input: 'summarise' });
    });

    expect(id).toBe('run_9');
    expect(startBody).toEqual({ model: 'gpt-5-mini', input: 'summarise' });
    expect(result.current.isActive).toBe(true);

    await waitFor(() => expect(result.current.run?.status).toBe('succeeded'));
    expect(result.current.isActive).toBe(false);
    expect(reads).toEqual(['run_9', 'run_9', 'run_9']);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0][0]).toMatchObject({ id: 'run_9', status: 'succeeded', output: mockAiResponse });

    // No further reads once terminal.
    await new Promise((resolve) => setTimeout(resolve, FAST * 5));
    expect(reads).toHaveLength(3);
  });

  it('cancels a running run and stops polling', async () => {
    const reads = scriptRun(['running']);
    let cancelled: string | null = null;
    server.use(
      http.post('*/api/ai/runs/:id/cancel', ({ params }) => {
        cancelled = String(params.id);
        return HttpResponse.json({ data: runWith('cancelled', { id: String(params.id) }) });
      }),
    );
    const onSettled = vi.fn();
    const { result } = renderHook(() => useAiRun({ intervalMs: FAST, onSettled }));

    await act(async () => {
      await result.current.start({ input: 'long job' });
    });
    await waitFor(() => expect(result.current.run?.status).toBe('running'));

    await act(async () => {
      await result.current.cancel();
    });

    expect(cancelled).toBe(mockAiRun.id);
    expect(result.current.run?.status).toBe('cancelled');
    expect(result.current.isActive).toBe(false);
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));

    const count = reads.length;
    await new Promise((resolve) => setTimeout(resolve, FAST * 5));
    expect(reads).toHaveLength(count);
  });

  it('surfaces a refused start with the AI code from details.reason', async () => {
    server.use(
      http.post('*/api/ai/runs', () =>
        HttpResponse.json(aiErrorBody('AI_MODEL_NOT_REACHABLE', 'not reachable'), { status: 403 }),
      ),
    );
    const { result } = renderHook(() => useAiRun({ intervalMs: FAST }));

    let id: string | null = 'unset';
    await act(async () => {
      id = await result.current.start({ input: 'x' });
    });

    expect(id).toBeNull();
    expect(result.current.error).toMatchObject({ code: 'AI_MODEL_NOT_REACHABLE', status: 403 });
    expect(result.current.isActive).toBe(false);
  });

  it('stops polling when the run cannot be read', async () => {
    let reads = 0;
    server.use(
      http.get('*/api/ai/runs/:id', () => {
        reads += 1;
        return HttpResponse.json({ code: 'NOT_FOUND', message: 'Run not found' }, { status: 404 });
      }),
    );
    const { result } = renderHook(() => useAiRun({ intervalMs: FAST }));

    await act(async () => {
      await result.current.start({ input: 'x' });
    });

    await waitFor(() => expect(result.current.error).toMatchObject({ status: 404, code: null }));
    expect(result.current.isActive).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, FAST * 5));
    expect(reads).toBe(1);
  });

  it('reports a failed run through onSettled with its errorCode', async () => {
    server.use(
      http.get('*/api/ai/runs/:id', ({ params }) =>
        HttpResponse.json({
          data: runWith('failed', { id: String(params.id), errorCode: 'AI_RATE_LIMITED' }),
        }),
      ),
    );
    const onSettled = vi.fn();
    const { result } = renderHook(() => useAiRun({ intervalMs: FAST, onSettled }));

    await act(async () => {
      await result.current.start({ input: 'x' });
    });

    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(result.current.run).toMatchObject({ status: 'failed', errorCode: 'AI_RATE_LIMITED' });
  });

  it('clear() forgets the run and stops polling', async () => {
    const reads = scriptRun(['running']);
    const { result } = renderHook(() => useAiRun({ intervalMs: FAST }));

    await act(async () => {
      await result.current.start({ input: 'x' });
    });
    await waitFor(() => expect(result.current.run).not.toBeNull());

    act(() => result.current.clear());
    expect(result.current.run).toBeNull();
    expect(result.current.runId).toBeNull();
    expect(result.current.isActive).toBe(false);

    const count = reads.length;
    await new Promise((resolve) => setTimeout(resolve, FAST * 5));
    expect(reads).toHaveLength(count);
  });
});

describe('useAiRun — startWith (#445)', () => {
  it('polls a run created by any 202 { runId } call, and reports a refused one', async () => {
    server.use(
      http.get('*/api/ai/runs/:id', ({ params }) =>
        HttpResponse.json({ data: runWith('succeeded', { id: String(params.id) }) }),
      ),
    );
    const onSettled = vi.fn();
    const { result } = renderHook(() => useAiRun({ intervalMs: FAST, onSettled }));

    await act(async () => {
      await result.current.startWith(async () => ({ runId: 'run_img_7', jobId: 'job_7' }));
    });
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(onSettled.mock.calls[0][0]).toMatchObject({ id: 'run_img_7', status: 'succeeded' });

    let id: string | null = 'unset';
    await act(async () => {
      id = await result.current.startWith(() => Promise.reject(new Error('refused')));
    });
    expect(id).toBeNull();
    expect(result.current.error).toMatchObject({ code: null, message: 'refused' });
    expect(result.current.isActive).toBe(false);
  });
});

describe('useAiRun — transient read failures (#509)', () => {
  it('tolerates 3 consecutive failures before giving up', () => {
    expect(AI_RUN_MAX_POLL_FAILURES).toBe(3);
  });

  it('keeps polling through a transient network failure, flags stale, then clears it', async () => {
    // pending → network error → pending → succeeded
    const script: Array<AiRunStatus | 'network'> = ['pending', 'network', 'pending', 'succeeded'];
    let reads = 0;
    const seen: Array<{ stale: boolean; status: string | undefined }> = [];
    server.use(
      http.get('*/api/ai/runs/:id', ({ params }) => {
        const step = script[Math.min(reads, script.length - 1)];
        reads += 1;
        if (step === 'network') return HttpResponse.error();
        return HttpResponse.json({ data: runWith(step, { id: String(params.id) }) });
      }),
    );
    const onSettled = vi.fn();
    const { result } = renderHook(() => {
      const r = useAiRun({ intervalMs: FAST, onSettled });
      seen.push({ stale: r.stale, status: r.run?.status });
      return r;
    });

    await act(async () => {
      await result.current.start({ input: 'x' });
    });

    await waitFor(() => expect(result.current.run?.status).toBe('succeeded'));
    expect(result.current.error).toBeNull();
    expect(result.current.stale).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
    // The failed read was exposed as stale over the last-known "pending" run.
    expect(seen).toContainEqual({ stale: true, status: 'pending' });
    expect(reads).toBe(4);
  });

  it('treats a 5xx read as transient too', async () => {
    let reads = 0;
    server.use(
      http.get('*/api/ai/runs/:id', ({ params }) => {
        reads += 1;
        if (reads === 1) return HttpResponse.json({ code: 'BAD_GATEWAY', message: 'upstream' }, { status: 502 });
        return HttpResponse.json({ data: runWith('succeeded', { id: String(params.id) }) });
      }),
    );
    const { result } = renderHook(() => useAiRun({ intervalMs: FAST }));

    await act(async () => {
      await result.current.start({ input: 'x' });
    });

    await waitFor(() => expect(result.current.run?.status).toBe('succeeded'));
    expect(result.current.error).toBeNull();
    expect(result.current.stale).toBe(false);
  });

  it('surfaces an error and stays stale after N consecutive failures, then stops polling', async () => {
    let reads = 0;
    server.use(
      http.get('*/api/ai/runs/:id', ({ params }) => {
        reads += 1;
        if (reads === 1) return HttpResponse.json({ data: runWith('pending', { id: String(params.id) }) });
        return HttpResponse.error();
      }),
    );
    const { result } = renderHook(() => useAiRun({ intervalMs: FAST }));

    await act(async () => {
      await result.current.start({ input: 'x' });
    });

    await waitFor(() => expect(result.current.error).not.toBeNull(), { timeout: 2000 });
    expect(result.current.stale).toBe(true);
    expect(result.current.run?.status).toBe('pending');
    expect(result.current.isActive).toBe(false);
    expect(result.current.error).toMatchObject({ code: null });
    expect(result.current.error?.message).toMatch(/may still be in progress/);
    expect(reads).toBe(1 + AI_RUN_MAX_POLL_FAILURES);

    await new Promise((resolve) => setTimeout(resolve, FAST * 10));
    expect(reads).toBe(1 + AI_RUN_MAX_POLL_FAILURES);

    act(() => result.current.clear());
    expect(result.current.stale).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('does not report a single transient failure as an error', async () => {
    let reads = 0;
    server.use(
      http.get('*/api/ai/runs/:id', ({ params }) => {
        reads += 1;
        if (reads === 1) return HttpResponse.error();
        return HttpResponse.json({ data: runWith('running', { id: String(params.id) }) });
      }),
    );
    const errors: unknown[] = [];
    const { result } = renderHook(() => {
      const r = useAiRun({ intervalMs: FAST });
      errors.push(r.error);
      return r;
    });

    await act(async () => {
      await result.current.start({ input: 'x' });
    });
    await waitFor(() => expect(result.current.run?.status).toBe('running'));
    expect(result.current.stale).toBe(false);
    expect(errors.every((e) => e === null)).toBe(true);
    expect(result.current.isActive).toBe(true);
    act(() => result.current.clear());
  });

  it('still surfaces a genuinely failed run through errorCode, not as stale', async () => {
    server.use(
      http.get('*/api/ai/runs/:id', ({ params }) =>
        HttpResponse.json({ data: runWith('failed', { id: String(params.id), errorCode: 'AI_PROVIDER_ERROR' }) }),
      ),
    );
    const { result } = renderHook(() => useAiRun({ intervalMs: FAST }));

    await act(async () => {
      await result.current.start({ input: 'x' });
    });

    await waitFor(() => expect(result.current.run?.status).toBe('failed'));
    expect(result.current.run?.errorCode).toBe('AI_PROVIDER_ERROR');
    expect(result.current.error).toBeNull();
    expect(result.current.stale).toBe(false);
  });
});
