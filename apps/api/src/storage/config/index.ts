/**
 * Storage configuration barrel (#373, epic #372).
 *
 * The runtime storage configuration: the pure rules that decide whether a
 * deployment has usable object storage, the service that gathers the two halves
 * behind them, and the 503 raised when it does not.
 */

export {
  R2_ENDPOINT_HOST_SUFFIX,
  R2_DEFAULT_REGION,
  S3_COMPATIBLE_DEFAULT_REGION,
  deriveR2Endpoint,
  describeStorageConfig,
  fingerprintStorageConfig,
  resolveStorageConfig,
  MISSING_STORAGE_CONFIG_FIELDS,
} from './storage-config';
export type {
  MissingStorageConfigField,
  ResolvedStorageConfig,
  StorageConfigResolution,
} from './storage-config';
export {
  StorageConfigService,
  STORAGE_POLICY_CACHE_MS,
} from './storage-config.service';
export {
  StorageNotConfiguredError,
  STORAGE_SETTINGS_PATH,
} from './storage-not-configured.error';
export type { StorageNotConfiguredReason } from './storage-not-configured.error';

// ---------------------------------------------------------------------------
// The admin surface (#375, epic #372)
// ---------------------------------------------------------------------------
//
// The module, and the one constant a caller outside this folder has any reason
// to hold: the typed confirmation word. Everything else — the controller, the
// three services, the DTO classes — is reached through Nest or through its own
// file; re-exporting a controller from a barrel only invites it to be imported
// somewhere it should not be.

export { StorageConfigModule } from './storage-config.module';
export { STORAGE_SWITCH_CONFIRMATION } from './dto/update-storage-config.dto';
