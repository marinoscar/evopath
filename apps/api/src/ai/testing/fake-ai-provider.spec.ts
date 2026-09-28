import { z } from 'zod';

import { AiError } from '../core/ai-error';
import { AiCallContext } from '../core/provider-adapter.interface';
import { AiProviderRegistry } from '../core/provider-registry';
import { AiStreamEvent } from '../core/types/responses.types';
import { FAKE_FILE_INPUT_STRATEGY, FakeAiProvider } from './fake-ai-provider';

const ctx = (apiKey = 'k', extra: Partial<AiCallContext> = {}): AiCallContext => ({
  apiKey,
  requestId: 'req',
  ...extra,
});

async function collect(stream: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('FakeAiProvider', () => {
  it('records every call with the key it was called with', async () => {
    const fake = new FakeAiProvider();

    await fake.listModels(ctx('ORG-KEY'));
    await fake.verifyKey(ctx('USER-KEY'));
    await fake.responses!.create({ model: 'fake-model', input: 'hi' }, ctx('USER-KEY'));
    await collect(fake.responses!.stream({ model: 'fake-model', input: 'hi' }, ctx('USER-KEY')));

    expect(fake.calls.map((c) => c.method)).toEqual([
      'listModels',
      'verifyKey',
      'responses.create',
      'responses.stream',
    ]);
    expect(fake.apiKeys).toEqual(['ORG-KEY', 'USER-KEY']);
    expect(fake.callsTo('responses.create')[0].request?.input).toBe('hi');

    fake.reset();
    expect(fake.calls).toEqual([]);
  });

  it('echoes the last user text by default', async () => {
    const res = await new FakeAiProvider().responses!.create(
      {
        model: 'fake-model',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'text', text: 'first' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
          { type: 'message', role: 'user', content: [{ type: 'text', text: 'second' }] },
        ],
      },
      ctx(),
    );

    expect(res.outputText).toBe('fake: second');
    expect(res.provider).toBe('fake');
    expect(res.finishReason).toBe('stop');
  });

  it('plays an array script in order and fails as AiError when exhausted', async () => {
    const fake = new FakeAiProvider({ responses: [{ outputText: 'one' }, { outputText: 'two' }] });
    const req = { model: 'fake-model', input: 'x' };

    await expect(fake.responses!.create(req, ctx())).resolves.toMatchObject({ outputText: 'one' });
    await expect(fake.responses!.create(req, ctx())).resolves.toMatchObject({ outputText: 'two' });
    await expect(fake.responses!.create(req, ctx())).rejects.toBeInstanceOf(AiError);
  });

  it('wraps a raw error thrown by a script function', async () => {
    const fake = new FakeAiProvider({
      responses: () => {
        throw new TypeError('boom');
      },
    });

    await expect(fake.responses!.create({ model: 'fake-model', input: 'x' }, ctx())).rejects.toMatchObject({
      code: 'AI_PROVIDER_UNAVAILABLE',
    });
  });

  it('honours validKeys', async () => {
    const fake = new FakeAiProvider({ validKeys: ['good'] });

    await expect(fake.verifyKey(ctx('bad'))).resolves.toEqual(
      expect.objectContaining({ ok: false, code: 'AI_KEY_INVALID' }),
    );
    await expect(fake.responses!.create({ model: 'fake-model', input: 'x' }, ctx('bad'))).rejects.toMatchObject({
      code: 'AI_KEY_INVALID',
    });
    await expect(fake.verifyKey(ctx('good'))).resolves.toEqual({ ok: true });
  });

  it('refuses a capability the model is not classified with', async () => {
    const fake = new FakeAiProvider({
      classify: {
        'plain-model': { capabilities: ['responses'], inputModalities: ['text'], outputModalities: ['text'] },
      },
    });

    await expect(
      fake.responses!.create(
        { model: 'plain-model', input: 'x', structuredOutput: { name: 's', schema: z.object({}) } },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'AI_CAPABILITY_UNSUPPORTED' });

    const events = await collect(fake.responses!.stream({ model: 'plain-model', input: 'x' }, ctx()));
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'AI_CAPABILITY_UNSUPPORTED' })]);
  });

  it('validates structured output into parsed', async () => {
    const fake = new FakeAiProvider({ responses: [{ outputText: '{"n":1}' }, { outputText: '{"n":"x"}' }] });
    const req = { model: 'fake-model', input: 'x', structuredOutput: { name: 's', schema: z.object({ n: z.number() }) } };

    await expect(fake.responses!.create(req, ctx())).resolves.toMatchObject({ parsed: { n: 1 } });
    await expect(fake.responses!.create(req, ctx())).rejects.toMatchObject({ code: 'AI_STRUCTURED_OUTPUT_INVALID' });
  });

  it('streams by chunking outputText', async () => {
    const fake = new FakeAiProvider({ responses: [{ outputText: 'abcdefg' }], chunkSize: 3 });
    const events = await collect(fake.responses!.stream({ model: 'fake-model', input: 'x' }, ctx()));

    expect(events.map((e) => e.type)).toEqual([
      'response.created',
      'output_text.delta',
      'output_text.delta',
      'output_text.delta',
      'output_item.done',
      'response.completed',
    ]);
    expect(
      events.flatMap((e) => (e.type === 'output_text.delta' ? [e.delta] : [])),
    ).toEqual(['abc', 'def', 'g']);
  });

  it('observes an abort mid-stream and records it', async () => {
    const fake = new FakeAiProvider({ responses: [{ outputText: 'a long answer indeed' }], chunkSize: 2, delayMs: 5 });
    const controller = new AbortController();
    const seen: AiStreamEvent[] = [];

    await expect(
      (async () => {
        for await (const event of fake.responses!.stream(
          { model: 'fake-model', input: 'x' },
          ctx('k', { signal: controller.signal }),
        )) {
          seen.push(event);
          if (seen.length === 2) controller.abort();
        }
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(seen.some((e) => e.type === 'response.completed')).toBe(false);
    expect(fake.callsTo('responses.stream')[0].aborted).toBe(true);
  });

  it('observes an abort during create', async () => {
    const fake = new FakeAiProvider({ delayMs: 50 });
    const controller = new AbortController();
    const pending = fake.responses!.create({ model: 'fake-model', input: 'x' }, ctx('k', { signal: controller.signal }));

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.calls[0].aborted).toBe(true);
  });

  it('carries only the ports it was given, which the registry reads', () => {
    const registry = new AiProviderRegistry();

    registry.register(new FakeAiProvider({ id: 'text-only' }));
    registry.register(
      new FakeAiProvider({ id: 'embed-only', responsesPort: false, ports: { embeddings: { embed: jest.fn() } } }),
    );

    expect(registry.supports('text-only', 'responses')).toBe(true);
    expect(registry.supports('text-only', 'embeddings')).toBe(false);
    expect(registry.capabilities('embed-only')).toEqual(['embeddings']);
  });
  describe('storage-object inputs (#441)', () => {
    const req = {
      model: 'fake-model',
      input: [
        {
          type: 'message' as const,
          role: 'user' as const,
          content: [
            { type: 'image' as const, storageObjectId: 'img' },
            { type: 'file' as const, storageObjectId: 'doc' },
          ],
        },
      ],
    };
    const storageInputs = new Map([
      ['img', { storageObjectId: 'img', modality: 'image' as const, mimeType: 'image/png', filename: 'a.png', strategy: 'presigned_url' as const, url: 'https://signed' }],
      [
        'doc',
        {
          storageObjectId: 'doc',
          modality: 'file' as const,
          mimeType: 'application/pdf',
          filename: 'b.pdf',
          strategy: 'upload' as const,
          open: async () => (async function* () {
            yield new Uint8Array([1, 2, 3]);
          })(),
        },
      ],
    ]);

    it("declares OpenAI's strategy by default, and none with fileInputStrategy: false", () => {
      expect(new FakeAiProvider().fileInputStrategy).toEqual(FAKE_FILE_INPUT_STRATEGY);
      expect(new FakeAiProvider({ fileInputStrategy: false }).fileInputStrategy).toBeUndefined();
    });

    it('records the URL / uploaded file id it received, and deletes the upload afterwards', async () => {
      const fake = new FakeAiProvider();

      const res = await fake.responses!.create(req, ctx('k', { storageInputs }));

      expect(res.outputText).toContain('a.png, b.pdf');
      expect(fake.calls[0].storageInputs).toEqual([
        expect.objectContaining({ storageObjectId: 'img', url: 'https://signed' }),
        expect.objectContaining({ storageObjectId: 'doc', fileId: 'fake_file_1', bytes: 3 }),
      ]);
      expect(fake.deletedFileIds).toEqual(['fake_file_1']);
    });

    it('refuses a storage part the runtime did not resolve', async () => {
      await expect(new FakeAiProvider().responses!.create(req, ctx())).rejects.toMatchObject({
        code: 'AI_INVALID_REQUEST',
      });
    });
  });
});
