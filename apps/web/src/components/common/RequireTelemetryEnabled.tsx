/**
 * Route guard: render `children` only while telemetry is available AND switched
 * on in this deployment — issue #537, epic #528. Modelled on `RequireAiEnabled`.
 *
 * The FEATURE half of a telemetry route's gate; `RequirePermission` is the
 * permission half, and `App.tsx` nests this inside it. The Telemetry settings
 * page does NOT use it: that page is where telemetry is switched on.
 *
 * While the first answer is in flight this renders a spinner rather than the
 * fallback, so a deep link is not bounced home on the provisional "off".
 */
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { isTelemetryOn, useTelemetryConfig } from '../../hooks/useTelemetryConfig';
import { LoadingSpinner } from './LoadingSpinner';

interface RequireTelemetryEnabledProps {
  children: ReactNode;
  /** Rendered when telemetry is off. Defaults to a replace-redirect to `/`. */
  fallback?: ReactNode;
}

export function RequireTelemetryEnabled({
  children,
  fallback = <Navigate to="/" replace />,
}: RequireTelemetryEnabledProps) {
  const { config, isLoading } = useTelemetryConfig();

  if (isLoading) return <LoadingSpinner />;
  if (!isTelemetryOn(config)) return <>{fallback}</>;
  return <>{children}</>;
}
