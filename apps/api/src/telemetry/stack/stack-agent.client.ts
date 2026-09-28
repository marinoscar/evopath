import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

// =============================================================================
// StackAgentClient — the API's side of the VPS `stack-agent` sidecar
// (issue #567, epic #528)
// =============================================================================
//
// On a VPS deployment a small sidecar (`stack-agent`) holds the Docker socket
// and exposes, on the internal network only:
//
//   GET  /health              → { ok: true }                      (no auth)
//   GET  /v1/telemetry        → { services: [{ name, state, health }] }
//   POST /v1/telemetry/up     → 200 { ok, exitCode, output }  | 500 { ok: false, … }
//                               409 { error: 'busy' } | 503 { error: 'not_configured' }
//
// This client is the ONLY code that talks to it. It never throws: every
// outcome is a typed result, so callers (the admin status read, the deploy
// job) decide what a failure means for them.
//
// CONFIGURATION IS DEPLOYMENT INFRASTRUCTURE. `STACK_AGENT_URL` and
// `STACK_AGENT_TOKEN` (`configuration.ts` → `stackAgent`) are set by the
// compose stack that runs both containers — like the database credentials,
// not a runtime setting. Either missing (every development machine) means
// `not_configured`, and no request is made.
//
// ⚠ THE TOKEN IS NEVER LOGGED, RETURNED OR PUT IN AN ERROR MESSAGE. It is read
// once, here, and used only in the `Authorization` header. Messages carry the
// URL's origin and the failure, never headers.
// =============================================================================

/** Ceiling on a status read. The admin page waits on it. */
export const STACK_AGENT_STATUS_TIMEOUT_MS = 5_000;

/**
 * Ceiling on `POST /v1/telemetry/up`. The agent may pull images, which can
 * take up to ten minutes; one more minute of slack, and still well inside the
 * deploy job's 15-minute `maxRuntimeMs`.
 */
export const STACK_AGENT_UP_TIMEOUT_MS = 11 * 60 * 1000;

export const STACK_SERVICE_STATES = [
  'running',
  'restarting',
  'exited',
  'created',
  'paused',
  'dead',
  'missing',
] as const;

export const STACK_SERVICE_HEALTH = ['healthy', 'unhealthy', 'starting'] as const;

export const stackServiceSchema = z.object({
  name: z.string().min(1),
  state: z.enum(STACK_SERVICE_STATES),
  health: z.enum(STACK_SERVICE_HEALTH).nullable(),
});

export type StackService = z.infer<typeof stackServiceSchema>;

const telemetryStatusBodySchema = z.object({ services: z.array(stackServiceSchema) });

const upBodySchema = z.object({
  ok: z.boolean().optional(),
  exitCode: z.number().int().nullable().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
});

/** Why a call did not produce what was asked for. */
export type StackAgentErrorKind = 'not_configured' | 'unreachable' | 'unauthorized' | 'busy' | 'failed';

export type StackAgentFailure = {
  ok: false;
  error: StackAgentErrorKind;
  /** Human-readable detail. Never carries the token. */
  message: string;
  /** For `failed`: the agent's exit code, when it reported one. */
  exitCode?: number | null;
  /** For `failed`: the agent's command output, when it reported any. */
  output?: string;
};

export type StackAgentStatusResult = { ok: true; services: StackService[] } | StackAgentFailure;

export type StackAgentUpResult = { ok: true; exitCode: number; output: string } | StackAgentFailure;

/** The subset of the global `fetch` this client uses; injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

@Injectable()
export class StackAgentClient {
  private readonly logger = new Logger(StackAgentClient.name);
  private readonly baseUrl: string;
  private readonly token: string;

  /** Overridable in tests; the Node 24 global otherwise. */
  protected fetchImpl: FetchLike = (input, init) => fetch(input, init);

  constructor(config: ConfigService) {
    const raw = config.get<{ url?: string; token?: string }>('stackAgent') ?? {};

    this.baseUrl = (raw.url ?? '').trim().replace(/\/+$/, '');
    this.token = (raw.token ?? '').trim();
  }

  /** Both `STACK_AGENT_URL` and `STACK_AGENT_TOKEN` are set. */
  isConfigured(): boolean {
    return this.baseUrl !== '' && this.token !== '';
  }

  /** `GET /v1/telemetry` — the state of each telemetry service. Never throws. */
  async telemetryStatus(): Promise<StackAgentStatusResult> {
    const response = await this.request('GET', '/v1/telemetry', STACK_AGENT_STATUS_TIMEOUT_MS);
    if (!isResponse(response)) return response;

    if (response.status === 401 || response.status === 403) return unauthorized(response.status);
    if (response.status === 503) return notConfiguredByAgent();

    if (!response.ok) {
      return { ok: false, error: 'failed', message: `stack-agent answered HTTP ${response.status}` };
    }

    const parsed = telemetryStatusBodySchema.safeParse(await readJson(response));
    if (!parsed.success) {
      return { ok: false, error: 'failed', message: 'stack-agent returned an unexpected telemetry status body' };
    }

    return { ok: true, services: parsed.data.services };
  }

  /**
   * `POST /v1/telemetry/up` — start (pulling if needed) the telemetry
   * services. May take up to ten minutes. Never throws.
   */
  async telemetryUp(): Promise<StackAgentUpResult> {
    const response = await this.request('POST', '/v1/telemetry/up', STACK_AGENT_UP_TIMEOUT_MS);
    if (!isResponse(response)) return response;

    if (response.status === 401 || response.status === 403) return unauthorized(response.status);
    if (response.status === 409) {
      return { ok: false, error: 'busy', message: 'stack-agent is already running a deployment' };
    }
    if (response.status === 503) return notConfiguredByAgent();

    const parsed = upBodySchema.safeParse(await readJson(response));
    const body = parsed.success ? parsed.data : {};

    if (response.ok && body.ok !== false) {
      return { ok: true, exitCode: body.exitCode ?? 0, output: body.output ?? '' };
    }

    return {
      ok: false,
      error: 'failed',
      message:
        `stack-agent could not start the telemetry services (HTTP ${response.status}` +
        (body.exitCode !== undefined && body.exitCode !== null ? `, exit code ${body.exitCode}` : '') +
        ')',
      exitCode: body.exitCode ?? null,
      output: body.output ?? body.error ?? '',
    };
  }

  // ---------------------------------------------------------------------------

  private async request(
    method: 'GET' | 'POST',
    path: string,
    timeoutMs: number,
  ): Promise<Response | StackAgentFailure> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        error: 'not_configured',
        message: 'The stack agent is not configured on this deployment (STACK_AGENT_URL / STACK_AGENT_TOKEN).',
      };
    }

    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = `stack-agent at ${this.origin()} is unreachable: ${describeFetchError(error, timeoutMs)}`;
      this.logger.warn(`${method} ${path}: ${message}`);

      return { ok: false, error: 'unreachable', message };
    }
  }

  /** The URL's origin, for messages (never a path, query or credential). */
  private origin(): string {
    try {
      return new URL(this.baseUrl).origin;
    } catch {
      return 'the configured URL';
    }
  }
}

function isResponse(value: Response | StackAgentFailure): value is Response {
  return typeof (value as { status?: unknown }).status === 'number';
}

function unauthorized(status: number): StackAgentFailure {
  return {
    ok: false,
    error: 'unauthorized',
    message: `stack-agent refused the API's token (HTTP ${status}); STACK_AGENT_TOKEN does not match the agent's.`,
  };
}

function notConfiguredByAgent(): StackAgentFailure {
  return {
    ok: false,
    error: 'not_configured',
    message: 'stack-agent reports that it has no telemetry stack configured on this host.',
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** A fetch failure in words: a timeout, a DNS/connect error (its `cause`), or the message. */
export function describeFetchError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `no answer within ${Math.round(timeoutMs / 1000)} s`;
  }

  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;

    return typeof code === 'string' ? `${code} (${cause.message})` : cause.message;
  }

  return error instanceof Error ? error.message : String(error);
}
