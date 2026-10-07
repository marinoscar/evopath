// =============================================================================
// TELEMETRY_SETTINGS_STORE adapter (marinoscar/EnterpriseAppBase#703, PP-4.2)
// =============================================================================
//
// The `telemetry` namespace goes through `SystemSettingsService` (its cached
// validation, its If-Match re-check and its `system_settings:patch` audit
// row), exactly as before the move. The provenance read and telemetry's own
// keyed row use the same Prisma calls the telemetry services made.
//
// LEAST PRIVILEGE: `readRow`/`writeRow`/`deleteRow` accept only the keys
// telemetry owns (`TELEMETRY_OWNED_ROW_KEYS`); any other key is a programming
// error and throws before the database is touched.
// =============================================================================

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TelemetrySettings } from '@marinoscar/platform-contract/telemetry';

import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import type {
  TelemetryFeatureFlag,
  TelemetrySettingsProvenance,
  TelemetrySettingsRow,
  TelemetrySettingsStore,
} from '@marinoscar/platform-api/telemetry';

/** The keyed `system_settings` rows telemetry may read and write. */
export const TELEMETRY_OWNED_ROW_KEYS: readonly string[] = ['telemetry_connection'];

const PROVENANCE_SELECT = {
  version: true,
  updatedAt: true,
  updatedByUser: { select: { id: true, email: true } },
} as const;

@Injectable()
export class TelemetrySettingsStoreAdapter implements TelemetrySettingsStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  getTelemetryPolicy(): Promise<TelemetrySettings> {
    return this.systemSettings.getTelemetryPolicy();
  }

  async replaceTelemetryPolicy(next: TelemetrySettings, actorUserId: string, expectedVersion?: number): Promise<void> {
    await this.systemSettings.patchSettings({ telemetry: next }, actorUserId, expectedVersion);
  }

  async readPolicyProvenance(): Promise<TelemetrySettingsProvenance | null> {
    const row = await this.prisma.systemSettings.findUnique({ where: { key: 'global' }, select: PROVENANCE_SELECT });

    return row ? { version: row.version, updatedAt: row.updatedAt, updatedBy: row.updatedByUser } : null;
  }

  async readRow(key: string): Promise<TelemetrySettingsRow | null> {
    assertOwnedKey(key);
    const row = await this.prisma.systemSettings.findUnique({
      where: { key },
      select: { value: true, ...PROVENANCE_SELECT },
    });

    return row
      ? { value: row.value, version: row.version, updatedAt: row.updatedAt, updatedBy: row.updatedByUser }
      : null;
  }

  async writeRow(key: string, value: unknown, actorUserId: string): Promise<void> {
    assertOwnedKey(key);
    await this.prisma.systemSettings.upsert({
      where: { key },
      update: {
        value: value as Prisma.InputJsonValue,
        updatedByUserId: actorUserId,
        version: { increment: 1 },
      },
      create: {
        key,
        value: value as Prisma.InputJsonValue,
        updatedByUserId: actorUserId,
      },
    });
  }

  async deleteRow(key: string): Promise<void> {
    assertOwnedKey(key);
    await this.prisma.systemSettings.deleteMany({ where: { key } });
  }

  async readFeatureFlag(flag: TelemetryFeatureFlag): Promise<boolean> {
    switch (flag) {
      case 'ai':
        return (await this.systemSettings.getAiPolicy()).enabled;
      case 'maintenanceMode':
        return (await this.systemSettings.getMaintenancePolicy()).enabled;
      case 'databaseBackup':
        return (await this.systemSettings.getDatabaseBackupPolicy()).enabled;
      case 'browserNotifications':
        return (await this.systemSettings.getNotificationsPolicy()).browserEnabled;
      case 'nodeJobSecretBroker':
        return (await this.systemSettings.getNodesPolicy()).jobSecretBrokerEnabled;
      default: {
        const unknown: never = flag;
        throw new Error(`Unknown telemetry feature flag "${String(unknown)}".`);
      }
    }
  }
}

function assertOwnedKey(key: string): void {
  if (!TELEMETRY_OWNED_ROW_KEYS.includes(key)) {
    throw new Error(`Telemetry may not access the system settings row "${key}".`);
  }
}
