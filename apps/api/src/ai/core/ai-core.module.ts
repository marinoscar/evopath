import { Module } from '@nestjs/common';

import { AiProviderRegistry } from './provider-registry';

/**
 * The provider-agnostic core of the AI platform (issue #424, epic #419).
 *
 * No database access and no provider SDK: everything here is contracts plus
 * the in-memory provider registry, so it boots anywhere — including a
 * `createTestApp()` with nothing registered. Provider modules import this and
 * self-register their adapter with `AiProviderRegistry` from `onModuleInit`.
 */
@Module({
  providers: [AiProviderRegistry],
  exports: [AiProviderRegistry],
})
export class AiCoreModule {}
