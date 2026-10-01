/**
 * Health sync fixtures (issue #283, epic #276), shaped exactly as
 * `/api/health-sync/*` and `/api/admin/android-app` answer inside the
 * `{ data }` envelope.
 */
import type {
  AndroidAppConfig,
  Device,
  Report,
  ReportSummary,
  Run,
} from '../../../services/healthSync';

export const DEVICE_ID = 'dev11111-0000-4000-8000-000000000001';
export const REPORT_ID = 'rep11111-0000-4000-8000-000000000001';
export const PIXEL_SHA =
  'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';

export function mockDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: DEVICE_ID,
    name: 'Pixel 9',
    manufacturer: 'Google',
    model: 'Pixel 9',
    androidVersion: '16',
    sdkInt: 36,
    appVersion: '0.1.0',
    healthConnectVersion: '1.1.0',
    packageName: 'com.evopath.android',
    signingSha256: PIXEL_SHA,
    timezone: 'America/Costa_Rica',
    userTimezone: 'America/Costa_Rica',
    status: 'active',
    lastSeenAt: '2026-09-30T12:00:00.000Z',
    lastSyncAt: '2026-09-30T12:00:00.000Z',
    lastSyncStatus: 'ok',
    lastError: null,
    tokenExpiresAt: '2026-12-29T12:00:00.000Z',
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-30T12:00:00.000Z',
    ...overrides,
  };
}

export function mockRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run11111-0000-4000-8000-000000000001',
    deviceId: DEVICE_ID,
    trigger: 'periodic',
    status: 'ok',
    startedAt: '2026-09-30T11:59:50.000Z',
    finishedAt: '2026-09-30T12:00:00.000Z',
    windowFrom: '2026-09-24',
    windowTo: '2026-09-30',
    recordsRead: 12,
    created: 2,
    updated: 1,
    deleted: 0,
    errorCode: null,
    errorMessage: null,
    details: null,
    createdAt: '2026-09-30T12:00:00.000Z',
    ...overrides,
  };
}

export const mockFailedRun = mockRun({
  id: 'run22222-0000-4000-8000-000000000002',
  trigger: 'manual',
  status: 'failed',
  recordsRead: 0,
  created: 0,
  updated: 0,
  errorCode: 'HC_PERMISSION_DENIED',
  errorMessage: 'Health Connect permission was revoked',
});

/** A run whose details carry the phone's per-type counts. */
export const mockRunWithTypes = mockRun({
  id: 'run33333-0000-4000-8000-000000000003',
  details: {
    syncedTypes: ['steps', 'sleep'],
    perType: {
      steps: { permission: 'granted', read: 7, sent: 7 },
      sleep: { permission: 'denied', read: 0, sent: 0 },
    },
  },
});

export const mockReportSummary: ReportSummary = {
  id: REPORT_ID,
  deviceId: DEVICE_ID,
  summary: '2 warnings, 1 failure',
  createdAt: '2026-09-30T12:05:00.000Z',
};

export const mockReport: Report = {
  ...mockReportSummary,
  report: {
    generatedAt: '2026-09-30T12:04:59.000Z',
    app: { versionName: '0.1.0', versionCode: 1, packageName: 'com.evopath.android', signingSha256: PIXEL_SHA },
    device: { manufacturer: 'Google', model: 'Pixel 9', androidVersion: '16', sdkInt: 36, timezone: 'America/Costa_Rica' },
    server: { url: 'https://evopath.example.com' },
    pairing: { deviceId: DEVICE_ID, tokenExpiresAt: '2026-12-29T12:00:00.000Z' },
    healthConnect: {
      status: 'available',
      version: '1.1.0',
      grantedPermissions: ['READ_STEPS', 'READ_SLEEP'],
      inventory: [
        {
          dataType: 'steps',
          permission: 'granted',
          recordCount30d: 1000,
          capped: true,
          latestRecordAt: '2026-09-30T11:00:00.000Z',
          sources: [{ packageName: 'com.sec.android.app.shealth', appLabel: 'Samsung Health', recordCount: 1000 }],
        },
        { dataType: 'sleep', permission: 'granted', recordCount30d: 0, capped: false, latestRecordAt: null, sources: [] },
        { dataType: 'weight', permission: 'denied', recordCount30d: 0, capped: false, latestRecordAt: null, sources: [] },
      ],
      sources: [
        {
          packageName: 'com.sec.android.app.shealth',
          appLabel: 'Samsung Health',
          dataTypes: ['steps', 'exercise'],
          recordCount: 1040,
          latestRecordAt: '2026-09-30T11:00:00.000Z',
        },
      ],
    },
    work: { state: 'ENQUEUED', nextRunAt: '2026-09-30T13:00:00.000Z' },
    checks: [
      { id: 'server.reachable', status: 'pass', detail: 'GET /api/health/live answered 200', remedy: null },
      {
        id: 'hc.permissions',
        status: 'fail',
        detail: 'READ_EXERCISE not granted',
        remedy: 'Grant exercise access in Health Connect',
      },
      { id: 'battery.optimization', status: 'warn', detail: 'Battery optimisation is on', remedy: 'Allow background use' },
      { id: 'twa.verification', status: 'skip', detail: 'No server configured', remedy: null },
    ],
    recentRuns: [],
    log: ['12:00:00 sync start', '12:00:01 read 12 records', '12:00:02 sync ok'],
  },
};

export const mockAndroidAppConfig: AndroidAppConfig = {
  trustedApps: [],
  reportedApps: [
    { packageName: 'com.evopath.android', sha256: PIXEL_SHA, deviceCount: 1, lastSeenAt: '2026-09-30T12:00:00.000Z' },
  ],
  assetLinks: [],
};
