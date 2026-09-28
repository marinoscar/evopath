import { Module } from '@nestjs/common';

import { AiCoreModule } from '../../core/ai-core.module';
import { AzureOpenAiClientFactory } from './azure-openai-client.factory';
import { AzureOpenAiProviderAdapter } from './azure-openai.adapter';

/**
 * The Azure OpenAI provider (issue #448, epic #421). Being in the module graph
 * is the registration: `AzureOpenAiProviderAdapter.onModuleInit()` adds itself
 * to `AiProviderRegistry`. Whether the provider is ENABLED, where its
 * resource is and which deployments it serves are runtime configuration
 * (`ai.providers['azure-openai']`), not wiring.
 */
@Module({
  imports: [AiCoreModule],
  providers: [AzureOpenAiClientFactory, AzureOpenAiProviderAdapter],
  exports: [AzureOpenAiProviderAdapter],
})
export class AzureOpenAiProviderModule {}
