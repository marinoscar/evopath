// =============================================================================
// Health data export (H7, #191): what one export reads, as format-free tables
// =============================================================================
//
// `collectHealthExport` reads the user's rows once and returns:
//   - one `ExportTable` per selected dataset, which the JSON, CSV and XLSX
//     writers serialise verbatim (column keys carry the unit: `weight_kg`);
//   - the ACTIVE readings of the selected measurement datasets, which the PDF
//     writer summarises (latest biomarkers, trends, averages);
//   - row counts per dataset, for the audit row and the job result.
//
// Rules every dataset follows:
//   - owner only: every query filters on `userId`;
//   - soft-deleted rows (`deletedAt`) are NEVER read;
//   - superseded rows (`supersededAt`) only with `includeHistory`, and never
//     the history of a value the user later deleted (an earlier revision of a
//     deleted reading is still the user's deletion);
//   - documents: kept files only (`retention = keep`, file not erased),
//     metadata only;
//   - progress photos (E7.9, #249): an index, metadata only, like documents
//     (day, pose, note, type, size). The images stay in storage, readable by
//     their owner through the signed download; no writer embeds them.
//
// Range: `from`..`to` are calendar dates, inclusive, in UTC. A daily wellness
// score is matched on its `localDate` (the user's day), every other reading
// on `measuredAt`; a document on `documentDate`, else its upload time; a
// progress photo on its `localDate`. The profile is not ranged.
//
// Values are exported in the metric's canonical unit (the unit in the column
// key and header), whatever the user's display preference. The one exception
// is the labs dataset (#234): its values and reference limits are shown in
// the export's `labUnits` (US conventional = canonical, or SI), rounded to
// that unit's display precision, and each row's `unit` names the unit used
// ({@link convertLabRow}). The PDF converts its lab readings the same way.
// =============================================================================

import type { Prisma, PrismaClient } from '@prisma/client';

import { addDays, fromDbDate, toDbDate } from '../check-ins/local-date';
import {
  getMetric,
  labDisplayUnit,
  type LabUnits,
  METRICS,
  type MetricDef,
  toDisplayUnit,
} from '../measurements/metric-registry';
import {
  HEALTH_EXPORT_DATASET_TITLES,
  HEALTH_EXPORT_DATASETS,
  type HealthExportDataset,
} from './health-export.constants';

export type ExportCell = string | number | boolean | null;

export interface ExportColumn {
  /** Machine name, unit included (`weight_kg`): CSV header and JSON key. */
  key: string;
  /** Human header, unit included (`Weight (kg)`): XLSX header. */
  header: string;
  /** Numeric columns are never formula-neutralised (`-5` stays `-5`). */
  numeric?: boolean;
}

export type ExportRow = Record<string, ExportCell>;

export interface ExportTable {
  dataset: HealthExportDataset;
  title: string;
  columns: ExportColumn[];
  rows: ExportRow[];
}

export interface HealthExportProfile {
  name: string | null;
  dateOfBirth: string | null;
  ageYears: number | null;
  sexAtBirth: string | null;
  heightCm: number | null;
  unitSystem: string | null;
  timeZone: string | null;
}

/** One active reading, for the PDF summaries. Canonical unit. */
export interface ExportReading {
  metricKey: string;
  value: number;
  measuredAt: Date;
  /** The reading's day: `localDate` when set, else the UTC day of `measuredAt`. */
  day: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  flag: string | null;
}

export interface HealthExportRequest {
  userId: string;
  from: string;
  to: string;
  datasets: readonly HealthExportDataset[];
  includeHistory: boolean;
  /** The unit convention lab values are shown in (#234). */
  labUnits: LabUnits;
}

export interface HealthExportData {
  exportedAt: Date;
  range: { from: string; to: string };
  includeHistory: boolean;
  /** The unit convention of the labs dataset and the PDF's lab values (#234). */
  labUnits: LabUnits;
  /** The selected datasets, in canonical order. */
  datasets: HealthExportDataset[];
  /** The account's display name, for the PDF header (never logged). */
  userName: string | null;
  /** Null unless `profile` is selected. */
  profile: HealthExportProfile | null;
  /** One per selected dataset, in canonical order. */
  tables: ExportTable[];
  /** Active readings of the selected measurement datasets, oldest first. */
  readings: ExportReading[];
  rowCounts: Record<HealthExportDataset, number>;
}

type Db = Prisma.TransactionClient | PrismaClient;

/** Measurement category per measurement dataset. */
const MEASUREMENT_CATEGORIES = {
  body: 'body',
  vitals: 'vital',
  labs: 'lab',
  wellness: 'wellness',
} as const;

type MeasurementDataset = keyof typeof MEASUREMENT_CATEGORIES;

function metricsOf(dataset: MeasurementDataset): MetricDef[] {
  return (METRICS as readonly MetricDef[]).filter((metric) => metric.category === MEASUREMENT_CATEGORIES[dataset]);
}

/** `%` -> `pct`, `mmHg` -> `mmhg`; `score` has no suffix. */
function unitSlug(unit: string): string {
  if (unit === '%') return 'pct';
  if (unit === 'score') return '';
  return unit.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** `weight` + `kg` -> `weight_kg`; `body_fat_pct` + `%` stays `body_fat_pct`. */
export function metricColumnKey(metric: Pick<MetricDef, 'key' | 'canonicalUnit'>): string {
  const slug = unitSlug(metric.canonicalUnit);
  if (!slug || metric.key.endsWith(`_${slug}`)) return metric.key;
  return `${metric.key}_${slug}`;
}

function metricColumnHeader(metric: MetricDef): string {
  if (metric.scale) return `${metric.label} (${metric.scale.min}-${metric.scale.max})`;
  return `${metric.label} (${metric.canonicalUnit})`;
}

const TRAILER_COLUMNS: ExportColumn[] = [
  { key: 'revision', header: 'Revision', numeric: true },
  { key: 'status', header: 'Status' },
  { key: 'entry_id', header: 'Entry id' },
];

/** The columns of each dataset. Exported for the writer tests. */
export function datasetColumns(dataset: HealthExportDataset): ExportColumn[] {
  switch (dataset) {
    case 'profile':
      return [
        { key: 'name', header: 'Name' },
        { key: 'date_of_birth', header: 'Date of birth' },
        { key: 'age_years', header: 'Age (years)', numeric: true },
        { key: 'sex_at_birth', header: 'Sex at birth' },
        { key: 'height_cm', header: 'Height (cm)', numeric: true },
        { key: 'unit_system', header: 'Unit system' },
        { key: 'time_zone', header: 'Time zone' },
      ];
    case 'body':
    case 'vitals':
      return [
        { key: 'measured_at', header: 'Measured at (UTC)' },
        ...metricsOf(dataset).map((metric) => ({
          key: metricColumnKey(metric),
          header: metricColumnHeader(metric),
          numeric: true,
        })),
        { key: 'methods', header: 'Methods' },
        { key: 'origin', header: 'Origin' },
        { key: 'notes', header: 'Notes' },
        ...TRAILER_COLUMNS,
      ];
    case 'wellness':
      return [
        { key: 'date', header: 'Date' },
        ...metricsOf('wellness').map((metric) => ({
          key: metricColumnKey(metric),
          header: metricColumnHeader(metric),
          numeric: true,
        })),
        { key: 'note', header: 'Note' },
        ...TRAILER_COLUMNS,
      ];
    case 'labs':
      return [
        { key: 'measured_at', header: 'Collected at (UTC)' },
        { key: 'panel', header: 'Panel' },
        { key: 'analyte_key', header: 'Analyte key' },
        { key: 'analyte', header: 'Analyte' },
        { key: 'value', header: 'Value', numeric: true },
        { key: 'unit', header: 'Unit' },
        { key: 'reference_low', header: 'Reference low (unit)', numeric: true },
        { key: 'reference_high', header: 'Reference high (unit)', numeric: true },
        { key: 'reference_text', header: 'Reference as printed' },
        { key: 'flag', header: 'Flag' },
        { key: 'method', header: 'Method' },
        { key: 'origin', header: 'Origin' },
        { key: 'notes', header: 'Notes' },
        ...TRAILER_COLUMNS,
      ];
    case 'documents':
      return [
        { key: 'id', header: 'Document id' },
        { key: 'kind', header: 'Kind' },
        { key: 'original_name', header: 'File name' },
        { key: 'mime_type', header: 'Type' },
        { key: 'size_bytes', header: 'Size (bytes)', numeric: true },
        { key: 'document_date', header: 'Document date' },
        { key: 'uploaded_at', header: 'Uploaded at (UTC)' },
      ];
    case 'progress_photos':
      return [
        { key: 'id', header: 'Photo id' },
        { key: 'date', header: 'Date' },
        { key: 'pose', header: 'Pose' },
        { key: 'note', header: 'Note' },
        { key: 'mime_type', header: 'Type' },
        { key: 'size_bytes', header: 'Size (bytes)', numeric: true },
        { key: 'added_at', header: 'Added at (UTC)' },
      ];
  }
}

/** The datasets in canonical order, deduplicated. */
export function orderDatasets(datasets: readonly HealthExportDataset[]): HealthExportDataset[] {
  const wanted = new Set(datasets);
  return HEALTH_EXPORT_DATASETS.filter((dataset) => wanted.has(dataset));
}

/** Whole years between `dateOfBirth` (`YYYY-MM-DD`) and `at`, UTC. */
export function ageYears(dateOfBirth: string, at: Date): number {
  const [year, month, day] = dateOfBirth.split('-').map(Number);
  let age = at.getUTCFullYear() - year;
  const beforeBirthday =
    at.getUTCMonth() + 1 < month || (at.getUTCMonth() + 1 === month && at.getUTCDate() < day);
  if (beforeBirthday) age -= 1;
  return age;
}

const MEASUREMENT_SELECT = {
  id: true,
  entryId: true,
  metricKey: true,
  value: true,
  unit: true,
  measuredAt: true,
  localDate: true,
  method: true,
  origin: true,
  notes: true,
  referenceLow: true,
  referenceHigh: true,
  referenceText: true,
  flag: true,
  revision: true,
  supersededAt: true,
} satisfies Prisma.MeasurementSelect;

type MeasurementRow = Prisma.MeasurementGetPayload<{ select: typeof MEASUREMENT_SELECT }>;

/**
 * Reads everything one export needs. Read-only; `now` is the export's
 * timestamp (age, `exportedAt`).
 */
export async function collectHealthExport(
  db: Db,
  request: HealthExportRequest,
  now: Date,
): Promise<HealthExportData> {
  const datasets = orderDatasets(request.datasets);
  const selected = new Set(datasets);
  const { userId, from, to, includeHistory, labUnits } = request;

  const fromInstant = toDbDate(from);
  const toExclusive = toDbDate(addDays(to, 1));

  const measurementDatasets = (Object.keys(MEASUREMENT_CATEGORIES) as MeasurementDataset[]).filter((dataset) =>
    selected.has(dataset),
  );
  const metricKeys = measurementDatasets.flatMap((dataset) => metricsOf(dataset).map((metric) => metric.key));

  const [user, profileRow, measurementRows, documentRows, photoRows] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { displayName: true, providerDisplayName: true } }),
    selected.has('profile') ? db.healthProfile.findUnique({ where: { userId } }) : Promise.resolve(null),
    metricKeys.length === 0
      ? Promise.resolve([] as MeasurementRow[])
      : db.measurement.findMany({
          where: {
            userId,
            deletedAt: null,
            ...(includeHistory ? {} : { supersededAt: null }),
            metricKey: { in: metricKeys },
            OR: [
              { localDate: { gte: fromInstant, lte: toDbDate(to) } },
              { localDate: null, measuredAt: { gte: fromInstant, lt: toExclusive } },
            ],
          },
          select: MEASUREMENT_SELECT,
          orderBy: [{ measuredAt: 'asc' }, { revision: 'asc' }, { createdAt: 'asc' }],
        }),
    selected.has('documents')
      ? db.healthDocument.findMany({
          where: {
            userId,
            retention: 'keep',
            fileDeletedAt: null,
            OR: [
              { documentDate: { gte: fromInstant, lte: toDbDate(to) } },
              { documentDate: null, createdAt: { gte: fromInstant, lt: toExclusive } },
            ],
          },
          select: {
            id: true,
            kind: true,
            originalName: true,
            mimeType: true,
            sizeBytes: true,
            documentDate: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        })
      : Promise.resolve([]),
    selected.has('progress_photos')
      ? db.progressPhoto.findMany({
          where: { userId, localDate: { gte: fromInstant, lte: toDbDate(to) } },
          select: {
            id: true,
            localDate: true,
            pose: true,
            note: true,
            createdAt: true,
            storageObject: { select: { mimeType: true, size: true } },
          },
          orderBy: [{ localDate: 'asc' }, { createdAt: 'asc' }],
        })
      : Promise.resolve([]),
  ]);

  const rows = includeHistory ? await withoutDeletedHistory(db, userId, measurementRows) : measurementRows;
  const userName = user?.displayName?.trim() || user?.providerDisplayName?.trim() || null;

  let profile: HealthExportProfile | null = null;
  if (selected.has('profile')) {
    const dateOfBirth = profileRow?.dateOfBirth ? fromDbDate(profileRow.dateOfBirth) : null;
    profile = {
      name: userName,
      dateOfBirth,
      ageYears: dateOfBirth ? ageYears(dateOfBirth, now) : null,
      sexAtBirth: profileRow?.sexAtBirth ?? null,
      heightCm: profileRow?.heightMm != null ? profileRow.heightMm / 10 : null,
      unitSystem: profileRow?.unitSystem ?? null,
      timeZone: profileRow?.timeZone ?? null,
    };
  }

  const tables: ExportTable[] = datasets.map((dataset) => ({
    dataset,
    title: HEALTH_EXPORT_DATASET_TITLES[dataset],
    columns: datasetColumns(dataset),
    rows: datasetRows(dataset, { profile, rows, documents: documentRows, labUnits, photos: photoRows }),
  }));

  const rowCounts = Object.fromEntries(HEALTH_EXPORT_DATASETS.map((dataset) => [dataset, 0])) as Record<
    HealthExportDataset,
    number
  >;
  for (const table of tables) rowCounts[table.dataset] = table.rows.length;

  const readings: ExportReading[] = rows
    .filter((row) => row.supersededAt === null)
    .map((row) => ({
      metricKey: row.metricKey,
      value: row.value,
      measuredAt: row.measuredAt,
      day: row.localDate ? fromDbDate(row.localDate) : row.measuredAt.toISOString().slice(0, 10),
      referenceLow: row.referenceLow,
      referenceHigh: row.referenceHigh,
      referenceText: row.referenceText,
      flag: row.flag,
    }));

  return {
    exportedAt: now,
    range: { from, to },
    includeHistory,
    labUnits,
    datasets,
    userName,
    profile,
    tables,
    readings,
    rowCounts,
  };
}

/**
 * Drops superseded rows whose value the user later deleted: an earlier
 * revision of a reading whose (entry, metric) carries a deleted row.
 */
async function withoutDeletedHistory(db: Db, userId: string, rows: MeasurementRow[]): Promise<MeasurementRow[]> {
  const historyEntryIds = [...new Set(rows.filter((row) => row.supersededAt !== null).map((row) => row.entryId))];
  if (historyEntryIds.length === 0) return rows;

  const deleted = new Set<string>();
  for (let i = 0; i < historyEntryIds.length; i += 1000) {
    const found = await db.measurement.findMany({
      where: { userId, entryId: { in: historyEntryIds.slice(i, i + 1000) }, deletedAt: { not: null } },
      select: { entryId: true, metricKey: true },
    });
    found.forEach((row) => deleted.add(`${row.entryId}:${row.metricKey}`));
  }

  return rows.filter((row) => row.supersededAt === null || !deleted.has(`${row.entryId}:${row.metricKey}`));
}

interface RowSources {
  labUnits: LabUnits;
  profile: HealthExportProfile | null;
  rows: MeasurementRow[];
  documents: Array<{
    id: string;
    kind: string;
    originalName: string;
    mimeType: string;
    sizeBytes: bigint | number | null;
    documentDate: Date | null;
    createdAt: Date;
  }>;
  photos: Array<{
    id: string;
    localDate: Date;
    pose: string;
    note: string | null;
    createdAt: Date;
    storageObject: { mimeType: string; size: bigint | number } | null;
  }>;
}

function datasetRows(dataset: HealthExportDataset, sources: RowSources): ExportRow[] {
  switch (dataset) {
    case 'profile': {
      const p = sources.profile;
      if (!p) return [];
      return [
        {
          name: p.name,
          date_of_birth: p.dateOfBirth,
          age_years: p.ageYears,
          sex_at_birth: p.sexAtBirth,
          height_cm: p.heightCm,
          unit_system: p.unitSystem,
          time_zone: p.timeZone,
        },
      ];
    }
    case 'body':
    case 'vitals':
    case 'wellness':
      return wideRows(dataset, sources.rows);
    case 'labs':
      return labRows(sources.rows).map((row) => convertLabRow(row, sources.labUnits));
    case 'documents':
      return sources.documents.map((doc) => ({
        id: doc.id,
        kind: doc.kind,
        original_name: doc.originalName,
        mime_type: doc.mimeType,
        size_bytes: doc.sizeBytes === null ? null : Number(doc.sizeBytes),
        document_date: doc.documentDate ? fromDbDate(doc.documentDate) : null,
        uploaded_at: doc.createdAt.toISOString(),
      }));
    case 'progress_photos':
      return sources.photos.map((photo) => ({
        id: photo.id,
        date: fromDbDate(photo.localDate),
        pose: photo.pose,
        note: photo.note,
        mime_type: photo.storageObject?.mimeType ?? null,
        size_bytes: photo.storageObject ? Number(photo.storageObject.size) : null,
        added_at: photo.createdAt.toISOString(),
      }));
  }
}

function statusOf(row: Pick<MeasurementRow, 'supersededAt'>): 'current' | 'superseded' {
  return row.supersededAt === null ? 'current' : 'superseded';
}

/**
 * One row per entry for body, vitals and wellness: the readings saved
 * together, side by side. With history, each superseded revision of an entry
 * is its own row (`status: superseded`).
 */
function wideRows(dataset: 'body' | 'vitals' | 'wellness', all: MeasurementRow[]): ExportRow[] {
  const metrics = metricsOf(dataset);
  const keys = new Set(metrics.map((metric) => metric.key));
  const groups = new Map<string, MeasurementRow[]>();

  for (const row of all) {
    if (!keys.has(row.metricKey)) continue;
    const groupKey = row.supersededAt === null ? `${row.entryId}:current` : `${row.entryId}:${row.revision}:old`;
    const group = groups.get(groupKey);
    if (group) group.push(row);
    else groups.set(groupKey, [row]);
  }

  const out: Array<{ sortAt: number; revision: number; row: ExportRow }> = [];

  for (const group of groups.values()) {
    const first = group[0];
    const revision = Math.max(...group.map((row) => row.revision));
    const row: ExportRow = {};

    if (dataset === 'wellness') {
      row.date = first.localDate ? fromDbDate(first.localDate) : first.measuredAt.toISOString().slice(0, 10);
    } else {
      row.measured_at = first.measuredAt.toISOString();
    }

    for (const metric of metrics) {
      const reading = group.find((candidate) => candidate.metricKey === metric.key);
      row[metricColumnKey(metric)] = reading ? reading.value : null;
    }

    const notes = first.notes ?? null;
    if (dataset === 'wellness') {
      row.note = notes;
    } else {
      const methods = [...new Set(group.map((r) => r.method).filter((m) => m !== 'unspecified'))];
      row.methods = methods.length > 0 ? methods.join('; ') : null;
      row.origin = [...new Set(group.map((r) => r.origin))].join('; ');
      row.notes = notes;
    }

    row.revision = revision;
    row.status = statusOf(first);
    row.entry_id = first.entryId;

    out.push({ sortAt: first.measuredAt.getTime(), revision, row });
  }

  return out.sort((a, b) => a.sortAt - b.sortAt || a.revision - b.revision).map((item) => item.row);
}

function labRows(all: MeasurementRow[]): ExportRow[] {
  return all
    .filter((row) => getMetric(row.metricKey)?.category === 'lab')
    .map((row) => {
      const metric = getMetric(row.metricKey)!;
      return {
        measured_at: row.measuredAt.toISOString(),
        panel: metric.panel ?? null,
        analyte_key: row.metricKey,
        analyte: metric.label,
        value: row.value,
        unit: metric.canonicalUnit,
        reference_low: row.referenceLow,
        reference_high: row.referenceHigh,
        reference_text: row.referenceText,
        flag: row.flag,
        method: row.method,
        origin: row.origin,
        notes: row.notes,
        revision: row.revision,
        status: statusOf(row),
        entry_id: row.entryId,
      };
    });
}

/**
 * A labs-dataset row (canonical values) shown in `labUnits` (#234): `value`
 * and the reference limits converted and rounded to the target unit's display
 * precision, `unit` naming that unit. A row already in the target unit is
 * returned unchanged (stored precision kept). Display only.
 */
export function convertLabRow(row: ExportRow, labUnits: LabUnits): ExportRow {
  const key = String(row.analyte_key);
  const metric = getMetric(key);
  if (!metric || metric.category !== 'lab') return row;

  const unit = labDisplayUnit(metric, labUnits);
  if (unit === metric.canonicalUnit) return { ...row, unit };

  const convert = (cell: ExportCell): ExportCell => (typeof cell === 'number' ? toDisplayUnit(key, cell, unit) : cell);
  return {
    ...row,
    value: convert(row.value),
    unit,
    reference_low: convert(row.reference_low),
    reference_high: convert(row.reference_high),
  };
}
