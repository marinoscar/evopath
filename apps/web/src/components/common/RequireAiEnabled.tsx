/**
 * Route guard: render `children` only while AI is switched on in this
 * deployment — issue #425, epic #419.
 *
 * The FEATURE half of an AI route's gate; `RequirePermission` is the
 * permission half, and `App.tsx` nests this inside it so a user without the
 * permission is redirected without the feature question mattering. Every AI
 * route uses it except `/admin/settings/ai`, which is where AI is switched on
 * and so must stay reachable while it is off.
 *
 * WHILE THE FIRST ANSWER IS IN FLIGHT this renders a spinner, not the
 * fallback: `useAiConfig` fails closed (`enabled: false`) until it knows, and
 * redirecting on that provisional answer would bounce every deep link to `/ai`
 * back home before the real answer arrived. Once the answer is in, a refresh
 * never flips `isLoading` again, so the guarded page is not unmounted by its
 * own re-read.
 */
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAiConfig } from '../../hooks/useAiConfig';
import { LoadingSpinner } from './LoadingSpinner';

interface RequireAiEnabledProps {
  children: ReactNode;
  /** Rendered when AI is off. Defaults to a replace-redirect to `/`, like every settings route. */
  fallback?: ReactNode;
}

export function RequireAiEnabled({
  children,
  fallback = <Navigate to="/" replace />,
}: RequireAiEnabledProps) {
  const { config, isLoading } = useAiConfig();

  if (isLoading) return <LoadingSpinner />;
  if (!config.enabled) return <>{fallback}</>;
  return <>{children}</>;
}
