import { Module } from '@nestjs/common';

import { AiCoreModule } from '../../core/ai-core.module';
import { OpenAiCompatibleClientFactory } from './openai-compatible-client.factory';
import { OpenAiCompatibleProviderAdapter } from './openai-compatible.adapter';

/**
 * The generic OpenAI-compatible provider (issue #448, epic #421) — Ollama,
 * vLLM, LM Studio and friends. Being in the module graph is the registration:
 * `OpenAiCompatibleProviderAdapter.onModuleInit()` adds itself to
 * `AiProviderRegistry`. Whether it is ENABLED, where the server is and
 * whether it needs a key are runtime configuration
 * (`ai.providers['openai-compatible']`), not wiring.
 */
@Module({
  imports: [AiCoreModule],
  providers: [OpenAiCompatibleClientFactory, OpenAiCompatibleProviderAdapter],
  exports: [OpenAiCompatibleProviderAdapter],
})
export class OpenAiCompatibleProviderModule {}
