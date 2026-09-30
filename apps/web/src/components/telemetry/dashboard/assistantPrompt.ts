/**
 * The question the Telemetry Dashboard's "Ask assistant" / "Explain this"
 * prefills — issue #579, epic #576.
 *
 * A pure function of what the panel SHOWS and the dashboard's window and
 * filters, so the assistant starts from the same picture as the reader:
 *
 *   Investigate "<panel title>" for <window> (<filters | all services>).
 *   Current state: <what the panel shows>.
 *   What is most likely causing this, and what should I check next?
 *
 * Bounds: the whole question is at most {@link ASSISTANT_PROMPT_MAX}
 * characters, any one message (a log body, an error, a verdict reason) at most
 * {@link ASSISTANT_PROMPT_MESSAGE_MAX}, lists stop at
 * {@link ASSISTANT_PROMPT_TOP_N} entries, and at most ONE sample trace id is
 * included. The text is prefilled, never sent: the reader can edit it.
 */
import {
  DASHBOARD_RANGE_LABELS,
  type DashboardApiBucket,
  type DashboardEvent,
  type DashboardLogsBucket,
  type DashboardMetricGroup,
  type DashboardMetricTable,
  type DashboardRange,
  type DashboardSeverity,
  type DashboardTile,
  type DashboardTopError,
  type DashboardTopRoute,
  type DashboardVerdictLevel,
} from '../../../services/telemetryDashboard';
import { formatDuration, formatMetricValue, formatTileValue, toNumber } from './format';
import { isTraceId } from './traceLink';

export const ASSISTANT_PROMPT_MAX = 2000;
export const ASSISTANT_PROMPT_MESSAGE_MAX = 200;
export const ASSISTANT_PROMPT_TOP_N = 5;

const CLOSING = 'What is most likely causing this, and what should I check next?';

const LEVEL_LABELS: Record<DashboardVerdictLevel, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  critical: 'Critical',
  no_data: 'No telemetry received',
};

/** What a panel shows, by kind. `title` is the panel's heading. */
export type AssistantPanelContext =
  | { kind: 'verdict'; title: string; verdict: { level: DashboardVerdictLevel; reasons: string[] } }
  | { kind: 'tiles'; title: string; tiles: DashboardTile[]; runtime?: DashboardTile[] }
  | { kind: 'api'; title: string; buckets: DashboardApiBucket[] }
  | { kind: 'logs'; title: string; buckets: DashboardLogsBucket[]; severities: DashboardSeverity[] }
  | { kind: 'routes'; title: string; items: DashboardTopRoute[] }
  | { kind: 'errors'; title: string; items: DashboardTopError[] }
  | { kind: 'events'; title: string; items: DashboardEvent[]; severities: DashboardSeverity[]; q: string }
  /** An infrastructure section (#127): its tiles and tables, as `/metrics` returned them. */
  | {
      kind: 'metrics';
      title: string;
      group: DashboardMetricGroup;
      tiles: DashboardTile[];
      tables: DashboardMetricTable[];
      /** For a hint when the section is partial. */
      skipped?: string[];
    };

/** The dashboard's window and filters (a subset of `DashboardState`). */
export interface AssistantQuestionContext {
  range: DashboardRange;
  from: string | null;
  to: string | null;
  service: string | null;
  instance: string | null;
  /** The host filter (#127); mentioned for an infrastructure section only, the one place it applies. */
  host?: string | null;
  /** For relative times ("Last data 2m ago"). Default `Date.now()`. */
  now?: number;
}

/** Whitespace collapsed, cut to `max` characters with an ellipsis. */
export function clip(text: string, max: number = ASSISTANT_PROMPT_MESSAGE_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `2026-09-27T10:03:00.000Z` → `2026-09-27 10:03 UTC`. */
function utcMinute(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function windowText(context: AssistantQuestionContext): string {
  if (context.from && context.to) return `${utcMinute(context.from)} – ${utcMinute(context.to)}`;
  return `the ${DASHBOARD_RANGE_LABELS[context.range].toLowerCase()}`;
}

function filtersText(context: AssistantQuestionContext, withHost = false): string {
  const parts: string[] = [];
  if (context.service) parts.push(`service ${clip(context.service)}`);
  if (context.instance) parts.push(`instance ${clip(context.instance)}`);
  if (withHost && context.host) parts.push(`host ${clip(context.host)}`);
  return parts.length > 0 ? parts.join(', ') : 'all services';
}

const count = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

function tileText(tile: DashboardTile, now: number): string {
  const current = formatTileValue(tile.value, tile.unit, now);
  const value = `${current.value}${current.unit === '%' || !current.unit ? current.unit : ` ${current.unit}`}`;
  if (tile.unit === 'timestamp' || toNumber(tile.previous) === null) return `${clip(tile.label)} ${value}`;
  const before = formatTileValue(tile.previous, tile.unit, now);
  const previous = `${before.value}${before.unit === '%' || !before.unit ? before.unit : ` ${before.unit}`}`;
  return `${clip(tile.label)} ${value} (previous window ${previous})`;
}

/** The busiest bucket by `pick`, or null when every value is 0. */
function peak<T extends { t: string }>(buckets: T[], pick: (bucket: T) => number): { t: string; value: number } | null {
  let best: { t: string; value: number } | null = null;
  for (const bucket of buckets) {
    const value = pick(bucket);
    if (value > 0 && (!best || value > best.value)) best = { t: bucket.t, value };
  }
  return best;
}

function apiState(buckets: DashboardApiBucket[]): string {
  if (buckets.length === 0) return 'no requests in this window';
  let total = 0;
  let s4xx = 0;
  let s5xx = 0;
  for (const b of buckets) {
    total += b.s2xx + b.s3xx + b.s4xx + b.s5xx;
    s4xx += b.s4xx;
    s5xx += b.s5xx;
  }
  if (total === 0) return 'no requests in this window';
  const parts = [`${count(total)} requests, ${count(s5xx)} 5xx (${pct((s5xx / total) * 100)}), ${count(s4xx)} 4xx`];
  const worstP95 = buckets.reduce<DashboardApiBucket | null>(
    (worst, b) => (b.p95Ms !== null && (worst?.p95Ms ?? -1) < b.p95Ms ? b : worst),
    null,
  );
  if (worstP95?.p95Ms != null) parts.push(`worst p95 ${formatDuration(worstP95.p95Ms)} at ${utcMinute(worstP95.t)}`);
  const most5xx = peak(buckets, (b) => b.s5xx);
  if (most5xx) parts.push(`most 5xx at ${utcMinute(most5xx.t)} (${count(most5xx.value)})`);
  return parts.join('; ');
}

function logsState(buckets: DashboardLogsBucket[], severities: DashboardSeverity[]): string {
  const totals = { error: 0, warn: 0, info: 0 };
  for (const b of buckets) {
    totals.error += b.error;
    totals.warn += b.warn;
    totals.info += b.info + b.other;
  }
  const shown = severities.filter((severity) => totals[severity] > 0);
  if (shown.length === 0) return `no ${severities.join('/')} log records in this window`;
  const parts = [`${shown.map((severity) => `${count(totals[severity])} ${severity}`).join(', ')} log records`];
  const mostErrors = severities.includes('error') ? peak(buckets, (b) => b.error) : null;
  if (mostErrors) parts.push(`most errors at ${utcMinute(mostErrors.t)} (${count(mostErrors.value)})`);
  return parts.join('; ');
}

function routesState(items: DashboardTopRoute[]): string {
  if (items.length === 0) return 'no requests in this window';
  return items
    .slice(0, ASSISTANT_PROMPT_TOP_N)
    .map((item) => {
      const route = clip([item.method, item.route].filter(Boolean).join(' ') || 'unknown route');
      const p95 = item.p95Ms === null ? 'p95 n/a' : `p95 ${formatDuration(item.p95Ms)}`;
      return `${route} — ${count(item.count)} requests, ${pct(item.errorRatePct)} errors, ${p95}`;
    })
    .join('; ');
}

function sampleTrace(ids: (string | null)[]): string | null {
  return ids.find(isTraceId) ?? null;
}

function errorsState(items: DashboardTopError[]): string {
  if (items.length === 0) return 'no error logs in this window';
  const top = items.slice(0, ASSISTANT_PROMPT_TOP_N);
  const text = top.map((item) => `"${clip(item.message ?? '(no message)')}" (${count(item.count)})`).join('; ');
  const trace = sampleTrace(top.map((item) => item.sampleTraceId));
  return trace ? `${text}; sample trace ${trace}` : text;
}

function eventsState(items: DashboardEvent[], severities: DashboardSeverity[], q: string): string {
  const filter = `${severities.join('/')} events${q ? ` matching "${clip(q)}"` : ''}`;
  if (items.length === 0) return `no ${filter} in this window`;
  const top = items.slice(0, ASSISTANT_PROMPT_TOP_N);
  const text = top
    .map((item) => `[${clip(item.severity, 16)}] ${clip(item.body ?? '(no message)')}`)
    .join('; ');
  const trace = sampleTrace(top.map((item) => item.traceId));
  return `latest ${filter}: ${text}${trace ? `; sample trace ${trace}` : ''}`;
}

function verdictState(verdict: { level: DashboardVerdictLevel; reasons: string[] }): string {
  const label = LEVEL_LABELS[verdict.level] ?? verdict.level;
  const reasons = verdict.reasons.slice(0, ASSISTANT_PROMPT_TOP_N).map((reason) => clip(reason));
  return reasons.length > 0 ? `${label} — ${reasons.join('; ')}` : label;
}

/** A row is a problem when a status column says so: a failing URL or scrape job, a type with no eligible node. */
function isProblemRow(row: DashboardMetricTable['rows'][number]): boolean {
  return row.up === false || row.noEligibleNode === true;
}

/** `key — Label value, Label value` for up to four of the row's measured columns. */
function rowText(table: DashboardMetricTable, row: DashboardMetricTable['rows'][number], now: number): string {
  const cells = table.columns
    .filter((column) => column.key !== 'key' && column.key !== 'lastSeenAt')
    .filter((column) => row[column.key] !== null && row[column.key] !== undefined)
    .slice(0, 4)
    .map((column) => `${column.label} ${clip(formatMetricValue(row[column.key], column.unit, now), 80)}`);
  const key = clip(String(row.key ?? '(unknown)'), 80);
  return cells.length > 0 ? `${key} — ${cells.join(', ')}` : key;
}

/**
 * A section's tiles (at most {@link ASSISTANT_PROMPT_TOP_N}), then at most
 * {@link ASSISTANT_PROMPT_TOP_N} table rows in all, problem rows first.
 */
function metricsState(
  tiles: DashboardTile[],
  tables: DashboardMetricTable[],
  skipped: string[],
  now: number,
): string {
  const parts: string[] = [];
  const shownTiles = tiles.slice(0, ASSISTANT_PROMPT_TOP_N).map((tile) => tileText(tile, now));
  if (shownTiles.length > 0) parts.push(shownTiles.join('; '));
  let budget = ASSISTANT_PROMPT_TOP_N;
  for (const table of tables) {
    if (budget <= 0) break;
    const rows = [...table.rows].sort((a, b) => Number(isProblemRow(b)) - Number(isProblemRow(a))).slice(0, budget);
    if (rows.length === 0) continue;
    budget -= rows.length;
    const more = table.rows.length - rows.length;
    parts.push(
      `${clip(table.label, 80)}: ${rows.map((row) => rowText(table, row, now)).join('; ')}${more > 0 ? ` (+${more} more)` : ''}`,
    );
  }
  if (skipped.length > 0) parts.push(`${skipped.length} metric(s) of this section are not collected`);
  return parts.length > 0 ? parts.join('; ') : 'nothing collected for this section in this window';
}

function stateText(panel: AssistantPanelContext, now: number): string {
  switch (panel.kind) {
    case 'verdict':
      return verdictState(panel.verdict);
    case 'tiles': {
      const tiles = [...panel.tiles, ...(panel.runtime ?? [])];
      return tiles.length > 0 ? tiles.map((tile) => tileText(tile, now)).join('; ') : 'no indicators in this window';
    }
    case 'api':
      return apiState(panel.buckets);
    case 'logs':
      return logsState(panel.buckets, panel.severities);
    case 'routes':
      return routesState(panel.items);
    case 'errors':
      return errorsState(panel.items);
    case 'events':
      return eventsState(panel.items, panel.severities, panel.q);
    case 'metrics':
      return metricsState(panel.tiles, panel.tables, panel.skipped ?? [], now);
  }
}

/** The prefilled question for `panel` under the dashboard's `context`. */
export function buildAssistantQuestion(panel: AssistantPanelContext, context: AssistantQuestionContext): string {
  const now = context.now ?? Date.now();
  const opening = `Investigate "${clip(panel.title, 80)}" for ${windowText(context)} (${filtersText(context, panel.kind === 'metrics')}).`;
  const prefix = `${opening}\nCurrent state: `;
  const suffix = `.\n${CLOSING}`;
  const budget = ASSISTANT_PROMPT_MAX - prefix.length - suffix.length;
  const state = stateText(panel, now).replace(/[.\s]+$/, '');
  return `${prefix}${clip(state, Math.max(budget, 1))}${suffix}`;
}
