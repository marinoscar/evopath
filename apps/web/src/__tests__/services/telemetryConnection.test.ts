/**
 * The telemetry-connection wire contract (issue #558, epic #528): method,
 * path, `If-Match` and body of each of the four routes, asserted against MSW.
 * `If-Match: 0` IS sent — the check is `=== undefined`, never truthiness, so
 * the first save over the deployment default is still guarded.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  getTelemetryConnection,
  isTelemetryProbeSkipped,
  resetTelemetryConnection,
  testTelemetryConnection,
  updateTelemetryConnection,
  type TelemetryConnectionInput,
} from '../../services/telemetry';
import {
  mockTelemetryConnectionEnvironment,
  mockTelemetryConnectionStored,
  mockTelemetryConnectionTestResult,
} from '../mocks/fixtures/telemetry';

const API_BASE = '*/api';

const input: TelemetryConnectionInput = {
  host: 'greptimedb',
  pgPort: 4003,
  database: 'public',
  readerUser: 'readonly',
  readerPassword: 'pw',
  adminUser: null,
};

function capture(method: 'put' | 'delete' | 'post', path: string, data: unknown) {
  const calls: { body: unknown; ifMatch: string | null }[] = [];
  server.use(
    http[method](`${API_BASE}${path}`, async ({ request }) => {
      const text = await request.text();
      calls.push({ body: text ? JSON.parse(text) : null, ifMatch: request.headers.get('If-Match') });
      return HttpResponse.json({ data });
    }),
  );
  return calls;
}

describe('telemetry connection service', () => {
  it('GETs the connection', async () => {
    await expect(getTelemetryConnection()).resolves.toEqual(mockTelemetryConnectionStored);
  });

  it('PUTs the body with If-Match, including 0', async () => {
    const calls = capture('put', '/admin/telemetry/connection', mockTelemetryConnectionStored);
    await updateTelemetryConnection(input, 0);
    expect(calls).toEqual([{ body: input, ifMatch: '0' }]);
  });

  it('PUTs without If-Match when no version is given', async () => {
    const calls = capture('put', '/admin/telemetry/connection', mockTelemetryConnectionStored);
    await updateTelemetryConnection(input);
    expect(calls[0].ifMatch).toBeNull();
  });

  it('DELETEs with If-Match and no body', async () => {
    const calls = capture('delete', '/admin/telemetry/connection', mockTelemetryConnectionEnvironment);
    await expect(resetTelemetryConnection(3)).resolves.toEqual(mockTelemetryConnectionEnvironment);
    expect(calls).toEqual([{ body: null, ifMatch: '3' }]);
  });

  it('POSTs a test and resolves a failed diagnosis rather than throwing', async () => {
    const result = {
      host: 'greptimedb',
      hostMode: 'custom',
      reader: { success: false, latencyMs: 5, error: 'refused' },
      admin: { skipped: true },
    };
    const calls = capture('post', '/admin/telemetry/connection/test', result);
    const answer = await testTelemetryConnection(input);
    expect(calls[0].body).toEqual(input);
    expect(answer.reader.success).toBe(false);
    expect(isTelemetryProbeSkipped(answer.admin)).toBe(true);
    expect(answer.host).toBe('greptimedb');
  });

  it('sends exactly { host: null } for an automatic host (#570)', async () => {
    const calls = capture('put', '/admin/telemetry/connection', mockTelemetryConnectionStored);
    await updateTelemetryConnection({ host: null }, 3);
    expect(calls).toEqual([{ body: { host: null }, ifMatch: '3' }]);
  });

  it('POSTs exactly { host: null } to test the automatic connection (#570)', async () => {
    const calls = capture('post', '/admin/telemetry/connection/test', mockTelemetryConnectionTestResult);
    const answer = await testTelemetryConnection({ host: null });
    expect(calls[0].body).toEqual({ host: null });
    expect(answer.hostMode).toBe('auto');
  });
});
