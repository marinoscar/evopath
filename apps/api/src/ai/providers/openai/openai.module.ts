import { Module } from '@nestjs/common';

import { AiCoreModule } from '../../core/ai-core.module';
import { OpenAiClientFactory } from './openai-client.factory';
import { OpenAiProviderAdapter } from './openai.adapter';

/**
 * The OpenAI provider (issue #426, epic #419). Being in the module graph is
 * the registration: `OpenAiProviderAdapter.onModuleInit()` adds itself to
 * `AiProviderRegistry`. Whether the provider is ENABLED, and with which key,
 * is runtime configuration (#423/#428), not wiring.
 */
@Module({
  imports: [AiCoreModule],
  providers: [OpenAiClientFactory, OpenAiProviderAdapter],
  exports: [OpenAiProviderAdapter],
})
export class OpenAiProviderModule {}
