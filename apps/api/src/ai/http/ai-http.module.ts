import { Module } from '@nestjs/common';

import { AiConfigModule } from '../config/ai-config.module';
import { AiRuntimeModule } from '../runtime/ai-runtime.module';
import { AiAudioController } from './ai-audio.controller';
import { AiEmbeddingsController } from './ai-embeddings.controller';
import { AiImagesController } from './ai-images.controller';
import { AiRealtimeController } from './ai-realtime.controller';
import { AiResponsesController } from './ai-responses.controller';
import { AiRunsController } from './ai-runs.controller';

// =============================================================================
// AiHttpModule (issue #433, epic #419) — the consumer HTTP API
// =============================================================================
//
// Controllers only. Everything they do goes through `AiService` /
// `AiRunsService` (AiRuntimeModule), so the HTTP surface applies exactly the
// gate pipeline an in-process fork gets and owns no policy of its own.
// `AiConfigModule` is here for `AiEnabledGuard`.
// =============================================================================

@Module({
  imports: [AiConfigModule, AiRuntimeModule],
  controllers: [
    AiResponsesController,
    AiRunsController,
    AiEmbeddingsController,
    AiImagesController,
    AiAudioController,
    AiRealtimeController,
  ],
})
export class AiHttpModule {}
