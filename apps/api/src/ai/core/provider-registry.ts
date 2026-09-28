// =============================================================================
// AI provider registry (issue #424, epic #419)
// =============================================================================
//
// The one place that knows which AI providers this process can talk to. It
// mirrors `jobs/job-handler.registry.ts` deliberately — explicit
// self-registration from each adapter's `onModuleInit()`, last registration
// wins with a warning — so there is one pattern to learn, not two. Read that
// file's header for why explicit registration beats decorator discovery.
//
// `supports()` is DERIVED from port presence and nothing else. There is no
// capability list on an adapter to disagree with the code: an adapter that
// carries an `images` port supports image generation; one that does not,
// does not. Model-level capability (does THIS model reason?) is a separate
// question answered by the catalog — see `capabilities.ts`.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

import { AiError } from './ai-error';
import { AI_CAPABILITIES, AiCapability } from './capabilities';
import { AiProviderAdapter } from './provider-adapter.interface';

/**
 * Which port (and, for optional port members, which method) each capability
 * needs. The model-level text capabilities all ride on the `responses` port:
 * at the PROVIDER level, "can this provider reason / call tools / stream" is
 * the same question as "does it implement the responses port".
 */
const CAPABILITY_PORT: Record<AiCapability, (adapter: AiProviderAdapter) => boolean> = {
  responses: (a) => a.responses !== undefined,
  reasoning: (a) => a.responses !== undefined,
  tools: (a) => a.responses !== undefined,
  // Rides on the responses port, unless the adapter declares it runs none (#446).
  hosted_tools: (a) => a.responses !== undefined && a.supportsHostedTools !== false,
  structured_output: (a) => a.responses !== undefined,
  streaming: (a) => a.responses !== undefined,
  vision_input: (a) => a.responses !== undefined,
  file_input: (a) => a.responses !== undefined,
  image_generation: (a) => a.images !== undefined,
  image_edit: (a) => typeof a.images?.edit === 'function',
  audio_transcription: (a) => typeof a.audio?.transcribe === 'function',
  audio_speech: (a) => typeof a.audio?.speech === 'function',
  embeddings: (a) => a.embeddings !== undefined,
  realtime: (a) => a.realtime !== undefined,
};

/** The capabilities an adapter's ports make possible, in `AI_CAPABILITIES` order. */
export function adapterCapabilities(adapter: AiProviderAdapter): AiCapability[] {
  return AI_CAPABILITIES.filter((cap) => CAPABILITY_PORT[cap](adapter));
}

@Injectable()
export class AiProviderRegistry {
  private readonly logger = new Logger(AiProviderRegistry.name);

  private readonly adapters = new Map<string, AiProviderAdapter>();

  /**
   * Adds `adapter` under its own `id`. A duplicate id REPLACES the earlier
   * registration and logs a warning — how a fork overrides a framework
   * adapter without editing it (see `JobHandlerRegistry.register`).
   */
  register(adapter: AiProviderAdapter): void {
    const existing = this.adapters.get(adapter.id);

    if (existing) {
      this.logger.warn(
        `Duplicate AI provider adapter for id "${adapter.id}": ` +
          `${existing.constructor.name} is being replaced by ` +
          `${adapter.constructor.name}. The last registration wins.`,
      );
    }

    this.adapters.set(adapter.id, adapter);
  }

  /** The adapter for `id`, or `undefined` — the caller decides what "unknown" means. */
  get(id: string): AiProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  /** The adapter for `id`, or `AiError('AI_PROVIDER_DISABLED')` when none is registered. */
  require(id: string): AiProviderAdapter {
    const adapter = this.adapters.get(id);

    if (!adapter) {
      throw new AiError(
        'AI_PROVIDER_DISABLED',
        `AI provider "${id}" is not available in this deployment.`,
        { details: { provider: id } },
      );
    }

    return adapter;
  }

  /** Every registered provider id, in registration order. */
  ids(): string[] {
    return [...this.adapters.keys()];
  }

  /** Whether provider `id` implements the port `cap` needs. `false` for an unknown id. */
  supports(id: string, cap: AiCapability): boolean {
    const adapter = this.adapters.get(id);

    return adapter !== undefined && CAPABILITY_PORT[cap](adapter);
  }

  /**
   * Whether provider `id` can chain a request onto a stored response with
   * `previousResponseId` (#446) — `AiProviderAdapter.supportsPreviousResponseId`,
   * absent meaning `true`. An unknown id answers `true`: there is nothing
   * registered to refuse on its behalf, and the gate pipeline refuses the id
   * itself.
   */
  supportsPreviousResponseId(id: string): boolean {
    return this.adapters.get(id)?.supportsPreviousResponseId !== false;
  }

  /** Every capability provider `id` supports; empty for an unknown id. */
  capabilities(id: string): AiCapability[] {
    const adapter = this.adapters.get(id);

    return adapter ? adapterCapabilities(adapter) : [];
  }
}
