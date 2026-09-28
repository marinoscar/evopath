import { EventEmitter } from 'node:events';

import type { FastifyReply } from 'fastify';

import { AiError } from '../core/ai-error';
import type { AiStreamEvent } from '../core/types/responses.types';
import {
  AI_SSE_HEARTBEAT_MS,
  abortOnDisconnect,
  formatSseEvent,
  pipeAiSse,
  toErrorEvent,
} from './ai-sse';

/** Just enough of a ServerResponse for `pipeAiSse`. */
class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  status?: number;
  headers?: Record<string, unknown>;
  writableEnded = false;
  writableFinished = false;
  destroyed = false;
  socket = { setNoDelay: jest.fn(), setTimeout: jest.fn() };

  writeHead(status: number, headers: Record<string, unknown>) {
    this.status = status;
    this.headers = headers;
  }
  flushHeaders() {}
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit('close');
  }
  /** The client went away. */
  disconnect() {
    this.destroyed = true;
    this.emit('close');
  }
}

function fakeReply(res: FakeResponse, headers: Record<string, unknown> = {}) {
  return {
    raw: res,
    hijack: jest.fn(),
    getHeaders: () => headers,
  } as unknown as FastifyReply & { hijack: jest.Mock };
}

const created: AiStreamEvent = { type: 'response.created', id: 'r1' };
const delta: AiStreamEvent = { type: 'output_text.delta', delta: 'Hi' };

describe('formatSseEvent', () => {
  it('writes `event: <type>` and the event as one JSON data line', () => {
    const frame = formatSseEvent({ type: 'output_text.delta', delta: 'line one\nline two' });

    expect(frame).toBe('event: output_text.delta\ndata: {"type":"output_text.delta","delta":"line one\\nline two"}\n\n');
  });
});

describe('toErrorEvent', () => {
  it('keeps an AiError code and message', () => {
    expect(toErrorEvent(new AiError('AI_CONTENT_FILTERED', 'Filtered.'))).toEqual({
      type: 'error',
      code: 'AI_CONTENT_FILTERED',
      message: 'Filtered.',
    });
  });

  it('never echoes a raw error message', () => {
    expect(toErrorEvent(new Error('socket hang up at sk-secret'))).toEqual({
      type: 'error',
      code: 'AI_PROVIDER_UNAVAILABLE',
      message: 'The AI provider request failed.',
    });
  });
});

describe('abortOnDisconnect', () => {
  it('aborts when the connection closes before the response finished', () => {
    const res = new FakeResponse();
    const signal = abortOnDisconnect(res as never).signal;

    res.disconnect();

    expect(signal.aborted).toBe(true);
  });

  it('does not abort when the response finished normally', () => {
    const res = new FakeResponse();
    const signal = abortOnDisconnect(res as never).signal;

    res.end();

    expect(signal.aborted).toBe(false);
  });

  it('stops listening once disposed', () => {
    const res = new FakeResponse();
    const disconnect = abortOnDisconnect(res as never);

    disconnect.dispose();
    res.disconnect();

    expect(disconnect.signal.aborted).toBe(false);
  });
});

describe('pipeAiSse', () => {
  afterEach(() => jest.useRealTimers());

  it('hijacks the reply, keeps inherited headers and writes the SSE headers', async () => {
    const res = new FakeResponse();
    const reply = fakeReply(res, { 'x-request-id': 'req-1', 'content-length': '12' });

    await pipeAiSse(reply, (async function* () {})(), abortOnDisconnect(res as never));

    expect(reply.hijack).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({
      'x-request-id': 'req-1',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    expect(res.headers).not.toHaveProperty('content-length');
    expect(res.writableEnded).toBe(true);
  });

  it('writes every event in order and ends the response', async () => {
    const res = new FakeResponse();

    await pipeAiSse(
      fakeReply(res),
      (async function* () {
        yield created;
        yield delta;
      })(),
      abortOnDisconnect(res as never),
    );

    expect(res.chunks).toEqual([formatSseEvent(created), formatSseEvent(delta)]);
    expect(res.writableEnded).toBe(true);
  });

  it('turns a mid-stream throw into an error frame', async () => {
    const res = new FakeResponse();

    await pipeAiSse(
      fakeReply(res),
      (async function* () {
        yield created;
        throw new AiError('AI_PROVIDER_UNAVAILABLE', 'The AI provider request failed.');
      })(),
      abortOnDisconnect(res as never),
    );

    expect(res.chunks[res.chunks.length - 1]).toBe(
      'event: error\ndata: {"type":"error","code":"AI_PROVIDER_UNAVAILABLE","message":"The AI provider request failed."}\n\n',
    );
  });

  it('stops reading (and returns the iterator) once the client is gone', async () => {
    const res = new FakeResponse();
    let returned = false;
    let produced = 0;

    await pipeAiSse(
      fakeReply(res),
      (async function* () {
        try {
          for (;;) {
            produced += 1;
            if (produced === 2) res.disconnect();
            yield delta;
          }
        } finally {
          returned = true;
        }
      })(),
      abortOnDisconnect(res as never),
    );

    expect(returned).toBe(true);
    expect(res.chunks).toHaveLength(1);
  });

  it(`sends a \`: ping\` comment every ${AI_SSE_HEARTBEAT_MS / 1000}s while the stream is quiet`, async () => {
    jest.useFakeTimers();
    const res = new FakeResponse();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const done = pipeAiSse(
      fakeReply(res),
      (async function* () {
        await gate;
        yield created;
      })(),
      abortOnDisconnect(res as never),
    );

    jest.advanceTimersByTime(AI_SSE_HEARTBEAT_MS * 2);
    expect(res.chunks).toEqual([': ping\n\n', ': ping\n\n']);

    release();
    await done;

    // The timer is gone once the stream ended.
    jest.advanceTimersByTime(AI_SSE_HEARTBEAT_MS * 2);
    expect(res.chunks.filter((c) => c.startsWith(':'))).toHaveLength(2);
  });
});
