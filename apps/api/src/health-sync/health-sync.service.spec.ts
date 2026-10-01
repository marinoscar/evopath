import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { createMockPrismaService, type MockPrismaService } from '../../test/mocks/prisma.mock';
import { ACTIVITY_ENTRY_RECORDED_EVENT } from '../activity/activity-events';
import type { HealthProfileService } from '../health-profile/health-profile.service';
import { HEALTH_DATA_CHANGED_EVENT } from '../measurements/health-data-events';
import type { PrismaService } from '../prisma/prisma.service';
import { syncSchema } from './dto/health-sync.dto';
import { HealthSyncService } from './health-sync.service';

const USER = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const PAT = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-01T12:00:00Z');
const TODAY = '2026-10-01';

function deviceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DEVICE,
    userId: USER,
    installationId: '44444444-4444-4444-8444-444444444444',
    name: 'Pixel 9',
    manufacturer: 'Google',
    model: 'Pixel 9',
    androidVersion: '16',
    sdkInt: 36,
    appVersion: '0.1.0',
    healthConnectVersion: null,
    packageName: 'com.evopath.android',
    signingSha256: null,
    timezone: 'America/Costa_Rica',
    patId: PAT,
    status: 'active',
    lastSeenAt: null,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    pat: { expiresAt: new Date('2026-12-30T00:00:00Z'), revokedAt: null },
    ...overrides,
  };
}

function body(extra: Record<string, unknown> = {}, run: Record<string, unknown> = {}) {
  return syncSchema.parse({
    run: { trigger: 'periodic', status: 'ok', startedAt: '2026-10-01T11:59:00Z', finishedAt: '2026-10-01T11:59:30Z', ...run },
    entries: [],
    ...extra,
  });
}

const stepsEntry = { externalId: `steps:${TODAY}`, occurredOn: TODAY, activityKind: 'steps', steps: 4200 };
const restingHr = { externalId: 'hr-1', metricKey: 'resting_hr', value: 58, unit: 'bpm', measuredAt: '2026-10-01T07:00:00Z' };

describe('HealthSyncService', () => {
  let prisma: MockPrismaService;
  let events: { emit: jest.Mock };
  let service: HealthSyncService;

  beforeEach(() => {
    prisma = createMockPrismaService();
    (prisma.$transaction as jest.Mock).mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)));
    (prisma.healthSyncDevice.findFirst as jest.Mock).mockResolvedValue(deviceRow());
    (prisma.healthSyncRun.create as jest.Mock).mockResolvedValue({ id: 'run-1' });
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ inserted: true, owned: null }]);
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(0);
    (prisma.activityEntry.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.sleepSession.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    events = { emit: jest.fn() };
    const healthProfile = { getTimeZone: jest.fn().mockResolvedValue(null) } as unknown as HealthProfileService;
    service = new HealthSyncService(prisma as unknown as PrismaService, healthProfile, events as never);
  });

  describe('register', () => {
    it('links the PAT that authenticated the request and reactivates the device', async () => {
      (prisma.healthSyncDevice.upsert as jest.Mock).mockResolvedValue(deviceRow());
      const view = await service.register(
        USER,
        { installationId: deviceRow().installationId, name: 'Pixel 9' },
        { kind: 'pat', tokenId: PAT },
        NOW,
      );

      const args = (prisma.healthSyncDevice.upsert as jest.Mock).mock.calls[0][0];
      expect(args.where).toEqual({ userId_installationId: { userId: USER, installationId: deviceRow().installationId } });
      expect(args.update).toMatchObject({ status: 'active', patId: PAT, lastSeenAt: NOW });
      expect(args.create).toMatchObject({ userId: USER, patId: PAT });
      expect(view).toMatchObject({ id: DEVICE, tokenExpiresAt: '2026-12-30T00:00:00.000Z', userTimezone: null });
    });

    it('revokes the previously linked PAT when the phone re-pairs with a new one', async () => {
      const NEW_PAT = '55555555-5555-4555-8555-555555555555';
      (prisma.healthSyncDevice.findUnique as jest.Mock).mockResolvedValue({ patId: PAT });
      (prisma.healthSyncDevice.upsert as jest.Mock).mockResolvedValue(deviceRow({ patId: NEW_PAT }));
      await service.register(USER, { installationId: deviceRow().installationId, name: 'Pixel 9' }, { kind: 'pat', tokenId: NEW_PAT }, NOW);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.personalAccessToken.updateMany).toHaveBeenCalledWith({
        where: { id: PAT, userId: USER, revokedAt: null },
        data: { revokedAt: NOW },
      });
      expect((prisma.healthSyncDevice.upsert as jest.Mock).mock.calls[0][0].update).toMatchObject({ patId: NEW_PAT });
    });

    it('revokes nothing when re-registering with the same PAT, a first registration or a JWT', async () => {
      (prisma.healthSyncDevice.upsert as jest.Mock).mockResolvedValue(deviceRow());
      const input = { installationId: deviceRow().installationId, name: 'Pixel 9' };

      (prisma.healthSyncDevice.findUnique as jest.Mock).mockResolvedValueOnce({ patId: PAT });
      await service.register(USER, input, { kind: 'pat', tokenId: PAT }, NOW);
      (prisma.healthSyncDevice.findUnique as jest.Mock).mockResolvedValueOnce(null);
      await service.register(USER, input, { kind: 'pat', tokenId: PAT }, NOW);
      (prisma.healthSyncDevice.findUnique as jest.Mock).mockResolvedValueOnce({ patId: null });
      await service.register(USER, input, { kind: 'pat', tokenId: PAT }, NOW);
      await service.register(USER, input, { kind: 'jwt' }, NOW);

      expect(prisma.personalAccessToken.updateMany).not.toHaveBeenCalled();
      expect(prisma.healthSyncDevice.findUnique).toHaveBeenCalledTimes(3); // not for the JWT caller
    });

    it('leaves the link alone for a session (JWT) caller', async () => {
      (prisma.healthSyncDevice.upsert as jest.Mock).mockResolvedValue(deviceRow({ patId: null, pat: null }));
      const view = await service.register(USER, { installationId: deviceRow().installationId, name: 'Pixel' }, { kind: 'jwt' }, NOW);

      const args = (prisma.healthSyncDevice.upsert as jest.Mock).mock.calls[0][0];
      expect(args.update).not.toHaveProperty('patId');
      expect(args.create).not.toHaveProperty('patId');
      expect(view.tokenExpiresAt).toBeNull();
    });
  });

  it('reports no token expiry once the linked PAT is revoked', async () => {
    (prisma.healthSyncDevice.findFirst as jest.Mock).mockResolvedValue(
      deviceRow({ pat: { expiresAt: new Date('2026-12-30T00:00:00Z'), revokedAt: NOW } }),
    );
    expect((await service.get(USER, DEVICE)).tokenExpiresAt).toBeNull();
  });

  describe('sync', () => {
    it('refuses measurements or sleep without health_data:write before touching the database', async () => {
      await expect(service.sync(USER, DEVICE, body({ measurements: [restingHr] }), false, NOW)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.healthSyncDevice.findFirst).not.toHaveBeenCalled();
    });

    it("is a 404 for another user's device and a 409 DEVICE_REVOKED for a revoked one", async () => {
      (prisma.healthSyncDevice.findFirst as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.sync(USER, DEVICE, body(), true, NOW)).rejects.toBeInstanceOf(NotFoundException);

      (prisma.healthSyncDevice.findFirst as jest.Mock).mockResolvedValueOnce(deviceRow({ status: 'revoked' }));
      const error = await service.sync(USER, DEVICE, body(), true, NOW).catch((caught) => caught);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse().details.reason).toBe('DEVICE_REVOKED');
    });

    it('records the run even when nothing was sent, trims retention and stamps the device', async () => {
      const result = await service.sync(
        USER,
        DEVICE,
        body({}, { status: 'failed', errorCode: 'HC_UNAVAILABLE', errorMessage: 'Health Connect missing', timezone: 'Europe/Madrid' }),
        true,
        NOW,
      );

      expect(result).toMatchObject({ runId: 'run-1', created: 0, updated: 0, deleted: 0 });
      expect(prisma.healthSyncRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ deviceId: DEVICE, userId: USER, status: 'failed', errorCode: 'HC_UNAVAILABLE', recordsRead: 0 }),
      });
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1); // runs trimmed
      expect(prisma.healthSyncDevice.update).toHaveBeenCalledWith({
        where: { id: DEVICE },
        data: {
          lastSeenAt: NOW,
          lastSyncAt: NOW,
          lastSyncStatus: 'failed',
          lastError: 'Health Connect missing',
          timezone: 'Europe/Madrid',
        },
      });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('counts each upsert outcome and emits after commit only for real changes', async () => {
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([{ inserted: true, owned: null }]) // entry a: created
        .mockResolvedValueOnce([{ inserted: false, owned: true }]) // entry b: updated
        .mockResolvedValueOnce([{ inserted: null, owned: true }]) // entry c: unchanged
        .mockResolvedValueOnce([{ inserted: null, owned: false }]) // entry d: a manual row owns the key
        .mockResolvedValueOnce([{ inserted: null, owned: false }]); // reading: the user deleted it

      const entries = ['a', 'b', 'c', 'd'].map((id) => ({ ...stepsEntry, externalId: id }));
      const result = await service.sync(USER, DEVICE, body({ entries, measurements: [restingHr] }), true, NOW);

      expect(result).toMatchObject({ created: 1, updated: 1, unchanged: 1, skipped: 1 });
      expect(result.measurements).toMatchObject({ created: 0, updated: 0, skipped: 1 });
      expect(events.emit).toHaveBeenCalledWith(ACTIVITY_ENTRY_RECORDED_EVENT, expect.objectContaining({ userId: USER }));
      expect(events.emit).not.toHaveBeenCalledWith(HEALTH_DATA_CHANGED_EVENT, expect.anything());
    });

    it('emits nothing when a re-sent payload changed nothing', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ inserted: null, owned: true }]);
      await service.sync(USER, DEVICE, body({ entries: [stepsEntry], measurements: [restingHr] }), true, NOW);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('emits health.data.changed when a reading was written', async () => {
      await service.sync(USER, DEVICE, body({ measurements: [restingHr] }), true, NOW);
      expect(events.emit).toHaveBeenCalledWith(HEALTH_DATA_CHANGED_EVENT, { userId: USER, source: 'measurements' });
    });

    it('reconciles only the synced types, scoped to this device and the window', async () => {
      const window = { from: '2026-09-25', to: TODAY };
      await service.sync(
        USER,
        DEVICE,
        body({ window, entries: [stepsEntry] }, { details: { syncedTypes: ['steps', 'blood_pressure'] } }),
        true,
        NOW,
      );

      expect(prisma.activityEntry.deleteMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          userId: USER,
          provider: `health_connect:${DEVICE}`,
          source: 'integration',
          activityKind: { in: ['steps'] },
          externalId: { notIn: [`steps:${TODAY}`] },
          occurredOn: { gte: new Date('2026-09-25T00:00:00Z'), lte: new Date('2026-10-01T00:00:00Z') },
        }),
      });
      expect(prisma.measurement.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          externalProvider: `health_connect:${DEVICE}`,
          metricKey: { in: ['bp_systolic', 'bp_diastolic'] },
          deletedAt: null,
          supersededAt: null,
        }),
        data: { deletedAt: NOW },
      });
      expect(prisma.sleepSession.deleteMany).not.toHaveBeenCalled();
    });

    it('never reconciles measurements or sleep for a caller without health_data:write', async () => {
      await service.sync(
        USER,
        DEVICE,
        body({ window: { from: '2026-09-25', to: TODAY } }, { details: { syncedTypes: ['steps', 'weight', 'sleep'] } }),
        false,
        NOW,
      );
      expect(prisma.activityEntry.deleteMany).toHaveBeenCalled();
      expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
      expect(prisma.sleepSession.deleteMany).not.toHaveBeenCalled();
    });

    it('does not reconcile a partial run', async () => {
      await service.sync(
        USER,
        DEVICE,
        body({ window: { from: '2026-09-25', to: TODAY } }, { status: 'partial', details: { syncedTypes: ['steps'] } }),
        true,
        NOW,
      );
      expect(prisma.activityEntry.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('unpair', () => {
    it('revokes the device and its PAT in one transaction, keeping the imported rows by default', async () => {
      await service.unpair(USER, DEVICE, false, NOW);
      expect(prisma.healthSyncDevice.update).toHaveBeenCalledWith({ where: { id: DEVICE }, data: { status: 'revoked' } });
      expect(prisma.personalAccessToken.updateMany).toHaveBeenCalledWith({
        where: { id: PAT, userId: USER, revokedAt: null },
        data: { revokedAt: NOW },
      });
      expect(prisma.activityEntry.deleteMany).not.toHaveBeenCalled();
    });

    it('with deleteEntries removes what this device imported', async () => {
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      await service.unpair(USER, DEVICE, true, NOW);
      const provider = `health_connect:${DEVICE}`;
      expect(prisma.activityEntry.deleteMany).toHaveBeenCalledWith({ where: { userId: USER, provider, source: 'integration' } });
      expect(prisma.sleepSession.deleteMany).toHaveBeenCalledWith({ where: { userId: USER, provider } });
      expect(prisma.measurement.updateMany).toHaveBeenCalledWith({
        where: { userId: USER, externalProvider: provider, supersededAt: null, deletedAt: null },
        data: { deletedAt: NOW },
      });
      expect(events.emit).toHaveBeenCalledWith(HEALTH_DATA_CHANGED_EVENT, { userId: USER, source: 'measurements' });
    });
  });

  it('diagnostics: stores the report and trims to the newest 20, also for a revoked device', async () => {
    (prisma.healthSyncDevice.findFirst as jest.Mock).mockResolvedValue(deviceRow({ status: 'revoked' }));
    (prisma.healthSyncDiagnosticReport.create as jest.Mock).mockResolvedValue({ id: 'rep-1', createdAt: NOW });

    expect(await service.uploadDiagnostics(USER, DEVICE, { report: { checks: [] } })).toEqual({
      id: 'rep-1',
      createdAt: NOW.toISOString(),
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
