import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { AndroidAppService } from '../android-app.service';
import type { ReportedAndroidApp } from '../dto/android-app.dto';

export const ANDROID_APP_SETTINGS_PATH = '/admin/settings/android';

/**
 * Pure: judges the reported apps (each already flagged `trusted` against the
 * stored list by `AndroidAppService.getReportedApps`).
 *
 *   - nothing reported → `skip`: no paired device has said which app it runs,
 *     so there is nothing to verify (the Android app is optional);
 *   - every reported pair trusted → `pass`;
 *   - any untrusted pair → `warn`, naming them: Chrome opens that build with a
 *     URL bar because `/.well-known/assetlinks.json` does not vouch for it.
 */
export function decideAndroidAssetLinks(
  reported: readonly ReportedAndroidApp[],
  trustedCount: number,
): DoctorCheckOutcome {
  if (reported.length === 0) {
    return {
      status: 'skip',
      detail: 'No paired Android device has reported its app signature',
      data: { trusted: trustedCount, reported: 0 },
    };
  }

  const untrusted = reported.filter((app) => !app.trusted);
  const data = { trusted: trustedCount, reported: reported.length, untrusted: untrusted.length };

  if (untrusted.length > 0) {
    const listed = untrusted
      .slice(0, 3)
      .map((app) => `${app.packageName} (${app.sha256}, ${app.deviceCount} device(s))`)
      .join('; ');

    return {
      status: 'warn',
      detail:
        `${untrusted.length} reported Android app signature(s) not in assetlinks.json, so the app opens ` +
        `with a URL bar: ${listed}${untrusted.length > 3 ? '; …' : ''}`,
      remedy: `Trust it in Admin → Settings → Android app (${ANDROID_APP_SETTINGS_PATH}).`,
      data,
    };
  }

  return {
    status: 'pass',
    detail: `All ${reported.length} reported Android app signature(s) are trusted in assetlinks.json`,
    data,
  };
}

/** `android` / `android.assetlinks` — every app paired devices run is vouched for by assetlinks.json. */
@Injectable()
export class AndroidAssetLinksDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'android.assetlinks';
  readonly category = 'android';
  readonly label = 'Android app Digital Asset Links';
  readonly settingsPath = ANDROID_APP_SETTINGS_PATH;
  readonly dependsOn = ['db.connection'];

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly androidApp: AndroidAppService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    try {
      const trusted = await this.androidApp.getTrustedApps();
      const reported = await this.androidApp.getReportedApps(trusted);

      return decideAndroidAssetLinks(reported, trusted.length);
    } catch (error) {
      return {
        status: 'fail',
        detail: 'Could not read the trusted and reported Android apps',
        remedy: `Check the database connection, then open ${ANDROID_APP_SETTINGS_PATH}.`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
