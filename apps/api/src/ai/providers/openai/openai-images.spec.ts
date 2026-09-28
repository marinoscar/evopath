// The OpenAI images port (issue #437): the adapter against the mocked
// transport (the real SDK builds the JSON / multipart request and parses the
// reply), plus the mapper's pure edge cases.

import { Logger } from '@nestjs/common';

import { AiError } from '../../core/ai-error';
import { AiProviderRegistry } from '../../core/provider-registry';
import type { AiCallContext } from '../../core/provider-adapter.interface';
import { OpenAiClientFactory } from './openai-client.factory';
import {
  fromOpenAiImagesResponse,
  isOpenAiDallE,
  toOpenAiImageEditRequest,
  toOpenAiImageGenerateRequest,
} from './openai-images.mapper';
import { OpenAiProviderAdapter } from './openai.adapter';
import { MOCK_PNG_BASE64, OpenAiMockServer } from './testing/openai-mock-transport';

const VALID_KEY = 'sk-proj-IMAGES-valid-abcdefghijk';
const INVALID_KEY = 'sk-proj-IMAGES-revoked-lmnopqrs';
const PNG = Buffer.from(MOCK_PNG_BASE64, 'base64');

function setup() {
  const server = new OpenAiMockServer({ validKeys: [VALID_KEY] });
  const adapter = new OpenAiProviderAdapter(new AiProviderRegistry(), new OpenAiClientFactory({ fetch: server.fetch }));
  const ctx: AiCallContext = { apiKey: VALID_KEY, requestId: 'req-images-1' };

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

describe('OpenAI images port', () => {
  it('is carried with both generate and edit — presence is the declaration', () => {
    const { adapter } = setup();

    expect(typeof adapter.images.generate).toBe('function');
    expect(typeof adapter.images.edit).toBe('function');
  });

  describe('generate', () => {
    it('POSTs /v1/images/generations as JSON with the key and the GPT-image parameters', async () => {
      const { adapter, ctx, server } = setup();

      await adapter.images.generate(
        {
          model: 'gpt-image-1',
          prompt: 'a red fox',
          n: 2,
          size: '1024x1024',
          quality: 'high',
          background: 'transparent',
          outputFormat: 'webp',
        },
        ctx,
      );

      const [req] = server.requestsTo('/v1/images/generations');

      expect(req.method).toBe('POST');
      expect(req.apiKey).toBe(VALID_KEY);
      expect(req.body).toEqual({
        model: 'gpt-image-1',
        prompt: 'a red fox',
        n: 2,
        size: '1024x1024',
        quality: 'high',
        background: 'transparent',
        output_format: 'webp',
        stream: false,
      });
    });

    it('returns decoded bytes with the MIME type of the produced format, plus token usage', async () => {
      const { adapter, ctx } = setup();

      const result = await adapter.images.generate({ model: 'gpt-image-1', prompt: 'a red fox', n: 2, outputFormat: 'jpeg' }, ctx);

      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-image-1');
      expect(result.images).toHaveLength(2);
      expect(Buffer.from(result.images[0].data).equals(PNG)).toBe(true);
      expect(result.images[0].mimeType).toBe('image/jpeg');
      expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 544 });
      expect(result.providerRequestId).toMatch(/^req_mock_/);
    });

    it('asks DALL·E for b64_json, maps quality high to hd on DALL·E 3, and omits GPT-image-only fields', async () => {
      const { adapter, ctx, server } = setup();

      const result = await adapter.images.generate(
        { model: 'dall-e-3', prompt: 'a red fox', quality: 'high', background: 'transparent', outputFormat: 'webp' },
        ctx,
      );

      expect(server.requestsTo('/v1/images/generations')[0].body).toEqual({
        model: 'dall-e-3',
        prompt: 'a red fox',
        response_format: 'b64_json',
        quality: 'hd',
        stream: false,
      });
      // DALL·E always produces PNG, whatever was asked for.
      expect(result.images[0].mimeType).toBe('image/png');
      expect(result.images[0].revisedPrompt).toBe('revised: a red fox #1');
      expect(result.usage).toEqual({});
    });

    it('lets providerOptions.openai add parameters, but never override the port’s own fields', () => {
      const body = toOpenAiImageGenerateRequest({
        model: 'gpt-image-1',
        prompt: 'p',
        providerOptions: { openai: { moderation: 'low', model: 'dall-e-2', stream: true } },
      });

      expect(body).toEqual({ moderation: 'low', model: 'gpt-image-1', prompt: 'p', stream: false });
    });

    it('a rejected key is AI_KEY_INVALID and the key never reaches the error or the log', async () => {
      const { adapter, ctx } = setup();
      const logged: string[] = [];
      const spy = jest.spyOn(Logger.prototype, 'debug').mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      });

      try {
        const err = await caught(() =>
          adapter.images.generate({ model: 'gpt-image-1', prompt: 'x' }, { ...ctx, apiKey: INVALID_KEY }),
        );

        expect(err.code).toBe('AI_KEY_INVALID');
        expect(JSON.stringify(err)).not.toContain(INVALID_KEY);
        expect(logged.join('\n')).not.toContain(INVALID_KEY);
        expect(logged.join('\n')).toContain('images.generate');
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      [400, 'moderation_blocked', 'AI_CONTENT_FILTERED'],
      [400, 'invalid_value', 'AI_INVALID_REQUEST'],
      [429, 'rate_limit_exceeded', 'AI_RATE_LIMITED'],
      [500, null, 'AI_PROVIDER_UNAVAILABLE'],
    ])('a %s (%s) maps to %s', async (status, code, expected) => {
      const { adapter, ctx, server } = setup();

      server.imagesWith(() => ({
        kind: 'error',
        status,
        error: { message: `failure for ${VALID_KEY}`, type: 'invalid_request_error', param: null, code },
      }));

      const err = await caught(() => adapter.images.generate({ model: 'gpt-image-1', prompt: 'x' }, ctx));

      expect(err.code).toBe(expected);
      expect(JSON.stringify(err)).not.toContain(VALID_KEY);
    });

    it('a network failure is AI_PROVIDER_UNAVAILABLE, never a raw TypeError', async () => {
      const { adapter, ctx, server } = setup();

      server.imagesWith(() => ({ kind: 'network' }));

      const err = await caught(() => adapter.images.generate({ model: 'gpt-image-1', prompt: 'x' }, ctx));

      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
    });
  });

  describe('edit', () => {
    it('POSTs /v1/images/edits as multipart, with each source image and the mask as typed files', async () => {
      const { adapter, ctx, server } = setup();

      const result = await adapter.images.edit!(
        {
          model: 'gpt-image-1',
          prompt: 'add a hat',
          images: [
            { data: PNG, mimeType: 'image/png', filename: 'cat.png' },
            { data: PNG, mimeType: 'image/webp' },
          ],
          mask: { data: PNG, mimeType: 'image/png' },
          n: 1,
          outputFormat: 'png',
        },
        ctx,
      );

      const [req] = server.requestsTo('/v1/images/edits');

      expect(req.apiKey).toBe(VALID_KEY);
      expect(req.body).toMatchObject({
        model: 'gpt-image-1',
        prompt: 'add a hat',
        n: '1',
        output_format: 'png',
        'image[]': [
          { filename: 'cat.png', type: 'image/png', size: PNG.length },
          { filename: 'image-2.webp', type: 'image/webp', size: PNG.length },
        ],
        mask: { filename: 'mask.png', type: 'image/png', size: PNG.length },
      });
      expect(result.images).toHaveLength(1);
      expect(result.images[0].mimeType).toBe('image/png');
    });

    it('sends DALL·E 2 its one image as a single file and asks for b64_json', async () => {
      const body = await toOpenAiImageEditRequest({
        model: 'dall-e-2',
        prompt: 'p',
        quality: 'high',
        images: [{ data: PNG, mimeType: 'image/png' }],
      });

      expect(Array.isArray(body.image)).toBe(false);
      expect(body.response_format).toBe('b64_json');
      expect(body.quality).toBeUndefined();
    });

    it('refuses an edit with no source image before any request is made', async () => {
      const { adapter, ctx, server } = setup();

      const err = await caught(() => adapter.images.edit!({ model: 'gpt-image-1', prompt: 'p', images: [] }, ctx));

      expect(err.code).toBe('AI_INVALID_REQUEST');
      expect(server.requestsTo('/v1/images/edits')).toEqual([]);
    });
  });

  describe('fromOpenAiImagesResponse', () => {
    const request = { model: 'gpt-image-1', prompt: 'p' };

    it('refuses an answer with no images as a malformed provider reply', () => {
      expect(() => fromOpenAiImagesResponse({ created: 1, data: [] }, { request })).toThrow(
        expect.objectContaining({ code: 'AI_PROVIDER_UNAVAILABLE' }),
      );
    });

    it('refuses a URL-only answer rather than fetching a provider-hosted URL', () => {
      expect(() =>
        fromOpenAiImagesResponse({ created: 1, data: [{ url: 'https://example.invalid/x.png' }] }, { request }),
      ).toThrow(expect.objectContaining({ code: 'AI_PROVIDER_UNAVAILABLE' }));
    });

    it('falls back to the requested outputFormat, then to PNG, for the MIME type', () => {
      const data = { created: 1, data: [{ b64_json: MOCK_PNG_BASE64 }] };

      expect(fromOpenAiImagesResponse(data, { request: { ...request, outputFormat: 'webp' } }).images[0].mimeType).toBe(
        'image/webp',
      );
      expect(fromOpenAiImagesResponse(data, { request }).images[0].mimeType).toBe('image/png');
    });

    it('recognises the DALL·E family by id', () => {
      expect(isOpenAiDallE('dall-e-2')).toBe(true);
      expect(isOpenAiDallE('DALL-E-3')).toBe(true);
      expect(isOpenAiDallE('gpt-image-1')).toBe(false);
    });
  });
});
