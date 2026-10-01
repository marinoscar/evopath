import { Module } from '@nestjs/common';

import { AndroidAppController } from './android-app.controller';
import { AndroidAppService } from './android-app.service';
import { AssetLinksController } from './asset-links.controller';
import { AndroidAssetLinksDoctorCheck } from './doctor/android-assetlinks.doctor-check';

// =============================================================================
// AndroidAppModule (issue #279, epic #276)
// =============================================================================
//
// Trust for the Android app's Trusted Web Activity: the admin list of trusted
// (package, signing fingerprint) pairs under `system_settings:*`, the public
// Digital Asset Links document the edge serves at
// `/.well-known/assetlinks.json`, and the `android.assetlinks` doctor check.
//
// Reads `health_sync_devices` directly (one grouped SELECT) for the apps paired
// devices report; it does not import the health-sync module, which owns the
// writes. `PrismaModule` and `DoctorModule` are global.
// =============================================================================

@Module({
  controllers: [AndroidAppController, AssetLinksController],
  providers: [AndroidAppService, AndroidAssetLinksDoctorCheck],
  exports: [AndroidAppService],
})
export class AndroidAppModule {}
