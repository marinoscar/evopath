/**
 * The app's web platform host: the ONE place the web app is bound to the
 * platform's packaged pages (marinoscar/EnterpriseAppBase#717, adopting the
 * Doctor package).
 *
 * Every packaged page (`@marinoscar/platform-web/<slice>/ui`) reads the app
 * through `usePlatformHost()`; this file builds that host from what the app
 * already has:
 *
 *   - `api`: the app's own transport (`services/api.ts`), so the auth header,
 *     the token refresh and the maintenance recogniser stay where they are.
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
import type { PlatformApiClient, PlatformApiError, PlatformWebHost } from '@marinoscar/platform-web/core';

import { useAuth } from '../contexts/AuthContext';
import { useAiFeatures } from '../hooks/useAiConfig';
import { usePermissions } from '../hooks/usePermissions';
import { useTelemetryFeatures } from '../hooks/useTelemetryConfig';
import { ApiError, api } from '../services/api';
import { formatRelativeTime } from '../utils/relativeTime';

/** The app's `ApiError` as a `PlatformApiError`; anything else unchanged. */
export function toPlatformApiError(error: unknown): unknown {
  if (error instanceof ApiError) {
    const mapped: Error & PlatformApiError = Object.assign(new Error(error.message), {
      name: 'PlatformApiError',
      status: error.status,
      ...(error.code === undefined ? {} : { code: error.code }),
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

/** The app's transport as a `PlatformApiClient`. Stable identity: a module constant. */
export const appPlatformApi: PlatformApiClient = Object.freeze({
  get: <T,>(path: string) => mapped(() => api.get<T>(path)),
  post: <T,>(path: string, body?: unknown) => mapped(() => api.post<T>(path, body)),
  put: <T,>(path: string, body?: unknown) => mapped(() => api.put<T>(path, body)),
  patch: <T,>(path: string, body?: unknown, options?: { ifMatch?: string }) =>
    mapped(() =>
      api.patch<T>(path, body, options?.ifMatch === undefined ? undefined : { headers: { 'If-Match': options.ifMatch } }),
    ),
  delete: <T,>(path: string) => mapped(() => api.delete<T>(path)),
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
