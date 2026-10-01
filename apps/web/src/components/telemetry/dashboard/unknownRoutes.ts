/**
 * Unknown API routes on the Telemetry Dashboard — issue #258.
 *
 * Pure helpers for the "Unknown API routes" panel (`UnknownRoutesPanel.tsx`),
 * kept apart from the component so the page can use them too.
 */
import { sqlList, type DashboardUnknownRoutes } from '../../../services/telemetryDashboard';

/** DOM id of the panel's region: the verdict reason about unknown routes scrolls here. */
export const UNKNOWN_ROUTES_ANCHOR = 'telemetry-unknown-routes';

/** The column only the API's unknown-route statements read (`app.route.matched`). */
const ROUTE_MATCHED_COLUMN = 'app.route.matched';

/**
 * The statements of the summary's `sql` that computed `unknownRoutes`, for
 * "Open in Explorer": the per-route list first, then the totals. Selected from
 * what the API reported it ran, never rebuilt. Empty when the summary ran
 * none (an older store), which disables the action.
 */
export function unknownRoutesSql(sql: string | string[] | null | undefined): string[] {
  const statements = sqlList(sql ?? undefined).filter((statement) => statement.includes(ROUTE_MATCHED_COLUMN));
  const perRoute = (statement: string) => /GROUP BY\s+method\s*,\s*route/i.test(statement);
  return [...statements.filter(perRoute), ...statements.filter((statement) => !perRoute(statement))];
}

/** Whether the panel has anything to show: the block is present and counted at least one request. */
export function hasUnknownRoutes(block: DashboardUnknownRoutes | undefined | null): block is DashboardUnknownRoutes {
  return !!block && block.requests > 0;
}

/** A verdict reason about unknown API routes (the API's wording, #258). */
export function isUnknownRoutesReason(reason: string): boolean {
  return /\bto unknown API routes\b/.test(reason);
}

/** Scroll the panel into view and move focus to it. */
export function scrollToUnknownRoutes(): void {
  const target = document.getElementById(UNKNOWN_ROUTES_ANCHOR);
  if (!target) return;
  target.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  target.focus({ preventScroll: true });
}
