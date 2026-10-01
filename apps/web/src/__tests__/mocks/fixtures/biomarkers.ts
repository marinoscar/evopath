/**
 * Blood-work history fixtures, H5 (#189), shaped exactly as the API answers
 * inside the `{ data }` envelope: `GET /api/health/biomarkers/summary`, a lab
 * `GET /api/measurements/series`, a lab page of `GET /api/measurements`,
 * `GET /api/measurements/:id/revisions` and the documents download link.
 * Values and limits are canonical. The lab catalog is `mockLabCatalog`
 * (`labReportIntake.ts`).
 */
import type {
  BiomarkerResult,
  BiomarkerSummaryItem,
  HealthDocumentDownload,
  LabMeasurement,
  LabSeries,
  LabSeriesPoint,
  MeasurementRevision,
} from '../../../services/biomarkers';
import type { LabPanel } from '../../../services/labReport';

let sequence = 0;
const uuid = () => `00000000-0000-4000-8b00-${String(++sequence).padStart(12, '0')}`;

export function biomarkerResult(value: number, measuredAt: string, extra: Partial<BiomarkerResult> = {}): BiomarkerResult {
  return {
    measurementId: uuid(),
    value,
    measuredAt,
    flag: 'normal',
    referenceLow: null,
    referenceHigh: null,
    referenceText: null,
    ...extra,
  };
}

export function summaryItem(
  analyteKey: string,
  label: string,
  panel: LabPanel,
  unit: string,
  latest: BiomarkerResult,
  previous: BiomarkerResult | null = null,
  extra: Partial<BiomarkerSummaryItem> = {},
): BiomarkerSummaryItem {
  return {
    analyteKey,
    label,
    panel,
    unit,
    latest,
    previous,
    delta: previous ? Number((latest.value - previous.value).toFixed(4)) : null,
    count: previous ? 2 : 1,
    ...extra,
  };
}

/** A user with lipids, a glycemic marker and thyroid, in catalog order. */
export const mockBiomarkerSummary: BiomarkerSummaryItem[] = [
  summaryItem(
    'ldl_cholesterol',
    'LDL cholesterol',
    'lipids',
    'mg/dL',
    biomarkerResult(142, '2026-09-15T12:00:00.000Z', { flag: 'high', referenceHigh: 100 }),
    biomarkerResult(130, '2026-03-10T12:00:00.000Z', { flag: 'high', referenceHigh: 130 }),
    { count: 3 },
  ),
  summaryItem(
    'hdl_cholesterol',
    'HDL cholesterol',
    'lipids',
    'mg/dL',
    biomarkerResult(55, '2026-09-15T12:00:00.000Z', { referenceLow: 40 }),
    biomarkerResult(58, '2026-03-10T12:00:00.000Z', { referenceLow: 40 }),
  ),
  summaryItem(
    'hba1c',
    'HbA1c',
    'glycemic',
    '%',
    biomarkerResult(5.6, '2026-09-15T12:00:00.000Z', { referenceLow: 4, referenceHigh: 5.6 }),
    biomarkerResult(5.6, '2026-03-10T12:00:00.000Z', { referenceLow: 4, referenceHigh: 5.6 }),
  ),
  summaryItem(
    'tsh',
    'TSH',
    'thyroid',
    'mIU/L',
    biomarkerResult(2.1, '2026-09-15T12:00:00.000Z', { referenceLow: 0.4, referenceHigh: 4.5 }),
  ),
];

export function labSeriesPoint(measuredAt: string, value: number, extra: Partial<LabSeriesPoint> = {}): LabSeriesPoint {
  return {
    id: uuid(),
    measuredAt,
    value,
    method: 'lab',
    origin: 'ai',
    referenceLow: null,
    referenceHigh: null,
    referenceText: null,
    flag: null,
    ...extra,
  };
}

export function labSeries(metricKey: string, unit: string, points: LabSeriesPoint[], truncated = false): LabSeries {
  return { metricKey, unit, points, truncated };
}

/** LDL over a year from two labs: the second lab prints a tighter range, the third result none. */
export const mockLdlSeries: LabSeries = labSeries('ldl_cholesterol', 'mg/dL', [
  labSeriesPoint('2025-09-20T12:00:00.000Z', 120, { referenceLow: 0, referenceHigh: 130, flag: 'normal' }),
  labSeriesPoint('2026-03-10T12:00:00.000Z', 130, { referenceLow: 0, referenceHigh: 130, flag: 'normal' }),
  labSeriesPoint('2026-06-01T12:00:00.000Z', 125, { origin: 'manual' }),
  labSeriesPoint('2026-09-15T12:00:00.000Z', 142, { referenceHigh: 100, flag: 'high' }),
]);

export function labMeasurement(
  metricKey: string,
  value: number,
  unit: string,
  overrides: Partial<LabMeasurement> = {},
): LabMeasurement {
  return {
    id: uuid(),
    entryId: uuid(),
    metricKey,
    value,
    unit,
    measuredAt: '2026-09-15T12:00:00.000Z',
    method: 'lab',
    origin: 'ai',
    notes: null,
    sourceRef: null,
    fileDeleted: null,
    revision: 1,
    edited: false,
    referenceLow: null,
    referenceHigh: null,
    referenceText: null,
    flag: null,
    ...overrides,
  };
}

export const KEPT_DOCUMENT_ID = '00000000-0000-4000-8d00-000000000001';
export const ERASED_DOCUMENT_ID = '00000000-0000-4000-8d00-000000000002';
export const MISSING_DOCUMENT_ID = '00000000-0000-4000-8d00-000000000003';

/** LDL results, newest first: a kept report (edited once), an erased one, a hand-entered row. */
export const mockLdlResults: LabMeasurement[] = [
  labMeasurement('ldl_cholesterol', 142, 'mg/dL', {
    id: '00000000-0000-4000-8c00-000000000001',
    measuredAt: '2026-09-15T12:00:00.000Z',
    referenceHigh: 100,
    flag: 'high',
    sourceRef: { kind: 'lab_report', healthDocumentId: KEPT_DOCUMENT_ID },
    fileDeleted: false,
    revision: 2,
    edited: true,
  }),
  labMeasurement('ldl_cholesterol', 130, 'mg/dL', {
    id: '00000000-0000-4000-8c00-000000000002',
    measuredAt: '2026-03-10T12:00:00.000Z',
    referenceLow: 0,
    referenceHigh: 130,
    flag: 'normal',
    sourceRef: { kind: 'lab_report', healthDocumentId: ERASED_DOCUMENT_ID },
    fileDeleted: true,
  }),
  labMeasurement('ldl_cholesterol', 125, 'mg/dL', {
    id: '00000000-0000-4000-8c00-000000000003',
    measuredAt: '2026-06-01T12:00:00.000Z',
    origin: 'manual',
  }),
];

/** The revisions of the first LDL result: the current value, then the AI's original read. */
export const mockLdlRevisions: MeasurementRevision[] = [
  {
    ...mockLdlResults[0],
    supersededAt: null,
    createdAt: '2026-09-16T09:00:00.000Z',
  },
  {
    ...mockLdlResults[0],
    id: '00000000-0000-4000-8c00-000000000009',
    value: 124,
    revision: 1,
    edited: false,
    supersededAt: '2026-09-16T09:00:00.000Z',
    createdAt: '2026-09-15T18:00:00.000Z',
  },
];

export const mockDocumentDownload: HealthDocumentDownload = {
  url: 'https://storage.example.test/signed/report.pdf?sig=abc',
  expiresIn: 300,
};
