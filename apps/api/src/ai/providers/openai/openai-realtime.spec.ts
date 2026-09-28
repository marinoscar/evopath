// The OpenAI realtime port (issue #449): the adapter against the mocked
// transport (the real SDK builds `POST /v1/realtime/client_secrets`), the
// mapper's pure edge cases, and the classifier's realtime families + voices.

import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { AiError } from '../../core/ai-error';
import { aiModelCapabilitiesSchema } from '../../core/capabilities';
import { AiProviderRegistry } from '../../core/provider-registry';
import type { AiCallContext } from '../../core/provider-adapter.interface';
import { AI_REALTIME_CLIENT_SECRET_TTL_SECONDS } from '../../core/types/media.types';
import { OpenAiClientFactory } from './openai-client.factory';
import { classifyOpenAiModel, OPENAI_REALTIME_VOICES } from './openai-model-catalog';
import {
  fromOpenAiClientSecretResponse,
  openAiRealtimeConnectUrl,
  OPENAI_REALTIME_MAX_OUTPUT_TOKENS,
  toOpenAiClientSecretRequest,
} from './openai-realtime.mapper';
import { OpenAiProviderAdapter } from './openai.adapter';
import { MOCK_REALTIME_SECRET_PREFIX, OpenAiMockServer } from './testing/openai-mock-transport';

const VALID_KEY = 'sk-proj-REALTIME-valid-abcdefghijk';
const INVALID_KEY = 'sk-proj-REALTIME-revoked-lmnopqrs';

function setup(ctxOverrides: Partial<AiCallContext> = {}) {
  const server = new OpenAiMockServer({ validKeys: [VALID_KEY] });
  const adapter = new OpenAiProviderAdapter(new AiProviderRegistry(), new OpenAiClientFactory({ fetch: server.fetch }));
  const ctx: AiCallContext = { apiKey: VALID_KEY, requestId: 'req-realtime-1', ...ctxOverrides };

  return { server, adapter, ctx };
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

describe('OpenAI realtime port', () => {
  it('is carried with createSession and the static realtime voice list — presence is the declaration', () => {
    const registry = new AiProviderRegistry();
    const adapter = new OpenAiProviderAdapter(registry, new OpenAiClientFactory());

    adapter.onModuleInit();

    expect(typeof adapter.realtime.createSession).toBe('function');
    expect(adapter.realtime.voices).toEqual(OPENAI_REALTIME_VOICES);
    expect(registry.supports('openai', 'realtime')).toBe(true);
  });

  describe('createSession', () => {
    it('POSTs /v1/realtime/client_secrets with the key as the Authorization header and a 60 s expiry', async () => {
      const { adapter, ctx, server } = setup();

      const session = await adapter.realtime.createSession(
        { model: 'gpt-realtime', voice: 'marin', instructions: 'Be brief.' },
        ctx,
      );

      const [req] = server.requestsTo('/v1/realtime/client_secrets');

      expect(req.method).toBe('POST');
      expect(req.apiKey).toBe(VALID_KEY);
      expect(req.body).toEqual({
        expires_after: { anchor: 'created_at', seconds: AI_REALTIME_CLIENT_SECRET_TTL_SECONDS },
        session: {
          type: 'realtime',
          model: 'gpt-realtime',
          instructions: 'Be brief.',
          audio: { output: { voice: 'marin' } },
        },
      });

      // The real key appears ONLY as the Authorization header of this one request.
      expect(server.requests).toHaveLength(1);
      expect(JSON.stringify(req.body)).not.toContain(VALID_KEY);

      expect(session).toEqual({
        id: 'sess_mock_1',
        provider: 'openai',
        model: 'gpt-realtime',
        clientSecret: `${MOCK_REALTIME_SECRET_PREFIX}1`,
        expiresAt: new Date((1_700_000_000 + AI_REALTIME_CLIENT_SECRET_TTL_SECONDS) * 1000),
        connectUrl: 'https://api.openai.com/v1/realtime/calls',
        voice: 'marin',
        sessionConfig: {
          modalities: ['audio'],
          instructions: 'Be brief.',
          turnDetection: { type: 'server_vad', threshold: 0.5 },
        },
        providerRequestId: 'req_mock_1',
      });
      expect(JSON.stringify(session)).not.toContain(VALID_KEY);
    });

    it('maps turn detection, modalities, tools, the output cap (clamped to 4096) and providerOptions', async () => {
      const { adapter, ctx, server } = setup();

      await adapter.realtime.createSession(
        {
          model: 'gpt-4o-mini-realtime-preview',
          voice: 'alloy',
          modalities: ['text'],
          maxOutputTokens: 50_000,
          turnDetection: { type: 'server_vad', threshold: 0.6, prefixPaddingMs: 300, silenceDurationMs: 700 },
          tools: [
            {
              type: 'function',
              name: 'get_time',
              description: 'The current time.',
              parameters: z.object({ tz: z.string() }),
            },
          ],
          expiresInSeconds: 120,
          providerOptions: { openai: { include: ['item.input_audio_transcription.logprobs'] }, other: { x: 1 } },
        },
        ctx,
      );

      const [req] = server.requestsTo('/v1/realtime/client_secrets');
      const session = req.body!.session as Record<string, any>;

      expect(req.body!.expires_after).toEqual({ anchor: 'created_at', seconds: 120 });
      expect(session.output_modalities).toEqual(['text']);
      expect(session.max_output_tokens).toBe(OPENAI_REALTIME_MAX_OUTPUT_TOKENS);
      expect(session.audio).toEqual({
        output: { voice: 'alloy' },
        input: { turn_detection: { type: 'server_vad', threshold: 0.6, prefix_padding_ms: 300, silence_duration_ms: 700 } },
      });
      expect(session.tools).toEqual([
        expect.objectContaining({ type: 'function', name: 'get_time', description: 'The current time.' }),
      ]);
      expect(session.tools[0].parameters).toMatchObject({ type: 'object', properties: { tz: { type: 'string' } } });
      expect(session.include).toEqual(['item.input_audio_transcription.logprobs']);
      expect(session).not.toHaveProperty('x');
    });

    it('sends turn_detection: null for push-to-talk, and semantic_vad with its eagerness', async () => {
      const { adapter, ctx, server } = setup();

      await adapter.realtime.createSession({ model: 'gpt-realtime', turnDetection: null }, ctx);
      await adapter.realtime.createSession(
        { model: 'gpt-realtime', turnDetection: { type: 'semantic_vad', eagerness: 'low' } },
        ctx,
      );

      const [first, second] = server.requestsTo('/v1/realtime/client_secrets');

      expect((first.body!.session as any).audio).toEqual({ input: { turn_detection: null } });
      expect((second.body!.session as any).audio).toEqual({
        input: { turn_detection: { type: 'semantic_vad', eagerness: 'low' } },
      });
    });

    it('derives the connect URL from the slot baseUrl (a gateway)', async () => {
      const server = new OpenAiMockServer({ validKeys: [VALID_KEY] });
      const adapter = new OpenAiProviderAdapter(
        new AiProviderRegistry(),
        new OpenAiClientFactory({ fetch: server.fetch }),
      );

      const session = await adapter.realtime.createSession(
        { model: 'gpt-realtime' },
        { apiKey: VALID_KEY, requestId: 'r', baseUrl: 'https://gw.example.com/openai/v1/' },
      );

      expect(session.connectUrl).toBe('https://gw.example.com/openai/v1/realtime/calls');
      expect(server.requests[0].path).toBe('/openai/v1/realtime/client_secrets');
    });

    it('maps a rejected key to AI_KEY_INVALID without echoing it', async () => {
      const { adapter, server } = setup();

      const err = await caught(() =>
        adapter.realtime.createSession({ model: 'gpt-realtime' }, { apiKey: INVALID_KEY, requestId: 'r' }),
      );

      expect(err.code).toBe('AI_KEY_INVALID');
      expect(JSON.stringify(err)).not.toContain(INVALID_KEY);
      expect(server.requestsTo('/v1/realtime/client_secrets')).toHaveLength(1);
    });

    it.each([
      [429, { message: 'slow down', type: 'requests', code: 'rate_limit_exceeded' }, 'AI_RATE_LIMITED'],
      [400, { message: 'bad voice', type: 'invalid_request_error', param: 'session.audio.output.voice', code: null }, 'AI_INVALID_REQUEST'],
      [500, { message: 'boom', type: 'server_error', code: null }, 'AI_PROVIDER_UNAVAILABLE'],
    ])('maps an HTTP %s through the OpenAI errors mapper', async (status, error, code) => {
      const { adapter, ctx, server } = setup();

      server.realtimeWith(() => ({ kind: 'error', status, error }));

      const err = await caught(() => adapter.realtime.createSession({ model: 'gpt-realtime' }, ctx));

      expect(err.code).toBe(code);
    });

    it('maps a network failure to AI_PROVIDER_UNAVAILABLE', async () => {
      const { adapter, ctx, server } = setup();

      server.realtimeWith(() => ({ kind: 'network' }));

      expect((await caught(() => adapter.realtime.createSession({ model: 'gpt-realtime' }, ctx))).code).toBe(
        'AI_PROVIDER_UNAVAILABLE',
      );
    });

    it('refuses an answer with no secret as AI_PROVIDER_UNAVAILABLE', async () => {
      const { adapter, ctx, server } = setup();

      server.realtimeWith(() => ({ kind: 'client_secret', body: { expires_at: 1, session: {} } }));

      expect((await caught(() => adapter.realtime.createSession({ model: 'gpt-realtime' }, ctx))).code).toBe(
        'AI_PROVIDER_UNAVAILABLE',
      );
    });

    it('never logs the ephemeral secret or the key', async () => {
      const lines: string[] = [];
      const spies = (['log', 'debug', 'warn', 'error', 'verbose'] as const).map((method) =>
        jest.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => {
          lines.push(JSON.stringify(args));
        }),
      );

      try {
        const { adapter, ctx } = setup();
        const session = await adapter.realtime.createSession({ model: 'gpt-realtime' }, ctx);

        expect(lines.length).toBeGreaterThan(0);
        expect(lines.join('\n')).not.toContain(session.clientSecret);
        expect(lines.join('\n')).not.toContain(VALID_KEY);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  });

  describe('mapper', () => {
    it.each([9, 7201, 1.5])('refuses a TTL of %s seconds before any call', (seconds) => {
      expect(() => toOpenAiClientSecretRequest({ model: 'gpt-realtime', expiresInSeconds: seconds })).toThrow(AiError);
    });

    it('rebuilds sessionConfig from named fields, never passing through anything secret-shaped', () => {
      const session = fromOpenAiClientSecretResponse(
        {
          value: 'ek_1',
          expires_at: 10,
          session: {
            id: 'sess_1',
            object: 'realtime.session',
            type: 'realtime',
            model: 'gpt-realtime',
            client_secret: { value: 'ek_nested_should_not_surface' },
          } as never,
        },
        { request: { model: 'gpt-realtime', voice: 'cedar' } },
      );

      expect(session.clientSecret).toBe('ek_1');
      expect(session.voice).toBe('cedar');
      expect(JSON.stringify(session)).not.toContain('ek_nested_should_not_surface');
    });

    it('connect URL defaults to api.openai.com', () => {
      expect(openAiRealtimeConnectUrl(undefined)).toBe('https://api.openai.com/v1/realtime/calls');
    });
  });

  describe('classifier', () => {
    it.each(['gpt-realtime', 'gpt-realtime-mini', 'gpt-realtime-2025-08-28', 'gpt-4o-realtime-preview', 'gpt-4o-mini-realtime-preview-2024-12-17'])(
      '%s is realtime, with the realtime voices',
      (id) => {
        const caps = classifyOpenAiModel(id);

        expect(aiModelCapabilitiesSchema.safeParse(caps).success).toBe(true);
        expect(caps?.capabilities).toEqual(['realtime']);
        expect(caps?.voices).toEqual([...OPENAI_REALTIME_VOICES]);
      },
    );

    it('the realtime voices are not the speech-only ones', () => {
      expect(OPENAI_REALTIME_VOICES).not.toContain('fable');
      expect(OPENAI_REALTIME_VOICES).not.toContain('onyx');
      expect(OPENAI_REALTIME_VOICES).toEqual(expect.arrayContaining(['marin', 'cedar', 'alloy']));
    });
  });
});
