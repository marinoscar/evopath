/**
 * Unknown API routes on the Telemetry Dashboard — issue #258.
 *
 * Pure helpers for the "Unknown API routes" panel (`UnknownRoutesPanel.tsx`),
 * kept apart from the component so the page can use them too.
 */
import { sqlList, type DashboardUnknownRoutes } from '../../../services/telemetryDashboard';

/** DOM id of the panel's region: the verdict reason about unknown routes scrolls here. */
export const UNKNOWN_ROUTES_ANCHOR = 'telemetry-unknown-routes';

/**
 * The statements the API reports it ran for `unknownRoutes`, for "Open in
 * Explorer": `unknownRoutes.sql` as sent (per-route list first, then the
 * totals), never rebuilt or picked out of the summary's `sql`. Empty when an
 * older API omits the field, which disables the action.
 */
export function unknownRoutesSql(block: DashboardUnknownRoutes | null | undefined): string[] {
  return sqlList(block?.sql);
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
