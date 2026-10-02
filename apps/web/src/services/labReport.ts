/**
 * Lab report extraction, H4 (#188): the `lab_report` kind of the photo-intake
 * kit (`services/intake.ts`) and its helper routes (the duplicate warning;
 * #307: map one result and every same-named one), as the web app sees them. Design: docs/specs/health-records.md §2.10.
 *
 * A lab report (a PDF from a patient portal, or photos of the pages) is read
 * by the server into one draft item per printed result. The SERVER matches
 * each result to the lab catalog and converts it to the analyte's canonical
 * unit; the browser only shows what it decided, collects the user's edits and
 * sends them back. Nothing here decides whether a value is valid, which
 * analyte a printed name is, or whether apply may run: the API does.
 */
import { api, ApiError } from './api';
import type { MeasurementDto, MetricCatalog, MetricDef } from './health';
import type { DraftItemView } from './intake';

/** The intake kind (`POST /api/intakes { kind }`). Permanent on the server. */
export const LAB_REPORT_KIND = 'lab_report';

/** The one draft item kind inside it (`POST /api/intakes/:id/items { kind }`). */
export const LAB_REPORT_ITEM_KIND = 'result';

/** Files one lab report intake takes (multi-page photos; a PDF counts as one, up to 20 pages). */
export const LAB_REPORT_MAX_PHOTOS = 10;

/** The kind reads PDFs as well as photos (server `acceptedInputs: ['image', 'pdf']`). */
export const LAB_REPORT_ACCEPTS_PDF = true;

/** Mirrors the API's `MEASUREMENT_FLAGS`. */
export const LAB_FLAGS = ['low', 'normal', 'high', 'critical', 'unknown'] as const;
export type LabFlag = (typeof LAB_FLAGS)[number];

/** Mirrors the API's `LAB_PANELS`, in display order. */
export const LAB_PANELS = ['lipids', 'glycemic', 'cbc', 'cmp', 'thyroid', 'iron', 'other'] as const;
export type LabPanel = (typeof LAB_PANELS)[number];

export const LAB_PANEL_LABELS: Record<LabPanel, string> = {
  lipids: 'Lipids',
  glycemic: 'Glycemic',
  cbc: 'Complete blood count',
  cmp: 'Metabolic panel',
  thyroid: 'Thyroid',
  iron: 'Iron',
  other: 'Other',
};

export const LAB_FLAG_LABELS: Record<LabFlag, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  critical: 'Critical',
  unknown: 'Unknown',
};

/** How the server found the result's analyte. */
export type LabMatchStatus = 'matched' | 'suggested' | 'user_mapped' | 'unmatched';

/** One draft item value: one printed result (`labReportValueSchema`). */
export interface LabReportValue {
  /** A lab catalog key, or `null` while the result is unmatched. */
  analyteKey: string | null;
  nameAsPrinted: string | null;
  /** In `unit` (canonical once matched and convertible). */
  value: number | null;
  unit: string | null;
  /** A non-numeric result as printed (`negative`, `<0.5`); shown, never saved. */
  valueText: string | null;
  /** What the report printed, kept when the server converted the value. */
  originalValue: number | null;
  originalUnit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  flag: LabFlag | null;
  panel: LabPanel | null;
  /**
   * #305: the date this result was collected (`YYYY-MM-DD`), read per result
   * from a multi-date (trend) report. `null` (or absent on a draft read before
   * #305): the report date applies.
   */
  collectionDate: string | null;
  /** Server-owned: recomputed on every write. */
  match: LabMatchStatus;
}

/** The intake's context: what the report says about itself. The user may correct both. */
export interface LabReportContext {
  /** `YYYY-MM-DD`. */
  collectionDate?: string | null;
  labName?: string | null;
}

export const LAB_NAME_MAX = 120;

/** One lab entry the apply wrote: the results of one collection date (#305). */
export interface LabReportApplyEntry {
  entryId: string;
  /** `null`: saved at the time of apply. */
  collectionDate: string | null;
  items: MeasurementDto[];
}

/** `POST /api/intakes/:id/apply` for this kind. */
export interface LabReportApplyResult {
  /** `null` when every item was rejected. The first entry, kept for older callers. */
  entryId: string | null;
  /** #305: every entry written, one per collection date. Absent from an older server. */
  entryIds?: string[];
  entries?: LabReportApplyEntry[];
  items: MeasurementDto[];
  /** `mixed` when some date groups were dated and some saved at apply time. */
  measuredAtSource: 'collection_date' | 'mixed' | 'apply_time' | null;
  documentDate: string | null;
}

export interface LabReportDuplicateMatch {
  measurementId: string;
  entryId: string;
  measuredAt: string;
  origin: string;
  healthDocumentId: string | null;
  intakeId: string | null;
}

export interface LabReportDuplicate {
  itemId: string;
  analyteKey: string;
  /** Canonical. */
  value: number;
  unit: string;
  matches: LabReportDuplicateMatch[];
}

/** `GET /api/measurements/lab-reports/:intakeId/duplicates`. */
export interface LabReportDuplicates {
  intakeId: string;
  checkedDate: string;
  collectionDate: string | null;
  duplicates: LabReportDuplicate[];
}

/** The duplicate warning (`health_data:read` + `intakes:read`). Apply never de-duplicates. */
export function getLabReportDuplicates(intakeId: string): Promise<LabReportDuplicates> {
  return api.get<LabReportDuplicates>(`/measurements/lab-reports/${encodeURIComponent(intakeId)}/duplicates`);
}

/**
 * #317: why `apply` would refuse a result if it were accepted, as the server
 * words it. `code` is one of `UNMATCHED`, `UNIT_NOT_ALLOWED`, `NO_VALUE`,
 * `OUT_OF_RANGE`, `REFERENCE_ORDER`, `DUPLICATE_ON_DATE`, `DATE_CAP` or
 * `INVALID_RESULT` (an unknown code is shown by its message all the same).
 */
export interface LabReportIssue {
  code: string;
  field: string | null;
  message: string;
}

/** The issues of one result. Only results with at least one are listed. */
export interface LabReportItemIssues {
  itemId: string;
  issues: LabReportIssue[];
}

/** `GET /api/measurements/lab-reports/:intakeId/issues` (#317). */
export interface LabReportIssues {
  items: LabReportItemIssues[];
}

/**
 * What apply would refuse, per result (#317): the same check apply runs, over
 * every result not rejected, so the review can point at the rows before Save.
 */
export function getLabReportIssues(intakeId: string): Promise<LabReportIssues> {
  return api.get<LabReportIssues>(`/measurements/lab-reports/${encodeURIComponent(intakeId)}/issues`);
}

/** The issues route as a map from item id to its issues. */
export function issuesByItem(result: LabReportIssues): Map<string, LabReportIssue[]> {
  return new Map(result.items.filter((entry) => entry.issues.length > 0).map((entry) => [entry.itemId, entry.issues] as const));
}

/** One result the map left unchanged, with the server's reason (#307). */
export interface LabReportMapSkipped {
  itemId: string;
  message: string;
}

/** `POST /api/measurements/lab-reports/:intakeId/map` (#307). */
export interface LabReportMapResult {
  /** Every result the server mapped: the one picked and each same-named one. */
  items: DraftItemView<LabReportValue>[];
  /** Same-named results it could not map (e.g. a unit the analyte does not take). */
  skipped: LabReportMapSkipped[];
}

/** What `mapLabResult` carries to every same-named result: at least one of the two. */
export type LabReportMapChange = { analyteKey: string; unit?: string } | { analyteKey?: string; unit: string };

/**
 * "Map once, apply to all" (#307): set the analyte and/or the unit of one
 * result; the SERVER applies the same change to every other result of the
 * intake printed under the same name (it picks which: not rejected, not
 * already changed by the user another way) in one transaction,
 * re-normalising each like an edit. The given result is a no-op when it
 * already carries the change. A 400 means the given result itself could not
 * take it (`intakes:write` + `health_data:write`).
 */
export function mapLabResult(intakeId: string, itemId: string, change: LabReportMapChange): Promise<LabReportMapResult> {
  return api.post<LabReportMapResult>(`/measurements/lab-reports/${encodeURIComponent(intakeId)}/map`, {
    itemId,
    ...(change.analyteKey !== undefined ? { analyteKey: change.analyteKey } : {}),
    ...(change.unit !== undefined ? { unit: change.unit } : {}),
  });
}

/** `POST /api/measurements/lab-reports/:intakeId/reject-unmatched` (#311). */
export interface LabReportRejectUnmatchedResult {
  /** The results the server rejected. */
  items: DraftItemView<LabReportValue>[];
}

/**
 * Reject every result of the intake that is not mapped to an analyte (#311).
 * The SERVER picks them (not rejected, `analyteKey` null; a suggested match is
 * left alone). Each can be restored one by one.
 */
export function rejectUnmatchedLabResults(intakeId: string): Promise<LabReportRejectUnmatchedResult> {
  return api.post<LabReportRejectUnmatchedResult>(`/measurements/lab-reports/${encodeURIComponent(intakeId)}/reject-unmatched`);
}

/** "Rejected 3 unmatched results". */
export function labRejectedUnmatchedMessage(count: number): string {
  if (count === 0) return 'No unmatched results to reject';
  return `Rejected ${count} unmatched ${count === 1 ? 'result' : 'results'}`;
}

/** A printed name as the review compares it: trimmed, lower-case, single spaces. The server decides. */
export function foldPrintedName(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The other results of the review printed under the same name as `item`
 * that are not rejected: whether an edit is worth carrying over (#307).
 */
export function sameNamedOthers<T extends Pick<DraftItemView<LabReportValue>, 'id' | 'status' | 'value'>>(
  items: readonly T[],
  item: Pick<DraftItemView<LabReportValue>, 'id' | 'value'>,
): T[] {
  const name = foldPrintedName(item.value.nameAsPrinted);
  if (!name) return [];
  return items.filter(
    (other) => other.id !== item.id && other.status !== 'rejected' && foldPrintedName(other.value.nameAsPrinted) === name,
  );
}

/**
 * The change an edit makes that same-named results should share: the analyte
 * and/or the unit when they differ from before; `null` when neither changed.
 */
export function labEditChange(
  previous: Pick<LabReportValue, 'analyteKey' | 'unit'>,
  next: Pick<LabReportValue, 'analyteKey' | 'unit'>,
): LabReportMapChange | null {
  const analyteKey = next.analyteKey && next.analyteKey !== previous.analyteKey ? next.analyteKey : undefined;
  const unit = next.unit && next.unit !== previous.unit ? next.unit : undefined;
  if (analyteKey !== undefined) return { analyteKey, ...(unit !== undefined ? { unit } : {}) };
  if (unit !== undefined) return { unit };
  return null;
}

/**
 * What the review says after a map: "Mapped 5 results named “Chol/HDL Ratio”
 * to Cholesterol/HDL ratio", plus "2 could not be mapped" when the server
 * skipped some. `null` when one result was mapped and nothing was skipped
 * (the row itself shows it).
 */
export function labMappedMessage(
  result: LabReportMapResult,
  nameAsPrinted: string | null,
  analyteLabel: string,
): { message: string; severity: 'success' | 'warning' } | null {
  const mapped = result.items.length;
  const skipped = result.skipped.length;
  if (mapped <= 1 && skipped === 0) return null;
  const named = nameAsPrinted ? ` named “${nameAsPrinted}”` : '';
  const parts: string[] = [];
  if (mapped > 1) parts.push(`Mapped ${mapped} results${named} to ${analyteLabel}`);
  else if (mapped === 1) parts.push(nameAsPrinted ? `Mapped “${nameAsPrinted}” to ${analyteLabel}` : `Mapped 1 result to ${analyteLabel}`);
  if (skipped > 0) parts.push(`${skipped} could not be mapped`);
  return { message: parts.join('. '), severity: skipped > 0 ? 'warning' : 'success' };
}

/**
 * What the review says after an edit was carried to same-named results:
 * "Updated 4 other results named “Glucose”", plus "1 could not be updated".
 * `null` when no other result changed and none was skipped.
 */
export function labPropagatedMessage(
  result: LabReportMapResult,
  editedId: string,
  nameAsPrinted: string | null,
): { message: string; severity: 'success' | 'warning' } | null {
  const others = result.items.filter((item) => item.id !== editedId).length;
  const skipped = result.skipped.length;
  if (others === 0 && skipped === 0) return null;
  const named = nameAsPrinted ? ` named “${nameAsPrinted}”` : '';
  const parts: string[] = [];
  if (others > 0) parts.push(`Updated ${others} other ${others === 1 ? 'result' : 'results'}${named}`);
  if (skipped > 0) parts.push(`${skipped} could not be updated`);
  return { message: parts.join('. '), severity: skipped > 0 ? 'warning' : 'success' };
}

// -----------------------------------------------------------------------------
// Presentation helpers (no decisions: the server re-checks everything)
// -----------------------------------------------------------------------------

/** The lab analytes of the catalog, in catalog (panel, then analyte) order. */
export function labMetrics(catalog: MetricCatalog | null): MetricDef[] {
  return (catalog?.metrics ?? []).filter((metric) => metric.category === 'lab');
}

export function panelOf(value: Pick<LabReportValue, 'panel'>): LabPanel {
  return value.panel && (LAB_PANELS as readonly string[]).includes(value.panel) ? value.panel : 'other';
}

/** Items grouped by panel, in `LAB_PANELS` order; empty panels are left out. */
export function groupByPanel<T extends { value: Pick<LabReportValue, 'panel'> }>(
  items: readonly T[],
): { panel: LabPanel; items: T[] }[] {
  return LAB_PANELS.map((panel) => ({ panel, items: items.filter((item) => panelOf(item.value) === panel) })).filter(
    (group) => group.items.length > 0,
  );
}

/** A result still blocking apply: not rejected and not mapped to an analyte. */
export function isUnresolved(item: Pick<DraftItemView<LabReportValue>, 'status' | 'value'>): boolean {
  return item.status !== 'rejected' && !item.value.analyteKey;
}

/** A row the user should look at closely: unsure, low confidence, or not plainly matched. */
export function needsAttention(item: DraftItemView<LabReportValue>): boolean {
  return (
    item.uncertain ||
    item.confidence === 'low' ||
    item.value.match === 'suggested' ||
    item.value.match === 'unmatched' ||
    !item.value.analyteKey
  );
}

/** #317: the reason shown for a result not in the lab catalog. */
export const UNMATCHED_REASON = 'Not in the lab catalog: map it or reject it';
/** #317: the reason shown for a result already saved that has no decision yet. */
export const DUPLICATE_REASON = 'Already saved: skip it or save it again';

/** One reason a row needs attention before saving (#317). */
export interface LabAttentionReason {
  /** The server's issue code, or `UNMATCHED` / `ALREADY_SAVED` for the review's own two. */
  code: string;
  message: string;
}

/**
 * #317: why a row needs attention before saving: not in the catalog, already
 * saved with no decision yet, or what the server says apply would refuse
 * (`GET …/issues`). Rejected rows need none. Presentation only: the server
 * decides at apply; this just lists what it said, without repeats.
 */
export function labAttentionReasons(
  item: Pick<DraftItemView<LabReportValue>, 'status' | 'value'>,
  context: { issues?: readonly LabReportIssue[]; undecidedDuplicate?: boolean },
): LabAttentionReason[] {
  if (item.status === 'rejected') return [];
  const reasons: LabAttentionReason[] = [];
  const unresolved = isUnresolved(item);
  if (unresolved) reasons.push({ code: 'UNMATCHED', message: UNMATCHED_REASON });
  if (context.undecidedDuplicate) reasons.push({ code: 'ALREADY_SAVED', message: DUPLICATE_REASON });
  for (const issue of context.issues ?? []) {
    // The catalog reason is already said, in the review's words.
    if (issue.code === 'UNMATCHED' && unresolved) continue;
    if (reasons.some((reason) => reason.message === issue.message)) continue;
    reasons.push({ code: issue.code, message: issue.message });
  }
  return reasons;
}

/** "Needs attention", or "Needs attention · 2" with more than one reason. */
export function attentionLabel(count: number): string {
  return count > 1 ? `Needs attention · ${count}` : 'Needs attention';
}

/** Lower-case without accents, for the review's search ("Hémoglobine" finds "hemoglobine"). */
export function foldSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * #317: whether the review's search matches a result: a case- and
 * accent-insensitive substring of the printed name, the analyte's label and
 * catalog aliases, or the panel's label. An empty query matches everything.
 */
export function labResultMatches(
  value: Pick<LabReportValue, 'analyteKey' | 'nameAsPrinted' | 'panel'>,
  query: string,
  catalog: MetricCatalog | null,
): boolean {
  const needle = foldSearchText(query);
  if (!needle) return true;
  const metric = value.analyteKey ? catalog?.metrics.find((entry) => entry.key === value.analyteKey) : undefined;
  const haystack = [
    value.nameAsPrinted ?? '',
    ...(metric ? [metric.label, ...(metric.aliases ?? [])] : []),
    LAB_PANEL_LABELS[panelOf(value)],
  ];
  return haystack.some((text) => foldSearchText(text).includes(needle));
}

/** An empty result for "Add missing value". */
export function emptyLabResult(): LabReportValue {
  return {
    analyteKey: null,
    nameAsPrinted: null,
    value: null,
    unit: null,
    valueText: null,
    originalValue: null,
    originalUnit: null,
    referenceLow: null,
    referenceHigh: null,
    referenceText: null,
    flag: null,
    panel: null,
    collectionDate: null,
    match: 'unmatched',
  };
}

/**
 * The fields sent on an edit or add. `match`, `panel` and the original
 * value/unit are the server's (`normalizeValue` recomputes them), so they are
 * left for it to fill.
 */
export function labResultPayload(value: LabReportValue): Partial<LabReportValue> {
  return {
    analyteKey: value.analyteKey,
    nameAsPrinted: value.nameAsPrinted,
    value: value.value,
    unit: value.unit,
    valueText: value.valueText,
    originalValue: value.originalValue,
    originalUnit: value.originalUnit,
    referenceLow: value.referenceLow,
    referenceHigh: value.referenceHigh,
    referenceText: value.referenceText,
    flag: value.flag,
    collectionDate: value.collectionDate ?? null,
  };
}

// -----------------------------------------------------------------------------
// Per-result dates (#305): a trend report prints one column per collection date
// -----------------------------------------------------------------------------

/** The result's own date, `null` when it has none (or the draft predates #305). */
export function resultDate(value: Pick<LabReportValue, 'collectionDate'>): string | null {
  return value.collectionDate ?? null;
}

/** The date the result is saved on: its own, else the report date, else `null` (the time of saving). */
export function effectiveDate(value: Pick<LabReportValue, 'collectionDate'>, reportDate: string | null | undefined): string | null {
  return resultDate(value) ?? reportDate ?? null;
}

/**
 * Items grouped by {@link effectiveDate}, newest date first; the undated
 * group (saved at the time of saving) last. Items keep their order.
 */
export function groupByDate<T extends { value: Pick<LabReportValue, 'collectionDate'> }>(
  items: readonly T[],
  reportDate: string | null | undefined,
): { date: string | null; items: T[] }[] {
  const groups = new Map<string | null, T[]>();
  for (const item of items) {
    const date = effectiveDate(item.value, reportDate);
    const group = groups.get(date);
    if (group) group.push(item);
    else groups.set(date, [item]);
  }
  return [...groups.entries()]
    .map(([date, grouped]) => ({ date, items: grouped }))
    .sort((a, b) => (a.date === b.date ? 0 : a.date === null ? 1 : b.date === null ? -1 : a.date < b.date ? 1 : -1));
}

/** "Nov 19, 2025" for a `YYYY-MM-DD`, as a calendar date (no time zone can move it). */
export function formatLabDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The item "Accept high confidence" takes: pending, read with high confidence
 * and not flagged uncertain. Mirrors the server's filter for the count only;
 * the server picks the items.
 */
export function isHighConfidencePending(item: Pick<DraftItemView<unknown>, 'status' | 'confidence' | 'uncertain'>): boolean {
  return item.status === 'pending' && item.confidence === 'high' && !item.uncertain;
}

/** What the snackbar says after a save: "Saved 85 results on 5 dates" for several entries. */
export function labSavedMessage(result: Pick<LabReportApplyResult, 'items' | 'entries'>): string {
  const count = result.items.length;
  if (count === 0) return 'Nothing was saved';
  const entries = result.entries?.length ?? 0;
  if (entries > 1) return `Saved ${count} ${count === 1 ? 'result' : 'results'} on ${entries} dates`;
  return `Saved ${count} lab ${count === 1 ? 'result' : 'results'} to Health`;
}

/** True when `query` matches the analyte's key, label or one of its aliases (case-insensitive). */
export function analyteMatches(metric: MetricDef, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [metric.key, metric.label, ...(metric.aliases ?? [])].some((name) => name.toLowerCase().includes(needle));
}

/** A number as the review shows it: at most four decimals, no trailing zeros. */
export function formatLabNumber(value: number): string {
  return String(Number(value.toFixed(4)));
}

/** `3.9–5.5`, `< 200`, `> 39`, the printed text, or `null`. */
export function referenceRangeText(value: Pick<LabReportValue, 'referenceLow' | 'referenceHigh' | 'referenceText'>): string | null {
  const { referenceLow: low, referenceHigh: high } = value;
  if (low !== null && high !== null) return `${formatLabNumber(low)}–${formatLabNumber(high)}`;
  if (high !== null) return `≤ ${formatLabNumber(high)}`;
  if (low !== null) return `≥ ${formatLabNumber(low)}`;
  return value.referenceText || null;
}

/** One reason a refused apply gave, with the result it is about when the path names one (`items.<id>.…`). */
export interface LabApplyIssue {
  itemId: string | null;
  message: string;
}

/** What a refused apply means, in a form the review can act on. */
export type LabApplyRefusal =
  | { kind: 'unresolved'; itemIds: string[] }
  | { kind: 'issues'; messages: string[]; issues: LabApplyIssue[] }
  | { kind: 'pending' }
  | { kind: 'other'; error: unknown };

/** Reads `409 UNRESOLVED_ANALYTES`, `400 PENDING_ITEMS` and `400 details.issues`. */
export function labApplyRefusal(err: unknown): LabApplyRefusal {
  if (err instanceof ApiError) {
    const details = (err.details && typeof err.details === 'object' ? err.details : {}) as Record<string, unknown>;
    const reason = typeof details.reason === 'string' ? details.reason : err.code;
    if (err.status === 409 && reason === 'UNRESOLVED_ANALYTES') {
      const ids = Array.isArray(details.itemIds) ? details.itemIds.filter((id): id is string => typeof id === 'string') : [];
      return { kind: 'unresolved', itemIds: ids };
    }
    if (err.status === 400 && reason === 'PENDING_ITEMS') return { kind: 'pending' };
    if (err.status === 400 && Array.isArray(details.issues)) {
      const issues: LabApplyIssue[] = [];
      for (const raw of details.issues as unknown[]) {
        if (!raw || typeof raw !== 'object') continue;
        const { message, path } = raw as { message?: unknown; path?: unknown };
        if (typeof message !== 'string') continue;
        const itemId = typeof path === 'string' ? (/^items\.([^.]+)/.exec(path)?.[1] ?? null) : null;
        if (!issues.some((issue) => issue.itemId === itemId && issue.message === message)) issues.push({ itemId, message });
      }
      if (issues.length > 0) {
        return { kind: 'issues', messages: [...new Set(issues.map((issue) => issue.message))], issues };
      }
    }
  }
  return { kind: 'other', error: err };
}
