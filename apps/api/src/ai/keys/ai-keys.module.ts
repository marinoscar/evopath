import { Module } from '@nestjs/common';

import { JobsModule } from '../../jobs/jobs.module';
import { AiConfigModule } from '../config/ai-config.module';
import { AiCoreModule } from '../core/ai-core.module';
import { AiKeyResolver } from './ai-key-resolver.service';
import { AiKeysCatalogListener } from './ai-keys-catalog.listener';
import { AiKeysRecheckHandler } from './ai-keys-recheck.handler';
import { AiKeysRecheckTask } from './ai-keys-recheck.task';
import { UsableModelsService } from './usable-models.service';
import { UserAiKeysController } from './user-ai-keys.controller';
import { UserAiKeysService } from './user-ai-keys.service';

// =============================================================================
// AiKeysModule (issue #431, epic #419)
// =============================================================================
//
// Each user's own (BYOK) provider keys, the key-resolution rule, and the
// usable-models answer. `UserAiKeysService` is deliberately NOT exported: its
// `getDecrypted` is plaintext, and the only thing outside this module that may
// obtain a user's key is `AiKeyResolver`, which applies the policy rule.
//
// Also the server-only `ai.keys.recheck` job, its weekly enqueue-only cron,
// and the listener that queues a recheck when a catalog sync adds models.
// =============================================================================

@Module({
  imports: [AiCoreModule, AiConfigModule, JobsModule],
  controllers: [UserAiKeysController],
  providers: [
    UserAiKeysService,
    AiKeyResolver,
    UsableModelsService,
    AiKeysRecheckHandler,
    AiKeysRecheckTask,
    AiKeysCatalogListener,
  ],
  exports: [AiKeyResolver, UsableModelsService],
})
export class AiKeysModule {}
