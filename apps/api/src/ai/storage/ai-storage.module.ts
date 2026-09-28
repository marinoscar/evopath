import { Module } from '@nestjs/common';

import { StorageProvidersModule } from '../../storage/providers/storage-providers.module';
import { AiOutputWriter } from './ai-output-writer';
import { AiStorageInputResolver } from './ai-storage-input.resolver';

// =============================================================================
// AiStorageModule (issue #437, epic #420) — storage objects in and out of AI
// =============================================================================
//
// The two reusable pieces every media story shares (images #437, audio
// #438/#439, file inputs #441, hosted image generation #442):
//
//   AiStorageInputResolver   a storage object id -> an ownership-checked input
//   AiOutputWriter           produced bytes -> storage objects the user owns
//
// Imports `StorageProvidersModule` (for `STORAGE_PROVIDER` and
// `StorageConfigService`) and nothing from `StorageModule`, so the AI
// platform depends on the storage PROVIDER, never on the objects HTTP surface.
// One-way: nothing under `storage/` imports AI.
// =============================================================================

@Module({
  imports: [StorageProvidersModule],
  providers: [AiStorageInputResolver, AiOutputWriter],
  exports: [AiStorageInputResolver, AiOutputWriter],
})
export class AiStorageModule {}
