import { AndroidAppService } from './android-app.service';

const SHA = Array.from({ length: 32 }, () => 'AB').join(':');

function setup(stored: unknown, groups: unknown[] = [], pushGroups: { platform?: unknown[]; users?: unknown[] } = {}) {
  const prisma = {
    pushSubscription: {
      groupBy: jest.fn().mockImplementation(async (args: { by: string[] }) =>
        args.by[0] === 'platform' ? (pushGroups.platform ?? []) : (pushGroups.users ?? []),
      ),
    },
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
  // #312
  it('counts push subscriptions by platform and distinct Android app users', async () => {
    const { service } = setup(undefined, [], {
      platform: [
        { platform: 'browser', _count: { _all: 4 } },
        { platform: 'android_app', _count: { _all: 3 } },
      ],
      users: [{ userId: 'u1' }, { userId: 'u2' }],
    });

    await expect(service.getPushSubscriptionCounts()).resolves.toEqual({
      androidApp: 3,
      browser: 4,
      androidAppUsers: 2,
    });
  });

  it('describe() includes zero counts when nobody has subscribed', async () => {
    await expect(setup(undefined).service.describe()).resolves.toMatchObject({
      pushSubscriptions: { androidApp: 0, browser: 0, androidAppUsers: 0 },
    });
  });

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

  describe('ensureTrusted (#285)', () => {
    it('adds an absent pair through an audited save', async () => {
      const existing = { packageName: 'com.example.old', sha256: SHA };
      const { prisma, service } = setup({ trustedApps: [existing] });

      await expect(service.ensureTrusted({ packageName: 'com.example.app', sha256: SHA.toLowerCase() }, 'user-1')).resolves.toBe(true);

      expect(prisma.systemSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            value: { trustedApps: [existing, { packageName: 'com.example.app', sha256: SHA }] },
          }),
        }),
      );
      expect(prisma.auditEvent.create).toHaveBeenCalled();
    });

    it('does nothing when the pair is already trusted (in any case)', async () => {
      const { prisma, service } = setup({ trustedApps: [{ packageName: 'com.example.app', sha256: SHA }] });

      await expect(service.ensureTrusted({ packageName: 'com.example.app', sha256: SHA.toLowerCase() }, 'user-1')).resolves.toBe(false);
      expect(prisma.systemSettings.upsert).not.toHaveBeenCalled();
    });

    it('does nothing when the list is full', async () => {
      const full = Array.from({ length: 10 }, (_, i) => ({ packageName: `com.example.app${i}`, sha256: SHA }));
      const { prisma, service } = setup({ trustedApps: full });

      await expect(service.ensureTrusted({ packageName: 'com.example.new', sha256: SHA }, 'user-1')).resolves.toBe(false);
      expect(prisma.systemSettings.upsert).not.toHaveBeenCalled();
    });
  });
});
