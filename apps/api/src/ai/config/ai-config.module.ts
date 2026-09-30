import { Module } from '@nestjs/common';

import { CredentialsModule } from '../../credentials/credentials.module';
import { SettingsModule } from '../../settings/settings.module';
import { AiCatalogModule } from '../catalog/ai-catalog.module';
import { AiCoreModule } from '../core/ai-core.module';
import { AiAdminController } from './ai-admin.controller';
import { AiConfigAdminService } from './ai-config-admin.service';
import { AiConfigService } from './ai-config.service';
import { AiEnabledGuard } from './ai-enabled.guard';
import { AiModelsAdminService } from './ai-models-admin.service';
import { AiProviderTestService } from './ai-provider-test.service';
import { AiPublicController } from './ai-public.controller';
import { AiEnabledDoctorCheck } from './doctor/ai-enabled.doctor-check';
import { AiProvidersDoctorCheck } from './doctor/ai-providers.doctor-check';

// =============================================================================
// AiConfigModule (issue #428, epic #419)
// =============================================================================
//
// The AI platform's configuration: the cached kill-switch resolver every other
// AI story consumes (`AiConfigService`, `AiEnabledGuard`), and the admin HTTP
// surface under `/api/admin/ai/*` plus the public `GET /api/ai/config`.
//
// `CredentialsModule` is imported explicitly — it is deliberately not
// `@Global` (see that module), so this line is the visible record that this
// module can read the admin AI key.
// =============================================================================

@Module({
  imports: [SettingsModule, CredentialsModule, AiCoreModule, AiCatalogModule],
  controllers: [AiAdminController, AiPublicController],
  providers: [
    AiConfigService,
    AiEnabledGuard,
    AiConfigAdminService,
    AiProviderTestService,
    AiModelsAdminService,
    // Doctor checks (#634): policy and key STATUS only — no model call.
    AiEnabledDoctorCheck,
    AiProvidersDoctorCheck,
  ],
  exports: [AiConfigService, AiEnabledGuard],
})
export class AiConfigModule {}
