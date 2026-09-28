import { Module } from '@nestjs/common';

import { AiCoreModule } from '../../core/ai-core.module';
import { AnthropicClientFactory } from './anthropic-client.factory';
import { AnthropicProviderAdapter } from './anthropic.adapter';

/**
 * The Anthropic provider (issue #446, epic #421). Being in the module graph
 * is the registration: `AnthropicProviderAdapter.onModuleInit()` adds itself
 * to `AiProviderRegistry`. Whether the provider is ENABLED, and with which
 * key, is runtime configuration (`ai.providers.anthropic`), not wiring.
 */
@Module({
  imports: [AiCoreModule],
  providers: [AnthropicClientFactory, AnthropicProviderAdapter],
  exports: [AnthropicProviderAdapter],
})
export class AnthropicProviderModule {}
