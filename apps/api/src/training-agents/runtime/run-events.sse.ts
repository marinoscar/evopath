import type { OutgoingHttpHeaders } from 'node:http';

import type { FastifyReply } from 'fastify';

import { AI_SSE_HEADERS, AI_SSE_HEARTBEAT_MS, type DisconnectSignal } from '../../ai/http/ai-sse';
import { STREAM_END_STATUSES } from './run-events.registry';
import type { RunEventLog, RunEventRecord } from './run-events.service';

// =============================================================================
// GET /api/ai/training/stream/:runId: a run's events as Server-Sent Events
// =============================================================================
//
// Modelled on the telemetry assistant's stream (`telemetry-assistant.sse.ts`):
// the same headers (`X-Accel-Buffering: no`), a `: ping` comment every
// `AI_SSE_HEARTBEAT_MS`, headers other hooks set kept across the hijack. The
// controller checks ownership BEFORE calling this, so an unknown or foreign
// run is an ordinary JSON 404.
//
// FRAMES. `id: <seq>`, `event: <type>`, `data: <json>`. The stream first
// REPLAYS every event with `seq > after`, then TAILS by polling the table every
// second. Polling, not an in-process bus: the job may run on another API
// replica. It closes with `event: end` (`{ status }`) once the run is in a
// status the job has nothing more to say about (`succeeded`, `failed`,
// `cancelled`, `blocked_safety`, `awaiting_approval`) and the log is drained:
// the end is sent on the poll AFTER the one that first saw that status, so an
// event the handler appends just after writing the status is not lost.
//
// A client disconnect stops the loop; it never cancels the run. Writes respect
// back-pressure: a `write` that returns false waits for `drain` (or close).
// =============================================================================

/** How often the tail re-reads the event table. */
export const TRAINING_SSE_POLL_MS = 1_000;

/** Events read per page. */
export const TRAINING_SSE_PAGE = 200;

/** One frame: `id`, `event`, one-line JSON `data`. */
export function formatRunEventFrame(event: Pick<RunEventRecord, 'seq' | 'type' | 'data'>): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`;
}

/** The closing frame. */
export function formatEndFrame(status: string): string {
  return `event: end\ndata: ${JSON.stringify({ status })}\n\n`;
}

/** `after` from the query, else a numeric `Last-Event-ID`, else 0. */
export function resolveCursor(after: number | undefined, lastEventId: string | string[] | undefined): number {
  if (after !== undefined) return after;

  const header = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
  const parsed = header !== undefined && /^\d{1,10}$/.test(header.trim()) ? Number(header.trim()) : 0;

  return Number.isSafeInteger(parsed) ? parsed : 0;
}

export interface RunEventStreamArgs {
  runId: string;
  after: number;
  events: Pick<RunEventLog, 'list'>;
  /** The run's current status, or `null` once it is gone. */
  status(): Promise<string | null>;
  disconnect: DisconnectSignal;
  /** Test seam: waits `ms` or until the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Hijacks `reply` and streams the run's events until the run settles or the client leaves. Never throws. */
export async function streamRunEvents(reply: FastifyReply, args: RunEventStreamArgs): Promise<void> {
  const inherited = { ...(reply.getHeaders() as OutgoingHttpHeaders) };
  delete inherited['content-length'];
  delete inherited['content-type'];

  reply.hijack();

  const res = reply.raw;
  const signal = args.disconnect.signal;
  const closed = () => res.destroyed || res.writableEnded || signal.aborted;
  const sleep = args.sleep ?? defaultSleep;

  res.socket?.setNoDelay(true);
  res.socket?.setTimeout(0);
  res.writeHead(200, { ...inherited, ...AI_SSE_HEADERS });
  res.flushHeaders();

  const write = async (chunk: string): Promise<void> => {
    if (closed() || res.write(chunk)) return;

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

  let cursor = args.after;
  let settledSeen: string | null = null;

  try {
    while (!closed()) {
      const status = await args.status();

      // Drain everything after the cursor.
      for (;;) {
        const page = await args.events.list(args.runId, cursor, TRAINING_SSE_PAGE);
        for (const event of page) {
          if (closed()) return;
          await write(formatRunEventFrame(event));
          cursor = event.seq;
        }
        if (page.length < TRAINING_SSE_PAGE) break;
      }

      if (status === null) {
        await write(formatEndFrame('deleted'));
        return;
      }

      if (STREAM_END_STATUSES.has(status)) {
        // End on the poll after the first one that saw the settled status.
        if (settledSeen === status) {
          await write(formatEndFrame(status));
          return;
        }
        settledSeen = status;
      } else {
        settledSeen = null;
      }

      await sleep(args.pollMs ?? TRAINING_SSE_POLL_MS, signal);
    }
  } catch {
    // A database failure mid-stream: close; the client reconnects with its cursor.
  } finally {
    clearInterval(heartbeat);
    args.disconnect.dispose();
    if (!res.writableEnded) res.end();
  }
}
