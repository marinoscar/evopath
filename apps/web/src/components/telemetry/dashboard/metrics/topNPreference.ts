/**
 * The "Top N" row limit a viewer picked for a dashboard table — issue #176.
 *
 * Per-viewer convenience in `localStorage`, modelled on the explorer's query
 * history (`../../queryHistory.ts`): every access is wrapped in try/catch
 * (private mode, blocked storage), and a missing, corrupt or no-longer-offered
 * value reads as `null`, so the caller falls back to the table's default.
 */

/** A row limit: a count, or every row the API returned. */
export type TopNOption = number | 'all';

export function topNStorageKey(tableKey: string): string {
  return `telemetry.dashboard.${tableKey}.topN`;
}

/** The stored choice for `tableKey`, if it is still one of `options`. */
export function readTopN(tableKey: string, options: readonly TopNOption[]): TopNOption | null {
  try {
    const raw = window.localStorage.getItem(topNStorageKey(tableKey));
    if (raw === null) return null;
    const value: TopNOption = raw === 'all' ? 'all' : Number(raw);
    return options.includes(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeTopN(tableKey: string, value: TopNOption): void {
  try {
    window.localStorage.setItem(topNStorageKey(tableKey), String(value));
  } catch {
    // Storage unavailable — the choice still holds for this page view.
  }
}
