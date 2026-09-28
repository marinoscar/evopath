/**
 * A hand-driven `POST /ai/responses/stream` for tests — issue #434.
 *
 * The default MSW handler answers the whole stream at once; to prove that
 * text renders INCREMENTALLY and that Stop really stops, a test needs to hold
 * the stream open and release frames one at a time. `controlledAiStream()`
 * installs a handler whose body is a `ReadableStream` the test pushes SSE
 * frames into, and records every request (body, headers, abort signal).
 */
import { afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { toSseBody } from '../mocks/fixtures/ai';
import type { AiStreamEvent } from '../../services/ai';

export interface CapturedAiRequest {
  body: Record<string, unknown>;
  headers: Headers;
  /**
   * The intercepted `Request`'s own `AbortSignal` — MSW's fetch interceptor
   * builds its own `Request` and links its signal to the one the caller
   * passed, but that link is wired up ASYNCHRONOUSLY (through the
   * interceptor's own event plumbing), not in the same tick as `abort()`.
   * Asserting on this one for "did stop() abort the request" is therefore a
   * `waitFor` away from the abort at best — see `clientSignal` below, which
   * doesn't have that gap. Kept mainly as a secondary, network-side proof
   * that the abort actually reached the intercepted request, not just the
   * app's own `AbortController`.
   */
  signal: AbortSignal;
  /**
   * The exact `AbortSignal` object the app passed to `fetch(url, { signal })`
   * — captured synchronously at the `fetch` call site (issue #483). This is
   * the SAME object `stop()`'s `AbortController` owns, so `.aborted` flips
   * the instant `controller.abort()` runs, with no async hop through MSW's
   * interceptor. Prefer this for asserting "stop() aborted the request" —
   * it can be checked right after `act(() => result.current.stop())` with no
   * `waitFor` at all.
   */
  clientSignal: AbortSignal;
}

export interface ControlledAiStream {
  requests: CapturedAiRequest[];
  /** Send frames on the most recent stream. */
  push: (...events: AiStreamEvent[]) => void;
  /** End the most recent stream. */
  close: () => void;
}

/** True for the one URL this utility intercepts, however `fetch` was called. */
function isAiStreamUrl(input: RequestInfo | URL): boolean {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return url.includes('/api/ai/responses/stream');
}

/**
 * Restores whatever `controlledAiStream()` last wrapped `globalThis.fetch`
 * with. Registered once, at module load (collection time, so this is a valid
 * place to call a Vitest hook), rather than per call — a second call in the
 * same test would otherwise double-wrap `fetch`.
 */
let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

export function controlledAiStream(): ControlledAiStream {
  const encoder = new TextEncoder();
  const requests: CapturedAiRequest[] = [];
  // Signals captured at the `fetch` call site, FIFO-matched to the requests
  // MSW's handler below records — safe because these tests only ever have
  // one `/api/ai/responses/stream` call in flight at a time.
  const pendingClientSignals: AbortSignal[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  // Wrap the CURRENT `fetch` (already MSW's patched one once `server.listen()`
  // has run) rather than a snapshot taken at import time, so requests still
  // reach the interceptor below; just capture `init.signal` on the way past.
  const wrapped = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal && isAiStreamUrl(input)) {
      pendingClientSignals.push(init.signal);
    }
    return wrapped(input, init);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = wrapped;
  };

  server.use(
    http.post('*/api/ai/responses/stream', async ({ request }) => {
      requests.push({
        body: (await request.json()) as Record<string, unknown>,
        headers: request.headers,
        signal: request.signal,
        // Fallback to the interceptor's own signal is only a safety net — it
        // should never be needed in practice.
        clientSignal: pendingClientSignals.shift() ?? request.signal,
      });
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      return new HttpResponse(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      });
    }),
  );

  return {
    requests,
    push: (...events) => {
      try {
        controller?.enqueue(encoder.encode(toSseBody(events)));
      } catch {
        // The stream was already closed or cancelled (the client aborted).
      }
    },
    close: () => {
      try {
        controller?.close();
      } catch {
        // Already closed or cancelled.
      }
    },
  };
}
