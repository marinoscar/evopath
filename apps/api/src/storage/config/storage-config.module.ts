import { Module } from '@nestjs/common';

import { CredentialsModule } from '../../credentials/credentials.module';
import { SettingsModule } from '../../settings/settings.module';
import { StorageProvidersModule } from '../providers/storage-providers.module';
import { StorageBucketProvisionService } from './storage-bucket-provision.service';
import { StorageConfigAdminService } from './storage-config-admin.service';
import { StorageConfigController } from './storage-config.controller';
import { StorageConnectionTestService } from './storage-connection-test.service';

// =============================================================================
// StorageConfigModule (issue #375, epic #372)
// =============================================================================
//
// The admin surface for object-storage CONFIGURATION: one controller and the
// three services behind it.
//
// -----------------------------------------------------------------------------
// WHY A NEW MODULE, AND NOT `StorageModule` OR `StorageProvidersModule`
// -----------------------------------------------------------------------------
//
// ⚠ NOT `StorageProvidersModule`, although that is where `StorageConfigService`
// lives and so looks like the natural home. That module is dependency-injection
// infrastructure — it has no controller and its own header says it exists to
// "provide dependency injection for storage provider implementations". Giving it
// an HTTP surface is precisely what `CredentialsModule`'s header argues against
// for the identical case: "the admin UI that eventually needs one adds it in its
// own module, where reviewing it is the point of the diff rather than a detail
// buried in shared infrastructure." A route that hands out object-store
// credentials' masked state and drives `CreateBucket` is exactly the kind of
// route that should be a visible module in `AppModule`'s list.
//
// ⚠ NOT `StorageModule` either, which is the other obvious candidate. That
// module is the OBJECT surface: `ObjectsController`, each route gated on
// `storage:read` (list, get, download) or `storage:write` (upload, metadata,
// delete; `storage:delete_any` widens delete to other users' objects, #516),
// plus the upload pipeline, the cleanup job and the processing chain. It imports `JobsModule` and `ObjectProcessingModule` for that work, and
// a settings page has no use for either. The two surfaces also differ on the one
// axis that matters most here: `StorageModule`'s routes are for EVERY user of
// the application (Viewer holds `storage:read`), and these routes are for the
// one or two people who decide which object store the deployment uses. Folding
// an Admin-only configuration surface into the module every user's uploads go
// through makes the permission boundary a detail of a decorator rather than a
// module you can point at.
//
// -----------------------------------------------------------------------------
// THE THREE IMPORTS, AND WHY NONE OF THEM IS A CYCLE
// -----------------------------------------------------------------------------
//
//   * `StorageProvidersModule` exports `StorageConfigService`, whose
//     `invalidateCache()` the write path must call the instant a save commits.
//     It is a one-way edge: nothing in that module knows this one exists.
//   * `SettingsModule` for `SystemSettingsService` — the `storage` namespace is
//     part of the single `global` settings row, so the write goes through
//     `patchSettings` rather than a hand-rolled upsert (see
//     `storage-config-admin.service.ts` for why that matters). `SettingsModule`
//     is a LEAF: it imports nothing, which is the property
//     `storage-providers.module.ts` already documents and relies on.
//   * `CredentialsModule` for the secret access key. It is deliberately not
//     `@Global()` — "requiring `imports: [CredentialsModule]` makes every new
//     consumer a visible line in a diff" — and this line is that diff.
//
// `PrismaModule` is `@Global()`, so `PrismaService` needs no import; it is used
// for the audit rows and for the switch gate's two `count` queries.
//
// NOTHING IS EXPORTED. These services back one settings page and have no second
// consumer; the moment one appears, adding an `exports` line is the diff that
// should be reviewed.
// =============================================================================

@Module({
  imports: [StorageProvidersModule, SettingsModule, CredentialsModule],
  controllers: [StorageConfigController],
  providers: [
    StorageConfigAdminService,
    StorageConnectionTestService,
    StorageBucketProvisionService,
  ],
})
export class StorageConfigModule {}
