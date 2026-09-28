import type { OutgoingHttpHeaders } from 'node:http';

import type { FastifyReply } from 'fastify';

import { AI_SSE_HEADERS, AI_SSE_HEARTBEAT_MS, type DisconnectSignal } from '../../ai/http/ai-sse';
import type { TelemetryAssistantEmit } from '../dto/telemetry-assistant.dto';

// =============================================================================
// The telemetry assistant's event stream (issue #536, epic #528)
// =============================================================================
//
// `pipeAiSse` streams an `AiStreamEvent` iterable; the assistant's frames are
// its own (`step`, `answer`, `error`, `done` — the web contract), pushed as
// they happen. Same wire rules as `ai/http/ai-sse.ts`: the SAME headers
// (`X-Accel-Buffering: no`), a `: ping` comment every
// `AI_SSE_HEARTBEAT_MS`, headers other hooks set kept across the hijack.
//
// LAZY. The reply is hijacked on the FIRST `send`, so anything thrown before
// it is still an ordinary JSON error answered by the global filter.
// =============================================================================

/** One frame: `event: <name>` and the payload as one-line JSON. */
export function formatTelemetrySseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface TelemetrySseStream {
  /** Writes one frame, opening the stream first if needed. Never throws; a no-op once closed. */
  send: TelemetryAssistantEmit;
  /** Whether the reply has been hijacked (committed to `200 text/event-stream`). */
  readonly opened: boolean;
  /** Stops the heartbeat and ends the response. */
  close(): void;
}

export function openTelemetrySse(reply: FastifyReply, disconnect: DisconnectSignal): TelemetrySseStream {
  let opened = false;
  let heartbeat: NodeJS.Timeout | undefined;
  const res = reply.raw;
  const closed = () => res.destroyed || res.writableEnded || disconnect.signal.aborted;

  const open = () => {
    const inherited = { ...(reply.getHeaders() as OutgoingHttpHeaders) };
    delete inherited['content-length'];
    delete inherited['content-type'];

    reply.hijack();
    opened = true;

    res.socket?.setNoDelay(true);
    res.socket?.setTimeout(0);
    res.writeHead(200, { ...inherited, ...AI_SSE_HEADERS });
    res.flushHeaders();

    heartbeat = setInterval(() => {
      if (!closed()) res.write(': ping\n\n');
    }, AI_SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
  };

  return {
    send: (event, data) => {
      try {
        if (!opened) open();
        if (!closed()) res.write(formatTelemetrySseFrame(event, data));
      } catch {
        // A dead socket: the disconnect signal stops the work.
      }
    },
    get opened() {
      return opened;
    },
    close: () => {
      if (heartbeat) clearInterval(heartbeat);
      disconnect.dispose();
      if (!res.writableEnded) res.end();
    },
  };
}
