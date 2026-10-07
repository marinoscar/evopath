/**
 * The app's web platform host: the ONE place the web app is bound to the
 * platform's packaged pages (marinoscar/EnterpriseAppBase#717, adopting the
 * Doctor package; marinoscar/EnterpriseAppBase#719, the telemetry package).
 *
 * Every packaged page (`@marinoscar/platform-web/<slice>/ui`) reads the app
 * through `usePlatformHost()`; this file builds that host from what the app
 * already has:
 *
 *   - `api`: the app's own transport (`services/api.ts`), so the auth header,
 *     the token refresh and the maintenance recogniser stay where they are.
 *     `getBlob`/`postBlob` use its `blobWithHeaders` response type for
 *     downloads, and `postSse` is `services/sse.ts`'s `postSse` (one POSTed
 *     request, one streamed answer) with the same bearer and refresh.
 *     The app's `ApiError` is mapped onto `PlatformApiError`; anything else
 *     (a network failure) passes through untouched. A MODULE-LEVEL constant,
 *     so its identity never changes and a packaged hook keyed on it never
 *     refetches on a re-render.
 *   - `viewer`: `usePermissions().hasPermission` and the auth context's user
 *     id, plus the feature map the settings hubs already read
 *     (`useAiFeatures`, `useTelemetryFeatures`: context only, never fetched).
 *   - `formatRelativeTime`: `utils/relativeTime`, so packaged pages date
 *     things the way the rest of the app does.
 *
 * Mounted once, in `App.tsx`, inside the auth provider and the AI / telemetry
 * config providers (so the feature map is real), around the shell. The test
 * wrapper (`__tests__/utils/test-utils.tsx`) mounts it the same way.
 */

import { useMemo } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { useTelemetryFeatures } from '@marinoscar/platform-web/telemetry/headless';
import type {
  PlatformApiClient,
  PlatformApiError,
  PlatformRequestOptions,
  PlatformSseOptions,
  PlatformWebHost,
} from '@marinoscar/platform-web/core';

import { useAuth } from '../contexts/AuthContext';
import { useAiFeatures } from '../hooks/useAiConfig';
import { usePermissions } from '../hooks/usePermissions';
import { API_BASE_URL, ApiError, api } from '../services/api';
import type { BlobWithHeaders } from '../services/api';
import { postSse } from '../services/sse';
import { formatRelativeTime } from '../utils/relativeTime';

/** The app's `ApiError` as a `PlatformApiError`; anything else unchanged. */
export function toPlatformApiError(error: unknown): unknown {
  if (error instanceof ApiError) {
    const mapped: Error & PlatformApiError = Object.assign(new Error(error.message), {
      name: 'PlatformApiError',
      status: error.status,
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.details === undefined ? {} : { details: error.details }),
    });
    return mapped;
  }
  return error;
}

async function mapped<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toPlatformApiError(error);
  }
}

/** `PlatformRequestOptions` as the app transport's request options. */
function requestOptions(options: PlatformRequestOptions | undefined) {
  if (options === undefined) return undefined;
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.ifMatch === undefined ? {} : { headers: { 'If-Match': options.ifMatch } }),
  };
}

/** The app's transport as a `PlatformApiClient`. Stable identity: a module constant. */
export const appPlatformApi: PlatformApiClient = Object.freeze({
  get: <T,>(path: string, options?: PlatformRequestOptions) => mapped(() => api.get<T>(path, requestOptions(options))),
  post: <T,>(path: string, body?: unknown, options?: PlatformRequestOptions) =>
    mapped(() => api.post<T>(path, body, requestOptions(options))),
  put: <T,>(path: string, body?: unknown, options?: PlatformRequestOptions) =>
    mapped(() => api.put<T>(path, body, requestOptions(options))),
  patch: <T,>(path: string, body?: unknown, options?: PlatformRequestOptions) =>
    mapped(() => api.patch<T>(path, body, requestOptions(options))),
  delete: <T,>(path: string, options?: PlatformRequestOptions) => mapped(() => api.delete<T>(path, requestOptions(options))),
  // Downloads (the Doctor's support bundle and the telemetry export,
  // marinoscar/EnterpriseAppBase#719):
  // the raw body and headers, through the same authenticated client (bearer,
  // refresh, maintenance).
  getBlob: (path: string, options?: PlatformRequestOptions) =>
    mapped(() => api.get<BlobWithHeaders>(path, { ...requestOptions(options), responseType: 'blobWithHeaders' })),
  postBlob: (path: string, body?: unknown, options?: PlatformRequestOptions) =>
    mapped(() =>
      api.post<BlobWithHeaders>(path, body, { ...requestOptions(options), responseType: 'blobWithHeaders' }),
    ),
  // One POSTed request, one streamed answer (the telemetry assistant):
  // `services/sse.ts`'s `postSse`, with the same bearer token and the same
  // single refresh-and-retry as every other call.
  postSse: (path: string, body: unknown, options: PlatformSseOptions) =>
    mapped(() =>
      postSse<unknown>({
        url: `${API_BASE_URL}${path}`,
        body,
        authorization: () => {
          const token = api.getAccessToken();
          return token ? `Bearer ${token}` : null;
        },
        reauthenticate: () => api.refreshToken(),
        onFrame: (event, data) => options.onFrame(event, data),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    ),
});

/** The host for the signed-in viewer. Memoised on what it reads. */
export function useAppPlatformHost(): PlatformWebHost {
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const { ai } = useAiFeatures();
  const { telemetry } = useTelemetryFeatures();
  const userId = user?.id ?? null;

  return useMemo<PlatformWebHost>(() => {
    const features: Record<string, boolean> = { ai, telemetry };
    return {
      api: appPlatformApi,
      viewer: {
        userId,
        hasPermission,
        isFeatureEnabled: (feature) => features[feature] === true,
      },
      formatRelativeTime: (iso) => formatRelativeTime(iso),
    };
  }, [userId, hasPermission, ai, telemetry]);
}

/** `PlatformHostProvider` bound to the app's host. Mount it once, inside the auth provider. */
export function AppPlatformHostProvider({ children }: { children: ReactNode }): ReactElement {
  const host = useAppPlatformHost();
  return <PlatformHostProvider host={host}>{children}</PlatformHostProvider>;
}
