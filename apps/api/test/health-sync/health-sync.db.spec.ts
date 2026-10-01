// =============================================================================
// Real-Postgres test: the health sync API's service (#278, epic #276)
// =============================================================================
//
// What only a real server can prove: the upserts through the raw-SQL partial
// unique indexes (a re-sent sync creates no duplicate and changes nothing, a
// changed value updates in place), reconciliation limited to the window, to
// `run.details.syncedTypes` and to this device's provider, a reading the user
// deleted never coming back, source precedence over real rows (an imported
// entry outranks a manual one in goal progress), DEVICE_REVOKED, unpairing
// revoking the linked PAT, re-pairing revoking the previous PAT, and the
// per-device retention of runs and reports.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { createActivityEntrySchema } from '../../src/activity/dto/activity-entry.dto';
import { ActivityEntriesService } from '../../src/activity/activity-entries.service';
import { GoalProgressService } from '../../src/activity/goal-progress.service';
import { GoalsService } from '../../src/activity/goals.service';
import { WorkoutActivitySyncService } from '../../src/activity/workout-activity-sync.service';
import { CheckInsService } from '../../src/check-ins/check-ins.service';
import { addDays, localDateInZone, toDbDate } from '../../src/check-ins/local-date';
import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import { syncSchema } from '../../src/health-sync/dto/health-sync.dto';
import { HealthSyncService } from '../../src/health-sync/health-sync.service';
import { MeasurementsService } from '../../src/measurements/measurements.service';
import { PatService } from '../../src/pat/pat.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('health-sync.db.spec');

describeWithDb('health sync (real Postgres)', () => {
  let client: PrismaClient;
  let healthSync: HealthSyncService;
  let pats: PatService;
  let measurements: MeasurementsService;
  let entries: ActivityEntriesService;
  let goals: GoalsService;
  let progress: GoalProgressService;
  const emitted: string[] = [];
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  const today = localDateInZone(new Date(), 'UTC');
  const window = { from: addDays(today, -6), to: today };

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `hs-${label}-${run}@example.com` }, select: { id: true } });
    userIds.push(user.id);
    return user.id;
  }

  async function makeDevice(userId: string, name = 'Pixel'): Promise<string> {
    const device = await healthSync.register(userId, { installationId: randomUUID(), name }, { kind: 'jwt' });
    return device.id;
  }

  function payload(extra: Record<string, unknown> = {}, runOverrides: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    return syncSchema.parse({
      run: { trigger: 'periodic', status: 'ok', startedAt: now, finishedAt: now, ...runOverrides },
      entries: [],
      ...extra,
    });
  }

  const steps = (day: string, value: number) => ({ externalId: `steps:${day}`, occurredOn: day, activityKind: 'steps', steps: value });
  const walk = (id: string, day: string, minutes: number) => ({
    externalId: id,
    occurredOn: day,
    occurredAt: `${day}T07:00:00.000Z`,
    activityKind: 'walk',
    durationSeconds: minutes * 60,
    distanceMeters: 2500.5,
  });
  const reading = (id: string, metricKey: string, value: number, unit: string, day: string, entryKey?: string) => ({
    externalId: id,
    metricKey,
    value,
    unit,
    measuredAt: `${day}T06:30:00.000Z`,
    ...(entryKey ? { entryKey } : {}),
  });
  const night = (id: string, day: string, minutes = 420) => ({
    externalId: id,
    startAt: `${addDays(day, -1)}T23:00:00.000Z`,
    endAt: `${day}T07:00:00.000Z`,
    localDate: day,
    durationMinutes: minutes,
    deepMinutes: 90,
    remMinutes: 100,
    lightMinutes: minutes - 190,
    awakeMinutes: 480 - minutes,
  });

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const healthProfile = new HealthProfileService(prisma);
    const checkIns = new CheckInsService(prisma, healthProfile);
    const workoutSync = new WorkoutActivitySyncService(prisma);
    const events = { emit: (event: string) => emitted.push(event) > 0 };
    healthSync = new HealthSyncService(prisma, healthProfile, events as never);
    pats = new PatService(prisma);
    measurements = new MeasurementsService(prisma);
    entries = new ActivityEntriesService(prisma, checkIns, workoutSync);
    goals = new GoalsService(prisma, checkIns);
    progress = new GoalProgressService(prisma, checkIns, workoutSync);
  });

  beforeEach(() => {
    emitted.length = 0;
  });

  afterAll(async () => {
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  it('a re-sent sync is idempotent: created, then unchanged, then updated in place, never duplicated', async () => {
    const userId = await makeUser('idempotent');
    const deviceId = await makeDevice(userId);
    const body = {
      window,
      entries: [steps(today, 5000), walk('ex-1', today, 30)],
      measurements: [
        reading('bp-1:sys', 'bp_systolic', 120, 'mmHg', today, 'bp-1'),
        reading('bp-1:dia', 'bp_diastolic', 80, 'mmHg', today, 'bp-1'),
        reading('hr-avg', 'heart_rate_avg', 71.4, 'bpm', today),
      ],
      sleepSessions: [night('sleep-1', today)],
    };

    const first = await healthSync.sync(userId, deviceId, payload(body), true);
    expect(first).toMatchObject({ created: 2, updated: 0, deleted: 0 });
    expect(first.measurements).toMatchObject({ created: 3 });
    expect(first.sleep).toMatchObject({ created: 1 });
    expect(emitted).toEqual(['activity.entry.recorded', 'health.data.changed']);

    emitted.length = 0;
    const second = await healthSync.sync(userId, deviceId, payload(body), true);
    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 2, skipped: 0 });
    expect(second.measurements).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(second.sleep).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(emitted).toEqual([]);

    const third = await healthSync.sync(
      userId,
      deviceId,
      payload({ ...body, entries: [steps(today, 7400), walk('ex-1', today, 30)] }),
      true,
    );
    expect(third).toMatchObject({ created: 0, updated: 1, unchanged: 1 });

    const rows = await client.activityEntry.findMany({ where: { userId } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.source === 'integration' && row.provider === `health_connect:${deviceId}`)).toBe(true);
    expect(rows.find((row) => row.activityKind === 'steps')?.steps).toBe(7400);

    const readings = await client.measurement.findMany({ where: { userId } });
    expect(readings).toHaveLength(3);
    expect(readings.every((row) => row.origin === 'device' && row.healthSyncDeviceId === deviceId)).toBe(true);
    const bp = readings.filter((row) => row.metricKey.startsWith('bp_'));
    expect(new Set(bp.map((row) => row.entryId)).size).toBe(1);
    expect(readings.find((row) => row.metricKey === 'heart_rate_avg')).toMatchObject({ method: 'wearable', unit: 'bpm' });
    expect(bp[0].method).toBe('bp_cuff');
    expect(readings.every((row) => row.localDate && row.localDate.toISOString().startsWith(today))).toBe(true);

    expect(await client.sleepSession.count({ where: { userId } })).toBe(1);
    expect(await client.healthSyncRun.count({ where: { deviceId } })).toBe(3);
    const device = await healthSync.get(userId, deviceId);
    expect(device).toMatchObject({ lastSyncStatus: 'ok', lastError: null });
    expect(device.lastSyncAt).not.toBeNull();
  });

  it('reconciles only absent rows inside the window, only for syncedTypes, never another device or a manual row', async () => {
    const userId = await makeUser('reconcile');
    const phone = await makeDevice(userId, 'Phone');
    const tablet = await makeDevice(userId, 'Tablet');
    const day1 = addDays(today, -2);
    const day2 = addDays(today, -1);
    const outside = addDays(today, -10);

    await healthSync.sync(
      userId,
      phone,
      payload({
        entries: [steps(day1, 4000), steps(day2, 6000), steps(outside, 3000), walk('ex-phone', day2, 20)],
        measurements: [reading('w-1', 'weight', 80, 'kg', day1), reading('w-2', 'weight', 80.4, 'kg', day2)],
        sleepSessions: [night('s-1', day1), night('s-2', day2)],
      }),
      true,
    );
    await healthSync.sync(userId, tablet, payload({ entries: [steps(day2, 999)] }), true);
    await entries.create(userId, createActivityEntrySchema.parse({ activityKind: 'steps', steps: 100, occurredOn: day2 }));

    // The phone now only reports day1's steps and w-1; it synced steps and weight only.
    const result = await healthSync.sync(
      userId,
      phone,
      payload(
        { window, entries: [steps(day1, 4000)], measurements: [reading('w-1', 'weight', 80, 'kg', day1)] },
        { details: { syncedTypes: ['steps', 'weight'] } },
      ),
      true,
    );
    expect(result).toMatchObject({ deleted: 1 });
    expect(result.measurements).toMatchObject({ deleted: 1 });
    expect(result.sleep).toMatchObject({ deleted: 0 });

    const left = await client.activityEntry.findMany({ where: { userId }, orderBy: { occurredOn: 'asc' } });
    const labels = left.map((row) => `${row.provider ?? 'manual'}|${row.externalId ?? ''}`).sort();
    expect(labels).toEqual(
      [
        `health_connect:${phone}|steps:${outside}`, // outside the window
        `health_connect:${phone}|steps:${day1}`, // still sent
        `health_connect:${phone}|ex-phone`, // exercise was not a synced type
        `health_connect:${tablet}|steps:${day2}`, // another device
        'manual|', // a manual check-in
      ].sort(),
    );

    const weights = await client.measurement.findMany({ where: { userId }, orderBy: { externalId: 'asc' } });
    expect(weights.map((row) => [row.externalId, row.deletedAt === null])).toEqual([
      ['w-1', true],
      ['w-2', false],
    ]);
    expect(await client.sleepSession.count({ where: { userId } })).toBe(2);

    // A partial run reconciles nothing.
    const partial = await healthSync.sync(
      userId,
      phone,
      payload({ window, entries: [] }, { status: 'partial', details: { syncedTypes: ['steps', 'sleep'] } }),
      true,
    );
    expect(partial).toMatchObject({ deleted: 0 });
    expect(await client.sleepSession.count({ where: { userId } })).toBe(2);

    // An ok run with sleep synced and none sent removes the phone's nights in the window.
    const sleepOnly = await healthSync.sync(userId, phone, payload({ window, entries: [] }, { details: { syncedTypes: ['sleep'] } }), true);
    expect(sleepOnly.sleep).toMatchObject({ deleted: 2 });
  });

  it('never resurrects or overwrites a reading the user deleted', async () => {
    const userId = await makeUser('deleted');
    const deviceId = await makeDevice(userId);
    const body = { measurements: [reading('rhr-1', 'resting_hr', 58, 'bpm', today)] };
    await healthSync.sync(userId, deviceId, payload(body), true);
    const [row] = await client.measurement.findMany({ where: { userId } });
    await measurements.deleteEntry(userId, row.entryId);

    const again = await healthSync.sync(userId, deviceId, payload({ measurements: [reading('rhr-1', 'resting_hr', 61, 'bpm', today)] }), true);
    expect(again.measurements).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    const rows = await client.measurement.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: 58 });
    expect(rows[0].deletedAt).not.toBeNull();
  });

  it('an imported entry outranks a manual one on the same day in goal progress', async () => {
    const userId = await makeUser('precedence');
    const deviceId = await makeDevice(userId);
    await goals.create(userId, { title: 'Walk', activityKind: 'walk', metric: 'minutes', target: 150, period: 'week' });
    await entries.create(userId, createActivityEntrySchema.parse({ activityKind: 'walk', durationSeconds: 600 }));
    await healthSync.sync(userId, deviceId, payload({ entries: [walk('walk-hc', today, 40)] }), true);

    const [goal] = await progress.progressForUser(userId);
    expect(goal.done).toBe(40);
    expect(goal.entries.find((entry) => entry.source === 'manual')?.superseded).toBe(true);
    expect(goal.entries.find((entry) => entry.source === 'integration')?.superseded).toBe(false);
  });

  it('a revoked device is refused with 409 DEVICE_REVOKED; unpairing revokes its PAT and deletes its rows on request', async () => {
    const userId = await makeUser('unpair');
    const token = await pats.createToken(userId, { name: 'EvoPath Android', durationValue: 90, durationUnit: 'days' });
    const device = await healthSync.register(userId, { installationId: randomUUID(), name: 'Pixel' }, { kind: 'pat', tokenId: token.id });
    expect(device.tokenExpiresAt).toBe(token.expiresAt);
    expect(await pats.validateToken(token.token)).not.toBeNull();

    await healthSync.sync(
      userId,
      device.id,
      payload({
        entries: [steps(today, 1234)],
        measurements: [reading('w', 'weight', 70, 'kg', today)],
        sleepSessions: [night('n', today)],
      }),
      true,
    );

    await healthSync.unpair(userId, device.id, true);
    expect(await pats.validateToken(token.token)).toBeNull();
    expect(await client.activityEntry.count({ where: { userId } })).toBe(0);
    expect(await client.sleepSession.count({ where: { userId } })).toBe(0);
    expect(await client.measurement.count({ where: { userId, deletedAt: null } })).toBe(0);
    expect((await healthSync.get(userId, device.id)).status).toBe('revoked');

    await expect(healthSync.sync(userId, device.id, payload(), true)).rejects.toBeInstanceOf(ConflictException);
    // Diagnostics still work for a revoked device.
    await expect(healthSync.uploadDiagnostics(userId, device.id, { report: { ok: false } })).resolves.toHaveProperty('id');

    // Re-registering the same installation brings it back.
    const installationId = (await client.healthSyncDevice.findUniqueOrThrow({ where: { id: device.id } })).installationId;
    const again = await healthSync.register(userId, { installationId, name: 'Pixel' }, { kind: 'jwt' });
    expect(again).toMatchObject({ id: device.id, status: 'active' });
  });

  it('re-pairing with a new PAT revokes the previously linked one; the same PAT revokes nothing', async () => {
    const userId = await makeUser('repair');
    const installationId = randomUUID();
    const first = await pats.createToken(userId, { name: 'EvoPath Android', durationValue: 90, durationUnit: 'days' });
    const device = await healthSync.register(userId, { installationId, name: 'Pixel' }, { kind: 'pat', tokenId: first.id });

    // Same PAT again: nothing revoked, link unchanged.
    await healthSync.register(userId, { installationId, name: 'Pixel' }, { kind: 'pat', tokenId: first.id });
    expect(await pats.validateToken(first.token)).not.toBeNull();
    expect((await client.healthSyncDevice.findUniqueOrThrow({ where: { id: device.id } })).patId).toBe(first.id);

    // A session (JWT) caller leaves the link and the token alone.
    await healthSync.register(userId, { installationId, name: 'Pixel' }, { kind: 'jwt' });
    expect(await pats.validateToken(first.token)).not.toBeNull();
    expect((await client.healthSyncDevice.findUniqueOrThrow({ where: { id: device.id } })).patId).toBe(first.id);

    // New PAT: the old one is revoked, the new one linked and live.
    const second = await pats.createToken(userId, { name: 'EvoPath Android', durationValue: 90, durationUnit: 'days' });
    const again = await healthSync.register(userId, { installationId, name: 'Pixel' }, { kind: 'pat', tokenId: second.id });
    expect(again).toMatchObject({ id: device.id, tokenExpiresAt: second.expiresAt });
    expect(await pats.validateToken(first.token)).toBeNull();
    expect(await pats.validateToken(second.token)).not.toBeNull();
    expect((await client.healthSyncDevice.findUniqueOrThrow({ where: { id: device.id } })).patId).toBe(second.id);
  });

  it('keeps the newest 200 runs and 20 reports per device', async () => {
    const userId = await makeUser('retention');
    const deviceId = await makeDevice(userId);
    const other = await makeDevice(userId, 'Other');
    const old = (i: number) => new Date(Date.now() - (300 - i) * 60_000);
    await client.healthSyncRun.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        deviceId,
        userId,
        trigger: 'periodic' as const,
        status: 'ok' as const,
        startedAt: old(i),
        finishedAt: old(i),
        createdAt: old(i),
      })),
    });
    await client.healthSyncRun.create({
      data: { deviceId: other, userId, trigger: 'periodic', status: 'ok', startedAt: old(0), finishedAt: old(0), createdAt: old(0) },
    });
    await client.healthSyncDiagnosticReport.createMany({
      data: Array.from({ length: 22 }, (_, i) => ({ deviceId, userId, report: { i }, createdAt: old(i) })),
    });

    const { runId } = await healthSync.sync(userId, deviceId, payload(), true);
    const { id: reportId } = await healthSync.uploadDiagnostics(userId, deviceId, { summary: 'latest', report: { checks: [] } });

    expect(await client.healthSyncRun.count({ where: { deviceId } })).toBe(200);
    expect(await client.healthSyncRun.count({ where: { deviceId: other } })).toBe(1);
    const runs = await healthSync.listRuns(userId, deviceId, 5);
    expect(runs[0].id).toBe(runId);

    expect(await client.healthSyncDiagnosticReport.count({ where: { deviceId } })).toBe(20);
    const reports = await healthSync.listDiagnostics(userId, deviceId, 20);
    expect(reports[0]).toMatchObject({ id: reportId, summary: 'latest' });
    expect(reports[0]).not.toHaveProperty('report');
  });

  it("decides the allowed days in the user's own time zone", async () => {
    const userId = await makeUser('zone');
    await client.healthProfile.create({ data: { userId, timeZone: 'Pacific/Kiritimati' } });
    const deviceId = await makeDevice(userId);
    const local = localDateInZone(new Date(), 'Pacific/Kiritimati');

    const ok = await healthSync.sync(userId, deviceId, payload({ entries: [steps(addDays(local, 1), 10)] }), true);
    expect(ok.created).toBe(1);
    await expect(
      healthSync.sync(userId, deviceId, payload({ entries: [steps(addDays(local, 2), 10)] }), true),
    ).rejects.toMatchObject({ response: { details: { reason: 'ENTRY_DATE_OUT_OF_RANGE', path: 'entries.0.occurredOn' } } });
    expect((await healthSync.get(userId, deviceId)).userTimezone).toBe('Pacific/Kiritimati');
    expect(toDbDate(local)).toBeInstanceOf(Date);
  });
});
