import { ConfigService } from '@nestjs/config';

import {
  STACK_AGENT_STATUS_TIMEOUT_MS,
  STACK_AGENT_UP_TIMEOUT_MS,
  StackAgentClient,
  describeFetchError,
  type FetchLike,
} from './stack-agent.client';

const TOKEN = 'sa-token-very-secret-value';

class TestClient extends StackAgentClient {
  setFetch(fn: FetchLike): void {
    this.fetchImpl = fn;
  }
}

function client(stackAgent: { url?: string; token?: string } | undefined, fetchMock?: jest.Mock): TestClient {
  const config = { get: jest.fn((key: string) => (key === 'stackAgent' ? stackAgent : undefined)) };
  const instance = new TestClient(config as unknown as ConfigService);
  if (fetchMock) instance.setFetch(fetchMock as unknown as FetchLike);

  return instance;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const CONFIGURED = { url: 'http://stack-agent:8090/', token: TOKEN };

describe('StackAgentClient', () => {
  describe('not configured', () => {
    it.each([
      ['no block at all', undefined],
      ['no url', { url: '', token: TOKEN }],
      ['no token', { url: 'http://stack-agent:8090', token: '' }],
    ])('reports not_configured with %s and makes no request', async (_label, stackAgent) => {
      const fetchMock = jest.fn();
      const c = client(stackAgent, fetchMock);

      expect(c.isConfigured()).toBe(false);
      await expect(c.telemetryStatus()).resolves.toMatchObject({ ok: false, error: 'not_configured' });
      await expect(c.telemetryUp()).resolves.toMatchObject({ ok: false, error: 'not_configured' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('telemetryStatus', () => {
    it('GETs /v1/telemetry with the bearer token and a 5 s timeout, trimming a trailing slash', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        json(200, { services: [{ name: 'greptimedb', state: 'running', health: 'healthy' }] }),
      );
      const timeout = jest.spyOn(AbortSignal, 'timeout');

      const result = await client(CONFIGURED, fetchMock).telemetryStatus();

      expect(result).toEqual({ ok: true, services: [{ name: 'greptimedb', state: 'running', health: 'healthy' }] });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://stack-agent:8090/v1/telemetry',
        expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }) }),
      );
      expect(timeout).toHaveBeenCalledWith(STACK_AGENT_STATUS_TIMEOUT_MS);
      timeout.mockRestore();
    });

    it('accepts a null health and a missing container', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        json(200, {
          services: [
            { name: 'greptimedb', state: 'missing', health: null },
            { name: 'otel-collector', state: 'exited', health: null },
          ],
        }),
      );

      const result = await client(CONFIGURED, fetchMock).telemetryStatus();

      expect(result.ok).toBe(true);
    });

    it('maps 401 to unauthorized', async () => {
      const result = await client(CONFIGURED, jest.fn().mockResolvedValue(json(401, { error: 'unauthorized' }))).telemetryStatus();

      expect(result).toMatchObject({ ok: false, error: 'unauthorized' });
    });

    it('maps a malformed body to failed', async () => {
      const result = await client(CONFIGURED, jest.fn().mockResolvedValue(json(200, { nope: true }))).telemetryStatus();

      expect(result).toMatchObject({ ok: false, error: 'failed' });
    });

    it('maps a DNS failure to unreachable, naming the code', async () => {
      const cause = Object.assign(new Error('getaddrinfo ENOTFOUND stack-agent'), { code: 'ENOTFOUND' });
      const fetchMock = jest.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause }));

      const result = await client(CONFIGURED, fetchMock).telemetryStatus();

      expect(result).toMatchObject({ ok: false, error: 'unreachable' });
      expect(!result.ok && result.message).toContain('ENOTFOUND');
      expect(!result.ok && result.message).toContain('http://stack-agent:8090');
    });

    it('maps a timeout to unreachable', async () => {
      const abort = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

      const result = await client(CONFIGURED, jest.fn().mockRejectedValue(abort)).telemetryStatus();

      expect(result).toMatchObject({ ok: false, error: 'unreachable' });
      expect(!result.ok && result.message).toContain('no answer within 5 s');
    });

    it('never puts the token in a message', async () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      const outcomes = [
        await client(CONFIGURED, jest.fn().mockRejectedValue(new TypeError('fetch failed', { cause }))).telemetryStatus(),
        await client(CONFIGURED, jest.fn().mockResolvedValue(json(401, {}))).telemetryStatus(),
        await client(CONFIGURED, jest.fn().mockResolvedValue(json(500, { ok: false, output: 'x' }))).telemetryUp(),
      ];

      for (const outcome of outcomes) {
        expect(JSON.stringify(outcome)).not.toContain(TOKEN);
      }
    });
  });

  describe('telemetryUp', () => {
    it('POSTs /v1/telemetry/up with the 11-minute timeout and returns the output', async () => {
      const fetchMock = jest.fn().mockResolvedValue(json(200, { ok: true, exitCode: 0, output: 'Started' }));
      const timeout = jest.spyOn(AbortSignal, 'timeout');

      const result = await client(CONFIGURED, fetchMock).telemetryUp();

      expect(result).toEqual({ ok: true, exitCode: 0, output: 'Started' });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://stack-agent:8090/v1/telemetry/up',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(timeout).toHaveBeenCalledWith(STACK_AGENT_UP_TIMEOUT_MS);
      expect(STACK_AGENT_UP_TIMEOUT_MS).toBe(11 * 60 * 1000);
      timeout.mockRestore();
    });

    it('maps 500 to failed, carrying the exit code and output', async () => {
      const fetchMock = jest.fn().mockResolvedValue(json(500, { ok: false, exitCode: 1, output: 'pull denied' }));

      const result = await client(CONFIGURED, fetchMock).telemetryUp();

      expect(result).toMatchObject({ ok: false, error: 'failed', exitCode: 1, output: 'pull denied' });
    });

    it('maps 409 to busy', async () => {
      const result = await client(CONFIGURED, jest.fn().mockResolvedValue(json(409, { error: 'busy' }))).telemetryUp();

      expect(result).toMatchObject({ ok: false, error: 'busy' });
    });

    it('maps 401 to unauthorized', async () => {
      const result = await client(CONFIGURED, jest.fn().mockResolvedValue(json(401, {}))).telemetryUp();

      expect(result).toMatchObject({ ok: false, error: 'unauthorized' });
    });

    it("maps the agent's 503 to not_configured", async () => {
      const result = await client(CONFIGURED, jest.fn().mockResolvedValue(json(503, { error: 'not_configured' }))).telemetryUp();

      expect(result).toMatchObject({ ok: false, error: 'not_configured' });
    });

    it('maps a connection refusal to unreachable', async () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.2:8090'), { code: 'ECONNREFUSED' });

      const result = await client(CONFIGURED, jest.fn().mockRejectedValue(new TypeError('fetch failed', { cause }))).telemetryUp();

      expect(result).toMatchObject({ ok: false, error: 'unreachable' });
    });
  });

  describe('describeFetchError', () => {
    it('falls back to the message', () => {
      expect(describeFetchError(new Error('boom'), 1000)).toBe('boom');
      expect(describeFetchError('weird', 1000)).toBe('weird');
    });
  });
});
