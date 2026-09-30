import { EventEmitter } from 'node:events';

import type { FastifyReply } from 'fastify';

import { InMemoryRunEventLog } from '../testing/in-memory-run-event-log';
import { formatEndFrame, formatRunEventFrame, resolveCursor, streamRunEvents } from './run-events.sse';

function fakeReply() {
  const raw = Object.assign(new EventEmitter(), {
    chunks: [] as string[],
    headers: {} as Record<string, unknown>,
    destroyed: false,
    writableEnded: false,
    socket: null,
    writeHead(_status: number, headers: Record<string, unknown>) {
      raw.headers = headers;
    },
    flushHeaders() {},
    write(chunk: string) {
      raw.chunks.push(chunk);
      return true;
    },
    end() {
      raw.writableEnded = true;
    },
  });
  const reply = { raw, getHeaders: () => ({ 'x-request-id': 'r1' }), hijack: jest.fn() };

  return { reply: reply as unknown as FastifyReply, raw };
}

const disconnect = () => {
  const controller = new AbortController();
  return { controller, signal: { signal: controller.signal, dispose: jest.fn() } };
};

describe('run event SSE frames', () => {
  it('formats id, event and one-line JSON data', () => {
    expect(formatRunEventFrame({ seq: 7, type: 'stage.started', data: { node: 'plan' } })).toBe(
      'id: 7\nevent: stage.started\ndata: {"node":"plan"}\n\n',
    );
    expect(formatEndFrame('succeeded')).toBe('event: end\ndata: {"status":"succeeded"}\n\n');
  });

  it.each([
    [5, undefined, 5],
    [undefined, '12', 12],
    [undefined, ['3'], 3],
    [0, '12', 0],
    [undefined, 'abc', 0],
    [undefined, undefined, 0],
  ])('resolveCursor(after=%p, Last-Event-ID=%p) is %p', (after, header, expected) => {
    expect(resolveCursor(after as number | undefined, header as string | undefined)).toBe(expected);
  });
});

describe('streamRunEvents', () => {
  it('replays events after the cursor, tails new ones, and ends one poll after the run settles', async () => {
    const log = new InMemoryRunEventLog();
    const runId = 'run-1';
    for (const node of ['a', 'b', 'c']) await log.append(runId, 'stage.started', { node });

    const { reply, raw } = fakeReply();
    const d = disconnect();
    let status = 'running';
    let polls = 0;

    await streamRunEvents(reply, {
      runId,
      after: 1,
      events: log,
      status: async () => status,
      disconnect: d.signal,
      sleep: async () => {
        polls += 1;
        if (polls === 1) await log.append(runId, 'stage.started', { node: 'd' });
        if (polls === 2) {
          status = 'succeeded';
          await log.append(runId, 'run.completed', {
            status: 'succeeded',
            tokens: { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
          });
        }
      },
    });

    const body = raw.chunks.join('');
    const ids = [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([2, 3, 4, 5]);
    expect(body.endsWith('event: end\ndata: {"status":"succeeded"}\n\n')).toBe(true);
    expect(raw.headers).toMatchObject({ 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no', 'x-request-id': 'r1' });
    expect(raw.writableEnded).toBe(true);
    expect(d.signal.dispose).toHaveBeenCalled();
  });

  it('a reconnect with the last id gets no duplicate and no gap', async () => {
    const log = new InMemoryRunEventLog();
    for (let i = 0; i < 4; i += 1) await log.append('r', 'stage.started', { node: `n${i}` });

    const first = fakeReply();
    const d1 = disconnect();
    await streamRunEvents(first.reply, {
      runId: 'r',
      after: 0,
      events: log,
      status: async () => 'running',
      disconnect: d1.signal,
      sleep: async () => d1.controller.abort(),
    });
    const lastId = Math.max(...[...first.raw.chunks.join('').matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])));

    await log.append('r', 'stage.started', { node: 'n4' });
    const second = fakeReply();
    await streamRunEvents(second.reply, {
      runId: 'r',
      after: lastId,
      events: log,
      status: async () => 'failed',
      disconnect: disconnect().signal,
      sleep: async () => undefined,
    });

    const ids = (chunks: string[]) => [...chunks.join('').matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect([...ids(first.raw.chunks), ...ids(second.raw.chunks)]).toEqual([1, 2, 3, 4, 5]);
  });

  it('a client disconnect stops the loop without an end frame', async () => {
    const log = new InMemoryRunEventLog();
    const { reply, raw } = fakeReply();
    const d = disconnect();

    await streamRunEvents(reply, {
      runId: 'r',
      after: 0,
      events: log,
      status: async () => 'running',
      disconnect: d.signal,
      sleep: async () => d.controller.abort(),
    });

    expect(raw.chunks.join('')).not.toContain('event: end');
    expect(raw.writableEnded).toBe(true);
  });

  it('ends with status "deleted" when the run disappears', async () => {
    const { reply, raw } = fakeReply();

    await streamRunEvents(reply, {
      runId: 'r',
      after: 0,
      events: new InMemoryRunEventLog(),
      status: async () => null,
      disconnect: disconnect().signal,
    });

    expect(raw.chunks.join('')).toBe(formatEndFrame('deleted'));
  });
});
