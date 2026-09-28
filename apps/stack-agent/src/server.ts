// =============================================================================
// The HTTP surface: three routes, no parameters
// =============================================================================
//
//   GET  /health              200 {"ok":true}                  no auth
//   GET  /v1/telemetry        200 {"services":[...]}           bearer token
//   POST /v1/telemetry/up     200/500 {"ok","exitCode","output"} bearer token
//
// Everything else is 404. No route reads a parameter: not from the path, the
// query string, a header or the body (which is drained up to 1 KB and then
// discarded). The project, the files and the service names come from this
// container's own labels and from constants -- see compose.ts.
// =============================================================================

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

import { DiscoveryError, parsePs, psArgv, upArgv, type ComposeTarget } from './compose.js';
import { tailCap, type CommandRunner } from './runner.js';

/** A token shorter than this is treated as no token at all. */
export const MIN_TOKEN_LENGTH = 32;
/** The most request body the agent will read (and then ignore). */
export const MAX_BODY_BYTES = 1024;
/** `compose up` may pull two images on a slow link. */
export const UP_TIMEOUT_MS = 10 * 60_000;
export const PS_TIMEOUT_MS = 60_000;

export type LogEntry = Record<string, string | number | boolean | null>;

export interface AgentOptions {
  /** STACK_AGENT_TOKEN. Unset or short: every /v1 call is 503. */
  token: string | undefined;
  runner: CommandRunner;
  discover: () => Promise<ComposeTarget>;
  log: (entry: LogEntry) => void;
  now?: () => number;
}

/** Whether the configured token is usable at all. */
export function isConfigured(token: string | undefined): token is string {
  return typeof token === 'string' && token.length >= MIN_TOKEN_LENGTH;
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time bearer check. Both sides are hashed first, so the comparison
 * is always 32 bytes against 32 bytes and leaks neither the token's content
 * nor its length.
 */
export function tokenMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header ?? '');
  const presented = match?.[1] ?? '';
  // Always compare, even with nothing presented, so a missing header costs
  // the same as a wrong one.
  const equal = timingSafeEqual(digest(presented), digest(token));
  return equal && presented !== '';
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

/**
 * Reads and discards the request body, refusing past MAX_BODY_BYTES. Resolves
 * false when the body was too large (the caller answers 413).
 */
function drainBody(request: IncomingMessage): Promise<boolean> {
  const declared = Number(request.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return Promise.resolve(false);

  return new Promise((resolve) => {
    let size = 0;
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.pause();
        finish(false);
      }
    });
    request.on('end', () => finish(true));
    request.on('error', () => finish(false));
  });
}

type Route = 'health' | 'telemetry' | 'telemetry-up' | undefined;

function routeOf(method: string | undefined, url: string | undefined): Route {
  // A query string is a parameter, and no route takes one.
  if (url === undefined || url.includes('?')) return undefined;
  if (method === 'GET' && url === '/health') return 'health';
  if (method === 'GET' && url === '/v1/telemetry') return 'telemetry';
  if (method === 'POST' && url === '/v1/telemetry/up') return 'telemetry-up';
  return undefined;
}

/** What is logged of the path: never a query string. */
function loggedPath(url: string | undefined): string {
  const path = (url ?? '').split('?')[0] ?? '';
  return path.length > 200 ? `${path.slice(0, 200)}...` : path;
}

export function createAgent(options: AgentOptions): RequestListener {
  const now = options.now ?? (() => Date.now());
  const token = options.token;
  const configured = isConfigured(token);
  /** Single flight: at most one `compose up` at a time. */
  let busy = false;

  /** Scrubs the token from anything returned, however it got there. */
  const redact = (text: string): string =>
    configured ? text.split(token).join('[redacted]') : text;

  async function telemetryStatus(response: ServerResponse): Promise<void> {
    const target = await options.discover();
    const result = await options.runner(psArgv(target), {
      cwd: target.workingDir,
      timeoutMs: PS_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      options.log({ level: 'error', msg: 'compose ps failed', exitCode: result.exitCode });
      send(response, 502, { error: 'compose_failed' });
      return;
    }
    let services;
    try {
      services = parsePs(result.stdout);
    } catch {
      options.log({ level: 'error', msg: 'compose ps printed unreadable output' });
      send(response, 502, { error: 'compose_failed' });
      return;
    }
    send(response, 200, { services });
  }

  async function telemetryUp(response: ServerResponse): Promise<void> {
    if (busy) {
      send(response, 409, { error: 'busy' });
      return;
    }
    busy = true;
    const started = now();
    try {
      const target = await options.discover();
      const result = await options.runner(upArgv(target), {
        cwd: target.workingDir,
        timeoutMs: UP_TIMEOUT_MS,
      });
      const output = tailCap(redact(result.output));
      options.log({
        level: result.exitCode === 0 ? 'info' : 'error',
        msg: 'compose up finished',
        exitCode: result.exitCode,
        ms: now() - started,
      });
      send(response, result.exitCode === 0 ? 200 : 500, {
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        output,
      });
    } finally {
      busy = false;
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const route = routeOf(request.method, request.url);
    const isV1 = (request.url ?? '').startsWith('/v1/') || request.url === '/v1';

    if (!(await drainBody(request))) {
      response.setHeader('connection', 'close');
      send(response, 413, { error: 'payload_too_large' });
      return;
    }

    if (route === 'health') {
      send(response, 200, { ok: true });
      return;
    }

    // Every /v1 path is authenticated BEFORE it is routed, so an unknown one
    // cannot be told apart from a known one without the token.
    if (isV1) {
      if (!configured) {
        send(response, 503, { error: 'not_configured' });
        return;
      }
      if (!tokenMatches(request.headers.authorization, token)) {
        send(response, 401, { error: 'unauthorized' });
        return;
      }
    }

    if (route === 'telemetry') return telemetryStatus(response);
    if (route === 'telemetry-up') return telemetryUp(response);
    send(response, 404, { error: 'not_found' });
  }

  return (request, response) => {
    const started = now();
    response.on('finish', () => {
      options.log({
        level: 'info',
        msg: 'request',
        method: request.method ?? '',
        path: loggedPath(request.url),
        status: response.statusCode,
        ms: now() - started,
      });
    });

    handle(request, response).catch((error: unknown) => {
      const discovery = error instanceof DiscoveryError;
      options.log({
        level: 'error',
        msg: discovery ? 'discovery failed' : 'request failed',
        // A DiscoveryError's message is ours and carries no secret; anything
        // else is summarised by its class only.
        error: discovery ? error.message : error instanceof Error ? error.name : 'unknown',
      });
      if (!response.headersSent) {
        send(response, discovery ? 503 : 500, {
          error: discovery ? 'discovery_failed' : 'internal_error',
        });
      } else {
        response.destroy();
      }
    });
  };
}
