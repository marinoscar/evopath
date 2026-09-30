/**
 * useTrainingRun: loads the run, streams from the last contiguous seq,
 * replays without duplicates across reconnects (re-opening with ?after=),
 * asks for a hole once and skips it if it cannot be filled, stops on `end`
 * and refetches once, and never cancels on unmount.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useTrainingRun } from '../../hooks/useTrainingRun';
import { mockRun, RUN_ID } from '../mocks/fixtures/programs';
import { fakeRunStream } from '../utils/fakeRunStream';
import { runEvents } from '../mocks/fixtures/runEvents';
import { trainingRunStreamUrl } from '../../services/trainingAgents';

afterEach(() => vi.useRealTimers());

function serveRun(status = 'running') {
  let gets = 0;
  let cancels = 0;
  server.use(
    http.get(`*/api/ai/training/runs/${RUN_ID}`, () => {
      gets += 1;
      return HttpResponse.json({ data: mockRun({ status: status as never }) });
    }),
    http.post(`*/api/ai/training/runs/${RUN_ID}/cancel`, () => {
      cancels += 1;
      return HttpResponse.json({ data: mockRun({ cancelRequested: true }) });
    }),
  );
  return { gets: () => gets, cancels: () => cancels };
}

describe('useTrainingRun', () => {
  it('loads the run, then streams from seq 0 and folds the events', async () => {
    serveRun();
    const stream = fakeRunStream();
    const { result } = renderHook(() => useTrainingRun(RUN_ID, { connect: stream.connect, pollMs: 0 }));
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    expect(stream.connections[0]).toMatchObject({ runId: RUN_ID, after: 0 });
    stream.open();
    expect(result.current.connection).toBe('open');
    stream.emit(...runEvents().slice(0, 8));
    expect(result.current.view.lastSeq).toBe(8);
    expect(result.current.view.sources.map((s) => s.id)).toEqual(['S1', 'S2']);
    expect(result.current.run?.status).toBe('running');
  });

  it('on reconnecting, re-opens with the current cursor and ignores replayed duplicates', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serveRun();
    const stream = fakeRunStream();
    const { result } = renderHook(() => useTrainingRun(RUN_ID, { connect: stream.connect, pollMs: 0, reconnectDelayMs: 1000 }));
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    stream.open();
    stream.emit(...runEvents().slice(0, 10));

    stream.state('reconnecting');
    expect(result.current.connection).toBe('reconnecting');
    expect(stream.connections[0].closed).toBe(true);
    expect(stream.connections).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(stream.connections).toHaveLength(2);
    expect(stream.connections[1].after).toBe(10);

    // The server replays from 11, but a racing duplicate or two sneaks in.
    stream.open();
    stream.emit(...runEvents().slice(8, 20));
    expect(result.current.view.lastSeq).toBe(20);
    expect(result.current.view.usage.researcher?.calls).toBe(1);
    expect(result.current.view.sources).toHaveLength(2);
  });

  it('asks for a hole by re-opening from the last contiguous seq', async () => {
    serveRun();
    const stream = fakeRunStream();
    const { result } = renderHook(() => useTrainingRun(RUN_ID, { connect: stream.connect, pollMs: 0 }));
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    stream.open();
    const events = runEvents();
    stream.emit(...events.slice(0, 5), events[7]);
    await waitFor(() => expect(stream.connections).toHaveLength(2));
    expect(stream.connections[1].after).toBe(5);
    stream.emit(...events.slice(5, 12));
    expect(result.current.view.lastSeq).toBe(12);
    expect(Object.keys(result.current.view.pending)).toHaveLength(0);
  });

  it('skips a hole the server cannot fill instead of looping', async () => {
    serveRun();
    const stream = fakeRunStream();
    const { result } = renderHook(() => useTrainingRun(RUN_ID, { connect: stream.connect, pollMs: 0, reconnectDelayMs: 0 }));
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    const events = runEvents();
    stream.emit(...events.slice(0, 5), events[7]);
    await waitFor(() => expect(stream.connections).toHaveLength(2));
    stream.emit(events[7], events[8]);
    await waitFor(() => expect(stream.connections).toHaveLength(3));
    stream.emit(events[8], events[9]);
    await waitFor(() => expect(result.current.view.lastSeq).toBe(10));
    expect(stream.connections.length).toBeLessThanOrEqual(3);
  });

  it('stops on end and refetches the run once', async () => {
    const counts = serveRun('succeeded');
    const stream = fakeRunStream();
    const { result } = renderHook(() => useTrainingRun(RUN_ID, { connect: stream.connect, pollMs: 0 }));
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    stream.emit(...runEvents());
    stream.end('succeeded');
    expect(result.current.ended).toBe(true);
    expect(result.current.connection).toBe('closed');
    expect(stream.connections[0].closed).toBe(true);
    await waitFor(() => expect(counts.gets()).toBe(2));
    expect(result.current.view.status).toBe('succeeded');
  });

  it('never cancels on unmount; cancel() posts the cancel', async () => {
    const counts = serveRun();
    const stream = fakeRunStream();
    const { result, unmount } = renderHook(() => useTrainingRun(RUN_ID, { connect: stream.connect, pollMs: 0 }));
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    await act(async () => {
      await result.current.cancel();
    });
    expect(counts.cancels()).toBe(1);
    expect(result.current.run?.cancelRequested).toBe(true);
    unmount();
    expect(stream.connections[0].closed).toBe(true);
    expect(counts.cancels()).toBe(1);
  });

  it('marks the view lost when the client gives up without end', async () => {
    serveRun();
    const stream = fakeRunStream();
    const { result } = renderHook(() => useTrainingRun(RUN_ID, { connect: stream.connect, pollMs: 0 }));
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    stream.state('closed');
    expect(result.current.lost).toBe(true);
    act(() => result.current.reconnect());
    expect(stream.connections).toHaveLength(2);
  });

  it('reports a missing run', async () => {
    server.use(http.get(`*/api/ai/training/runs/${RUN_ID}`, () => HttpResponse.json({ message: 'Not found' }, { status: 404 })));
    const stream = fakeRunStream();
    const { result } = renderHook(() => useTrainingRun(RUN_ID, { connect: stream.connect, pollMs: 0 }));
    await waitFor(() => expect(result.current.notFound).toBe(true));
    expect(stream.connections).toHaveLength(0);
  });

  it('builds the stream URL with the cursor', () => {
    expect(trainingRunStreamUrl(RUN_ID, 12)).toMatch(new RegExp(`/api/ai/training/stream/${RUN_ID}\\?after=12$`));
    expect(trainingRunStreamUrl(RUN_ID, -3)).toMatch(/after=0$/);
  });
});
