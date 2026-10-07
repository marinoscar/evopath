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
