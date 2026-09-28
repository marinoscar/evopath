import { Logger } from '@nestjs/common';

import { AiError } from '../../core/ai-error';
import type { AiCallContext, AiProviderAdapter } from '../../core/provider-adapter.interface';
import { AiProviderRegistry } from '../../core/provider-registry';
import type { AiStreamEvent } from '../../core/types/responses.types';
import { conformanceChatResponder, conformanceResponsesResponder } from '../openai/testing/conformance-responders';
import { OpenAiMockServer } from '../openai/testing/openai-mock-transport';
import { azureOpenAiBaseUrl, AzureOpenAiClientFactory } from './azure-openai-client.factory';
import { AZURE_OPENAI_DEFAULT_API_VERSION, azureOpenAiSettings } from './azure-openai-settings';
import { AzureOpenAiProviderAdapter } from './azure-openai.adapter';

const KEY = 'azure-key-VALID-abcdefghijklmnop';
const MODEL = 'gpt-4o-mini';

function setup(settings: Record<string, unknown> = {}, fetchOverride?: typeof fetch) {
  const server = new OpenAiMockServer({
    auth: 'api-key',
    validKeys: [KEY],
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-35-turbo'],
    respond: conformanceResponsesResponder(MODEL, 'broken'),
    chat: conformanceChatResponder(MODEL, 'broken'),
  });
  const registry = new AiProviderRegistry();
  const adapter = new AzureOpenAiProviderAdapter(
    registry,
    new AzureOpenAiClientFactory({ fetch: fetchOverride ?? server.fetch }),
  );
  const ctx: AiCallContext = {
    apiKey: KEY,
    baseUrl: 'https://contoso.openai.azure.com/',
    requestId: 'req-azure-1',
    providerSettings: settings,
  };

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

describe('AzureOpenAiProviderAdapter', () => {
  it('self-registers with its id, and declares its flags and ports', () => {
    const { adapter, registry } = setup();

    adapter.onModuleInit();

    expect(registry.get('azure-openai')).toBe(adapter);
    expect(adapter.displayName).toBe('Azure OpenAI');
    expect(adapter.supportsPreviousResponseId).toBe(false);
    expect(adapter.supportsHostedTools).toBe(false);
    expect(adapter.responses).toBeDefined();
    expect(adapter.embeddings).toBeDefined();
    expect((adapter as AiProviderAdapter).images).toBeUndefined();
    expect((adapter as AiProviderAdapter).audio).toBeUndefined();
    expect(registry.supports('azure-openai', 'hosted_tools')).toBe(false);
  });

  describe('the wire', () => {
    it('authenticates with the api-key header and the default api-version, never a bearer token', async () => {
      const { adapter, server, ctx } = setup();

      await adapter.responses!.create({ model: MODEL, input: 'Hi' }, ctx);

      const [request] = server.requestsTo('/openai/responses');

      expect(request.headers.get('api-key')).toBe(KEY);
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.url.searchParams.get('api-version')).toBe(AZURE_OPENAI_DEFAULT_API_VERSION);
      expect(request.url.origin).toBe('https://contoso.openai.azure.com');
    });

    it('uses the configured api-version, and sends the DEPLOYMENT as the model', async () => {
      const { adapter, server, ctx } = setup({ apiVersion: '2024-10-21', deployments: { [MODEL]: 'mini-prod' } });

      const response = await adapter.responses!.create({ model: MODEL, input: 'Hi' }, ctx);

      const [request] = server.requestsTo('/openai/responses');

      expect(request.url.searchParams.get('api-version')).toBe('2024-10-21');
      expect(request.body?.model).toBe('mini-prod');
      expect(response.provider).toBe('azure-openai');
    });

    it('routes Chat Completions to /deployments/<name>/chat/completions with max_completion_tokens', async () => {
      const { adapter, server, ctx } = setup({ apiStyle: 'chat_completions', deployments: { [MODEL]: 'mini-prod' } });

      await adapter.responses!.create({ model: MODEL, input: 'Hi', maxOutputTokens: 32 }, ctx);
      await collect(adapter.responses!.stream({ model: MODEL, input: 'Hi' }, ctx));

      const requests = server.requestsTo('/openai/deployments/mini-prod/chat/completions');

      expect(requests).toHaveLength(2);
      expect(requests[0].body).toMatchObject({ model: 'mini-prod', max_completion_tokens: 32 });
      expect(requests[1].body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
      expect(server.requestsTo('/openai/responses')).toHaveLength(0);
    });

    it('falls back to the model id as its own deployment name', async () => {
      const { adapter, server, ctx } = setup({ apiStyle: 'chat_completions' });

      await adapter.responses!.create({ model: MODEL, input: 'Hi' }, ctx);

      expect(server.requestsTo(`/openai/deployments/${MODEL}/chat/completions`)).toHaveLength(1);
    });

    it('routes embeddings to /deployments/<name>/embeddings', async () => {
      const { adapter, server, ctx } = setup({ deployments: { 'text-embedding-3-small': 'embed-prod' } });

      const result = await adapter.embeddings!.embed({ model: 'text-embedding-3-small', input: ['a', 'b'] }, ctx);

      expect(server.requestsTo('/openai/deployments/embed-prod/embeddings')).toHaveLength(1);
      expect(result).toMatchObject({ provider: 'azure-openai', dimensions: 1536 });
      expect(result.vectors).toHaveLength(2);
    });

    it('is not moved by an ambient OPENAI_BASE_URL / OPENAI_API_VERSION', async () => {
      const saved = { base: process.env.OPENAI_BASE_URL, version: process.env.OPENAI_API_VERSION };

      process.env.OPENAI_BASE_URL = 'https://attacker.example/v1';
      process.env.OPENAI_API_VERSION = '1999-01-01';

      try {
        const { adapter, server, ctx } = setup();

        await adapter.responses!.create({ model: MODEL, input: 'Hi' }, ctx);

        const [request] = server.requestsTo('/openai/responses');

        expect(request.url.origin).toBe('https://contoso.openai.azure.com');
        expect(request.url.searchParams.get('api-version')).toBe(AZURE_OPENAI_DEFAULT_API_VERSION);
      } finally {
        if (saved.base === undefined) delete process.env.OPENAI_BASE_URL;
        else process.env.OPENAI_BASE_URL = saved.base;
        if (saved.version === undefined) delete process.env.OPENAI_API_VERSION;
        else process.env.OPENAI_API_VERSION = saved.version;
      }
    });
  });

  describe('models', () => {
    it('lists what the resource reports when no deployments are configured, and verifies the key with it', async () => {
      const { adapter, ctx } = setup();

      expect((await adapter.listModels(ctx)).map((m) => m.id)).toEqual(['gpt-4o-mini', 'gpt-4o', 'gpt-35-turbo']);
      await expect(adapter.verifyKey(ctx)).resolves.toEqual({ ok: true });
      await expect(adapter.verifyKey({ ...ctx, apiKey: 'wrong' })).resolves.toEqual({ ok: false, code: 'AI_KEY_INVALID' });
    });

    it('classifies with the OpenAI table minus hosted tools, unknown ids unclassified', () => {
      const { adapter } = setup();

      expect(adapter.classifyModel('gpt-4o')?.capabilities).toEqual(expect.arrayContaining(['responses', 'tools']));
      expect(adapter.classifyModel('gpt-4o')?.capabilities).not.toContain('hosted_tools');
      expect(adapter.classifyModel('gpt-35-turbo')).toBeNull();
    });
  });

  describe('refusals', () => {
    it('refuses a hosted tool before any request, in both call styles', async () => {
      for (const apiStyle of ['responses', 'chat_completions']) {
        const { adapter, server, ctx } = setup({ apiStyle });
        const req = { model: MODEL, input: 'x', tools: [{ type: 'web_search' as const }] };

        expect((await caught(() => adapter.responses!.create(req, ctx))).code).toBe('AI_CAPABILITY_UNSUPPORTED');
        expect((await caught(() => collect(adapter.responses!.stream(req, ctx)))).code).toBe('AI_CAPABILITY_UNSUPPORTED');
        expect(server.requests).toHaveLength(0);
      }
    });

    it('needs an endpoint', async () => {
      const { adapter, ctx } = setup();
      const err = await caught(() => adapter.listModels({ ...ctx, baseUrl: undefined }));

      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(err.toJSON().details).toMatchObject({ provider: 'azure-openai', missing: 'baseUrl' });
    });

    it('follows no redirect, and says nothing about where it pointed', async () => {
      const followed: string[] = [];
      const redirecting: typeof fetch = async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);

        if (url.startsWith('https://elsewhere.example')) followed.push(url);
        expect(init?.redirect).toBe('manual');

        return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/steal' } });
      };
      const { adapter, ctx } = setup({}, redirecting);

      const err = await caught(() => adapter.responses!.create({ model: MODEL, input: 'Hi' }, ctx));

      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(err.toJSON().details).toMatchObject({ status: 302, providerCode: 'redirect_refused' });
      expect(JSON.stringify(err.toJSON())).not.toContain('elsewhere');
      expect(followed).toEqual([]);
    });
  });

  it('never logs the key', async () => {
    const lines: string[] = [];
    const spies = [
      jest.spyOn(Logger.prototype, 'debug').mockImplementation((...args: unknown[]) => void lines.push(JSON.stringify(args))),
      jest.spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => void lines.push(JSON.stringify(args))),
    ];

    try {
      const { adapter, ctx } = setup();

      await adapter.responses!.create({ model: MODEL, input: 'Hi' }, ctx);
      await adapter.verifyKey({ ...ctx, apiKey: 'wrong-key-zzzz' });

      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join('\n')).not.toContain(KEY);
      expect(lines.join('\n')).not.toContain('wrong-key-zzzz');
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

describe('azure-openai settings helpers', () => {
  it.each([
    ['https://contoso.openai.azure.com', 'https://contoso.openai.azure.com/openai'],
    ['https://contoso.openai.azure.com///', 'https://contoso.openai.azure.com/openai'],
    ['https://contoso.openai.azure.com/openai/', 'https://contoso.openai.azure.com/openai'],
    ['https://gw.example.com/azure', 'https://gw.example.com/azure/openai'],
  ])('azureOpenAiBaseUrl(%s) is %s', (endpoint, expected) => {
    expect(azureOpenAiBaseUrl(endpoint)).toBe(expected);
  });

  it('defaults each field independently, ignoring a malformed one', () => {
    expect(azureOpenAiSettings(undefined)).toEqual({
      apiVersion: AZURE_OPENAI_DEFAULT_API_VERSION,
      apiStyle: 'responses',
      deployments: {},
    });
    expect(azureOpenAiSettings({ apiVersion: 'bad version!', apiStyle: 'chat_completions', deployments: 7 })).toEqual({
      apiVersion: AZURE_OPENAI_DEFAULT_API_VERSION,
      apiStyle: 'chat_completions',
      deployments: {},
    });
  });
});
