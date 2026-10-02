import { Module } from '@nestjs/common';

import { AndroidAppController } from './android-app.controller';
import { AndroidAppService } from './android-app.service';
import { AssetLinksController } from './asset-links.controller';
import { AndroidAssetLinksDoctorCheck } from './doctor/android-assetlinks.doctor-check';
import { AndroidReleasesDoctorCheck } from './doctor/android-releases.doctor-check';
import { AndroidReleaseAdminController } from './releases/android-release-admin.controller';
import { AndroidReleaseController } from './releases/android-release.controller';
import { AndroidReleaseService } from './releases/android-release.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';

// =============================================================================
// AndroidAppModule (issue #279, epic #276)
// =============================================================================
//
// Trust for the Android app's Trusted Web Activity: the admin list of trusted
// (package, signing fingerprint) pairs under `system_settings:*`, the public
// Digital Asset Links document the edge serves at
// `/.well-known/assetlinks.json`, and the `android.assetlinks` and
// `android.releases` doctor checks.
//
// Reads `health_sync_devices` directly (one grouped SELECT) for the apps paired
// devices report; it does not import the health-sync module, which owns the
// writes. `PrismaModule` and `DoctorModule` are global.
//
// Hosted APK releases (issue #285): the admin upload/list/make-current/delete
// routes, the user's latest-release and download-link routes and the public
// signed download. `StorageProvidersModule` (not `StorageModule`, which would
// pull in the queue) supplies the object storage the APKs live in.
//
// Notifications (issue #312): `NotificationsModule` supplies
// `AndroidAppPushService` for the admin test notification.
// =============================================================================

@Module({
  imports: [StorageProvidersModule, NotificationsModule],
  controllers: [AndroidAppController, AssetLinksController, AndroidReleaseAdminController, AndroidReleaseController],
  providers: [AndroidAppService, AndroidAssetLinksDoctorCheck, AndroidReleasesDoctorCheck, AndroidReleaseService],
  exports: [AndroidAppService, AndroidReleaseService],
})
export class AndroidAppModule {}
