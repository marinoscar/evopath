import { DoctorCheckRegistry } from '../../doctor/doctor-check.registry';
import type { AndroidAppService } from '../android-app.service';
import {
  ANDROID_APP_SETTINGS_PATH,
  AndroidAssetLinksDoctorCheck,
  decideAndroidAssetLinks,
} from './android-assetlinks.doctor-check';

const SHA = Array.from({ length: 32 }, () => 'AB').join(':');

const reported = (packageName: string, trusted: boolean, deviceCount = 1) => ({
  packageName,
  sha256: SHA,
  deviceCount,
  lastSeenAt: null,
  trusted,
});

describe('android.assetlinks doctor check', () => {
  describe('decideAndroidAssetLinks', () => {
    it('skips when no device has reported a signature', () => {
      const outcome = decideAndroidAssetLinks([], 2);

      expect(outcome.status).toBe('skip');
      expect(outcome.remedy).toBeUndefined();
      expect(outcome.data).toMatchObject({ trusted: 2, reported: 0 });
    });

    it('passes when every reported pair is trusted', () => {
      const outcome = decideAndroidAssetLinks([reported('com.example.app', true, 3)], 1);

      expect(outcome.status).toBe('pass');
      expect(outcome.data).toMatchObject({ reported: 1, untrusted: 0 });
    });

    it('warns naming each untrusted pair, with the settings page as the remedy', () => {
      const outcome = decideAndroidAssetLinks(
        [reported('com.example.app', true), reported('com.example.app.debug', false, 2)],
        1,
      );

      expect(outcome.status).toBe('warn');
      expect(outcome.detail).toContain('com.example.app.debug');
      expect(outcome.detail).toContain(SHA);
      expect(outcome.detail).not.toContain('com.example.app (');
      expect(outcome.remedy).toContain('Trust it in Admin → Settings → Android app');
      expect(outcome.data).toMatchObject({ reported: 2, untrusted: 1 });
    });

    it('lists at most three untrusted pairs', () => {
      const outcome = decideAndroidAssetLinks(
        ['a.one', 'a.two', 'a.three', 'a.four'].map((name) => reported(name, false)),
        0,
      );

      expect(outcome.detail).not.toContain('a.four');
      expect(outcome.detail).toMatch(/…$/);
    });
  });

  describe('the check', () => {
    const service = (overrides: Partial<Record<'getTrustedApps' | 'getReportedApps', jest.Mock>>) =>
      ({
        getTrustedApps: jest.fn().mockResolvedValue([]),
        getReportedApps: jest.fn().mockResolvedValue([]),
        ...overrides,
      }) as unknown as AndroidAppService;

    it('registers itself under its id with the android category and settings path', () => {
      const registry = new DoctorCheckRegistry();
      const check = new AndroidAssetLinksDoctorCheck(registry, service({}));

      check.onModuleInit();

      expect(registry.get('android.assetlinks')).toBe(check);
      expect(check.category).toBe('android');
      expect(check.settingsPath).toBe(ANDROID_APP_SETTINGS_PATH);
      expect(ANDROID_APP_SETTINGS_PATH).toBe('/admin/settings/android');
    });

    it('judges the reported apps against the stored list, reading only', async () => {
      const trusted = [{ packageName: 'com.example.app', sha256: SHA }];
      const getReportedApps = jest.fn().mockResolvedValue([reported('com.example.app', true)]);
      const check = new AndroidAssetLinksDoctorCheck(
        new DoctorCheckRegistry(),
        service({ getTrustedApps: jest.fn().mockResolvedValue(trusted), getReportedApps }),
      );

      await expect(check.run()).resolves.toMatchObject({ status: 'pass' });
      expect(getReportedApps).toHaveBeenCalledWith(trusted);
    });

    it('reports a failed read as fail with the error, never throwing', async () => {
      const check = new AndroidAssetLinksDoctorCheck(
        new DoctorCheckRegistry(),
        service({ getTrustedApps: jest.fn().mockRejectedValue(new Error('connection refused')) }),
      );

      await expect(check.run()).resolves.toMatchObject({ status: 'fail', error: 'connection refused' });
    });
  });
});
