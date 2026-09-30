import { Inject, Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '../../../doctor/doctor-check.interface';
import { DoctorCheckRegistry } from '../../../doctor/doctor-check.registry';
import { STORAGE_PROVIDER, StorageProvider } from '../../providers/storage-provider.interface';
import {
  BUCKET_FORBIDDEN_CODES,
  BUCKET_MISSING_CODES,
  BUCKET_REGION_CODES,
  CREDENTIAL_REJECTION_CODES,
  describeStorageError,
} from '../storage-probe.support';
import { STORAGE_SETTINGS_PATH } from '../storage-not-configured.error';

/**
 * A key nothing ever writes. `exists()` on it is a single `HeadObject`: it
 * proves the endpoint answers and the credential is accepted, and it writes
 * nothing.
 *
 * ⚠ READ-ONLY BY DESIGN, and therefore weaker than the settings page's "Test
 * connection" (`StorageConnectionTestService`), which round-trips a probe
 * object and audits the attempt. A `HeadObject` on a missing key can answer
 * `404` whether or not the BUCKET exists, so a pass here means "the store
 * answered without refusing us", not "uploads will work". The remedy on every
 * failure points at the full test for exactly that reason.
 */
export const STORAGE_DOCTOR_PROBE_KEY = '.doctor/read-only-probe-never-written';

export function decideStorageProbeError(error: unknown): DoctorCheckOutcome {
  // No secret is passed for redaction: the probe never holds one — the SDK
  // error message carries the request, not the credential.
  const described = describeStorageError(error, null);
  const base = { error: described.message, data: { httpStatus: described.status, code: described.code || null } };
  const fullTest = `Run "Test connection" at ${STORAGE_SETTINGS_PATH} for a full diagnosis.`;

  if (described.unreachable) {
    return {
      ...base,
      status: 'fail',
      detail: 'The object storage endpoint did not answer',
      remedy: `Check the endpoint URL and that the API can reach it (DNS, firewall, TLS). ${fullTest}`,
    };
  }

  if (CREDENTIAL_REJECTION_CODES.has(described.code)) {
    return {
      ...base,
      status: 'fail',
      detail: `The object store rejected the credential (${described.code})`,
      remedy: `Re-enter the access key id and secret access key at ${STORAGE_SETTINGS_PATH}.`,
    };
  }

  if (BUCKET_MISSING_CODES.has(described.code)) {
    return {
      ...base,
      status: 'fail',
      detail: 'The configured bucket does not exist at this endpoint',
      remedy: `Create the bucket, or correct its name and region at ${STORAGE_SETTINGS_PATH}.`,
    };
  }

  if (BUCKET_REGION_CODES.has(described.code)) {
    return {
      ...base,
      status: 'fail',
      detail: `The bucket is in a different region than configured (${described.code})`,
      remedy: `Correct the region at ${STORAGE_SETTINGS_PATH}.`,
    };
  }

  if (BUCKET_FORBIDDEN_CODES.has(described.code)) {
    return {
      ...base,
      status: 'fail',
      detail: `The credential may not read the bucket (${described.code})`,
      remedy: `Grant the key s3:GetObject and s3:ListBucket on the bucket. ${fullTest}`,
    };
  }

  return {
    ...base,
    status: 'fail',
    detail: `The object store answered with an error${described.code ? ` (${described.code})` : ''}`,
    remedy: fullTest,
  };
}

/** `storage` / `storage.bucket` — the configured store answers a read. */
@Injectable()
export class StorageBucketDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'storage.bucket';
  readonly category = 'storage';
  readonly label = 'Object storage reachability';
  readonly settingsPath = STORAGE_SETTINGS_PATH;
  readonly dependsOn = ['storage.config'];

  constructor(
    private readonly registry: DoctorCheckRegistry,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const started = Date.now();

    try {
      await this.storage.exists(STORAGE_DOCTOR_PROBE_KEY);
      const latencyMs = Date.now() - started;

      return {
        status: 'pass',
        detail: `The object store answered a read in ${latencyMs} ms`,
        data: { latencyMs },
      };
    } catch (error) {
      return decideStorageProbeError(error);
    }
  }
}
