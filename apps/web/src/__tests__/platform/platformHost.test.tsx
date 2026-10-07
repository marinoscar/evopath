/**
 * The app's web platform host (marinoscar/EnterpriseAppBase#717): the adapter
 * every packaged page reads.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { server } from '../mocks/server';
import { mockAdminUser, mockUser, render } from '../utils/test-utils';
import { ApiError, api } from '../../services/api';
import { appPlatformApi, toPlatformApiError, useAppPlatformHost } from '../../platform/platformHost';

beforeEach(() => {
  api.setAccessToken(null);
});

describe('toPlatformApiError', () => {
  it("maps the app's ApiError onto PlatformApiError, code included", () => {
    const mapped = toPlatformApiError(new ApiError('Settings version mismatch', 409, 'CONFLICT'));

    expect(isPlatformApiError(mapped)).toBe(true);
    expect(mapped).toMatchObject({ status: 409, message: 'Settings version mismatch', code: 'CONFLICT' });
  });

  it('carries the error envelope details (telemetry reads details.reason)', () => {
    const mapped = toPlatformApiError(
      new ApiError('Query rejected', 400, 'BAD_REQUEST', { reason: 'TELEMETRY_QUERY_REJECTED' }),
    );

    expect(mapped).toMatchObject({ status: 400, details: { reason: 'TELEMETRY_QUERY_REJECTED' } });
  });

  it('passes anything else through untouched', () => {
    const network = new TypeError('Failed to fetch');

    expect(toPlatformApiError(network)).toBe(network);
    expect(isPlatformApiError(toPlatformApiError(network))).toBe(false);
  });
});

describe('appPlatformApi (the app transport)', () => {
  it('unwraps the { data } envelope and rejects an error status as a PlatformApiError', async () => {
    server.use(
      http.get('*/api/platform-probe', () => HttpResponse.json({ data: { ok: true } })),
      http.delete('*/api/platform-probe', () => HttpResponse.json({ message: 'Nope' }, { status: 403 })),
    );

    await expect(appPlatformApi.get('/platform-probe')).resolves.toEqual({ ok: true });
    const error = await appPlatformApi.delete('/platform-probe').catch((e: unknown) => e);
    expect(isPlatformApiError(error)).toBe(true);
    expect(error).toMatchObject({ status: 403, message: 'Nope' });
  });

  it('sends ifMatch as the If-Match header on a PATCH', async () => {
    let ifMatch: string | null = null;
    server.use(
      http.patch('*/api/platform-probe', ({ request }) => {
        ifMatch = request.headers.get('If-Match');
        return HttpResponse.json({ data: null });
      }),
    );

    await appPlatformApi.patch('/platform-probe', { a: 1 }, { ifMatch: '4' });
    expect(ifMatch).toBe('4');
  });
});

describe('appPlatformApi.getBlob (downloads)', () => {
  it('returns the raw body and the headers, not the envelope', async () => {
    server.use(
      http.get('*/api/platform-file', () =>
        new HttpResponse('{"bundleVersion":1}', {
          headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="x.json"' },
        }),
      ),
    );

    const { blob, headers } = await appPlatformApi.getBlob!('/platform-file');

    expect(await blob.text()).toBe('{"bundleVersion":1}');
    expect(headers.get('Content-Disposition')).toBe('attachment; filename="x.json"');
  });

  it('rejects an error status as a PlatformApiError', async () => {
    server.use(http.get('*/api/platform-file', () => HttpResponse.json({ message: 'Nope' }, { status: 403 })));

    const error = await appPlatformApi.getBlob!('/platform-file').catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 403, message: 'Nope' });
  });
});

describe('appPlatformApi request options, postBlob and postSse (marinoscar/EnterpriseAppBase#719)', () => {
  it('sends ifMatch as If-Match on a PUT and a DELETE', async () => {
    const seen: Array<string | null> = [];
    server.use(
      http.put('*/api/platform-probe', ({ request }) => {
        seen.push(request.headers.get('If-Match'));
        return HttpResponse.json({ data: null });
      }),
      http.delete('*/api/platform-probe', ({ request }) => {
        seen.push(request.headers.get('If-Match'));
        return HttpResponse.json({ data: null });
      }),
    );

    await appPlatformApi.put('/platform-probe', { a: 1 }, { ifMatch: '7' });
    await appPlatformApi.delete('/platform-probe', { ifMatch: '8' });
    expect(seen).toEqual(['7', '8']);
  });

  it('postBlob POSTs the JSON body and returns the raw body and headers', async () => {
    let body: unknown = null;
    server.use(
      http.post('*/api/platform-file', async ({ request }) => {
        body = await request.json();
        return new HttpResponse('a,b\n1,2\n', {
          headers: { 'Content-Type': 'text/csv', 'X-Telemetry-Row-Count': '1' },
        });
      }),
    );

    const { blob, headers } = await appPlatformApi.postBlob!('/platform-file', { sql: 'SELECT 1' });

    expect(body).toEqual({ sql: 'SELECT 1' });
    expect(await blob.text()).toBe('a,b\n1,2\n');
    expect(headers.get('X-Telemetry-Row-Count')).toBe('1');
  });

  it('postSse streams the frames of one POSTed request with the bearer token', async () => {
    let authorization: string | null = null;
    server.use(
      http.post('*/api/platform-stream', ({ request }) => {
        authorization = request.headers.get('Authorization');
        return new HttpResponse('event: step\ndata: {"n":1}\n\nevent: answer\ndata: {"text":"ok"}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );
    api.setAccessToken('token-1');
    const frames: Array<[string, unknown]> = [];

    await appPlatformApi.postSse!('/platform-stream', { q: 1 }, { onFrame: (event, data) => frames.push([event, data]) });

    expect(authorization).toBe('Bearer token-1');
    expect(frames).toEqual([
      ['step', { n: 1 }],
      ['answer', { text: 'ok' }],
    ]);
  });

  it('postSse rejects a refused request as a PlatformApiError', async () => {
    server.use(
      http.post('*/api/platform-stream', () =>
        HttpResponse.json({ message: 'Off', code: 'CONFLICT', details: { reason: 'AI_DISABLED' } }, { status: 409 }),
      ),
    );

    const error = await appPlatformApi.postSse!('/platform-stream', {}, { onFrame: () => undefined }).catch((e: unknown) => e);

    expect(isPlatformApiError(error)).toBe(true);
    expect(error).toMatchObject({ status: 409, details: { reason: 'AI_DISABLED' } });
  });
});

describe('useAppPlatformHost', () => {
  function hostFor(options: Parameters<typeof render>[1]) {
    let host: ReturnType<typeof useAppPlatformHost> | undefined;
    function Probe() {
      host = usePlatformHost();
      return null;
    }
    render(<Probe />, options);
    return host!;
  }

  it("exposes usePermissions().hasPermission, the user id and the app's transport", () => {
    const host = hostFor({ wrapperOptions: { user: mockAdminUser } });

    expect(host.api).toBe(appPlatformApi);
    expect(host.viewer.userId).toBe(mockAdminUser.id);
    expect(host.viewer.hasPermission('system_settings:read')).toBe(true);
    expect(host.viewer.hasPermission('doctor:read')).toBe(false);
    expect(typeof host.formatRelativeTime?.(new Date().toISOString())).toBe('string');
  });

  it("a viewer's permissions are the fixture user's", () => {
    const host = hostFor({ wrapperOptions: { user: mockUser } });

    expect(host.viewer.hasPermission('system_settings:read')).toBe(false);
    expect(host.viewer.hasPermission('user_settings:read')).toBe(true);
  });

  it('reads the feature map from the shell providers, never fetching it', () => {
    expect(hostFor({ wrapperOptions: { user: mockAdminUser } }).viewer.isFeatureEnabled('ai')).toBe(false);

    const on = hostFor({ wrapperOptions: { user: mockAdminUser, aiEnabled: true, telemetryEnabled: true } });
    expect(on.viewer.isFeatureEnabled('ai')).toBe(true);
    expect(on.viewer.isFeatureEnabled('telemetry')).toBe(true);
    expect(on.viewer.isFeatureEnabled('billing')).toBe(false);
  });

  it('keeps the same host across re-renders (packaged hooks key on it)', () => {
    const seen: unknown[] = [];
    function Probe({ tick }: { tick: number }) {
      seen.push(usePlatformHost());
      return <span>{tick}</span>;
    }
    const { rerender } = render(<Probe tick={1} />, { wrapperOptions: { user: mockAdminUser } });
    rerender(<Probe tick={2} />);

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size).toBe(1);
  });
});
