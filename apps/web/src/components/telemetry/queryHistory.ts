/**
 * The explorer's per-browser query history — issue #537, epic #528.
 *
 * The last {@link QUERY_HISTORY_LIMIT} distinct queries, newest first, in
 * `localStorage`. A per-viewer convenience only: every access is wrapped in
 * try/catch (private mode, blocked storage), and a missing or corrupt value
 * reads as an empty history.
 */

export const QUERY_HISTORY_KEY = 'telemetry-explorer:history';
export const QUERY_HISTORY_LIMIT = 20;

export function readQueryHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(QUERY_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, QUERY_HISTORY_LIMIT)
      : [];
  } catch {
    return [];
  }
}

/** Record `sql` as the newest entry and return the new history. */
export function pushQueryHistory(sql: string): string[] {
  const trimmed = sql.trim();
  const current = readQueryHistory();
  if (!trimmed) return current;
  const next = [trimmed, ...current.filter((entry) => entry !== trimmed)].slice(
    0,
    QUERY_HISTORY_LIMIT,
  );
  try {
    window.localStorage.setItem(QUERY_HISTORY_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — the in-memory list still updates for this session.
  }
  return next;
}

export function clearQueryHistory(): void {
  try {
    window.localStorage.removeItem(QUERY_HISTORY_KEY);
  } catch {
    // Nothing to do.
  }
}
