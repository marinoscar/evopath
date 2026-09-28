// =============================================================================
// AI provider conformance kit (issue #424, epic #419)
// =============================================================================
//
// ONE Jest suite every provider adapter runs, so "implements
// AiProviderAdapter" means the same thing for every provider — including a
// fork's own. Usage, from a `*.conformance.spec.ts`:
//
//   describeAiProviderConformance('OpenAI adapter', () => ({
//     adapter: new OpenAiAdapter(registry, { fetch: mockedFetch }),
//     ctx: { apiKey: 'sk-valid', requestId: 'conf-1' },
//     fixtures: { invalidApiKey: 'sk-bad', classify: {...}, responses: {...} },
//   }));
//
// The kit owns the REQUESTS (`conformanceRequests()`, the canonical schema
// and tool below are exported so a mocked HTTP layer can answer them); the
// fixtures own what only the provider knows (which keys and model ids exist,
// which request it cannot serve, which request makes it fail). `factory` runs
// before EVERY test, so a stateful mock starts clean each time, and the
// optional `arrange(scenario)` hook runs before each scenario's calls for a
// mock that needs to queue a specific reply.
//
// Real network is never required; adapters run this against a mocked
// transport (#426).
// =============================================================================

import { z } from 'zod';

import { AiError, isAiErrorCode } from '../core/ai-error';
import { aiModelCapabilitiesSchema } from '../core/capabilities';
import { asInputItems, replayOutput } from '../core/conversation';
import { AiCallContext, AiProviderAdapter } from '../core/provider-adapter.interface';
import { defineTool } from '../core/tools';
import {
  AiEmbeddingRequest,
  AiEmbeddingResult,
  AiImageGenerationRequest,
  AiImageResult,
  AiTranscriptionRequest,
  AiTranscriptionResult,
  AI_SPEECH_INPUT_MAX_CHARS,
  AI_TRANSCRIPTION_DEFAULT_MAX_BYTES,
} from '../core/types/media.types';
import { AiOutputItem, AiResponse, AiResponseRequest, AiStreamEvent } from '../core/types/responses.types';

export type AiConformanceScenario =
  | 'listModels'
  | 'listModels.invalidKey'
  | 'verifyKey.valid'
  | 'verifyKey.invalid'
  | 'classifyModel'
  | 'responses.text'
  | 'responses.stream'
  | 'responses.structured'
  | 'responses.toolCall'
  | 'responses.toolResult'
  | 'responses.unsupported'
  | 'responses.invalidKey'
  | 'responses.providerError'
  | 'responses.streamProviderError'
  | 'embeddings.single'
  | 'embeddings.batch'
  | 'embeddings.dimensions'
  | 'embeddings.invalidKey'
  | 'embeddings.providerError'
  | 'images.generate'
  | 'images.edit'
  | 'images.invalidKey'
  | 'images.providerError'
  | 'audio.transcribe'
  | 'audio.transcribeStream'
  | 'audio.transcribeTooLarge'
  | 'audio.transcribeInvalidKey'
  | 'audio.transcribeProviderError'
  | 'audio.speech'
  | 'audio.speechVoices'
  | 'audio.speechTooLong'
  | 'audio.speechInvalidKey'
  | 'audio.speechProviderError';

export interface AiConformanceFixtures {
  /** A key the provider rejects. */
  invalidApiKey: string;
  /** Ids `listModels` must include (a subset is fine). */
  expectedModelIds?: string[];
  classify: {
    /** Ids `classifyModel` must classify (schema-valid capabilities). */
    known: string[];
    /** Ids `classifyModel` must return `null` for. */
    unknown: string[];
  };
  /** Required when the adapter carries a `responses` port. */
  responses?: {
    /** A model supporting text, streaming, structured output and function tools. */
    model: string;
    /** A request the provider must refuse with `AI_CAPABILITY_UNSUPPORTED`. */
    unsupportedRequest: AiResponseRequest;
    /** A request that makes the provider fail (e.g. a mocked 500 / socket error). */
    failingRequest: AiResponseRequest;
  };
  /** Required when the adapter carries an `embeddings` port. */
  embeddings?: {
    /** A model with the `embeddings` capability. */
    model: string;
    /** A length `model` can be shortened to with `dimensions`; omit when it cannot. */
    shortenTo?: number;
    /** A request that makes the provider fail. */
    failingRequest: AiEmbeddingRequest;
  };
  /** Required when the adapter carries an `images` port. */
  images?: {
    /** A model with `image_generation` (and `image_edit`, when the port carries `edit`). */
    model: string;
    /** A request that makes the provider fail. */
    failingRequest: AiImageGenerationRequest;
  };
  /** Required when the adapter's `audio` port carries `transcribe`. */
  transcription?: {
    /** A model with `audio_transcription`. */
    model: string;
    /** A request that makes the provider fail (its `audio` is replaced by the kit's). */
    failingModel: string;
  };
  /** Required when the adapter's `audio` port carries `speech`. */
  speech?: {
    /** A model with `audio_speech`. */
    model: string;
    /** A voice `model` speaks. */
    voice: string;
    /** A model that makes the provider fail. */
    failingModel: string;
  };
  /** Runs before each scenario's calls — for a mocked transport that queues replies. */
  arrange?(scenario: AiConformanceScenario): void | Promise<void>;
}

export interface AiConformanceSubject {
  adapter: AiProviderAdapter;
  /** A context carrying a VALID key. */
  ctx: AiCallContext;
  fixtures: AiConformanceFixtures;
}

export interface AiConformanceOptions {
  /** Scenarios to skip, with the reason in the caller's comment. */
  skip?: AiConformanceScenario[];
}

// ---- The canonical requests ------------------------------------------------------

export const CONFORMANCE_TEXT_PROMPT = 'Reply with a short friendly greeting.';
export const CONFORMANCE_STRUCTURED_PROMPT = 'What is the capital of France and roughly how many people live there?';
export const CONFORMANCE_TOOL_PROMPT = 'What is the weather in Paris right now? Use the tool.';
export const CONFORMANCE_EMBEDDING_INPUTS = ['The quick brown fox.', 'jumps over', 'the lazy dog.'];
export const CONFORMANCE_IMAGE_PROMPT = 'A watercolour lighthouse at dusk.';

/** A real 1x1 PNG — the source image the kit's edit scenario sends. */
export const CONFORMANCE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A real, tiny WAV (8 kHz mono 16-bit, 0.05 s of silence) — the audio the
 * kit's transcription scenarios send.
 */
export const CONFORMANCE_WAV = (() => {
  const samples = 400;
  const data = samples * 2;
  const wav = Buffer.alloc(44 + data);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + data, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(data, 40);

  return wav;
})();

/** `CONFORMANCE_WAV` as a stream of small chunks. */
async function* conformanceWavStream(): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < CONFORMANCE_WAV.length; i += 128) yield CONFORMANCE_WAV.subarray(i, i + 128);
}

/** The structured-output schema the kit requests. */
export const conformanceStructuredSchema = z.object({
  city: z.string(),
  population: z.number().int(),
});

/** The function tool the kit offers. */
export const conformanceWeatherTool = defineTool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: z.object({ city: z.string() }),
  execute: ({ city }) => ({ city, temperatureC: 21, conditions: 'sunny' }),
});

export function conformanceRequests(model: string) {
  const toolCall = {
    model,
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: CONFORMANCE_TOOL_PROMPT }] }],
    tools: [conformanceWeatherTool.tool],
    toolChoice: 'required',
  } satisfies AiResponseRequest;

  return {
    text: { model, input: CONFORMANCE_TEXT_PROMPT, maxOutputTokens: 64 } satisfies AiResponseRequest,
    structured: {
      model,
      input: CONFORMANCE_STRUCTURED_PROMPT,
      structuredOutput: { name: 'city_facts', schema: conformanceStructuredSchema, strict: true },
    } satisfies AiResponseRequest,
    toolCall,
    toolResult: (previousResponseId: string, callId: string, output: string): AiResponseRequest => ({
      model,
      previousResponseId,
      input: [{ type: 'function_call_output', callId, output }],
      tools: [conformanceWeatherTool.tool],
    }),
    /**
     * The same follow-up for a provider that stores no responses
     * (`supportsPreviousResponseId: false`, #446): the whole conversation —
     * the tool-call request's input, the model's first answer replayed, and
     * the tool's result — exactly as the runtime's tool loop sends it.
     */
    toolResultFromHistory: (firstOutput: AiOutputItem[], callId: string, output: string): AiResponseRequest => ({
      model,
      input: [
        ...asInputItems(toolCall.input),
        ...replayOutput(firstOutput),
        { type: 'function_call_output', callId, output },
      ],
      tools: [conformanceWeatherTool.tool],
    }),
  };
}

// ---- helpers ------------------------------------------------------------------------

async function expectAiError(run: () => Promise<unknown>, code?: string): Promise<AiError> {
  let caught: unknown;

  try {
    await run();
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(AiError);

  if (code) {
    expect((caught as AiError).code).toBe(code);
  }

  return caught as AiError;
}

async function collect(stream: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

function messageText(output: AiOutputItem[]): string {
  return output
    .filter((item): item is Extract<AiOutputItem, { type: 'message' }> => item.type === 'message')
    .map((item) => item.text)
    .join('');
}

function expectWellFormedResponse(response: AiResponse, adapter: AiProviderAdapter): void {
  expect(typeof response.id).toBe('string');
  expect(response.id.length).toBeGreaterThan(0);
  expect(response.provider).toBe(adapter.id);
  expect(typeof response.model).toBe('string');
  expect(Array.isArray(response.output)).toBe(true);
  expect(typeof response.usage).toBe('object');
  expect(['stop', 'length', 'tool_calls', 'content_filter', 'error']).toContain(response.finishReason);
  expect(response.outputText).toBe(messageText(response.output));
}

function expectWellFormedEmbedding(result: AiEmbeddingResult, adapter: AiProviderAdapter, count: number): void {
  expect(result.provider).toBe(adapter.id);
  expect(typeof result.model).toBe('string');
  expect(typeof result.usage).toBe('object');
  expect(result.vectors).toHaveLength(count);
  expect(result.dimensions).toBeGreaterThan(0);

  for (const vector of result.vectors) {
    expect(Array.isArray(vector)).toBe(true);
    expect(vector).toHaveLength(result.dimensions);
    expect(vector.every((value) => typeof value === 'number' && Number.isFinite(value))).toBe(true);
  }
}

function expectWellFormedImages(result: AiImageResult, adapter: AiProviderAdapter, count: number): void {
  expect(result.provider).toBe(adapter.id);
  expect(typeof result.model).toBe('string');
  expect(typeof result.usage).toBe('object');
  expect(result.images).toHaveLength(count);

  for (const image of result.images) {
    expect(image.data).toBeInstanceOf(Uint8Array);
    expect(image.data.length).toBeGreaterThan(0);
    expect(image.mimeType).toMatch(/^image\//);
  }
}

function expectWellFormedTranscription(result: AiTranscriptionResult, adapter: AiProviderAdapter): void {
  expect(result.provider).toBe(adapter.id);
  expect(typeof result.model).toBe('string');
  expect(typeof result.usage).toBe('object');
  expect(typeof result.text).toBe('string');
  expect(result.text.length).toBeGreaterThan(0);

  if (result.durationSeconds !== undefined) {
    expect(Number.isFinite(result.durationSeconds) && result.durationSeconds >= 0).toBe(true);
  }

  for (const segment of result.segments ?? []) {
    expect(segment.endSeconds).toBeGreaterThanOrEqual(segment.startSeconds);
    expect(typeof segment.text).toBe('string');
  }
}

// ---- The suite ------------------------------------------------------------------------

export function describeAiProviderConformance(
  name: string,
  factory: () => AiConformanceSubject | Promise<AiConformanceSubject>,
  options: AiConformanceOptions = {},
): void {
  const skip = new Set(options.skip ?? []);

  describe(`AI provider conformance: ${name}`, () => {
    let subject: AiConformanceSubject;

    const scenario = (id: AiConformanceScenario, title: string, fn: () => Promise<void>) => {
      const register = skip.has(id) ? it.skip : it;

      register(`[${id}] ${title}`, async () => {
        await subject.fixtures.arrange?.(id);
        await fn();
      });
    };

    const invalidCtx = (): AiCallContext => ({ ...subject.ctx, apiKey: subject.fixtures.invalidApiKey });

    beforeEach(async () => {
      subject = await factory();
    });

    it('declares a stable id and a display name', () => {
      expect(subject.adapter.id).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
      expect(subject.adapter.displayName.length).toBeGreaterThan(0);
    });

    scenario('listModels', 'listModels returns model ids', async () => {
      const models = await subject.adapter.listModels(subject.ctx);

      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);

      for (const model of models) {
        expect(typeof model.id).toBe('string');
        expect(model.id.length).toBeGreaterThan(0);
      }

      const ids = models.map((model) => model.id);

      for (const expected of subject.fixtures.expectedModelIds ?? []) {
        expect(ids).toContain(expected);
      }
    });

    scenario('listModels.invalidKey', 'listModels with a rejected key fails as AiError', async () => {
      await expectAiError(() => subject.adapter.listModels(invalidCtx()));
    });

    scenario('verifyKey.valid', 'verifyKey accepts a valid key', async () => {
      await expect(subject.adapter.verifyKey(subject.ctx)).resolves.toMatchObject({ ok: true });
    });

    scenario('verifyKey.invalid', 'verifyKey answers (not throws) AI_KEY_INVALID for a rejected key', async () => {
      const result = await subject.adapter.verifyKey(invalidCtx());

      expect(result.ok).toBe(false);
      expect(result.code).toBe('AI_KEY_INVALID');
    });

    scenario('classifyModel', 'classifyModel returns schema-valid capabilities or null', async () => {
      const { known, unknown } = subject.fixtures.classify;

      expect(known.length).toBeGreaterThan(0);

      for (const id of known) {
        const caps = subject.adapter.classifyModel(id);

        expect(caps).not.toBeNull();
        expect(aiModelCapabilitiesSchema.safeParse(caps).success).toBe(true);
      }

      for (const id of unknown) {
        expect(subject.adapter.classifyModel(id)).toBeNull();
      }
    });

    describe('responses port', () => {
      const port = () => {
        const responses = subject.adapter.responses;
        const fixture = subject.fixtures.responses;

        if (!responses || !fixture) {
          throw new Error('unreachable: guarded by hasPort()');
        }

        return { responses, fixture, requests: conformanceRequests(fixture.model) };
      };

      // Registration of the tests below cannot depend on `subject` (it does not
      // exist at collection time), so each test checks port presence itself.
      const whenPort = (fn: () => Promise<void>) => async () => {
        if (!subject.adapter.responses) {
          return;
        }

        expect(subject.fixtures.responses).toBeDefined();
        await fn();
      };

      it('has create and stream when the port is present', () => {
        if (!subject.adapter.responses) {
          return;
        }

        expect(typeof subject.adapter.responses.create).toBe('function');
        expect(typeof subject.adapter.responses.stream).toBe('function');
      });

      scenario('responses.text', 'create returns outputText', whenPort(async () => {
        const { responses, requests } = port();
        const response = await responses.create(requests.text, subject.ctx);

        expectWellFormedResponse(response, subject.adapter);
        expect(response.outputText.length).toBeGreaterThan(0);
        expect(response.finishReason).toBe('stop');
      }));

      scenario('responses.stream', 'stream yields created … completed in order, deltas equal final text', whenPort(async () => {
        const { responses, requests } = port();
        const events = await collect(responses.stream(requests.text, subject.ctx));

        expect(events.length).toBeGreaterThanOrEqual(2);
        expect(events[0].type).toBe('response.created');

        const last = events[events.length - 1];
        expect(last.type).toBe('response.completed');
        expect(events.filter((e) => e.type === 'response.completed')).toHaveLength(1);
        expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
        expect(events.filter((e) => e.type === 'response.created')).toHaveLength(1);

        const completed = (last as Extract<AiStreamEvent, { type: 'response.completed' }>).response;
        const created = events[0] as Extract<AiStreamEvent, { type: 'response.created' }>;
        const deltas = events
          .filter((e): e is Extract<AiStreamEvent, { type: 'output_text.delta' }> => e.type === 'output_text.delta')
          .map((e) => e.delta)
          .join('');

        expectWellFormedResponse(completed, subject.adapter);
        expect(completed.id).toBe(created.id);
        expect(completed.outputText.length).toBeGreaterThan(0);
        expect(deltas).toBe(completed.outputText);
      }));

      scenario('responses.structured', 'structured output returns parsed data that passes the schema', whenPort(async () => {
        const { responses, requests } = port();
        const response = await responses.create(requests.structured, subject.ctx);

        expectWellFormedResponse(response, subject.adapter);
        expect(response.parsed).toBeDefined();
        expect(conformanceStructuredSchema.safeParse(response.parsed).success).toBe(true);
        expect(response.parsed).toEqual(conformanceStructuredSchema.parse(JSON.parse(response.outputText)));
      }));

      scenario('responses.toolCall', 'function tool call round-trip', whenPort(async () => {
        const { responses, requests } = port();

        const first = await responses.create(requests.toolCall, subject.ctx);

        expectWellFormedResponse(first, subject.adapter);
        expect(first.finishReason).toBe('tool_calls');

        const call = first.output.find(
          (item): item is Extract<AiOutputItem, { type: 'function_call' }> => item.type === 'function_call',
        );

        expect(call).toBeDefined();
        expect(call?.name).toBe(conformanceWeatherTool.tool.name);
        expect(call?.callId.length).toBeGreaterThan(0);

        const args = conformanceWeatherTool.parseArguments(call!.arguments);
        expect(args.success).toBe(true);

        const result = await conformanceWeatherTool.execute(
          args.success ? args.data : { city: '' },
          { userId: 'conformance-user', requestId: subject.ctx.requestId },
        );

        await subject.fixtures.arrange?.('responses.toolResult');

        // The adapter's declared flag (#446) decides how the follow-up
        // travels: chained onto the first response, or as full history.
        const followUp =
          subject.adapter.supportsPreviousResponseId === false
            ? requests.toolResultFromHistory(first.output, call!.callId, JSON.stringify(result))
            : requests.toolResult(first.id, call!.callId, JSON.stringify(result));

        const second = await responses.create(followUp, subject.ctx);

        expectWellFormedResponse(second, subject.adapter);
        expect(second.finishReason).toBe('stop');
        expect(second.outputText.length).toBeGreaterThan(0);
        expect(second.output.some((item) => item.type === 'function_call')).toBe(false);
      }));

      scenario('responses.unsupported', 'an unsupported capability surfaces as AI_CAPABILITY_UNSUPPORTED', whenPort(async () => {
        const { responses, fixture } = port();

        await expectAiError(() => responses.create(fixture.unsupportedRequest, subject.ctx), 'AI_CAPABILITY_UNSUPPORTED');
      }));

      scenario('responses.invalidKey', 'a rejected key surfaces as AI_KEY_INVALID', whenPort(async () => {
        const { responses, requests } = port();

        await expectAiError(() => responses.create(requests.text, invalidCtx()), 'AI_KEY_INVALID');
      }));

      scenario('responses.providerError', 'a provider failure surfaces as AiError, never a raw error', whenPort(async () => {
        const { responses, fixture } = port();

        await expectAiError(() => responses.create(fixture.failingRequest, subject.ctx));
      }));

      scenario('responses.streamProviderError', 'a streamed provider failure is an AiError or an error event', whenPort(async () => {
        const { responses, fixture } = port();
        const events: AiStreamEvent[] = [];
        let thrown: unknown;

        try {
          for await (const event of responses.stream(fixture.failingRequest, subject.ctx)) {
            events.push(event);
          }
        } catch (err) {
          thrown = err;
        }

        expect(events.some((e) => e.type === 'response.completed')).toBe(false);

        if (thrown !== undefined) {
          expect(thrown).toBeInstanceOf(AiError);
        } else {
          const last = events[events.length - 1];

          expect(last?.type).toBe('error');
          expect(isAiErrorCode((last as Extract<AiStreamEvent, { type: 'error' }>).code)).toBe(true);
        }
      }));
    });

    describe('embeddings port', () => {
      const port = () => {
        const embeddings = subject.adapter.embeddings;
        const fixture = subject.fixtures.embeddings;

        if (!embeddings || !fixture) {
          throw new Error('unreachable: guarded by whenPort()');
        }

        return { embeddings, fixture };
      };

      const whenPort = (fn: () => Promise<void>) => async () => {
        if (!subject.adapter.embeddings) {
          return;
        }

        expect(subject.fixtures.embeddings).toBeDefined();
        await fn();
      };

      scenario('embeddings.single', 'a string input yields exactly one vector', whenPort(async () => {
        const { embeddings, fixture } = port();
        const result = await embeddings.embed({ model: fixture.model, input: CONFORMANCE_EMBEDDING_INPUTS[0] }, subject.ctx);

        expectWellFormedEmbedding(result, subject.adapter, 1);
      }));

      scenario('embeddings.batch', 'a batch yields one vector per input, in input order', whenPort(async () => {
        const { embeddings, fixture } = port();
        const batch = await embeddings.embed({ model: fixture.model, input: CONFORMANCE_EMBEDDING_INPUTS }, subject.ctx);

        expectWellFormedEmbedding(batch, subject.adapter, CONFORMANCE_EMBEDDING_INPUTS.length);

        await subject.fixtures.arrange?.('embeddings.single');

        const last = CONFORMANCE_EMBEDDING_INPUTS[CONFORMANCE_EMBEDDING_INPUTS.length - 1];
        const alone = await embeddings.embed({ model: fixture.model, input: last }, subject.ctx);

        expect(batch.vectors[batch.vectors.length - 1]).toEqual(alone.vectors[0]);
      }));

      scenario('embeddings.dimensions', '`dimensions` shortens every vector to that length', whenPort(async () => {
        const { embeddings, fixture } = port();

        if (fixture.shortenTo === undefined) {
          return;
        }

        const result = await embeddings.embed(
          { model: fixture.model, input: CONFORMANCE_EMBEDDING_INPUTS, dimensions: fixture.shortenTo },
          subject.ctx,
        );

        expectWellFormedEmbedding(result, subject.adapter, CONFORMANCE_EMBEDDING_INPUTS.length);
        expect(result.dimensions).toBe(fixture.shortenTo);
      }));

      scenario('embeddings.invalidKey', 'a rejected key surfaces as AI_KEY_INVALID', whenPort(async () => {
        const { embeddings, fixture } = port();

        await expectAiError(
          () => embeddings.embed({ model: fixture.model, input: CONFORMANCE_EMBEDDING_INPUTS[0] }, invalidCtx()),
          'AI_KEY_INVALID',
        );
      }));

      scenario('embeddings.providerError', 'a provider failure surfaces as AiError, never a raw error', whenPort(async () => {
        const { embeddings, fixture } = port();

        await expectAiError(() => embeddings.embed(fixture.failingRequest, subject.ctx));
      }));
    });

    describe('images port', () => {
      const port = () => {
        const images = subject.adapter.images;
        const fixture = subject.fixtures.images;

        if (!images || !fixture) {
          throw new Error('unreachable: guarded by whenPort()');
        }

        return { images, fixture };
      };

      const whenPort = (fn: () => Promise<void>) => async () => {
        if (!subject.adapter.images) {
          return;
        }

        expect(subject.fixtures.images).toBeDefined();
        await fn();
      };

      scenario('images.generate', 'generate returns n images as bytes + an image MIME type, never a URL', whenPort(async () => {
        const { images, fixture } = port();
        const result = await images.generate({ model: fixture.model, prompt: CONFORMANCE_IMAGE_PROMPT, n: 2 }, subject.ctx);

        expectWellFormedImages(result, subject.adapter, 2);
      }));

      scenario('images.edit', 'edit (when carried) returns images for a source image', whenPort(async () => {
        const { images, fixture } = port();

        if (!images.edit) {
          return;
        }

        const result = await images.edit(
          {
            model: fixture.model,
            prompt: CONFORMANCE_IMAGE_PROMPT,
            images: [{ data: CONFORMANCE_PNG, mimeType: 'image/png', filename: 'source.png' }],
          },
          subject.ctx,
        );

        expectWellFormedImages(result, subject.adapter, 1);
      }));

      scenario('images.invalidKey', 'a rejected key surfaces as AI_KEY_INVALID', whenPort(async () => {
        const { images, fixture } = port();

        await expectAiError(
          () => images.generate({ model: fixture.model, prompt: CONFORMANCE_IMAGE_PROMPT }, invalidCtx()),
          'AI_KEY_INVALID',
        );
      }));

      scenario('images.providerError', 'a provider failure surfaces as AiError, never a raw error', whenPort(async () => {
        const { images, fixture } = port();

        await expectAiError(() => images.generate(fixture.failingRequest, subject.ctx));
      }));
    });

    describe('audio port (transcription)', () => {
      const port = () => {
        const transcribe = subject.adapter.audio?.transcribe?.bind(subject.adapter.audio);
        const fixture = subject.fixtures.transcription;

        if (!transcribe || !fixture) {
          throw new Error('unreachable: guarded by whenPort()');
        }

        const request = (patch: Partial<AiTranscriptionRequest> = {}): AiTranscriptionRequest => ({
          model: fixture.model,
          audio: { data: CONFORMANCE_WAV, mimeType: 'audio/wav', filename: 'conformance.wav' },
          ...patch,
        });

        return { transcribe, fixture, request };
      };

      const whenPort = (fn: () => Promise<void>) => async () => {
        if (typeof subject.adapter.audio?.transcribe !== 'function') {
          return;
        }

        expect(subject.fixtures.transcription).toBeDefined();
        await fn();
      };

      scenario('audio.transcribe', 'transcribe returns text for audio bytes', whenPort(async () => {
        const { transcribe, request } = port();

        expectWellFormedTranscription(await transcribe(request(), subject.ctx), subject.adapter);
      }));

      scenario('audio.transcribeStream', 'transcribe accepts a streamed input', whenPort(async () => {
        const { transcribe, request } = port();
        const result = await transcribe(
          request({
            audio: { stream: conformanceWavStream(), mimeType: 'audio/wav', filename: 'conformance.wav', size: CONFORMANCE_WAV.length },
          }),
          subject.ctx,
        );

        expectWellFormedTranscription(result, subject.adapter);
      }));

      scenario('audio.transcribeTooLarge', 'an input declared larger than transcriptionMaxBytes is AI_INVALID_REQUEST', whenPort(async () => {
        const { transcribe, request } = port();
        const max = subject.adapter.audio?.transcriptionMaxBytes ?? AI_TRANSCRIPTION_DEFAULT_MAX_BYTES;
        let read = false;

        async function* never(): AsyncGenerator<Uint8Array> {
          read = true;
          yield new Uint8Array(1);
        }

        await expectAiError(
          () => transcribe(request({ audio: { stream: never(), mimeType: 'audio/wav', size: max + 1 } }), subject.ctx),
          'AI_INVALID_REQUEST',
        );
        expect(read).toBe(false);
      }));

      scenario('audio.transcribeInvalidKey', 'a rejected key surfaces as AI_KEY_INVALID', whenPort(async () => {
        const { transcribe, request } = port();

        await expectAiError(() => transcribe(request(), invalidCtx()), 'AI_KEY_INVALID');
      }));

      scenario('audio.transcribeProviderError', 'a provider failure surfaces as AiError, never a raw error', whenPort(async () => {
        const { transcribe, fixture, request } = port();

        await expectAiError(() => transcribe(request({ model: fixture.failingModel }), subject.ctx));
      }));
    });

    describe('audio port (speech)', () => {
      const port = () => {
        const speech = subject.adapter.audio?.speech?.bind(subject.adapter.audio);
        const fixture = subject.fixtures.speech;

        if (!speech || !fixture) {
          throw new Error('unreachable: guarded by whenPort()');
        }

        return { speech, fixture };
      };

      const whenPort = (fn: () => Promise<void>) => async () => {
        if (typeof subject.adapter.audio?.speech !== 'function') {
          return;
        }

        expect(subject.fixtures.speech).toBeDefined();
        await fn();
      };

      scenario('audio.speech', 'speech returns audio bytes with an audio MIME type, never a URL', whenPort(async () => {
        const { speech, fixture } = port();
        const result = await speech(
          { model: fixture.model, voice: fixture.voice, input: 'Hello from the conformance kit.', format: 'wav' },
          subject.ctx,
        );

        expect(result.provider).toBe(subject.adapter.id);
        expect(typeof result.usage).toBe('object');
        expect(result.audio.data).toBeInstanceOf(Uint8Array);
        expect(result.audio.data.length).toBeGreaterThan(0);
        expect(result.audio.mimeType).toMatch(/^audio\//);
      }));

      scenario('audio.speechVoices', 'the port lists its voices, and the fixture voice is one of them', whenPort(async () => {
        const { fixture } = port();
        const voices = subject.adapter.audio?.voices;

        expect(Array.isArray(voices)).toBe(true);
        expect(voices!.length).toBeGreaterThan(0);
        expect(voices).toContain(fixture.voice);
      }));

      scenario('audio.speechTooLong', `input over ${AI_SPEECH_INPUT_MAX_CHARS} characters is AI_INVALID_REQUEST`, whenPort(async () => {
        const { speech, fixture } = port();

        await expectAiError(
          () => speech({ model: fixture.model, voice: fixture.voice, input: 'x'.repeat(AI_SPEECH_INPUT_MAX_CHARS + 1) }, subject.ctx),
          'AI_INVALID_REQUEST',
        );
      }));

      scenario('audio.speechInvalidKey', 'a rejected key surfaces as AI_KEY_INVALID', whenPort(async () => {
        const { speech, fixture } = port();

        await expectAiError(() => speech({ model: fixture.model, voice: fixture.voice, input: 'hi' }, invalidCtx()), 'AI_KEY_INVALID');
      }));

      scenario('audio.speechProviderError', 'a provider failure surfaces as AiError, never a raw error', whenPort(async () => {
        const { speech, fixture } = port();

        await expectAiError(() => speech({ model: fixture.failingModel, voice: fixture.voice, input: 'hi' }, subject.ctx));
      }));
    });
  });
}
