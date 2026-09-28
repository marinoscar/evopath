/**
 * Handing a SQL statement to the Telemetry Explorer — issue #579, epic #576.
 *
 * The Telemetry Dashboard's "Open in Explorer" and "View trace" navigate to the
 * explorer with the statement in the router's `location.state` (`{ sql }`).
 * A plain link can carry it instead as `?sql=<URL-encoded>` — the fallback for
 * a bookmark or a link pasted from elsewhere; `state` wins when both are set.
 *
 * The explorer puts a handed statement in its editor and NEVER runs it: the
 * reader reviews it and presses Run. Anything empty, not a string, or longer
 * than {@link TELEMETRY_SQL_MAX_LENGTH} (what the API would refuse anyway) is
 * ignored, and the explorer opens as usual.
 */
import { TELEMETRY_SQL_MAX_LENGTH } from '../../services/telemetry';

export const TELEMETRY_EXPLORER_PATH = '/admin/settings/telemetry/explorer';
export const TELEMETRY_DASHBOARD_PATH = '/admin/settings/telemetry/dashboard';
export const TELEMETRY_SETTINGS_PATH = '/admin/settings/telemetry';

/** The query parameter the explorer reads a handed statement from. */
export const EXPLORER_SQL_PARAM = 'sql';

export interface ExplorerHandoffState {
  sql: string;
}

/** A statement the explorer would accept from a handoff, or `null`. */
export function acceptableHandoffSql(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.trim() === '' || value.length > TELEMETRY_SQL_MAX_LENGTH) return null;
  return value;
}

/** The `navigate()` arguments that open the explorer with `sql` in its editor. */
export function explorerHandoff(sql: string): { to: string; state: ExplorerHandoffState } {
  return { to: TELEMETRY_EXPLORER_PATH, state: { sql } };
}

/** An explorer URL carrying `sql` as `?sql=` — for a link rather than a navigation. */
export function explorerSqlUrl(sql: string): string {
  return `${TELEMETRY_EXPLORER_PATH}?${new URLSearchParams({ [EXPLORER_SQL_PARAM]: sql })}`;
}

/**
 * The statement handed to the explorer on this navigation: `location.state.sql`
 * first, then `?sql=`. `null` when there is none or it is not acceptable.
 */
export function readExplorerHandoff(state: unknown, params: URLSearchParams): string | null {
  const fromState =
    typeof state === 'object' && state !== null ? acceptableHandoffSql((state as { sql?: unknown }).sql) : null;
  return fromState ?? acceptableHandoffSql(params.get(EXPLORER_SQL_PARAM));
}
