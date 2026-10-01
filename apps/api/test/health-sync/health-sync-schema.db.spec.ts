// =============================================================================
// Real-Postgres test: health sync schema (#277, epic #276)
// =============================================================================
//
// What only a real server can prove: the raw-SQL partial unique indexes
// `measurements_provider_external_uniq_idx` and
// `sleep_sessions_provider_external_uniq_idx` (manual rows, with no provider,
// are never constrained), the CHECK constraints, the device unique key and the
// ON DELETE behaviour (SetNull on a device's imported rows, Cascade on runs).
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('health-sync-schema.db.spec');

describeWithDb('health sync schema (real Postgres)', () => {
  let client: PrismaClient;
  const tag = randomUUID().slice(0, 8);
  let userId: string;
  let deviceId: string;

  const measurement = (over: Record<string, unknown> = {}) => ({
    userId,
    entryId: randomUUID(),
    metricKey: 'weight',
    value: 80,
    unit: 'kg',
    measuredAt: new Date(),
    origin: 'device',
    ...over,
  });
  const sleep = (over: Record<string, unknown> = {}) => ({
    userId,
    startAt: new Date('2026-09-01T22:00:00Z'),
    endAt: new Date('2026-09-02T06:00:00Z'),
    localDate: new Date('2026-09-02'),
    durationMinutes: 480,
    ...over,
  });

  beforeAll(async () => {
    client = createDbClient();
    userId = (await client.user.create({ data: { email: `hs-schema-${tag}@example.com` } })).id;
    deviceId = (
      await client.healthSyncDevice.create({ data: { userId, installationId: randomUUID(), name: 'Pixel' } })
    ).id;
  });

  afterAll(async () => {
    await client.user.delete({ where: { id: userId } }).catch(() => undefined);
    await client.$disconnect();
  });

  it('allows one device measurement per (user, provider, external id) but any number of manual rows', async () => {
    const ext = { externalProvider: `health_connect:${deviceId}`, externalId: `w-${tag}`, healthSyncDeviceId: deviceId };
    await client.measurement.create({ data: measurement(ext) });
    await expect(client.measurement.create({ data: measurement(ext) })).rejects.toThrow();
    await client.measurement.create({ data: measurement({ ...ext, externalId: `w2-${tag}` }) });
    await client.measurement.create({ data: measurement({ origin: 'manual' }) });
    await client.measurement.create({ data: measurement({ origin: 'manual' }) });
  });

  it('allows one device sleep session per (user, provider, external id)', async () => {
    const ext = { origin: 'device', provider: `health_connect:${deviceId}`, externalId: `s-${tag}`, healthSyncDeviceId: deviceId };
    await client.sleepSession.create({ data: sleep(ext) });
    await expect(client.sleepSession.create({ data: sleep(ext) })).rejects.toThrow();
    await client.sleepSession.create({ data: sleep() });
    await client.sleepSession.create({ data: sleep() });
  });

  it('rejects an inverted or oversized sleep session and negative minutes', async () => {
    await expect(
      client.sleepSession.create({ data: sleep({ endAt: new Date('2026-09-01T21:00:00Z') }) }),
    ).rejects.toThrow();
    await expect(client.sleepSession.create({ data: sleep({ durationMinutes: 1441 }) })).rejects.toThrow();
    await expect(client.sleepSession.create({ data: sleep({ deepMinutes: -1 }) })).rejects.toThrow();
  });

  it('rejects negative run counts and an over-long device name', async () => {
    const now = new Date();
    await expect(
      client.healthSyncRun.create({
        data: { deviceId, userId, trigger: 'manual', status: 'ok', startedAt: now, finishedAt: now, created: -1 },
      }),
    ).rejects.toThrow();
    await expect(
      client.healthSyncDevice.create({ data: { userId, installationId: randomUUID(), name: 'x'.repeat(101) } }),
    ).rejects.toThrow();
  });

  it('keeps one device per (user, installation id)', async () => {
    const installationId = randomUUID();
    await client.healthSyncDevice.create({ data: { userId, installationId, name: 'A' } });
    await expect(client.healthSyncDevice.create({ data: { userId, installationId, name: 'B' } })).rejects.toThrow();
  });

  it('cascades runs and reports with the device and nulls the device link on imported rows', async () => {
    const dev = await client.healthSyncDevice.create({ data: { userId, installationId: randomUUID(), name: 'Tmp' } });
    const now = new Date();
    await client.healthSyncRun.create({
      data: { deviceId: dev.id, userId, trigger: 'periodic', status: 'ok', startedAt: now, finishedAt: now },
    });
    await client.healthSyncDiagnosticReport.create({ data: { deviceId: dev.id, userId, report: {} } });
    const m = await client.measurement.create({
      data: measurement({ externalProvider: `health_connect:${dev.id}`, externalId: `t-${tag}`, healthSyncDeviceId: dev.id }),
    });
    const s = await client.sleepSession.create({
      data: sleep({ provider: `health_connect:${dev.id}`, externalId: `t-${tag}`, healthSyncDeviceId: dev.id }),
    });

    await client.healthSyncDevice.delete({ where: { id: dev.id } });

    expect(await client.healthSyncRun.count({ where: { deviceId: dev.id } })).toBe(0);
    expect(await client.healthSyncDiagnosticReport.count({ where: { deviceId: dev.id } })).toBe(0);
    expect((await client.measurement.findUniqueOrThrow({ where: { id: m.id } })).healthSyncDeviceId).toBeNull();
    expect((await client.sleepSession.findUniqueOrThrow({ where: { id: s.id } })).healthSyncDeviceId).toBeNull();
  });

  it('nulls a device PAT link when the token is deleted', async () => {
    const pat = await client.personalAccessToken.create({
      data: {
        userId, name: 'hs', tokenHash: `hash-${tag}`, tokenPrefix: 'pat_x', durationValue: 90, durationUnit: 'days',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const dev = await client.healthSyncDevice.create({
      data: { userId, installationId: randomUUID(), name: 'Pat', patId: pat.id },
    });
    await client.personalAccessToken.delete({ where: { id: pat.id } });
    expect((await client.healthSyncDevice.findUniqueOrThrow({ where: { id: dev.id } })).patId).toBeNull();
  });
});
