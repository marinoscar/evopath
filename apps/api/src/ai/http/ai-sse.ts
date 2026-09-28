// =============================================================================
// Server-Sent Events for AI streaming (issue #433, epic #419)
// =============================================================================
//
// `POST /api/ai/responses/stream` cannot use Nest's `@Sse()` (the notifications
// precedent): `@Sse()` is GET-only in spirit — it commits to `200 text/event-
// stream` BEFORE the handler runs, so a gate refusal (no key, model not
// enabled) could only ever be an in-band frame. The contract here is the
// opposite: every failure that happens before the first event is an ORDINARY
// JSON error (status + `details.reason`), so the web client's `postSse`
// rejects with the same `ApiError` the non-streaming call would have thrown.
//
// So the controller settles the stream first (`AiService.openStream` rejects
// for every pre-stream failure), and only then hands the reply to
// `pipeAiSse`, which hijacks it and writes frames by hand:
//
//   event: <AiStreamEvent.type>\ndata: <the event as JSON>\n\n
//
// with a `: ping` comment every 15 s so no proxy reaps a quiet stream (a
// reasoning model can think for a long time before its first delta), and
// `X-Accel-Buffering: no` so nginx forwards each frame as it is written — the
// response-side half of the dedicated `location /api/ai/responses/stream`
// block in `infra/nginx/nginx.conf`.
//
// CLIENT DISCONNECT. `abortOnDisconnect` aborts an `AbortController` when the
// response's connection closes before the response finished; the controller
// passes its signal to the facade, which hands it to the provider adapter —
// so a closed tab stops the provider call (and its billing), and the usage
// row records a cancellation.
// =============================================================================

import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';

import type { FastifyReply } from 'fastify';

import { AiError } from '../core/ai-error';
import type { AiStreamEvent } from '../core/types/responses.types';

/** Interval of the `: ping` keep-alive comment. */
export const AI_SSE_HEARTBEAT_MS = 15_000;

export const AI_SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // nginx: do not buffer this response (the location block also says so).
  'X-Accel-Buffering': 'no',
} as const;

/** One SSE frame. `JSON.stringify` never emits a raw newline, so `data:` is one line. */
export function formatSseEvent(event: AiStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The in-band `error` frame for a failure after streaming began. Generic for anything not an `AiError`. */
export function toErrorEvent(err: unknown): Extract<AiStreamEvent, { type: 'error' }> {
  const error = AiError.wrap(err);

  return { type: 'error', code: error.code, message: error.message };
}

export interface DisconnectSignal {
  readonly signal: AbortSignal;
  /** Stop listening (the response finished normally). */
  dispose(): void;
}

/**
 * Aborts when the client goes away before the response finished.
 *
 * Listens on the RESPONSE's `close`, not the request's: since Node 16 an
 * `IncomingMessage` emits `close` as soon as its body has been consumed, which
 * for a POST is before the first event is even generated.
 */
export function abortOnDisconnect(res: ServerResponse): DisconnectSignal {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) controller.abort(new Error('Client disconnected'));
  };

  res.on('close', onClose);

  return {
    signal: controller.signal,
    dispose: () => res.off('close', onClose),
  };
}

/**
 * Hijacks `reply` and streams `events` to it as SSE, ending the response when
 * the iterable ends. A failure thrown mid-stream becomes an `error` frame (the
 * facade already turns a provider failure into one, in band). Never throws.
 */
export async function pipeAiSse(
  reply: FastifyReply,
  events: AsyncIterable<AiStreamEvent>,
  disconnect: DisconnectSignal,
): Promise<void> {
  // Keep headers hooks already set on the reply (CORS, request id) — a
  // hijacked reply writes straight to the socket and would drop them.
  const inherited = { ...(reply.getHeaders() as OutgoingHttpHeaders) };
  delete inherited['content-length'];
  delete inherited['content-type'];

  reply.hijack();

  const res = reply.raw;
  const closed = () => res.destroyed || res.writableEnded || disconnect.signal.aborted;

  res.socket?.setNoDelay(true);
  res.socket?.setTimeout(0);
  res.writeHead(200, { ...inherited, ...AI_SSE_HEADERS });
  res.flushHeaders();

  const write = async (chunk: string): Promise<void> => {
    if (closed() || res.write(chunk)) return;

    // Back-pressure: wait for the socket to drain (or die).
    await new Promise<void>((resolve) => {
      const done = () => {
        res.off('drain', done);
        res.off('close', done);
        resolve();
      };
      res.on('drain', done);
      res.on('close', done);
    });
  };

  const heartbeat = setInterval(() => {
    if (!closed()) res.write(': ping\n\n');
  }, AI_SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    for await (const event of events) {
      // `break` returns the iterator, which lets the adapter close its
      // connection; the aborted signal has already stopped the provider.
      if (closed()) break;
      await write(formatSseEvent(event));
    }
  } catch (err) {
    if (!closed()) await write(formatSseEvent(toErrorEvent(err)));
  } finally {
    clearInterval(heartbeat);
    disconnect.dispose();
    if (!res.writableEnded) res.end();
  }
}
