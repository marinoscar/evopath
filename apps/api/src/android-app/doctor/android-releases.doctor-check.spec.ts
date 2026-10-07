import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { AndroidReleasesDoctorCheck, decideAndroidReleases } from './android-releases.doctor-check';

const CURRENT = { packageName: 'com.evopath.android', versionName: '0.3.0', versionCode: 3 };

describe('android.releases doctor check', () => {
  describe('decideAndroidReleases', () => {
    it('skips when no device is paired, release or not', () => {
      expect(decideAndroidReleases({ activeDevices: 0, current: null, devicesBehind: 0 }).status).toBe('skip');
      expect(decideAndroidReleases({ activeDevices: 0, current: CURRENT, devicesBehind: 0 }).status).toBe('skip');
    });

    it('warns when devices are paired but nothing is published, naming the remedy', () => {
      const outcome = decideAndroidReleases({ activeDevices: 2, current: null, devicesBehind: 0 });

      expect(outcome.status).toBe('warn');
      expect(outcome.remedy).toContain('/admin/settings/android');
    });

    it('passes with a current release, counting devices on older builds', () => {
      const outcome = decideAndroidReleases({ activeDevices: 3, current: CURRENT, devicesBehind: 1 });

      expect(outcome.status).toBe('pass');
      expect(outcome.data).toEqual({ activeDevices: 3, current: 3, devicesBehind: 1 });
    });
  });

  describe('AndroidReleasesDoctorCheck', () => {
    function check(prisma: Record<string, unknown>) {
      return new AndroidReleasesDoctorCheck(new DoctorCheckRegistry(), prisma as never);
    }

    it('counts devices of the current package below its versionCode', async () => {
      const count = jest.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(2);
      const outcome = await check({
        healthSyncDevice: { count },
        androidAppRelease: { findFirst: jest.fn().mockResolvedValue(CURRENT) },
      }).run();

      expect(outcome).toMatchObject({ status: 'pass', data: { activeDevices: 4, devicesBehind: 2 } });
      expect(count).toHaveBeenLastCalledWith({
        where: { status: 'active', packageName: 'com.evopath.android', appVersionCode: { lt: 3 } },
      });
    });

    it('fails, without throwing, when the database cannot be read', async () => {
      const outcome = await check({
        healthSyncDevice: { count: jest.fn().mockRejectedValue(new Error('down')) },
        androidAppRelease: { findFirst: jest.fn().mockResolvedValue(null) },
      }).run();

      expect(outcome).toMatchObject({ status: 'fail', error: 'down' });
    });
  });
});
