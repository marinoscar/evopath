/**
 * The one `GET /api/telemetry/config` fetch for the authenticated shell —
 * issue #537, epic #528. Mounted beside `AiConfigProvider`, for the same
 * reasons: its endpoint is `@Auth()`, and one mount point means one request
 * shared by the chrome and every routed page. See `hooks/useTelemetryConfig.ts`.
 */
import type { ReactNode } from 'react';
import { TelemetryConfigContext, useTelemetryConfigQuery } from '../hooks/useTelemetryConfig';

export function TelemetryConfigProvider({ children }: { children: ReactNode }) {
  const value = useTelemetryConfigQuery();
  return <TelemetryConfigContext.Provider value={value}>{children}</TelemetryConfigContext.Provider>;
}
