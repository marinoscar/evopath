import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import type { StorageConfigResolution } from '../storage-config';
import { StorageConfigService } from '../storage-config.service';
import { STORAGE_SETTINGS_PATH } from '../storage-not-configured.error';

/**
 * Pure: judges a resolution. Reports the provider, bucket and region (the
 * settings page shows all three to the same audience) and the NAMES of missing
 * fields — never the access key id or the secret.
 */
export function decideStorageConfig(resolution: StorageConfigResolution): DoctorCheckOutcome {
  if (!resolution.configured) {
    return {
      status: 'fail',
      detail: `Object storage is not configured (${resolution.provider}; missing: ${resolution.missing.join(', ')})`,
      remedy: `Complete the object storage settings at ${STORAGE_SETTINGS_PATH}; uploads, profile images and backups need them.`,
      data: { provider: resolution.provider, missing: resolution.missing.join(',') },
    };
  }

  const { provider, bucket, region } = resolution.config;

  return {
    status: 'pass',
    detail: `${provider} bucket "${bucket}" in ${region}`,
    data: { provider, bucket, region },
  };
}

/** `storage` / `storage.config` — the active object-storage configuration is complete. */
@Injectable()
export class StorageConfigDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'storage.config';
  readonly category = 'storage';
  readonly label = 'Object storage configuration';
  readonly settingsPath = STORAGE_SETTINGS_PATH;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly storageConfig: StorageConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    try {
      return decideStorageConfig(await this.storageConfig.resolve({ fresh: true }));
    } catch (error) {
      return {
        status: 'fail',
        detail: 'The object storage configuration could not be read',
        remedy:
          `Check SECRETS_ENCRYPTION_KEY is the key the storage credential was saved with, then re-save ` +
          `the credential at ${STORAGE_SETTINGS_PATH}.`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
