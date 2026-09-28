import { Module } from '@nestjs/common';

import { CredentialsModule } from '../../credentials/credentials.module';
import { SettingsModule } from '../../settings/settings.module';
import { StorageConfigService } from '../config/storage-config.service';
import { ResolvingStorageProvider } from './resolving-storage.provider';
import { STORAGE_PROVIDER } from './storage-provider.interface';

/**
 * Storage Providers Module
 * Provides dependency injection for storage provider implementations
 *
 * `STORAGE_PROVIDER` resolves to `ResolvingStorageProvider` (#373, epic #372),
 * which reads the `storage` system-settings namespace and the credential store
 * PER CALL and delegates to a client built for whatever it finds. The token,
 * the interface and the export list are unchanged, so the six modules that
 * import this one — and the nine consumers that inject the token — are
 * unaffected by the switch.
 *
 * WHY `useClass` STILL, AND NOT `useFactory`. A factory would resolve the
 * configuration once, at boot: no live reconfiguration, and a fresh install
 * with no storage configured could not start. The reasoning is set out in full
 * at the top of `resolving-storage.provider.ts`.
 *
 * TWO NEW IMPORTS, AND NO CYCLE:
 *
 *   * `SettingsModule` for `SystemSettingsService.getStoragePolicy()`. It is
 *     safe because `SettingsModule` is a LEAF — it imports nothing — which is
 *     the property `profile-image.module.ts` already documents and relies on
 *     ("`StorageModule` -> `JobsModule` -> `SettingsModule` already exists, so
 *     settings importing storage would be a cycle"). Nothing here makes
 *     settings depend on storage, and nothing may: if a future change needs
 *     `SettingsModule` to read storage, the fix is a third module, never a
 *     `forwardRef` pair.
 *   * `CredentialsModule` for the secret access key. It is deliberately not
 *     `@Global()` — "requiring `imports: [CredentialsModule]` makes every new
 *     consumer a visible line in a diff" — and this line is that diff.
 *
 * `StorageConfigService` IS EXPORTED, and part 3 of #373 is the change that
 * made it so — the one-line change this comment predicted, made where the need
 * became visible. Three services outside this module
 * (`ObjectsService`, `ProfileImageService`, `DatabaseBackupRunnerService`)
 * record the ACTIVE PROVIDER ID onto a row, and until part 3 all three wrote
 * the literal `'s3'`. They now ask `StorageConfigService.activeProvider()`,
 * which is the same settings read the bucket comes from, so a row cannot name
 * one configuration's bucket and another's provider.
 *
 * ⚠ EXPORTED, NOT `@Global()`. A consumer takes it by adding this module to its
 * `imports` — a visible line in a diff — exactly as `CredentialsModule`
 * requires of its own.
 *
 * To add an alternative provider (local filesystem, Azure Blob, etc.), teach
 * `ResolvingStorageProvider.delegateFor` to build it from the resolved
 * configuration's `provider` field.
 */
@Module({
  imports: [SettingsModule, CredentialsModule],
  providers: [
    StorageConfigService,
    {
      provide: STORAGE_PROVIDER,
      useClass: ResolvingStorageProvider,
    },
  ],
  exports: [STORAGE_PROVIDER, StorageConfigService],
})
export class StorageProvidersModule {}
