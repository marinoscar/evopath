import { describe, expect, it, vi } from 'vitest';

import type { NodeApi, NodeSpan } from './node-api.js';
import { JobSpanRecorder, MAX_SPANS_PER_BATCH, NodeSpanRelay, errorTypeOf } from '@marinoscar/platform-cli/telemetry';
import { MissingJobInputError } from './node-errors.js';
import { ApiError } from '../errors.js';

// =============================================================================
// Job phase spans and their best-effort relay  (issue #133)
// =============================================================================
//
// The relay lives in `@marinoscar/platform-cli/telemetry` now
// (marinoscar/EnterpriseAppBase#719) and reads an HTTP status structurally
// instead of `instanceof ApiError`. These cases stay here, unchanged, with this
// CLI's REAL `ApiError` and `MissingJobInputError`: they prove the app's
// errors classify exactly as before. The package runs the same cases against
// look-alikes.

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    serverMessage: `status ${status}`,
    code: undefined,
    details: undefined,
    method: 'POST',
    url: 'http://h/api/nodes/node-1/telemetry',
    structured: true,
    rawBody: undefined,
  });
}

function span(jobId = 'job-1', startTimeUnixMs = 1_000): NodeSpan {
  return { jobId, name: 'job.execute', startTimeUnixMs, durationMs: 1, status: 'ok' };
}

function relayWith(telemetry: NodeApi['telemetry'], options: { maxQueuedSpans?: number; onDisabled?: (r: string) => void } = {}) {
  const api = { telemetry } as unknown as NodeApi;
  return new NodeSpanRelay({ api, nodeId: 'node-1', ...options });
}

describe('errorTypeOf', () => {
  it('names the class, never the message', () => {
    const type = errorTypeOf(new MissingJobInputError('job-1', 'example.checksum', 'GET https://bucket/key?sig=abc failed'));
    expect(type).toBe('MissingJobInputError');
  });

  it('appends an HTTP status for an ApiError and a code for a system error', () => {
    expect(errorTypeOf(apiError(409))).toBe('ApiError.409');
    const system = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' });
    expect(errorTypeOf(system)).toBe('Error.ECONNREFUSED');
  });

  it('sanitises to the server’s identifier shape and caps the length', () => {
    class WeirdError extends Error {
      override name = 'Weird Error/with:stuff';
    }
    expect(errorTypeOf(new WeirdError('x'))).toBe('Weird_Error_with_stuff');
    const long = Object.assign(new Error('x'), { name: 'N'.repeat(100) });
    expect(errorTypeOf(long)).toHaveLength(64);
    expect(errorTypeOf('a string')).toBe('string');
  });
});

describe('JobSpanRecorder', () => {
  it('records an ok phase with duration and attributes, returning the result', async () => {
    let now = 1_000;
    const recorder = new JobSpanRecorder('job-1', () => now);

    const result = await recorder.phase(
      'job.download',
      async () => {
        now = 1_250;
        return { size: '42' };
      },
      (downloaded) => ({ bytes: Number(downloaded.size) }),
    );

    expect(result).toEqual({ size: '42' });
    expect(recorder.drain()).toEqual([
      { jobId: 'job-1', name: 'job.download', startTimeUnixMs: 1_000, durationMs: 250, status: 'ok', attributes: { bytes: 42 } },
    ]);
  });

  it('records an error phase with errorType only, and rethrows the original error', async () => {
    const recorder = new JobSpanRecorder('job-1', () => 5);
    const boom = new MissingJobInputError('job-1', 't', 'secret path /var/x');

    await expect(recorder.phase('job.execute', async () => Promise.reject(boom))).rejects.toBe(boom);

    const [recorded] = recorder.drain();
    expect(recorded).toMatchObject({ name: 'job.execute', status: 'error', errorType: 'MissingJobInputError' });
    expect(JSON.stringify(recorded)).not.toContain('/var/x');
  });

  it('drops attributes the server would refuse rather than sending them', async () => {
    const recorder = new JobSpanRecorder('job-1', () => 0);
    await recorder.phase('job.upload', async () => undefined, { bytes: Number.NaN, attempt: -1, httpStatus: 42 });

    expect(recorder.drain()[0]?.attributes).toBeUndefined();
  });

  it('never lets a throwing attributes function fail the phase', async () => {
    const recorder = new JobSpanRecorder('job-1', () => 0);
    await expect(
      recorder.phase('job.upload', async () => 'ok', () => {
        throw new Error('nope');
      }),
    ).resolves.toBe('ok');
    expect(recorder.drain()).toHaveLength(1);
  });
});

describe('NodeSpanRelay', () => {
  it('is off when the API has no telemetry method', () => {
    const relay = new NodeSpanRelay({ api: {} as NodeApi, nodeId: 'node-1' });
    relay.enqueue([span()]);
    expect(relay.enabled).toBe(false);
    expect(relay.queued).toBe(0);
  });

  it('sends in batches of at most 50', async () => {
    const telemetry = vi.fn(async () => ({ accepted: 0, dropped: 0 }));
    const relay = relayWith(telemetry);

    relay.enqueue(Array.from({ length: 120 }, (_, i) => span(`job-${i}`)));
    await relay.flush();

    expect(telemetry.mock.calls.map((call) => (call as unknown as [string, { spans: NodeSpan[] }])[1].spans.length)).toEqual([
      MAX_SPANS_PER_BATCH,
      MAX_SPANS_PER_BATCH,
      20,
    ]);
  });

  it('drops the OLDEST spans when the queue is full', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: NodeSpan[][] = [];
    const telemetry = vi.fn(async (_nodeId: string, body: { spans: NodeSpan[] }) => {
      sent.push(body.spans);
      await gate;
      return { accepted: 0, dropped: 0 };
    });
    const relay = relayWith(telemetry, { maxQueuedSpans: 3 });

    relay.enqueue([span('first')]); // taken by the in-flight send
    relay.enqueue([span('a'), span('b'), span('c'), span('d')]);
    expect(relay.droppedForCapacity).toBe(1);

    release();
    await relay.flush();

    expect(sent[1]?.map((s) => s.jobId)).toEqual(['b', 'c', 'd']);
  });

  it('disables itself on a 404, announcing it once, and sends nothing more', async () => {
    const onDisabled = vi.fn();
    const telemetry = vi.fn(async () => {
      throw apiError(404);
    });
    const relay = relayWith(telemetry, { onDisabled });

    relay.enqueue([span()]);
    await relay.flush();
    relay.enqueue([span()]);
    await relay.flush();

    expect(telemetry).toHaveBeenCalledTimes(1);
    expect(onDisabled).toHaveBeenCalledTimes(1);
    expect(relay.enabled).toBe(false);
  });

  it.each([400, 403, 429, 500])('drops the batch on %i and keeps sending later ones', async (status) => {
    const telemetry = vi
      .fn()
      .mockRejectedValueOnce(apiError(status))
      .mockResolvedValue({ accepted: 1, dropped: 0 });
    const relay = relayWith(telemetry as unknown as NodeApi['telemetry']);

    relay.enqueue([span('x')]);
    await relay.flush();
    relay.enqueue([span('y')]);
    await relay.flush();

    expect(telemetry).toHaveBeenCalledTimes(2);
    expect(relay.enabled).toBe(true);
  });

  it('swallows a non-API failure (network down) too', async () => {
    const relay = relayWith(async () => {
      throw new TypeError('fetch failed');
    });
    relay.enqueue([span()]);
    await expect(relay.flush()).resolves.toBeUndefined();
    expect(relay.enabled).toBe(true);
  });
});
