import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '../../doctor/doctor-check.interface';
import { DoctorCheckRegistry } from '../../doctor/doctor-check.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { ANDROID_APP_SETTINGS_PATH } from './android-assetlinks.doctor-check';

export interface AndroidReleaseFacts {
  /** Active paired devices. */
  activeDevices: number;
  /** The current release, or null when none is published. */
  current: { packageName: string; versionName: string; versionCode: number } | null;
  /** Active devices of the current release's package reporting a lower versionCode. */
  devicesBehind: number;
}

/**
 * Pure (issue #285):
 *
 *   - no active paired device → `skip`: nobody runs the Android app here;
 *   - devices but no current release → `warn`: users cannot download or update
 *     the app from this server (they fall back to the GitHub build);
 *   - otherwise → `pass`, with how many devices run an older build (an
 *     informational count: updating is the user's act, not a fault).
 */
export function decideAndroidReleases(facts: AndroidReleaseFacts): DoctorCheckOutcome {
  if (facts.activeDevices === 0) {
    return {
      status: 'skip',
      detail: 'No Android device is paired',
      data: { activeDevices: 0, current: facts.current?.versionCode ?? null },
    };
  }

  if (!facts.current) {
    return {
      status: 'warn',
      detail: `${facts.activeDevices} Android device(s) are paired but no APK release is published on this server`,
      remedy:
        `Publish one with \`evopathcli android publish\` or upload it in Admin → Settings → Android app ` +
        `(${ANDROID_APP_SETTINGS_PATH}).`,
      data: { activeDevices: facts.activeDevices, current: null },
    };
  }

  return {
    status: 'pass',
    detail:
      `Current release ${facts.current.versionName} (${facts.current.versionCode}); ` +
      `${facts.devicesBehind} of ${facts.activeDevices} paired device(s) run an older build`,
    data: {
      activeDevices: facts.activeDevices,
      current: facts.current.versionCode,
      devicesBehind: facts.devicesBehind,
    },
  };
}

/** `android` / `android.releases` — a hosted APK exists when phones are paired. Read-only. */
@Injectable()
export class AndroidReleasesDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'android.releases';
  readonly category = 'android';
  readonly label = 'Android app releases';
  readonly settingsPath = ANDROID_APP_SETTINGS_PATH;
  readonly dependsOn = ['db.connection'];

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    try {
      const [activeDevices, current] = await Promise.all([
        this.prisma.healthSyncDevice.count({ where: { status: 'active' } }),
        this.prisma.androidAppRelease.findFirst({
          where: { isCurrent: true },
          select: { packageName: true, versionName: true, versionCode: true },
        }),
      ]);
      const devicesBehind = current
        ? await this.prisma.healthSyncDevice.count({
            where: {
              status: 'active',
              packageName: current.packageName,
              appVersionCode: { lt: current.versionCode },
            },
          })
        : 0;

      return decideAndroidReleases({ activeDevices, current: current ?? null, devicesBehind });
    } catch (error) {
      return {
        status: 'fail',
        detail: 'Could not read the Android releases and paired devices',
        remedy: `Check the database connection, then open ${ANDROID_APP_SETTINGS_PATH}.`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
