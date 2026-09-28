import { Module } from '@nestjs/common';

import { AiCoreModule } from '../../core/ai-core.module';
import { GeminiClientFactory } from './gemini-client.factory';
import { GeminiProviderAdapter } from './gemini.adapter';

/**
 * The Google Gemini provider (issue #447, epic #421). Being in the module
 * graph is the registration: `GeminiProviderAdapter.onModuleInit()` adds
 * itself to `AiProviderRegistry`. Whether the provider is ENABLED, and with
 * which key, is runtime configuration (`ai.providers.gemini`), not wiring.
 */
@Module({
  imports: [AiCoreModule],
  providers: [GeminiClientFactory, GeminiProviderAdapter],
  exports: [GeminiProviderAdapter],
})
export class GeminiProviderModule {}
