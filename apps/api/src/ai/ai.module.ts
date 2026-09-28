import { Module } from '@nestjs/common';

import { AiCatalogModule } from './catalog/ai-catalog.module';
import { AiConfigModule } from './config/ai-config.module';
import { AiCoreModule } from './core/ai-core.module';
import { AiHttpModule } from './http/ai-http.module';
import { AiKeysModule } from './keys/ai-keys.module';
import { AnthropicProviderModule } from './providers/anthropic/anthropic.module';
import { AzureOpenAiProviderModule } from './providers/azure-openai/azure-openai.module';
import { GeminiProviderModule } from './providers/gemini/gemini.module';
import { OpenAiProviderModule } from './providers/openai/openai.module';
import { OpenAiCompatibleProviderModule } from './providers/openai-compatible/openai-compatible.module';
import { AiRuntimeModule } from './runtime/ai-runtime.module';
import { AiUsageModule } from './usage/ai-usage.module';

/**
 * The AI platform's root module (epic #419).
 *
 * Deliberately just a list of imports. Each later story (providers, catalog,
 * config, keys, runtime, HTTP) adds ONE import line here, so the whole
 * platform's wiring is visible in one short file — the same "being in the
 * graph is the registration" rule `app.module.ts` states for `JobsModule`.
 */
@Module({
  imports: [
    AiCoreModule,
    OpenAiProviderModule,
    AnthropicProviderModule,
    GeminiProviderModule,
    AzureOpenAiProviderModule,
    OpenAiCompatibleProviderModule,
    AiCatalogModule,
    AiConfigModule,
    AiKeysModule,
    AiRuntimeModule,
    AiHttpModule,
    AiUsageModule,
  ],
  // `AiRuntimeModule` is re-exported so a fork's module can simply
  // `imports: [AiModule]` and inject `AiService`.
  exports: [AiCoreModule, AiConfigModule, AiRuntimeModule],
})
export class AiModule {}
