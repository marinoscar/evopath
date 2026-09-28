/**
 * Pure helpers shared by the admin AI Usage page and the user's "Usage"
 * section (issue #444, epic #420).
 */
import type { AiUsageCounters, AiUsageReport, AiUsageSeriesEntry } from '../../../services/ai';

const numberFormat = new Intl.NumberFormat('en-US');

/** `48000` → `48,000`. */
export function formatCount(value: number): string {
  return numberFormat.format(value);
}

/**
 * `failed / requests` as a percentage with one decimal, or an em dash when
 * nothing was requested — 0% would claim a success rate nobody measured.
 */
export function formatFailureRate(counters: Pick<AiUsageCounters, 'failed' | 'requests'>): string {
  if (counters.requests <= 0) return '—';
  return `${((counters.failed / counters.requests) * 100).toFixed(1)}%`;
}

/** `2026-09-24` → `Sep 24` (UTC, so the day never shifts with the viewer's zone). */
export function formatUsageDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** `units` as `images: 4 · audioSeconds: 31.4`, or `null` when there are none. */
export function formatUnits(units: Record<string, number>): string | null {
  const entries = Object.entries(units ?? {}).filter(([, value]) => value > 0);
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => `${key}: ${formatCount(value)}`).join(' · ');
}

/**
 * The `day` series, one entry per calendar day of the report's range.
 *
 * The API may omit days with no activity; a time axis that skips them draws
 * two busy days as neighbours and hides the quiet stretch between them, so
 * the gaps are filled with zero entries here. Entries outside the range (a
 * backend that answers more than asked) are kept, in date order.
 */
export function fillDailySeries(report: AiUsageReport<string>): AiUsageSeriesEntry[] {
  const byKey = new Map(report.series.map((entry) => [entry.key, entry]));
  const start = Date.parse(`${report.range.from.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${report.range.to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start || end - start > 366 * 86_400_000) {
    return [...report.series].sort((a, b) => a.key.localeCompare(b.key));
  }

  const days: AiUsageSeriesEntry[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    const key = new Date(t).toISOString().slice(0, 10);
    days.push(
      byKey.get(key) ?? {
        key,
        label: key,
        requests: 0,
        failed: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        units: {},
      },
    );
    byKey.delete(key);
  }
  return [...days, ...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}
