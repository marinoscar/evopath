import { AndroidAppService } from './android-app.service';

const SHA = Array.from({ length: 32 }, () => 'AB').join(':');

function setup(stored: unknown, groups: unknown[] = []) {
  const prisma = {
    systemSettings: {
      findUnique: jest.fn().mockResolvedValue(stored === undefined ? null : { value: stored }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    healthSyncDevice: { groupBy: jest.fn().mockResolvedValue(groups) },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };

  return { prisma, service: new AndroidAppService(prisma as never) };
}

describe('AndroidAppService', () => {
  it('reads nothing stored as no trusted apps', async () => {
    await expect(setup(undefined).service.getTrustedApps()).resolves.toEqual([]);
  });

  it('reads a malformed stored value as no trusted apps instead of throwing', async () => {
    await expect(setup({ trustedApps: [{ packageName: 'x' }] }).service.getTrustedApps()).resolves.toEqual([]);
    await expect(setup(null).service.getTrustedApps()).resolves.toEqual([]);
  });

  it('merges reported groups whose fingerprints differ only in case, summing devices and keeping the latest sighting', async () => {
    const { service } = setup(undefined, [
      { packageName: 'com.example.app', signingSha256: SHA, _count: { _all: 1 }, _max: { lastSeenAt: new Date('2026-09-01T00:00:00Z') } },
      { packageName: 'com.example.app', signingSha256: SHA.toLowerCase(), _count: { _all: 2 }, _max: { lastSeenAt: new Date('2026-09-02T00:00:00Z') } },
      { packageName: 'com.other.app', signingSha256: SHA, _count: { _all: 5 }, _max: { lastSeenAt: null } },
    ]);

    await expect(service.getReportedApps([{ packageName: 'com.example.app', sha256: SHA }])).resolves.toEqual([
      { packageName: 'com.other.app', sha256: SHA, deviceCount: 5, lastSeenAt: null, trusted: false },
      { packageName: 'com.example.app', sha256: SHA, deviceCount: 3, lastSeenAt: '2026-09-02T00:00:00.000Z', trusted: true },
    ]);
  });

  it('audits which pairs a save added and removed', async () => {
    const before = { packageName: 'com.example.old', sha256: SHA };
    const after = { packageName: 'com.example.app', sha256: SHA };
    const { prisma, service } = setup({ trustedApps: [before] });

    await service.replace({ trustedApps: [after] }, 'user-1');

    expect(prisma.systemSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'android_app' },
        create: { key: 'android_app', value: { trustedApps: [after] }, updatedByUserId: 'user-1' },
      }),
    );
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'android_app.trusted_apps.updated',
        meta: { count: 1, added: [after], removed: [before] },
      }),
    });
  });
});
