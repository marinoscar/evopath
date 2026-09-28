import { describe, it, expect, vi, afterEach } from 'vitest';
import { postSse } from '../../services/sse';
import { ApiError } from '../../services/api';
import { clearMaintenanceBlock, getMaintenanceBlock } from '../../services/maintenance';

/**
 * `postSse` — issue #425, epic #419. One POSTed request, one streamed answer:
 * no reconnect, one retry after a 401, `ApiError` on a non-2xx, and a quiet
 * resolve on abort.
 *
 * `fetch` is stubbed with hand-built responses (the `sse.connect.test.ts`
 * approach) rather than MSW so each test controls chunk boundaries, status
 * codes and the exact moment a read is aborted.
 */

const encoder = new TextEncoder();

/** A 2xx response whose body yields `chunks` one read at a time, then ends. */
function streamResponse(chunks: string[]) {
  const queue = [...chunks];
  const read = vi.fn(async () => {
    const next = queue.shift();
    return next === undefined
      ? { done: true as const, value: undefined }
      : { done: false as const, value: encoder.encode(next) };
  });
  return {
    status: 200,
    ok: true,
    body: {
      getReader: () => ({ read, releaseLock: vi.fn() }),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function errorResponse(status: number, body: unknown) {
  return {
    status,
    ok: false,
    json: vi.fn().mockResolvedValue(body),
    body: { cancel: vi.fn().mockResolvedValue(undefined) },
  };
}

function abortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

function baseOptions(overrides: Partial<Parameters<typeof postSse>[0]> = {}) {
  return {
    url: 'http://x/api/ai/responses/stream',
    body: { input: 'hi' },
    authorization: () => 'Bearer token-1',
    reauthenticate: vi.fn().mockResolvedValue(true),
    onFrame: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearMaintenanceBlock();
});

describe('postSse — streaming', () => {
  it('POSTs the JSON body with event-stream Accept and the bearer header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await postSse(baseOptions());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://x/api/ai/responses/stream');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ input: 'hi' }));
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: 'Bearer token-1',
    });
  });

  it('omits Authorization when there is no token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await postSse(baseOptions({ authorization: () => null }));

    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  it('delivers each frame in order, parsed as JSON, across chunk boundaries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        streamResponse([
          'event: response.created\ndata: {"id":"r1"}\n\nevent: output_text.del',
          'ta\ndata: {"delta":"Hel',
          'lo"}\n\n: ping\n\nevent: response.completed\ndata: {"ok":true}\n\n',
        ]),
      ),
    );
    const onFrame = vi.fn();

    await postSse(baseOptions({ onFrame }));

    expect(onFrame.mock.calls).toEqual([
      ['response.created', { id: 'r1' }],
      ['output_text.delta', { delta: 'Hello' }],
      ['response.completed', { ok: true }],
    ]);
  });

  it('passes non-JSON data through as the raw string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(['data: plain text\n\n'])));
    const onFrame = vi.fn();

    await postSse(baseOptions({ onFrame }));

    expect(onFrame).toHaveBeenCalledWith('message', 'plain text');
  });

  it('flushes a final frame the server ended without a blank line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(streamResponse(['event: done\ndata: {"n":1}'])),
    );
    const onFrame = vi.fn();

    await postSse(baseOptions({ onFrame }));

    expect(onFrame).toHaveBeenCalledWith('done', { n: 1 });
  });

  it('never reconnects: one request, resolved when the stream ends', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse(['data: {"a":1}\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postSse(baseOptions())).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('postSse — 401 retry', () => {
  it('re-authenticates once and retries with the renewed header', async () => {
    let token = 'stale';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(401, {}))
      .mockResolvedValueOnce(streamResponse(['data: {"ok":true}\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    const reauthenticate = vi.fn(async () => {
      token = 'fresh';
      return true;
    });
    const onFrame = vi.fn();

    await postSse(
      baseOptions({ authorization: () => `Bearer ${token}`, reauthenticate, onFrame }),
    );

    expect(reauthenticate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer stale');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh');
    // The body is re-sent verbatim on the retry.
    expect(fetchMock.mock.calls[1][1].body).toBe(JSON.stringify({ input: 'hi' }));
    expect(onFrame).toHaveBeenCalledWith('message', { ok: true });
  });

  it('rejects with a 401 ApiError when the retry is refused too — no second refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(401, {}))
      .mockResolvedValueOnce(errorResponse(401, { message: 'Unauthorized' }));
    vi.stubGlobal('fetch', fetchMock);
    const reauthenticate = vi.fn().mockResolvedValue(false);

    const promise = postSse(baseOptions({ reauthenticate }));

    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 401 });
    expect(reauthenticate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('postSse — errors', () => {
  it('rejects with ApiError carrying the JSON body code, message and details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errorResponse(403, {
          code: 'AI_DISABLED',
          message: 'AI is disabled',
          details: { reason: 'AI_DISABLED' },
        }),
      ),
    );
    const onFrame = vi.fn();

    const promise = postSse(baseOptions({ onFrame }));

    await expect(promise).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'AI_DISABLED',
      message: 'AI is disabled',
      details: { reason: 'AI_DISABLED' },
    });
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    const response = errorResponse(502, {});
    response.json.mockRejectedValue(new SyntaxError('bad json'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(postSse(baseOptions())).rejects.toMatchObject({
      status: 502,
      message: 'Stream responded 502',
      code: undefined,
    });
  });

  it('reports a maintenance 503 to the maintenance gate on the way past', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errorResponse(503, {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Down for maintenance',
          details: { reason: 'MAINTENANCE_MODE' },
        }),
      ),
    );

    await expect(postSse(baseOptions())).rejects.toBeInstanceOf(ApiError);
    expect(getMaintenanceBlock()).not.toBeNull();
  });

  it('rejects on a network failure that is not an abort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(postSse(baseOptions())).rejects.toThrow('Failed to fetch');
  });
});

describe('postSse — abort', () => {
  it('resolves quietly when aborted before the response arrives', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError()));

    await expect(postSse(baseOptions({ signal: controller.signal }))).resolves.toBeUndefined();
  });

  it('resolves quietly when aborted mid-stream, after delivering what arrived', async () => {
    const controller = new AbortController();
    let call = 0;
    const read = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return { done: false as const, value: encoder.encode('data: {"n":1}\n\n') };
      }
      controller.abort();
      throw abortError();
    });
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      body: { getReader: () => ({ read, releaseLock: vi.fn() }), cancel: vi.fn() },
    });
    vi.stubGlobal('fetch', fetchMock);
    const onFrame = vi.fn();

    await expect(
      postSse(baseOptions({ onFrame, signal: controller.signal })),
    ).resolves.toBeUndefined();

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith('message', { n: 1 });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
    // Aborting is not a reason to try again.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
