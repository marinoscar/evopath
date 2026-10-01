/**
 * Blood-work history, H5 (#189): the biomarker summary, a lab analyte's
 * series and results, a reading's revisions and the source document link, as
 * the web app sees them. Design: docs/specs/health-records.md §2.12.
 *
 * Every route is owner-scoped behind `health_data:read`; a foreign or deleted
 * id is a `404`. Values and limits are CANONICAL (the catalog's unit): the
 * server converted them when they were saved, and the browser shows them as
 * they are. Nothing here decides a flag, a range or a delta: the API does.
 */
import { api, ApiError } from './api';
import type { MeasurementDto, MeasurementPage, SeriesPoint } from './health';
import type { LabFlag, LabPanel } from './labReport';

/** What the lab printed alongside a result: its reference range and flag. */
export interface LabRangeContext {
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  flag: LabFlag | null;
}

/** One result inside a summary item. */
export interface BiomarkerResult extends LabRangeContext {
  measurementId: string;
  value: number;
  measuredAt: string;
}

/** One analyte of `GET /api/health/biomarkers/summary`. */
export interface BiomarkerSummaryItem {
  analyteKey: string;
  label: string;
  panel: LabPanel;
  /** Canonical unit. */
  unit: string;
  latest: BiomarkerResult;
  previous: BiomarkerResult | null;
  /** `latest.value - previous.value` (4 decimals), `null` without a previous result. */
  delta: number | null;
  /** Active results of the analyte. */
  count: number;
}

export interface BiomarkerSummaryParams {
  panel?: LabPanel;
  /** Keep analytes whose LATEST flag is low, high or critical. */
  outOfRange?: boolean;
}

/**
 * `GET /api/health/biomarkers/summary`: one item per analyte with at least one
 * active result, in catalog order (panel, then analyte).
 */
export async function getBiomarkerSummary(
  params: BiomarkerSummaryParams = {},
  options: { signal?: AbortSignal } = {},
): Promise<BiomarkerSummaryItem[]> {
  const search = new URLSearchParams();
  if (params.panel) search.set('panel', params.panel);
  if (params.outOfRange) search.set('outOfRange', 'true');
  const query = search.toString();
  const data = await api.get<{ items: BiomarkerSummaryItem[] }>(
    `/health/biomarkers/summary${query ? `?${query}` : ''}`,
    { signal: options.signal },
  );
  return data.items;
}

/** A lab series point: the plain point plus the range the lab printed for that event. */
export interface LabSeriesPoint extends SeriesPoint, LabRangeContext {}

/** `GET /api/measurements/series` for a lab `metricKey`. */
export interface LabSeries {
  metricKey: string;
  unit: string;
  points: LabSeriesPoint[];
  truncated: boolean;
}

/** How far back the detail chart reads: the API's maximum window (5 years). */
export const BIOMARKER_SERIES_YEARS = 5;

/** `GET /api/measurements/series` with a lab key: oldest first, each point with its range. */
export function getLabSeries(
  params: { metricKey: string; from?: string; to?: string },
  options: { signal?: AbortSignal } = {},
): Promise<LabSeries> {
  const search = new URLSearchParams({ metricKey: params.metricKey });
  if (params.from) search.set('from', params.from);
  if (params.to) search.set('to', params.to);
  return api.get<LabSeries>(`/measurements/series?${search}`, { signal: options.signal });
}

/** A lab row of `GET /api/measurements`: the measurement view plus its range and flag. */
export interface LabMeasurement extends MeasurementDto, LabRangeContext {}

export interface LabMeasurementPage extends Omit<MeasurementPage, 'items'> {
  items: LabMeasurement[];
}

/** Results per page in the detail table (the API caps `pageSize` at 100). */
export const BIOMARKER_RESULTS_PAGE_SIZE = 25;

/** `GET /api/measurements?metricKey=<lab key>`: every active result, newest first. */
export function listLabResults(
  params: { metricKey: string; page?: number; pageSize?: number },
  options: { signal?: AbortSignal } = {},
): Promise<LabMeasurementPage> {
  const search = new URLSearchParams({ metricKey: params.metricKey });
  if (params.page) search.set('page', String(params.page));
  search.set('pageSize', String(params.pageSize ?? BIOMARKER_RESULTS_PAGE_SIZE));
  return api.get<LabMeasurementPage>(`/measurements?${search}`, { signal: options.signal });
}

/** One revision of a reading: `supersededAt` is null for the current one. */
export interface MeasurementRevision extends LabMeasurement {
  supersededAt: string | null;
  createdAt: string;
}

/** `GET /api/measurements/:id/revisions`: every revision, newest (current) first. */
export async function getMeasurementRevisions(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<MeasurementRevision[]> {
  const data = await api.get<{ items: MeasurementRevision[] }>(
    `/measurements/${encodeURIComponent(id)}/revisions`,
    { signal: options.signal },
  );
  return data.items;
}

/** `GET /api/health/documents/:id/download`: a short-lived signed URL. */
export interface HealthDocumentDownload {
  /** Signed, valid `expiresIn` seconds. A bearer credential: never stored, logged or shared. */
  url: string;
  expiresIn: number;
  expiresAt?: string;
}

/**
 * `GET /api/health/documents/:id/download?disposition=inline` (`health_data:read`).
 * The documents API (#190) answers `404` for a document that is gone or not
 * the caller's.
 */
export function getHealthDocumentDownloadUrl(id: string): Promise<HealthDocumentDownload> {
  return api.get<HealthDocumentDownload>(
    `/health/documents/${encodeURIComponent(id)}/download?disposition=inline`,
  );
}

/** True for a `404`: the document (or reading) is not available any more. */
export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** The health document a lab result was read from (`sourceRef.healthDocumentId`), if any. */
export function sourceDocumentId(row: Pick<MeasurementDto, 'sourceRef'>): string | null {
  const id = row.sourceRef?.healthDocumentId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
