/** `services/healthSync.ts` (#283): every route's method, path, query and body, and the helpers. */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  ANDROID_PACKAGE_PATTERN,
  SHA256_FINGERPRINT_PATTERN,
  androidReleaseUrl,
  daysUntil,
  getAndroidAppConfig,
  getDevice,
  getDiagnostic,
  hasTimezoneMismatch,
  isGrantedButEmpty,
  runTypeStats,
  listDevices,
  listDiagnostics,
  listRuns,
  putAndroidAppConfig,
  unpairDevice,
} from '../../services/healthSync';
import {
  DEVICE_ID,
  PIXEL_SHA,
  REPORT_ID,
  mockAndroidAppConfig,
  mockDevice,
  mockReport,
  mockReportSummary,
  mockRun,
  mockRunWithTypes,
} from '../mocks/fixtures/healthSync';

interface Seen {
  url?: string;
  method?: string;
  body?: unknown;
}

function capture(
  method: 'get' | 'put' | 'delete',
  path: string,
  data: unknown = null,
  status = 200,
): Seen {
  const seen: Seen = {};
  server.use(
    http[method](`*/api${path}`, async ({ request }) => {
      seen.url = request.url;
      seen.method = request.method;
      const text = await request.clone().text();
      seen.body = text ? JSON.parse(text) : undefined;
      if (status === 204) return new HttpResponse(null, { status });
      return HttpResponse.json({ data }, { status });
    }),
  );
  return seen;
}

describe('healthSync service', () => {
  it('lists devices and unwraps the { data } envelope', async () => {
    const seen = capture('get', '/health-sync/devices', [mockDevice()]);
    const devices = await listDevices();
    expect(seen.method).toBe('GET');
    expect(devices).toHaveLength(1);
    expect(devices[0].id).toBe(DEVICE_ID);
  });

  it('reads one device', async () => {
    const seen = capture('get', `/health-sync/devices/${DEVICE_ID}`, mockDevice());
    const device = await getDevice(DEVICE_ID);
    expect(new URL(seen.url!).pathname).toBe(`/api/health-sync/devices/${DEVICE_ID}`);
    expect(device.name).toBe('Pixel 9');
  });

  it('lists runs with a limit', async () => {
    const seen = capture('get', `/health-sync/devices/${DEVICE_ID}/runs`, [mockRun()]);
    const runs = await listRuns(DEVICE_ID);
    expect(new URL(seen.url!).search).toBe('?limit=50');
    expect(runs[0].status).toBe('ok');
    await listRuns(DEVICE_ID, 10);
    expect(new URL(seen.url!).search).toBe('?limit=10');
  });

  it('lists diagnostics and reads one report', async () => {
    const list = capture('get', `/health-sync/devices/${DEVICE_ID}/diagnostics`, [mockReportSummary]);
    await listDiagnostics(DEVICE_ID);
    expect(new URL(list.url!).search).toBe('?limit=5');

    const one = capture('get', `/health-sync/devices/${DEVICE_ID}/diagnostics/${REPORT_ID}`, mockReport);
    const report = await getDiagnostic(DEVICE_ID, REPORT_ID);
    expect(one.method).toBe('GET');
    expect(report.report.checks).toHaveLength(4);
  });

  it('unpairs with deleteEntries in the query string', async () => {
    const seen = capture('delete', `/health-sync/devices/${DEVICE_ID}`, null, 204);
    await unpairDevice(DEVICE_ID, true);
    expect(seen.method).toBe('DELETE');
    expect(new URL(seen.url!).search).toBe('?deleteEntries=true');
    await unpairDevice(DEVICE_ID, false);
    expect(new URL(seen.url!).search).toBe('?deleteEntries=false');
  });

  it('reads and replaces the admin Android app config', async () => {
    const get = capture('get', '/admin/android-app', mockAndroidAppConfig);
    const config = await getAndroidAppConfig();
    expect(get.method).toBe('GET');
    expect(config.reportedApps).toHaveLength(1);

    const trusted = [{ packageName: 'com.evopath.android', sha256: PIXEL_SHA }];
    const put = capture('put', '/admin/android-app', { ...mockAndroidAppConfig, trustedApps: trusted });
    const saved = await putAndroidAppConfig(trusted);
    expect(put.method).toBe('PUT');
    expect(put.body).toEqual({ trustedApps: trusted });
    expect(saved.trustedApps).toEqual(trusted);
  });
});

describe('healthSync helpers', () => {
  it('builds the rolling release URL from the repo slug', () => {
    expect(androidReleaseUrl('acme/app')).toBe('https://github.com/acme/app/releases/tag/android-latest');
  });

  it('counts whole days until a date, negative once past, null without one', () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    expect(daysUntil('2026-10-11T00:00:00.000Z', now)).toBe(10);
    expect(daysUntil('2026-09-30T00:00:00.000Z', now)).toBe(-1);
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil('not a date', now)).toBeNull();
  });

  it('flags a timezone mismatch only when both zones are set and differ', () => {
    expect(hasTimezoneMismatch({ timezone: 'Europe/Madrid', userTimezone: 'America/Costa_Rica' })).toBe(true);
    expect(hasTimezoneMismatch({ timezone: 'Europe/Madrid', userTimezone: 'Europe/Madrid' })).toBe(false);
    expect(hasTimezoneMismatch({ timezone: null, userTimezone: 'Europe/Madrid' })).toBe(false);
    expect(hasTimezoneMismatch({ timezone: 'Europe/Madrid', userTimezone: null })).toBe(false);
  });

  it('validates package names and SHA-256 fingerprints as the API does', () => {
    expect(ANDROID_PACKAGE_PATTERN.test('com.evopath.android')).toBe(true);
    expect(ANDROID_PACKAGE_PATTERN.test('evopath')).toBe(false);
    expect(ANDROID_PACKAGE_PATTERN.test('com..evopath')).toBe(false);
    expect(SHA256_FINGERPRINT_PATTERN.test(PIXEL_SHA)).toBe(true);
    expect(SHA256_FINGERPRINT_PATTERN.test(PIXEL_SHA.toLowerCase())).toBe(false);
    expect(SHA256_FINGERPRINT_PATTERN.test('AB:CD')).toBe(false);
  });

  it('reads per-type run stats, or none for a run without details', () => {
    expect(runTypeStats(mockRun())).toEqual([]);
    expect(runTypeStats(mockRunWithTypes)).toEqual([
      { dataType: 'steps', permission: 'granted', read: 7, sent: 7 },
      { dataType: 'sleep', permission: 'denied', read: 0, sent: 0 },
    ]);
  });

  it('flags a granted type with no records, not a denied one', () => {
    expect(isGrantedButEmpty({ permission: 'granted', recordCount30d: 0 })).toBe(true);
    expect(isGrantedButEmpty({ permission: 'granted', recordCount30d: 3 })).toBe(false);
    expect(isGrantedButEmpty({ permission: 'denied', recordCount30d: 0 })).toBe(false);
  });
});
