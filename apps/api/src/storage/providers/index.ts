/**
 * Storage Providers Barrel Export
 * Centralizes imports for storage provider abstractions and implementations
 */

export { STORAGE_PROVIDER, StorageProvider } from './storage-provider.interface';
export {
  StorageUploadOptions,
  StorageUploadResult,
  UploadPart,
  SignedUrlOptions,
  SignedPutUrlOptions,
  MultipartUploadInit,
} from './storage-provider.types';
export { StorageProvidersModule } from './storage-providers.module';
export { ResolvingStorageProvider } from './resolving-storage.provider';
export {
  S3StorageProvider,
  DEFAULT_S3_PART_SIZE,
  buildS3ClientConfig,
} from './s3/s3-storage.provider';
export type { S3StorageProviderConfig } from './s3/s3-storage.provider';
