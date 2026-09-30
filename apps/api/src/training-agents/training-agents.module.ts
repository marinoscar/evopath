import { Module } from '@nestjs/common';

import { AiConfigModule } from '../ai/config/ai-config.module';
import { AiCoreModule } from '../ai/core/ai-core.module';
import { AiKeysModule } from '../ai/keys/ai-keys.module';
import { GraphRuntimeInfo } from './graph-runtime-info';
import { TrainingModelResolver } from './models/training-model-resolver.service';
import { TrainingModelsController } from './models/training-models.controller';
import { TrainingModelsService } from './models/training-models.service';

/**
 * Training agents: the orchestration layer above `AiService`.
 *
 * `@langchain/langgraph` and `@langchain/core` may be imported only under this
 * folder; every model call still goes through `AiService.forUser`.
 * `GraphRuntimeInfo` loads the runtime at boot and logs its version.
 * `TrainingModelResolver` turns the caller's per-role model preferences, usable
 * models and the AI policy into a state per agent role; it reads through the
 * read-only seams `AiConfigModule` (`AiConfigService`, `AiEnabledGuard`),
 * `AiKeysModule` (`UsableModelsService`, `AiKeyResolver`) and `AiCoreModule`
 * (`AiProviderRegistry`) export, and never sees key material;
 * `TrainingModelsController` serves it at `/api/ai/training/models` and
 * `/api/ai/training/estimate`. The spike under
 * `spike/` is deliberately NOT registered here: it is constructed only inside
 * specs.
 */
@Module({
  imports: [AiConfigModule, AiCoreModule, AiKeysModule],
  controllers: [TrainingModelsController],
  providers: [GraphRuntimeInfo, TrainingModelResolver, TrainingModelsService],
  exports: [GraphRuntimeInfo, TrainingModelResolver],
})
export class TrainingAgentsModule {}
