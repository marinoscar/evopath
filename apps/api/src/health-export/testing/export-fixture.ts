// =============================================================================
// A hand-built `HealthExportData` for the writer tests (H7, #191)
// =============================================================================
//
// Every dataset, with cells that exercise the writers' edge cases: a note
// that a spreadsheet would read as a formula, a file name starting with `@`,
// a name with a quote and a comma, and a negative number that must stay a
// number.
// =============================================================================

import { datasetColumns, type ExportReading, type ExportRow, type HealthExportData } from '../health-export-data';
import { HEALTH_EXPORT_DATASET_TITLES, HEALTH_EXPORT_DATASETS, type HealthExportDataset } from '../health-export.constants';

export const FIXTURE_FORMULA_NOTE = '=HYPERLINK("http://evil.example","click")';
export const FIXTURE_AT_FILE_NAME = '@SUM(1+1).pdf';

const ROWS: Record<HealthExportDataset, ExportRow[]> = {
  profile: [
    {
      name: 'Ana "Doc", Pérez',
      date_of_birth: '1990-05-01',
      age_years: 36,
      sex_at_birth: 'female',
      height_cm: 168.5,
      unit_system: 'metric',
      time_zone: 'America/Costa_Rica',
    },
  ],
  body: [
    {
      measured_at: '2026-09-01T07:00:00.000Z',
      weight_kg: 70.2,
      body_fat_pct: 22.1,
      waist_circumference_cm: null,
      methods: 'smart_scale',
      origin: 'manual',
      notes: FIXTURE_FORMULA_NOTE,
      revision: 1,
      status: 'current',
      entry_id: '00000000-0000-4000-8000-000000000001',
    },
    {
      measured_at: '2026-09-20T07:00:00.000Z',
      weight_kg: 69.4,
      body_fat_pct: null,
      waist_circumference_cm: 80,
      methods: null,
      origin: 'ai',
      notes: '-not a number',
      revision: 2,
      status: 'current',
      entry_id: '00000000-0000-4000-8000-000000000002',
    },
  ],
  vitals: [
    {
      measured_at: '2026-09-10T08:00:00.000Z',
      bp_systolic_mmhg: 121,
      bp_diastolic_mmhg: 79,
      resting_hr_bpm: 58,
      methods: 'bp_cuff',
      origin: 'manual',
      notes: null,
      revision: 1,
      status: 'current',
      entry_id: '00000000-0000-4000-8000-000000000003',
    },
  ],
  labs: [
    {
      measured_at: '2026-09-05T09:00:00.000Z',
      panel: 'lipids',
      analyte_key: 'ldl_cholesterol',
      analyte: 'LDL cholesterol',
      value: 132,
      unit: 'mg/dL',
      reference_low: null,
      reference_high: 100,
      reference_text: '<100',
      flag: 'high',
      method: 'lab',
      origin: 'ai',
      notes: '+1 vs last year',
      revision: 1,
      status: 'current',
      entry_id: '00000000-0000-4000-8000-000000000004',
    },
    {
      measured_at: '2026-09-05T09:00:00.000Z',
      panel: 'glycemic',
      analyte_key: 'hba1c',
      analyte: 'HbA1c',
      value: -5,
      unit: '%',
      reference_low: 4,
      reference_high: 5.6,
      reference_text: null,
      flag: 'normal',
      method: 'lab',
      origin: 'manual',
      notes: null,
      revision: 1,
      status: 'current',
      entry_id: '00000000-0000-4000-8000-000000000004',
    },
  ],
  wellness: [
    {
      date: '2026-09-28',
      energy: 4,
      sleep_quality: 3,
      muscle_soreness: 2,
      stress: 3,
      note: 'Slept late',
      revision: 1,
      status: 'current',
      entry_id: '00000000-0000-4000-8000-000000000005',
    },
  ],
  documents: [
    {
      id: '00000000-0000-4000-8000-000000000006',
      kind: 'lab_report',
      original_name: FIXTURE_AT_FILE_NAME,
      mime_type: 'application/pdf',
      size_bytes: 12345,
      document_date: '2026-09-05',
      uploaded_at: '2026-09-06T10:00:00.000Z',
    },
  ],
  progress_photos: [
    {
      id: '00000000-0000-4000-8000-000000000007',
      date: '2026-09-14',
      pose: 'front',
      note: 'Morning, fasted',
      mime_type: 'image/jpeg',
      size_bytes: 345678,
      added_at: '2026-09-14T07:30:00.000Z',
    },
  ],
};

const READINGS: ExportReading[] = [
  { metricKey: 'weight', value: 70.2, day: '2026-09-01' },
  { metricKey: 'weight', value: 69.4, day: '2026-09-20' },
  { metricKey: 'body_fat_pct', value: 22.1, day: '2026-09-01' },
  { metricKey: 'bp_systolic', value: 121, day: '2026-09-10' },
  { metricKey: 'bp_diastolic', value: 79, day: '2026-09-10' },
  { metricKey: 'resting_hr', value: 58, day: '2026-09-10' },
  { metricKey: 'ldl_cholesterol', value: 132, day: '2026-09-05', referenceHigh: 100, referenceText: '<100', flag: 'high' },
  { metricKey: 'hba1c', value: 5.2, day: '2026-09-05', referenceLow: 4, referenceHigh: 5.6, flag: 'normal' },
  { metricKey: 'energy', value: 4, day: '2026-09-28' },
  { metricKey: 'energy', value: 2, day: '2026-09-10' },
  { metricKey: 'sleep_quality', value: 3, day: '2026-09-28' },
].map((partial) => ({
  referenceLow: null,
  referenceHigh: null,
  referenceText: null,
  flag: null,
  measuredAt: new Date(`${partial.day}T08:00:00.000Z`),
  ...partial,
}));

/** The fixture for `datasets` (all by default). */
export function exportFixture(datasets: readonly HealthExportDataset[] = HEALTH_EXPORT_DATASETS): HealthExportData {
  const selected = HEALTH_EXPORT_DATASETS.filter((dataset) => datasets.includes(dataset));
  const rowCounts = Object.fromEntries(
    HEALTH_EXPORT_DATASETS.map((dataset) => [dataset, selected.includes(dataset) ? ROWS[dataset].length : 0]),
  ) as Record<HealthExportDataset, number>;

  return {
    exportedAt: new Date('2026-09-30T12:00:00.000Z'),
    range: { from: '2026-09-01', to: '2026-09-30' },
    includeHistory: false,
    datasets: selected,
    userName: 'Ana "Doc", Pérez',
    profile: selected.includes('profile')
      ? {
          name: 'Ana "Doc", Pérez',
          dateOfBirth: '1990-05-01',
          ageYears: 36,
          sexAtBirth: 'female',
          heightCm: 168.5,
          unitSystem: 'metric',
          timeZone: 'America/Costa_Rica',
        }
      : null,
    tables: selected.map((dataset) => ({
      dataset,
      title: HEALTH_EXPORT_DATASET_TITLES[dataset],
      columns: datasetColumns(dataset),
      rows: ROWS[dataset],
    })),
    readings: READINGS.filter((reading) => {
      const category = reading.metricKey;
      if (['weight', 'body_fat_pct'].includes(category)) return selected.includes('body');
      if (['bp_systolic', 'bp_diastolic', 'resting_hr'].includes(category)) return selected.includes('vitals');
      if (['energy', 'sleep_quality'].includes(category)) return selected.includes('wellness');
      return selected.includes('labs');
    }),
    rowCounts,
  };
}
