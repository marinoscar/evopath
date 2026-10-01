import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { localDate } from '../../activity/dto/goal.dto';
import { ENTRY_BOUNDS } from '../../activity/activity.constants';
import { isValidTimeZone } from '../../health-profile/health-profile.validation';
import { getMetric, isMethodAllowed, isWithinBounds, roundCanonical } from '../../measurements/metric-registry';
import {
  DEVICE_STRING_MAX,
  DIAGNOSTIC_REPORT_MAX_BYTES,
  DIAGNOSTIC_SUMMARY_MAX,
  HEALTH_SYNC_DEVICE_STATUSES,
  HEALTH_SYNC_RUN_STATUSES,
  HEALTH_SYNC_TRIGGERS,
  REPORTS_LIMIT_DEFAULT,
  REPORTS_LIMIT_MAX,
  RUNS_LIMIT_DEFAULT,
  RUNS_LIMIT_MAX,
  SIGNING_SHA256_PATTERN,
  SYNC_ACTIVITY_KINDS,
  SYNC_DETAILS_MAX_BYTES,
  SYNC_ENTRIES_MAX,
  SYNC_ENTRY_KEY_MAX,
  SYNC_ERROR_CODE_MAX,
  SYNC_ERROR_MESSAGE_MAX,
  SYNC_EXTERNAL_ID_MAX,
  SYNC_MEASUREMENTS_MAX,
  SYNC_METRIC_KEYS,
  SYNC_NOTE_MAX,
  SYNC_SLEEP_MAX,
} from '../health-sync.constants';

// =============================================================================
// /api/health-sync — schemas (epic #276, #278)
// =============================================================================
//
// Everything a phone sends is validated here; the day windows need the user's
// time zone, so the service checks those (400 ENTRY_DATE_OUT_OF_RANGE).
// =============================================================================

const deviceString = z.string().trim().max(DEVICE_STRING_MAX, `At most ${DEVICE_STRING_MAX} characters`);
const instant = z.iso.datetime({ offset: true });
const timeZone = z
  .string()
  .trim()
  .max(DEVICE_STRING_MAX)
  .refine(isValidTimeZone, { message: 'Must be an IANA time zone' })
  .meta({ description: 'An IANA time zone, e.g. `America/Costa_Rica`.' });

function serializedAtMost(maxBytes: number) {
  return (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes;
}

const jsonObject = z.record(z.string(), z.unknown());

// -----------------------------------------------------------------------------
// POST /devices
// -----------------------------------------------------------------------------

export const registerDeviceSchema = z
  .object({
    installationId: z.uuid().meta({ description: 'Generated once per app install.' }),
    name: deviceString.min(1, 'Name is required'),
    manufacturer: deviceString.optional(),
    model: deviceString.optional(),
    androidVersion: deviceString.optional(),
    sdkInt: z.number().int().min(0).max(10_000).optional(),
    appVersion: deviceString.optional(),
    appVersionCode: z
      .number()
      .int()
      .min(1)
      .max(2_100_000_000)
      .optional()
      .meta({ description: "The installed app's Android `versionCode` (#285); compared with the server's current release." }),
    healthConnectVersion: deviceString.optional(),
    packageName: deviceString.optional(),
    signingSha256: z
      .string()
      .regex(SIGNING_SHA256_PATTERN, 'Must be 32 colon-separated upper-case hex bytes')
      .optional()
      .meta({ description: 'The APK signing certificate SHA-256, `AA:BB:…` (32 bytes).' }),
    timezone: timeZone.optional(),
  })
  .strict();
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;
export class RegisterDeviceDto extends createZodDto(registerDeviceSchema) {}

// -----------------------------------------------------------------------------
// POST /devices/:id/sync
// -----------------------------------------------------------------------------

const syncRunSchema = z
  .object({
    trigger: z.enum(HEALTH_SYNC_TRIGGERS),
    status: z.enum(HEALTH_SYNC_RUN_STATUSES),
    startedAt: instant,
    finishedAt: instant,
    recordsRead: z.number().int().min(0).max(10_000_000).optional().meta({
      description: 'Records the phone read from Health Connect; defaults to the rows sent.',
    }),
    errorCode: z.string().trim().max(SYNC_ERROR_CODE_MAX).optional(),
    errorMessage: z.string().trim().max(SYNC_ERROR_MESSAGE_MAX).optional(),
    details: jsonObject
      .refine(serializedAtMost(SYNC_DETAILS_MAX_BYTES), { message: `At most ${SYNC_DETAILS_MAX_BYTES} bytes serialized` })
      .optional()
      .meta({
        description:
          '`{ syncedTypes: string[], perType, sources, timezone }`. `syncedTypes` limits reconciliation: ' +
          '`steps`, `exercise`, `weight`, `body_fat`, `resting_heart_rate`, `heart_rate`, `hrv`, `blood_pressure`, `sleep`.',
      }),
    timezone: timeZone.optional(),
  })
  .strict();

const syncEntrySchema = z
  .object({
    externalId: z.string().trim().min(1).max(SYNC_EXTERNAL_ID_MAX),
    occurredOn: localDate,
    occurredAt: instant.optional(),
    activityKind: z.enum(SYNC_ACTIVITY_KINDS),
    durationSeconds: z.number().int().min(ENTRY_BOUNDS.durationSeconds.min).max(ENTRY_BOUNDS.durationSeconds.max).optional(),
    distanceMeters: z
      .number()
      .min(ENTRY_BOUNDS.distanceMeters.min)
      .max(ENTRY_BOUNDS.distanceMeters.max)
      .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, { message: 'At most 2 decimal places' })
      .optional(),
    steps: z.number().int().min(ENTRY_BOUNDS.steps.min).max(ENTRY_BOUNDS.steps.max).optional(),
    note: z.string().trim().max(SYNC_NOTE_MAX).optional(),
  })
  .strict()
  .refine((entry) => entry.activityKind !== 'steps' || entry.steps !== undefined, {
    message: 'A `steps` entry needs a `steps` value',
    path: ['steps'],
  });
export type SyncEntryInput = z.infer<typeof syncEntrySchema>;

const syncMeasurementSchema = z
  .object({
    externalId: z.string().trim().min(1).max(SYNC_EXTERNAL_ID_MAX),
    entryKey: z.string().trim().min(1).max(SYNC_ENTRY_KEY_MAX).optional().meta({
      description: 'Readings sharing an `entryKey` in one payload share one entry (a blood-pressure pair).',
    }),
    metricKey: z.enum(SYNC_METRIC_KEYS),
    value: z.number().finite(),
    unit: z.string().trim().min(1).max(20).meta({ description: "The metric's canonical unit (kg, %, bpm, ms, mmHg)." }),
    measuredAt: instant,
    method: z.string().trim().min(1).max(40).optional(),
  })
  .strict()
  .superRefine((reading, ctx) => {
    const metric = getMetric(reading.metricKey)!;
    if (reading.unit !== metric.canonicalUnit) {
      ctx.addIssue({ code: 'custom', path: ['unit'], message: `Must be ${metric.canonicalUnit}` });
    }
    if (!isWithinBounds(reading.metricKey, roundCanonical(reading.value))) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `Must be between ${metric.min} and ${metric.max}` });
    }
    if (reading.method !== undefined && !isMethodAllowed(reading.metricKey, reading.method)) {
      ctx.addIssue({ code: 'custom', path: ['method'], message: `Not a method of ${reading.metricKey}` });
    }
  });
export type SyncMeasurementInput = z.infer<typeof syncMeasurementSchema>;

const stageMinutes = z.number().int().min(0).max(1440);
const syncSleepSchema = z
  .object({
    externalId: z.string().trim().min(1).max(SYNC_EXTERNAL_ID_MAX),
    startAt: instant,
    endAt: instant,
    localDate: localDate.meta({ description: 'The local day of waking (`endAt`), phone time zone.' }),
    durationMinutes: stageMinutes.meta({ description: 'Asleep minutes (total minus awake when stages exist).' }),
    awakeMinutes: stageMinutes.optional(),
    lightMinutes: stageMinutes.optional(),
    deepMinutes: stageMinutes.optional(),
    remMinutes: stageMinutes.optional(),
    unknownMinutes: stageMinutes.optional(),
    note: z.string().trim().max(SYNC_NOTE_MAX).optional(),
  })
  .strict()
  .refine((session) => Date.parse(session.endAt) > Date.parse(session.startAt), {
    message: 'endAt must be after startAt',
    path: ['endAt'],
  });
export type SyncSleepInput = z.infer<typeof syncSleepSchema>;

export const syncSchema = z
  .object({
    run: syncRunSchema,
    window: z
      .object({ from: localDate, to: localDate })
      .strict()
      .refine((window) => window.from <= window.to, { message: '`from` must not be after `to`', path: ['from'] })
      .optional()
      .meta({ description: 'The local days the phone read. With `run.status: ok` it bounds reconciliation.' }),
    entries: z.array(syncEntrySchema).max(SYNC_ENTRIES_MAX),
    measurements: z.array(syncMeasurementSchema).max(SYNC_MEASUREMENTS_MAX).optional().meta({
      description: 'Body and heart readings. Needs `health_data:write`.',
    }),
    sleepSessions: z.array(syncSleepSchema).max(SYNC_SLEEP_MAX).optional().meta({
      description: 'Sleep sessions. Needs `health_data:write`.',
    }),
  })
  .strict();
export type SyncInput = z.infer<typeof syncSchema>;
export class SyncDto extends createZodDto(syncSchema) {}

// -----------------------------------------------------------------------------
// Diagnostics, queries
// -----------------------------------------------------------------------------

export const uploadDiagnosticsSchema = z
  .object({
    summary: z.string().trim().max(DIAGNOSTIC_SUMMARY_MAX).optional(),
    report: jsonObject.refine(serializedAtMost(DIAGNOSTIC_REPORT_MAX_BYTES), {
      message: `At most ${DIAGNOSTIC_REPORT_MAX_BYTES} bytes serialized`,
    }),
  })
  .strict();
export type UploadDiagnosticsInput = z.infer<typeof uploadDiagnosticsSchema>;
export class UploadDiagnosticsDto extends createZodDto(uploadDiagnosticsSchema) {}

export const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(RUNS_LIMIT_MAX).default(RUNS_LIMIT_DEFAULT),
});
export class ListRunsQueryDto extends createZodDto(listRunsQuerySchema) {}

export const listReportsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(REPORTS_LIMIT_MAX).default(REPORTS_LIMIT_DEFAULT),
});
export class ListReportsQueryDto extends createZodDto(listReportsQuerySchema) {}

export const unpairQuerySchema = z.object({
  deleteEntries: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(false)
    .meta({
      description:
        "`true` also deletes this device's imported activity entries and sleep sessions and soft-deletes its measurements.",
    }),
});
export class UnpairQueryDto extends createZodDto(unpairQuerySchema) {}

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

export const deviceViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  androidVersion: z.string().nullable(),
  sdkInt: z.number().int().nullable(),
  appVersion: z.string().nullable(),
  appVersionCode: z.number().int().nullable().meta({ description: 'The versionCode the phone last registered with.' }),
  latestVersionCode: z
    .number()
    .int()
    .nullable()
    .meta({ description: "The current server release's versionCode for this device's package; null when there is none." }),
  updateAvailable: z
    .boolean()
    .meta({ description: 'True when the current server release is newer than the installed app (same package).' }),
  healthConnectVersion: z.string().nullable(),
  packageName: z.string().nullable(),
  signingSha256: z.string().nullable(),
  timezone: z.string().nullable().meta({ description: "The phone's time zone at its last sync." }),
  userTimezone: z.string().nullable().meta({ description: "The user's Health Profile time zone (null: UTC is used)." }),
  status: z.enum(HEALTH_SYNC_DEVICE_STATUSES),
  lastSeenAt: z.iso.datetime().nullable(),
  lastSyncAt: z.iso.datetime().nullable(),
  lastSyncStatus: z.enum(HEALTH_SYNC_RUN_STATUSES).nullable(),
  lastError: z.string().nullable(),
  tokenExpiresAt: z.iso.datetime().nullable().meta({ description: 'Expiry of the linked access token; null when none.' }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DeviceView = z.infer<typeof deviceViewSchema>;
export class DeviceViewDto extends createZodDto(deviceViewSchema) {}

export const runViewSchema = z.object({
  id: z.uuid(),
  deviceId: z.uuid(),
  trigger: z.enum(HEALTH_SYNC_TRIGGERS),
  status: z.enum(HEALTH_SYNC_RUN_STATUSES),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  windowFrom: z.iso.date().nullable(),
  windowTo: z.iso.date().nullable(),
  recordsRead: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  deleted: z.number().int(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  details: jsonObject.nullable(),
  createdAt: z.iso.datetime(),
});
export type RunView = z.infer<typeof runViewSchema>;
export class RunViewDto extends createZodDto(runViewSchema) {}

export const reportSummaryViewSchema = z.object({
  id: z.uuid(),
  deviceId: z.uuid(),
  summary: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type ReportSummaryView = z.infer<typeof reportSummaryViewSchema>;
export class ReportSummaryViewDto extends createZodDto(reportSummaryViewSchema) {}

export const reportViewSchema = reportSummaryViewSchema.extend({ report: jsonObject });
export type ReportView = z.infer<typeof reportViewSchema>;
export class ReportViewDto extends createZodDto(reportViewSchema) {}

export const reportCreatedViewSchema = z.object({ id: z.uuid(), createdAt: z.iso.datetime() });
export class ReportCreatedViewDto extends createZodDto(reportCreatedViewSchema) {}

const countsSchema = z.object({ created: z.number().int(), updated: z.number().int(), deleted: z.number().int() });

export const syncResultViewSchema = z.object({
  runId: z.uuid(),
  created: z.number().int().meta({ description: 'Activity entries inserted.' }),
  updated: z.number().int().meta({ description: 'Activity entries whose values changed.' }),
  deleted: z.number().int().meta({ description: 'Activity entries reconciled away.' }),
  unchanged: z.number().int().meta({ description: 'Activity entries re-sent with identical values.' }),
  skipped: z.number().int().meta({
    description: 'Activity entries not written: the key belongs to a row this sync does not own.',
  }),
  measurements: countsSchema.extend({
    unchanged: z.number().int(),
    skipped: z.number().int().meta({ description: 'Readings the user deleted or edited: never overwritten.' }),
  }),
  sleep: countsSchema.extend({ unchanged: z.number().int(), skipped: z.number().int() }),
});
export type SyncResultView = z.infer<typeof syncResultViewSchema>;
export class SyncResultViewDto extends createZodDto(syncResultViewSchema) {}
