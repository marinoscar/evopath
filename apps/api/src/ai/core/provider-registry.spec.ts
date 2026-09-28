import { Logger } from '@nestjs/common';

import { AiError } from './ai-error';
import { AI_CAPABILITIES } from './capabilities';
import { AiProviderAdapter } from './provider-adapter.interface';
import { adapterCapabilities, AiProviderRegistry } from './provider-registry';

function bareAdapter(id: string, extra: Partial<AiProviderAdapter> = {}): AiProviderAdapter {
  return {
    id,
    displayName: id.toUpperCase(),
    listModels: async () => [],
    verifyKey: async () => ({ ok: true }),
    classifyModel: () => null,
    ...extra,
  };
}

const responsesPort = {
  create: jest.fn(),
  stream: jest.fn(),
} as unknown as AiProviderAdapter['responses'];

describe('AiProviderRegistry', () => {
  let registry: AiProviderRegistry;

  beforeEach(() => {
    registry = new AiProviderRegistry();
  });

  afterEach(() => jest.restoreAllMocks());

  it('starts empty', () => {
    expect(registry.ids()).toEqual([]);
    expect(registry.get('openai')).toBeUndefined();
  });

  it('registers and returns adapters in registration order', () => {
    const a = bareAdapter('a');
    const b = bareAdapter('b');

    registry.register(a);
    registry.register(b);

    expect(registry.ids()).toEqual(['a', 'b']);
    expect(registry.get('a')).toBe(a);
    expect(registry.require('b')).toBe(b);
  });

  it('lets a duplicate id overwrite and logs a warning', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const first = bareAdapter('dup');
    const second = bareAdapter('dup');

    registry.register(first);
    registry.register(second);

    expect(registry.get('dup')).toBe(second);
    expect(registry.ids()).toEqual(['dup']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"dup"');
  });

  it('require() throws AI_PROVIDER_DISABLED for an unknown id', () => {
    expect(() => registry.require('missing')).toThrow(AiError);

    try {
      registry.require('missing');
    } catch (err) {
      expect((err as AiError).code).toBe('AI_PROVIDER_DISABLED');
      expect((err as AiError).getStatus()).toBe(403);
    }
  });

  describe('supportsPreviousResponseId() (#446)', () => {
    it('is true when the adapter declares nothing (the default), and for an unknown id', () => {
      registry.register(bareAdapter('chains'));

      expect(registry.supportsPreviousResponseId('chains')).toBe(true);
      expect(registry.supportsPreviousResponseId('unknown')).toBe(true);
    });

    it('is false only when the adapter declares false', () => {
      registry.register(bareAdapter('stateless', { supportsPreviousResponseId: false }));
      registry.register(bareAdapter('explicit', { supportsPreviousResponseId: true }));

      expect(registry.supportsPreviousResponseId('stateless')).toBe(false);
      expect(registry.supportsPreviousResponseId('explicit')).toBe(true);
    });
  });

  describe('hosted_tools and supportsHostedTools (#446)', () => {
    it('rides on the responses port when the adapter declares nothing', () => {
      registry.register(bareAdapter('p', { responses: responsesPort }));

      expect(registry.supports('p', 'hosted_tools')).toBe(true);
    });

    it('is withdrawn by supportsHostedTools: false, leaving every other text capability', () => {
      registry.register(bareAdapter('p', { responses: responsesPort, supportsHostedTools: false }));

      expect(registry.supports('p', 'hosted_tools')).toBe(false);
      expect(registry.capabilities('p')).toEqual([
        'responses',
        'reasoning',
        'tools',
        'structured_output',
        'streaming',
        'vision_input',
        'file_input',
      ]);
    });

    it('never appears without a responses port, whatever is declared', () => {
      registry.register(bareAdapter('p', { supportsHostedTools: true }));

      expect(registry.supports('p', 'hosted_tools')).toBe(false);
    });
  });

  describe('supports() — derived purely from port presence', () => {
    it('is false for every capability on an unknown provider', () => {
      for (const cap of AI_CAPABILITIES) {
        expect(registry.supports('nope', cap)).toBe(false);
      }
    });

    it('is false for every capability when no port is present', () => {
      registry.register(bareAdapter('bare'));

      expect(registry.capabilities('bare')).toEqual([]);
    });

    it('a responses port enables exactly the text-family capabilities', () => {
      registry.register(bareAdapter('text', { responses: responsesPort }));

      expect(registry.capabilities('text')).toEqual([
        'responses',
        'reasoning',
        'tools',
        'hosted_tools',
        'structured_output',
        'streaming',
        'vision_input',
        'file_input',
      ]);
      expect(registry.supports('text', 'image_generation')).toBe(false);
    });

    it('image_edit needs images.edit, not just an images port', () => {
      registry.register(bareAdapter('gen', { images: { generate: jest.fn() } }));
      registry.register(bareAdapter('edit', { images: { generate: jest.fn(), edit: jest.fn() } }));

      expect(registry.supports('gen', 'image_generation')).toBe(true);
      expect(registry.supports('gen', 'image_edit')).toBe(false);
      expect(registry.supports('edit', 'image_edit')).toBe(true);
    });

    it('audio capabilities follow the individual audio methods', () => {
      registry.register(bareAdapter('stt', { audio: { transcribe: jest.fn() } }));
      registry.register(bareAdapter('tts', { audio: { speech: jest.fn() } }));

      expect(registry.capabilities('stt')).toEqual(['audio_transcription']);
      expect(registry.capabilities('tts')).toEqual(['audio_speech']);
    });

    it('embeddings and realtime follow their ports', () => {
      registry.register(
        bareAdapter('all', {
          responses: responsesPort,
          images: { generate: jest.fn(), edit: jest.fn() },
          audio: { transcribe: jest.fn(), speech: jest.fn() },
          embeddings: { embed: jest.fn() },
          realtime: { createSession: jest.fn() },
        }),
      );

      expect(registry.capabilities('all')).toEqual([...AI_CAPABILITIES]);
    });

    it('reflects the adapter as it is, not as it was registered', () => {
      const adapter = bareAdapter('late') as { -readonly [K in keyof AiProviderAdapter]: AiProviderAdapter[K] };
      registry.register(adapter);

      expect(registry.supports('late', 'embeddings')).toBe(false);
      adapter.embeddings = { embed: jest.fn() };
      expect(registry.supports('late', 'embeddings')).toBe(true);
    });

    it('adapterCapabilities() matches supports()', () => {
      const adapter = bareAdapter('x', { embeddings: { embed: jest.fn() } });
      registry.register(adapter);

      expect(adapterCapabilities(adapter)).toEqual(
        AI_CAPABILITIES.filter((cap) => registry.supports('x', cap)),
      );
    });
  });
});
