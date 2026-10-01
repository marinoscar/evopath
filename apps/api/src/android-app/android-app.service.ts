import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  ANDROID_APP_SETTINGS_KEY,
  ANDROID_APP_TRUSTED_APPS_UPDATED_ACTION,
  androidAppSettingsValueSchema,
  buildAssetLinks,
  MAX_TRUSTED_ANDROID_APPS,
  type AssetLinkStatement,
  type TrustedAndroidApp,
  trustedAppKey,
} from './android-app.schema';
import type { AndroidAppResponse, ReportedAndroidApp, UpdateAndroidAppInput } from './dto/android-app.dto';

// =============================================================================
// AndroidAppService (issue #279, epic #276)
// =============================================================================
//
// Owns the `android_app` system_settings row (the trusted apps), derives the
// Digital Asset Links document from it, and reads which apps paired devices
// actually report (`health_sync_devices.package_name` / `signing_sha256`,
// written by the health-sync module when a device pairs or syncs).
//
// A MALFORMED STORED VALUE READS AS "NOTHING TRUSTED" rather than throwing:
// the public assetlinks route must keep answering, and the admin page must stay
// usable so the list can be saved again (the trap `system-settings.service.ts`
// describes). The problem is logged.
// =============================================================================

@Injectable()
export class AndroidAppService {
  private readonly logger = new Logger(AndroidAppService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The stored trusted apps; `[]` when nothing is stored or the row does not validate. */
  async getTrustedApps(): Promise<TrustedAndroidApp[]> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: ANDROID_APP_SETTINGS_KEY },
    });

    if (!row) return [];

    const parsed = androidAppSettingsValueSchema.safeParse(row.value);
    if (!parsed.success) {
      this.logger.warn(
        `Stored ${ANDROID_APP_SETTINGS_KEY} settings do not validate; treating as no trusted apps ` +
          `(${parsed.error.issues.length} issue(s)). Save the list again in Admin → Settings → Android app.`,
      );
      return [];
    }

    return parsed.data.trustedApps;
  }

  /** The body of `/.well-known/assetlinks.json`. */
  async getAssetLinks(): Promise<AssetLinkStatement[]> {
    return buildAssetLinks(await this.getTrustedApps());
  }

  /**
   * Distinct (packageName, sha256) pairs reported by ACTIVE devices, with how
   * many devices report each and when one was last seen. Fingerprints are
   * compared and returned uppercase, so a device reporting lowercase hex
   * lands in the same row. Most devices first, then by package name.
   */
  async getReportedApps(trusted: readonly TrustedAndroidApp[] = []): Promise<ReportedAndroidApp[]> {
    const groups = await this.prisma.healthSyncDevice.groupBy({
      by: ['packageName', 'signingSha256'],
      where: {
        status: 'active',
        packageName: { not: null },
        signingSha256: { not: null },
      },
      _count: { _all: true },
      _max: { lastSeenAt: true },
    });

    const trustedKeys = new Set(trusted.map((app) => trustedAppKey(app.packageName, app.sha256)));
    const merged = new Map<string, { packageName: string; sha256: string; deviceCount: number; lastSeenAt: Date | null }>();

    for (const group of groups ?? []) {
      if (!group.packageName || !group.signingSha256) continue;

      const sha256 = group.signingSha256.trim().toUpperCase();
      const key = trustedAppKey(group.packageName, sha256);
      const lastSeenAt = group._max?.lastSeenAt ?? null;
      const count = group._count?._all ?? 0;
      const existing = merged.get(key);

      if (existing) {
        existing.deviceCount += count;
        if (lastSeenAt && (!existing.lastSeenAt || lastSeenAt > existing.lastSeenAt)) {
          existing.lastSeenAt = lastSeenAt;
        }
      } else {
        merged.set(key, { packageName: group.packageName, sha256, deviceCount: count, lastSeenAt });
      }
    }

    return [...merged.entries()]
      .map(([key, app]) => ({
        packageName: app.packageName,
        sha256: app.sha256,
        deviceCount: app.deviceCount,
        lastSeenAt: app.lastSeenAt ? app.lastSeenAt.toISOString() : null,
        trusted: trustedKeys.has(key),
      }))
      .sort((a, b) => b.deviceCount - a.deviceCount || a.packageName.localeCompare(b.packageName) || a.sha256.localeCompare(b.sha256));
  }

  /** `GET /api/admin/android-app`. */
  async describe(): Promise<AndroidAppResponse> {
    const trustedApps = await this.getTrustedApps();
    const reportedApps = await this.getReportedApps(trustedApps);

    return {
      trustedApps,
      reportedApps,
      assetLinks: buildAssetLinks(trustedApps),
    };
  }

  /**
   * Adds (packageName, sha256) to the trusted apps when absent (issue #285:
   * making an uploaded release current trusts its signing key, so the app it
   * installs opens without a URL bar). Audited like a save. Returns whether it
   * was added; false when already trusted, or when the list is full (logged,
   * the administrator must make room by hand).
   */
  async ensureTrusted(app: TrustedAndroidApp, userId: string): Promise<boolean> {
    const before = await this.getTrustedApps();
    const key = trustedAppKey(app.packageName, app.sha256);
    if (before.some((existing) => trustedAppKey(existing.packageName, existing.sha256) === key)) return false;

    if (before.length >= MAX_TRUSTED_ANDROID_APPS) {
      this.logger.warn(
        `Not trusting ${app.packageName}: the trusted apps list is full (${MAX_TRUSTED_ANDROID_APPS}). ` +
          'Remove an entry in Admin → Settings → Android app.',
      );
      return false;
    }

    await this.replace(
      { trustedApps: [...before, { packageName: app.packageName, sha256: app.sha256.toUpperCase() }] },
      userId,
    );
    return true;
  }

  /** `PUT /api/admin/android-app` — replace the list, audit the change, return the new state. */
  async replace(input: UpdateAndroidAppInput, userId: string): Promise<AndroidAppResponse> {
    const before = await this.getTrustedApps();
    const next = input.trustedApps;
    const value = { trustedApps: next } as unknown as Prisma.InputJsonValue;

    await this.prisma.systemSettings.upsert({
      where: { key: ANDROID_APP_SETTINGS_KEY },
      update: { value, updatedByUserId: userId, version: { increment: 1 } },
      create: { key: ANDROID_APP_SETTINGS_KEY, value, updatedByUserId: userId },
    });

    const beforeKeys = new Set(before.map((app) => trustedAppKey(app.packageName, app.sha256)));
    const nextKeys = new Set(next.map((app) => trustedAppKey(app.packageName, app.sha256)));

    // Package names and certificate fingerprints are public by design (they
    // are what assetlinks.json publishes), so the audit row names them.
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: ANDROID_APP_TRUSTED_APPS_UPDATED_ACTION,
        targetType: 'system_settings',
        targetId: ANDROID_APP_SETTINGS_KEY,
        meta: {
          count: next.length,
          added: next.filter((app) => !beforeKeys.has(trustedAppKey(app.packageName, app.sha256))),
          removed: before.filter((app) => !nextKeys.has(trustedAppKey(app.packageName, app.sha256))),
        } as unknown as Prisma.InputJsonValue,
      },
    });

    this.logger.log(`Trusted Android apps saved by user ${userId} (${next.length} app(s))`);

    return this.describe();
  }
}
