// =============================================================================
// AiService — storage-object inputs in Responses requests (issue #441)
// =============================================================================
//
// The facade resolves `{ type: 'image' | 'file', storageObjectId }` parts
// before the adapter: ownership, readiness, modality vs. the model, size,
// the provider's `fileInputStrategy` — then prepares what that strategy needs
// (a presigned URL or a capped stream) in `ctx.storageInputs`, never in the
// request. Over the #432 harness: the REAL facade and input resolver, the
// in-memory storage (whose presigned URLs carry a sentinel signature), and
// `FakeAiProvider` delivering inputs OpenAI's way (images by URL, files by
// upload) and recording what it received.
// =============================================================================

import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import type { Job } from '@prisma/client';
import { z } from 'zod';

import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { AiError } from '../core/ai-error';
import type { AiModelCapabilities } from '../core/capabilities';
import { defineTool } from '../core/tools';
import {
  AI_STORAGE_INPUT_FILE_MAX_BYTES,
  AI_STORAGE_INPUT_IMAGE_MAX_BYTES,
  AI_STORAGE_INPUT_URL_TTL_SECONDS,
  AI_STORAGE_INPUTS_MAX,
} from '../core/types/file-inputs.types';
import type { AiContentPart, AiInputItem } from '../core/types/responses.types';
import {
  createAiRuntimeHarness,
  HARNESS_MODEL,
  HARNESS_OTHER_USER,
  HARNESS_USER,
  type AiRuntimeHarnessOptions,
} from '../testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES } from '../testing/fake-ai-provider';
import { IN_MEMORY_PRESIGNED_SIGNATURE } from '../testing/in-memory-ai-storage';
import { AiResponseRunHandler } from './ai-response-run.handler';
import { AI_RESPONSE_RUN_TYPE } from './ai-runs.service';

const VISION_ONLY = 'fake-vision-only';
const FILES_ONLY = 'fake-files-only';
const TEXT_ONLY = 'fake-text-only';

const PDF = Buffer.from('%PDF-1.7 the contract says: pay on delivery');
const PNG = Buffer.from('fake-png-bytes');

function caps(capabilities: AiModelCapabilities['capabilities'], inputModalities: AiModelCapabilities['inputModalities']) {
  return { capabilities, inputModalities, outputModalities: ['text'] } as AiModelCapabilities;
}

function setup(opts: AiRuntimeHarnessOptions = {}) {
  const h = createAiRuntimeHarness({
    models: [
      { modelId: HARNESS_MODEL },
      { modelId: VISION_ONLY, capabilities: caps(['responses', 'streaming', 'vision_input'], ['text', 'image']) },
      // Declares `file_input` but not the `file` modality: both are required.
      { modelId: FILES_ONLY, capabilities: caps(['responses', 'file_input'], ['text', 'image']) },
      { modelId: TEXT_ONLY, capabilities: caps(['responses', 'streaming'], ['text']) },
    ],
    ...opts,
  });
  const client = h.ai.forUser(HARNESS_USER);
  const pdf = (owner = HARNESS_USER, extra: { size?: number; status?: string } = {}) =>
    h.storage.addObject({ uploadedById: owner, bytes: PDF, mimeType: 'application/pdf', name: 'contract.pdf', ...extra });
  const png = (owner = HARNESS_USER, extra: { size?: number } = {}) =>
    h.storage.addObject({ uploadedById: owner, bytes: PNG, mimeType: 'image/png', name: 'cat.png', ...extra });

  return { h, client, pdf, png };
}

function ask(...parts: AiContentPart[]): AiInputItem[] {
  return [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Summarise.' }, ...parts] }];
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('AiService — storage-object inputs (#441)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('delivery', () => {
    it('an owned PDF reaches the provider as an uploaded file id, deleted after the response — never as a URL in the request', async () => {
      const { h, client, pdf } = setup();
      const object = pdf();

      const res = await client.respond({ model: HARNESS_MODEL, input: ask({ type: 'file', storageObjectId: object.id }) });

      expect(res.outputText).toContain('contract.pdf');

      const [call] = h.fake.callsTo('responses.create');

      expect(call.storageInputs).toEqual([
        {
          storageObjectId: object.id,
          modality: 'file',
          strategy: 'upload',
          filename: 'contract.pdf',
          mimeType: 'application/pdf',
          fileId: 'fake_file_1',
          bytes: PDF.length,
        },
      ]);
      expect(h.fake.deletedFileIds).toEqual(['fake_file_1']);
      // The request the adapter received still names the object, nothing more.
      expect(call.request?.input).toEqual(ask({ type: 'file', storageObjectId: object.id }));
      expect(h.storage.provider.getSignedDownloadUrl).not.toHaveBeenCalled();
      expect(h.usageEvents).toEqual([expect.objectContaining({ status: 'succeeded', operation: 'responses' })]);
    });

    it('an owned image reaches the provider as a 10-minute presigned URL that appears nowhere else', async () => {
      const { h, client, png } = setup();
      const object = png();

      await client.respond({ model: HARNESS_MODEL, input: ask({ type: 'image', storageObjectId: object.id, detail: 'low' }) });

      const [call] = h.fake.callsTo('responses.create');
      const [delivered] = call.storageInputs!;

      expect(delivered).toMatchObject({ storageObjectId: object.id, modality: 'image', strategy: 'presigned_url' });
      expect(delivered.url).toContain(IN_MEMORY_PRESIGNED_SIGNATURE);
      expect(h.storage.provider.getSignedDownloadUrl).toHaveBeenCalledWith(object.storageKey, {
        expiresIn: AI_STORAGE_INPUT_URL_TTL_SECONDS,
      });
      expect(AI_STORAGE_INPUT_URL_TTL_SECONDS).toBe(600);
      expect(JSON.stringify(call.request)).not.toContain(IN_MEMORY_PRESIGNED_SIGNATURE);
      expect(JSON.stringify(h.usageEvents)).not.toContain(IN_MEMORY_PRESIGNED_SIGNATURE);
    });

    it('an image sent as a file part is still an image: its modality follows the MIME type', async () => {
      const { h, client, png } = setup();
      const object = png();

      await client.respond({ model: VISION_ONLY, input: ask({ type: 'file', storageObjectId: object.id }) });

      expect(h.fake.callsTo('responses.create')[0].storageInputs?.[0]).toMatchObject({
        modality: 'image',
        strategy: 'presigned_url',
      });
    });

    it('resolves a repeated object once and delivers each distinct one', async () => {
      const { h, client, pdf, png } = setup();
      const doc = pdf();
      const img = png();

      await client.respond({
        model: HARNESS_MODEL,
        input: ask(
          { type: 'file', storageObjectId: doc.id },
          { type: 'image', storageObjectId: img.id },
          { type: 'file', storageObjectId: doc.id },
        ),
      });

      expect(h.storage.prisma.storageObject.findUnique).toHaveBeenCalledTimes(2);
      expect(h.fake.callsTo('responses.create')[0].storageInputs?.map((i) => i.storageObjectId)).toEqual([
        doc.id,
        img.id,
        doc.id,
      ]);
    });

    it('streams (lazy and eager) with the same delivery, deleting the upload once the stream ends', async () => {
      const { h, client, pdf } = setup();
      const object = pdf();
      const req = { model: HARNESS_MODEL, input: ask({ type: 'file' as const, storageObjectId: object.id }) };

      const lazy: string[] = [];
      for await (const event of client.stream(req)) lazy.push(event.type);

      const eager: string[] = [];
      for await (const event of await client.openStream(req)) eager.push(event.type);

      expect(lazy.at(-1)).toBe('response.completed');
      expect(eager.at(-1)).toBe('response.completed');
      expect(h.fake.callsTo('responses.stream').map((c) => c.storageInputs?.[0].fileId)).toEqual([
        'fake_file_1',
        'fake_file_2',
      ]);
      expect(h.fake.deletedFileIds).toEqual(['fake_file_1', 'fake_file_2']);
    });

    it('respondStructured and runTools resolve the inputs of each round-trip that carries them', async () => {
      const { h, client, pdf } = setup({
        fake: {
          responses: [
            { outputText: '{"total":42}' },
            { output: [{ type: 'function_call', callId: 'c1', name: 'noop', arguments: '{}' }] },
            { outputText: 'done' },
          ],
        },
      });
      const object = pdf();
      const input = ask({ type: 'file', storageObjectId: object.id });

      const structured = await client.respondStructured({
        model: HARNESS_MODEL,
        input,
        schema: z.object({ total: z.number() }),
      });

      const noop = defineTool({ name: 'noop', description: 'Does nothing.', parameters: z.object({}), execute: () => 'ok' });
      const looped = await client.runTools({ model: HARNESS_MODEL, input, tools: [noop] });

      expect(structured.parsed).toEqual({ total: 42 });
      expect(looped.final.outputText).toBe('done');
      // The loop's follow-up round-trip chains on the previous response
      // (function output only), so only the first two calls carry the file.
      expect(h.fake.callsTo('responses.create').map((c) => c.storageInputs?.[0].fileId)).toEqual([
        'fake_file_1',
        'fake_file_2',
        undefined,
      ]);
      expect(h.fake.deletedFileIds).toEqual(['fake_file_1', 'fake_file_2']);
    });

    it('never logs the presigned URL, even with prompt logging on', async () => {
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const { h, client, png } = setup({ policy: { logPromptContent: true } });

      await client.respond({ model: HARNESS_MODEL, input: ask({ type: 'image', storageObjectId: png().id }) });

      expect(h.fake.callsTo('responses.create')[0].storageInputs?.[0].url).toContain(IN_MEMORY_PRESIGNED_SIGNATURE);
      expect(debug).toHaveBeenCalled();
      expect(JSON.stringify(debug.mock.calls)).not.toContain(IN_MEMORY_PRESIGNED_SIGNATURE);
    });
  });

  describe('authorisation', () => {
    it("answers another user's object with 403 (as ObjectsService does) — the provider is never called", async () => {
      const { h, client, pdf } = setup();
      const foreign = pdf(HARNESS_OTHER_USER);

      const err = await caught(() =>
        client.respond({ model: HARNESS_MODEL, input: ask({ type: 'file', storageObjectId: foreign.id }) }),
      );

      expect(err).toBeInstanceOf(ForbiddenException);
      expect(h.fake.calls).toEqual([]);
      expect(h.usageEvents).toEqual([]);
    });

    it('answers an unknown object with 404', async () => {
      const { h, client } = setup();

      await expect(
        client.respond({
          model: HARNESS_MODEL,
          input: ask({ type: 'file', storageObjectId: '33333333-3333-4333-8333-333333333333' }),
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(h.fake.calls).toEqual([]);
    });

    it('refuses an object that is not ready', async () => {
      const { client, pdf } = setup();

      await expect(
        client.respond({ model: HARNESS_MODEL, input: ask({ type: 'file', storageObjectId: pdf(HARNESS_USER, { status: 'pending' }).id }) }),
      ).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
    });
  });

  describe('modality, size and shape', () => {
    it.each([
      ['a PDF to a model without file input', TEXT_ONLY, 'pdf', 'file_input'],
      ['a PDF to a vision-only model', VISION_ONLY, 'pdf', 'file_input'],
      ['a PDF to a model declaring file_input but not the file modality', FILES_ONLY, 'pdf', 'file_input'],
      ['an image to a model without vision', TEXT_ONLY, 'png', 'vision_input'],
    ] as const)('%s is AI_CAPABILITY_UNSUPPORTED, nothing sent', async (_name, model, kind, capability) => {
      const { h, client, pdf, png } = setup();
      const object = kind === 'pdf' ? pdf() : png();

      const err = (await caught(() =>
        client.respond({ model, input: ask({ type: 'file', storageObjectId: object.id }) }),
      )) as AiError;

      expect(err.code).toBe('AI_CAPABILITY_UNSUPPORTED');
      expect(err.toJSON().details).toMatchObject({ capability, storageObjectId: object.id });
      expect(h.fake.calls).toEqual([]);
    });

    it('an image part pointing at a non-image is AI_INVALID_REQUEST', async () => {
      const { client, pdf } = setup();

      await expect(
        client.respond({ model: HARNESS_MODEL, input: ask({ type: 'image', storageObjectId: pdf().id }) }),
      ).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
    });

    it.each([
      ['an image over 20 MiB', 'png', AI_STORAGE_INPUT_IMAGE_MAX_BYTES + 1],
      ['a file over 50 MiB', 'pdf', AI_STORAGE_INPUT_FILE_MAX_BYTES + 1],
    ] as const)('%s is AI_INVALID_REQUEST', async (_name, kind, size) => {
      const { h, client, pdf, png } = setup();
      const object = kind === 'pdf' ? pdf(HARNESS_USER, { size }) : png(HARNESS_USER, { size });

      const err = (await caught(() =>
        client.respond({ model: HARNESS_MODEL, input: ask({ type: 'file', storageObjectId: object.id }) }),
      )) as AiError;

      expect(err.code).toBe('AI_INVALID_REQUEST');
      expect(err.toJSON().details).toMatchObject({ maxBytes: size - 1 });
      expect(h.fake.calls).toEqual([]);
    });

    it('a 30 MiB file is within the file cap', async () => {
      const { client, pdf } = setup();

      await expect(
        client.respond({
          model: HARNESS_MODEL,
          input: ask({ type: 'file', storageObjectId: pdf(HARNESS_USER, { size: 30 * 1024 * 1024 }).id }),
        }),
      ).resolves.toBeDefined();
    });

    it('a part with both url and storageObjectId is AI_INVALID_REQUEST', async () => {
      const { client, pdf } = setup();

      await expect(
        client.respond({
          model: HARNESS_MODEL,
          input: ask({ type: 'file', url: 'https://example.com/a.pdf', storageObjectId: pdf().id }),
        }),
      ).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
    });

    it(`more than ${AI_STORAGE_INPUTS_MAX} distinct objects is AI_INVALID_REQUEST`, async () => {
      const { client, pdf } = setup();
      const parts = Array.from({ length: AI_STORAGE_INPUTS_MAX + 1 }, () => ({
        type: 'file' as const,
        storageObjectId: pdf().id,
      }));

      await expect(client.respond({ model: HARNESS_MODEL, input: ask(...parts) })).rejects.toMatchObject({
        code: 'AI_INVALID_REQUEST',
      });
    });

    it('a provider that declares no fileInputStrategy refuses stored inputs with AI_CAPABILITY_UNSUPPORTED', async () => {
      const { h, client, pdf } = setup({ fake: { fileInputStrategy: false } });

      await expect(
        client.respond({ model: HARNESS_MODEL, input: ask({ type: 'file', storageObjectId: pdf().id }) }),
      ).rejects.toMatchObject({ code: 'AI_CAPABILITY_UNSUPPORTED' });
      expect(h.fake.calls).toEqual([]);
    });

    it('a url part is untouched by all of this', async () => {
      const { h, client } = setup();

      await client.respond({ model: HARNESS_MODEL, input: ask({ type: 'file', url: 'https://example.com/a.pdf' }) });

      expect(h.fake.callsTo('responses.create')[0].storageInputs).toBeUndefined();
    });
  });

  describe('unusable storage', () => {
    it('storage that cannot presign is AI_STORAGE_UNAVAILABLE (503) before any provider call or usage row', async () => {
      const { h, client, png } = setup();
      const object = png();

      h.storage.setConfigured(false);

      const err = (await caught(() =>
        client.respond({ model: HARNESS_MODEL, input: ask({ type: 'image', storageObjectId: object.id }) }),
      )) as AiError;

      expect(err.code).toBe('AI_STORAGE_UNAVAILABLE');
      expect(err.getStatus()).toBe(503);
      expect(h.fake.calls).toEqual([]);
      expect(h.usageEvents).toEqual([]);
    });

    it('storage that cannot be read for an upload fails the call with AI_STORAGE_UNAVAILABLE', async () => {
      const { h, client, pdf } = setup();
      const object = pdf();

      h.storage.setConfigured(false);

      await expect(
        client.respond({ model: HARNESS_MODEL, input: ask({ type: 'file', storageObjectId: object.id }) }),
      ).rejects.toMatchObject({ code: 'AI_STORAGE_UNAVAILABLE' });
      expect(h.fake.deletedFileIds).toEqual([]);
    });
  });

  describe('background runs', () => {
    function handlerFor(h: ReturnType<typeof setup>['h']) {
      const handler = new AiResponseRunHandler(new JobHandlerRegistry(), h.ai, h.runs, h.outputs);
      const job = (handle: { runId: string; jobId: string }) =>
        ({ id: handle.jobId, type: AI_RESPONSE_RUN_TYPE, payload: { runId: handle.runId } }) as unknown as Job;

      return { handler, job };
    }

    it('checks the inputs when queued, stores only the id, and resolves them afresh when the job runs', async () => {
      const { h, client, pdf, png } = setup();
      const doc = pdf();
      const img = png();
      const input = ask({ type: 'file', storageObjectId: doc.id }, { type: 'image', storageObjectId: img.id });

      const handle = await client.startRun({ model: HARNESS_MODEL, input });
      const row = h.runRows.find((r) => r.id === handle.runId)!;

      expect(row.request).toMatchObject({ input });
      expect(JSON.stringify(row.request)).not.toContain(IN_MEMORY_PRESIGNED_SIGNATURE);
      expect(h.storage.provider.getSignedDownloadUrl).not.toHaveBeenCalled();
      expect(h.fake.calls).toEqual([]);

      const { handler, job } = handlerFor(h);

      await handler.process(job(handle));

      expect(row.status).toBe('succeeded');
      expect(h.fake.callsTo('responses.create')[0].storageInputs).toEqual([
        expect.objectContaining({ storageObjectId: doc.id, fileId: 'fake_file_1' }),
        expect.objectContaining({ storageObjectId: img.id, url: expect.stringContaining(IN_MEMORY_PRESIGNED_SIGNATURE) }),
      ]);
      expect(JSON.stringify(row)).not.toContain(IN_MEMORY_PRESIGNED_SIGNATURE);
      expect(h.fake.deletedFileIds).toEqual(['fake_file_1']);
    });

    it("refuses another user's object at queue time — nothing is queued", async () => {
      const { h, client, pdf } = setup();

      await expect(
        client.startRun({ model: HARNESS_MODEL, input: ask({ type: 'file', storageObjectId: pdf(HARNESS_OTHER_USER).id }) }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.runRows).toEqual([]);
    });

    it('an input deleted before the job runs fails the run AI_INVALID_REQUEST; the job itself returns', async () => {
      const { h, client, pdf } = setup();
      const doc = pdf();
      const handle = await client.startRun({ model: HARNESS_MODEL, input: ask({ type: 'file', storageObjectId: doc.id }) });

      h.storage.objects.splice(h.storage.objects.indexOf(doc), 1);

      const { handler, job } = handlerFor(h);

      await expect(handler.process(job(handle))).resolves.toBeUndefined();
      expect(h.runRows.find((r) => r.id === handle.runId)).toMatchObject({
        status: 'failed',
        errorCode: 'AI_INVALID_REQUEST',
      });
      expect(h.fake.calls).toEqual([]);
    });

    it('unconfigured storage when the job runs fails the run AI_STORAGE_UNAVAILABLE; the job returns (#509)', async () => {
      const { h, client, png } = setup();
      const handle = await client.startRun({ model: HARNESS_MODEL, input: ask({ type: 'image', storageObjectId: png().id }) });

      h.storage.setConfigured(false);

      const { handler, job } = handlerFor(h);

      // Terminal, not rethrown: a rethrown StorageNotConfiguredError (a 503)
      // was deferred by the queue as a provider throttle — issue #509.
      await expect(handler.process(job(handle))).resolves.toBeUndefined();
      expect(h.runRows.find((r) => r.id === handle.runId)).toMatchObject({
        status: 'failed',
        errorCode: 'AI_STORAGE_UNAVAILABLE',
      });
      expect(h.fake.calls).toEqual([]);
    });
  });

  it('keeps the fake model fully capable for these tests', () => {
    expect(FAKE_TEXT_MODEL_CAPABILITIES.capabilities).toEqual(expect.arrayContaining(['vision_input', 'file_input']));
  });
});
