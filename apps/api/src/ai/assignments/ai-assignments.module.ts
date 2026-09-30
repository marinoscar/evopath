import { Module } from '@nestjs/common';

import { SettingsModule } from '../../settings/settings.module';
import { AiConfigModule } from '../config/ai-config.module';
import { AiCoreModule } from '../core/ai-core.module';
import { AiKeysModule } from '../keys/ai-keys.module';
import { AiAssignmentsAdminController } from './ai-assignments-admin.controller';
import { AiAssignmentsAdminService } from './ai-assignments-admin.service';
import { AiFeatureModelResolver } from './ai-feature-model-resolver.service';
import { AiFeaturesController } from './ai-features.controller';
import { AiFeatureAssignmentsDoctorCheck } from './doctor/ai-feature-assignments.doctor-check';
import { AiWebSearchDoctorCheck } from './doctor/ai-web-search.doctor-check';

/**
 * Administrator model assignments per AI feature (#173): the admin routes,
 * the caller's `GET /api/ai/features`, and `AiFeatureModelResolver` — the one
 * resolver every feature (photo intake analyze, the training agents) asks
 * which model to use. `PrismaService` comes from the global `PrismaModule`.
 */
@Module({
  imports: [SettingsModule, AiCoreModule, AiConfigModule, AiKeysModule],
  controllers: [AiAssignmentsAdminController, AiFeaturesController],
  providers: [
    AiFeatureModelResolver,
    AiAssignmentsAdminService,
    // Doctor checks (#182): assignments view and key STATUS only — no model call.
    AiFeatureAssignmentsDoctorCheck,
    AiWebSearchDoctorCheck,
  ],
  exports: [AiFeatureModelResolver],
})
export class AiAssignmentsModule {}
