import { AiError } from '../../core/ai-error';
import {
  AI_KEYLESS_API_KEY,
  type AiCallContext,
  type AiProviderAdapter,
} from '../../core/provider-adapter.interface';
import { AiProviderRegistry } from '../../core/provider-registry';
import type { AiStreamEvent } from '../../core/types/responses.types';
import { conformanceChatResponder, conformanceResponsesResponder } from '../openai/testing/conformance-responders';
import { OpenAiMockServer } from '../openai/testing/openai-mock-transport';
import { OpenAiCompatibleClientFactory } from './openai-compatible-client.factory';
import { openAiCompatibleSettings } from './openai-compatible-settings';
import { OpenAiCompatibleProviderAdapter } from './openai-compatible.adapter';

const KEY = 'lmstudio-key-VALID-abcdefgh';
const BASE_URL = 'http://ollama.internal:11434/v1';
const MODEL = 'llama3.1:8b';

function setup(opts: { allowAnonymous?: boolean; settings?: Record<string, unknown>; fetch?: typeof fetch } = {}) {
  const server = new OpenAiMockServer({
    validKeys: [KEY],
    allowAnonymous: opts.allowAnonymous,
    models: [MODEL, 'nomic-embed-text'],
    respond: conformanceResponsesResponder(MODEL, 'broken'),
    chat: conformanceChatResponder(MODEL, 'broken'),
  });
  const registry = new AiProviderRegistry();
  const adapter = new OpenAiCompatibleProviderAdapter(
    registry,
    new OpenAiCompatibleClientFactory({ fetch: opts.fetch ?? server.fetch }),
  );
  const ctx: AiCallContext = { apiKey: KEY, baseUrl: BASE_URL, requestId: 'req-compat-1', providerSettings: opts.settings };

  return { server, registry, adapter, ctx };
}

async function collect(stream: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];

  for await (const event of stream) events.push(event);

  return events;
}

async function caught(run: () => Promise<unknown>): Promise<AiError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(AiError);

    return err as AiError;
  }

  throw new Error('expected an AiError');
}

describe('OpenAiCompatibleProviderAdapter', () => {
  it('self-registers with its id, and declares its flags and ports', () => {
    const { adapter, registry } = setup();

    adapter.onModuleInit();

    expect(registry.get('openai-compatible')).toBe(adapter);
    expect(adapter.displayName).toBe('OpenAI-compatible');
    expect(adapter.supportsPreviousResponseId).toBe(false);
    expect(adapter.supportsHostedTools).toBe(false);
    expect(adapter.fileInputStrategy).toEqual({ image: 'inline', file: 'inline' });
    expect(adapter.embeddings).toBeDefined();
    expect((adapter as AiProviderAdapter).images).toBeUndefined();
    expect((adapter as AiProviderAdapter).audio).toBeUndefined();
  });

  it('classifies nothing: every model is left to an administrator', () => {
    const { adapter } = setup();

    for (const id of [MODEL, 'gpt-4o', 'Qwen/Qwen2.5-7B-Instruct', 'nomic-embed-text']) {
      expect(adapter.classifyModel()).toBeNull();
      expect((adapter as AiProviderAdapter).classifyModel(id)).toBeNull();
    }
  });

  describe('the wire', () => {
    it('defaults to Chat Completions at {baseUrl}/chat/completions with max_tokens and a bearer key', async () => {
      const { adapter, server, ctx } = setup();

      const response = await adapter.responses!.create({ model: MODEL, input: 'Hi', maxOutputTokens: 16 }, ctx);

      const [request] = server.requestsTo('/v1/chat/completions');

      expect(request.url.origin).toBe('http://ollama.internal:11434');
      expect(request.body).toMatchObject({ model: MODEL, max_tokens: 16 });
      expect(request.body).not.toHaveProperty('max_completion_tokens');
      expect(request.headers.get('authorization')).toBe(`Bearer ${KEY}`);
      expect(response).toMatchObject({ provider: 'openai-compatible', finishReason: 'stop' });
    });

    it("uses the Responses API when apiStyle is 'responses'", async () => {
      const { adapter, server, ctx } = setup({ settings: { apiStyle: 'responses' } });

      await adapter.responses!.create({ model: MODEL, input: 'Hi' }, ctx);
      await collect(adapter.responses!.stream({ model: MODEL, input: 'Hi' }, ctx));

      expect(server.requestsTo('/v1/responses')).toHaveLength(2);
      expect(server.requestsTo('/v1/chat/completions')).toHaveLength(0);
    });

    it('sends a stored image inline, as a data: URL', async () => {
      const { adapter, server, ctx } = setup();
      const bytes = new Uint8Array([137, 80, 78, 71]);

      await adapter.responses!.create(
        {
          model: MODEL,
          input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'What is it?' }, { type: 'image', storageObjectId: 'obj-1' }] }],
        },
        {
          ...ctx,
          storageInputs: new Map([
            [
              'obj-1',
              {
                storageObjectId: 'obj-1',
                modality: 'image' as const,
                mimeType: 'image/png',
                filename: 'cat.png',
                strategy: 'inline' as const,
                read: async () => ({ data: bytes, mimeType: 'image/png' }),
              },
            ],
          ]),
        },
      );

      const [request] = server.requestsTo('/v1/chat/completions');
      const parts = (request.body?.messages as Array<{ content: unknown }>)[0].content as Array<Record<string, unknown>>;

      expect(parts[1]).toEqual({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`, detail: 'auto' },
      });
    });
  });

  describe('keyless (requiresKey: false → keySource none)', () => {
    it('sends no credential at all, and the marker never reaches the wire', async () => {
      const { adapter, server, ctx } = setup({ allowAnonymous: true, settings: { requiresKey: false } });
      const keyless = { ...ctx, apiKey: AI_KEYLESS_API_KEY };

      await expect(adapter.verifyKey(keyless)).resolves.toEqual({ ok: true });
      expect((await adapter.listModels(keyless)).map((m) => m.id)).toEqual([MODEL, 'nomic-embed-text']);
      await adapter.responses!.create({ model: MODEL, input: 'Hi' }, keyless);
      await collect(adapter.responses!.stream({ model: MODEL, input: 'Hi' }, keyless));
      await adapter.embeddings!.embed({ model: 'nomic-embed-text', input: 'Hi' }, keyless);

      expect(server.requests.length).toBe(5);

      for (const request of server.requests) {
        expect(request.headers.get('authorization')).toBeNull();
        expect(request.headers.get('api-key')).toBeNull();
        expect(JSON.stringify([...request.headers.entries()])).not.toContain(AI_KEYLESS_API_KEY);
        expect(JSON.stringify(request.body ?? {})).not.toContain(AI_KEYLESS_API_KEY);
      }
    });

    it('surfaces a server that does want a key as AI_KEY_INVALID', async () => {
      const { adapter, ctx } = setup({ allowAnonymous: false });

      await expect(adapter.verifyKey({ ...ctx, apiKey: AI_KEYLESS_API_KEY })).resolves.toEqual({
        ok: false,
        code: 'AI_KEY_INVALID',
      });
    });
  });

  describe('refusals', () => {
    it('refuses a hosted tool before any request, in both styles', async () => {
      for (const apiStyle of ['responses', 'chat_completions']) {
        const { adapter, server, ctx } = setup({ settings: { apiStyle } });
        const req = { model: MODEL, input: 'x', tools: [{ type: 'code_interpreter' as const }] };

        expect((await caught(() => adapter.responses!.create(req, ctx))).code).toBe('AI_CAPABILITY_UNSUPPORTED');
        expect((await caught(() => collect(adapter.responses!.stream(req, ctx)))).code).toBe('AI_CAPABILITY_UNSUPPORTED');
        expect(server.requests).toHaveLength(0);
      }
    });

    it('needs a base URL', async () => {
      const { adapter, ctx } = setup();
      const err = await caught(() => adapter.listModels({ ...ctx, baseUrl: undefined }));

      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(err.toJSON().details).toMatchObject({ provider: 'openai-compatible', missing: 'baseUrl' });
    });

    it('follows no redirect to another host', async () => {
      const seen: string[] = [];
      const redirecting: typeof fetch = async (input) => {
        seen.push(String(input instanceof Request ? input.url : input));

        return new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
      };
      const { adapter, ctx } = setup({ fetch: redirecting });

      const err = await caught(() => adapter.responses!.create({ model: MODEL, input: 'Hi' }, ctx));

      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(err.toJSON().details).toMatchObject({ provider: 'openai-compatible', status: 307, providerCode: 'redirect_refused' });
      expect(seen).toEqual([`${BASE_URL}/chat/completions`]);
      await expect(adapter.verifyKey(ctx)).resolves.toMatchObject({ ok: false, code: 'AI_PROVIDER_UNAVAILABLE' });
    });

    it('maps a server error to an AiError carrying the provider id, never the raw SDK error', async () => {
      const { adapter, ctx } = setup();
      const err = await caught(() => adapter.responses!.create({ model: 'broken', input: 'Hi' }, ctx));

      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(err.message).toBe('The OpenAI-compatible server is unavailable or the request failed.');
      expect(err.toJSON().details).toMatchObject({ provider: 'openai-compatible', status: 500 });
    });
  });
});

describe('openAiCompatibleSettings', () => {
  it('defaults to chat_completions with a key required', () => {
    expect(openAiCompatibleSettings(undefined)).toEqual({ apiStyle: 'chat_completions', requiresKey: true });
    expect(openAiCompatibleSettings({ apiStyle: 'nonsense', requiresKey: 'no' })).toEqual({
      apiStyle: 'chat_completions',
      requiresKey: true,
    });
    expect(openAiCompatibleSettings({ apiStyle: 'responses', requiresKey: false })).toEqual({
      apiStyle: 'responses',
      requiresKey: false,
    });
  });
});
