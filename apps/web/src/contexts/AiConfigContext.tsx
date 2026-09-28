/**
 * The one `GET /api/ai/config` fetch for the authenticated shell — issue #425,
 * epic #419. See `hooks/useAiConfig.ts` for why there is exactly one.
 *
 * Mounted inside `ProtectedRoute` (the endpoint is `@Auth()`, so mounting it on
 * `/login` would buy a 401) and around `Layout`, so the navigation chrome and
 * every routed page read the same answer.
 */
import type { ReactNode } from 'react';
import { AiConfigContext, useAiConfigQuery } from '../hooks/useAiConfig';

export function AiConfigProvider({ children }: { children: ReactNode }) {
  const value = useAiConfigQuery();
  return <AiConfigContext.Provider value={value}>{children}</AiConfigContext.Provider>;
}
