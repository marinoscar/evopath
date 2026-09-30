import { Module } from '@nestjs/common';

import { AiConfigModule } from '../config/ai-config.module';
import { AiCoreModule } from '../core/ai-core.module';
import { AiKeysModule } from '../keys/ai-keys.module';
import { AiFeatureModelResolver } from './ai-feature-model-resolver.service';

/**
 * Administrator model assignments per AI feature (#173):
 * `AiFeatureModelResolver`, the one resolver every feature (photo intake
 * analyze, the training agents) asks which model to use. `PrismaService`
 * comes from the global `PrismaModule`.
 */
@Module({
  imports: [AiCoreModule, AiConfigModule, AiKeysModule],
  providers: [AiFeatureModelResolver],
  exports: [AiFeatureModelResolver],
})
export class AiAssignmentsModule {}
