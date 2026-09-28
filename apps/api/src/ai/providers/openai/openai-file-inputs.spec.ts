// The OpenAI adapter's storage-object input delivery (issue #441): the real
// SDK over the mocked transport. Images by presigned URL (`image_url`),
// files through the Files API (`purpose: user_data`, `file_id`) and deleted
// provider-side afterwards — on success, failure, and at the end of a stream.

import { Readable } from 'node:stream';

import { Logger } from '@nestjs/common';

import { AiError } from '../../core/ai-error';
import type { AiCallContext } from '../../core/provider-adapter.interface';
import { AiProviderRegistry } from '../../core/provider-registry';
import type { AiResolvedStorageInput } from '../../core/types/file-inputs.types';
import type { AiResponseRequest, AiStreamEvent } from '../../core/types/responses.types';
import { OpenAiClientFactory } from './openai-client.factory';
import { OpenAiProviderAdapter } from './openai.adapter';
import { messageItem, responseFixture } from './testing/openai-fixtures';
import { OpenAiMockServer } from './testing/openai-mock-transport';

const KEY = 'sk-proj-FILES-valid-abcdefghijk';
const PRESIGNED = 'https://bucket.test/uploads/cat.png?X-Amz-Expires=600&X-Amz-Signature=presigned-sig-123';
const PDF = Buffer.from('%PDF-1.7 pay on delivery');

const IMG_ID = '11111111-1111-4111-8111-111111111111';
const PDF_ID = '22222222-2222-4222-8222-222222222222';
const CSV_ID = '33333333-3333-4333-8333-333333333333';

function image(): AiResolvedStorageInput {
  return {
    storageObjectId: IMG_ID,
    modality: 'image',
    mimeType: 'image/png',
    filename: 'cat.png',
    strategy: 'presigned_url',
    url: PRESIGNED,
  };
}

function pdf(id = PDF_ID, filename = 'contract.pdf'): AiResolvedStorageInput {
  return {
    storageObjectId: id,
    modality: 'file',
    mimeType: 'application/pdf',
    filename,
    strategy: 'upload',
    open: jest.fn(async () => Readable.from([PDF])),
  };
}

function request(...parts: Array<{ type: 'image' | 'file'; storageObjectId: string }>): AiResponseRequest {
  return {
    model: 'gpt-4o',
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Summarise.' }, ...parts] }],
  };
}

function setup(inputs: AiResolvedStorageInput[]) {
  const server = new OpenAiMockServer({
    validKeys: [KEY],
    respond: () => ({ kind: 'response', response: responseFixture({ output: [messageItem('It says: pay on delivery.')] }) }),
  });
  const adapter = new OpenAiProviderAdapter(new AiProviderRegistry(), new OpenAiClientFactory({ fetch: server.fetch }));
  const ctx: AiCallContext = {
    apiKey: KEY,
    requestId: 'req-files-1',
    storageInputs: new Map(inputs.map((input) => [input.storageObjectId, input])),
  };

  return { server, adapter, ctx };
}

function responsesBody(server: OpenAiMockServer) {
  const [req] = server.requestsTo('/v1/responses');

  return req.body as { input: Array<{ content: unknown[] }> };
}

describe('OpenAI storage-object inputs (#441)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('declares images by presigned URL and files by upload', () => {
    const { adapter } = setup([]);

    expect(adapter.fileInputStrategy).toEqual({ image: 'presigned_url', file: 'upload' });
  });

  it('sends a stored image as input_image.image_url — the presigned URL, no upload', async () => {
    const { adapter, ctx, server } = setup([image()]);

    await adapter.responses.create(request({ type: 'image', storageObjectId: IMG_ID }), ctx);

    expect(responsesBody(server).input[0].content).toEqual([
      { type: 'input_text', text: 'Summarise.' },
      { type: 'input_image', image_url: PRESIGNED, detail: 'auto' },
    ]);
    expect(server.requestsTo('/v1/files')).toEqual([]);
  });

  it('uploads a stored file to the Files API (user_data, the call key), sends its file_id, then deletes it', async () => {
    const input = pdf();
    const { adapter, ctx, server } = setup([input]);

    const res = await adapter.responses.create(request({ type: 'file', storageObjectId: PDF_ID }), ctx);

    expect(res.outputText).toBe('It says: pay on delivery.');

    const [upload] = server.requestsTo('/v1/files');

    expect(upload).toMatchObject({
      method: 'POST',
      apiKey: KEY,
      body: { purpose: 'user_data', file: { filename: 'contract.pdf', type: 'application/pdf', size: PDF.length } },
    });
    expect(input.open).toHaveBeenCalledTimes(1);
    expect(responsesBody(server).input[0].content).toEqual([
      { type: 'input_text', text: 'Summarise.' },
      { type: 'input_file', file_id: 'file-mock1' },
    ]);

    const [deleted] = server.requestsTo('/v1/files/file-mock1');

    expect(deleted).toMatchObject({ method: 'DELETE', apiKey: KEY });
    expect(server.deletedFileIds).toEqual(['file-mock1']);
    expect(server.files.size).toBe(0);
  });

  it('uploads every distinct stored file once and deletes them all', async () => {
    const { adapter, ctx, server } = setup([image(), pdf(), pdf(CSV_ID, 'rows.csv')]);

    await adapter.responses.create(
      request(
        { type: 'file', storageObjectId: PDF_ID },
        { type: 'image', storageObjectId: IMG_ID },
        { type: 'file', storageObjectId: CSV_ID },
        { type: 'file', storageObjectId: PDF_ID },
      ),
      ctx,
    );

    expect(server.requestsTo('/v1/files')).toHaveLength(2);
    expect(responsesBody(server).input[0].content).toEqual([
      { type: 'input_text', text: 'Summarise.' },
      { type: 'input_file', file_id: 'file-mock1' },
      { type: 'input_image', image_url: PRESIGNED, detail: 'auto' },
      { type: 'input_file', file_id: 'file-mock2' },
      { type: 'input_file', file_id: 'file-mock1' },
    ]);
    expect(server.deletedFileIds.sort()).toEqual(['file-mock1', 'file-mock2']);
  });

  it('deletes the uploaded file when the response fails', async () => {
    const { adapter, ctx, server } = setup([pdf()]);

    server.enqueue({ kind: 'error', status: 500, error: { message: 'boom', type: 'server_error', code: null } });

    await expect(adapter.responses.create(request({ type: 'file', storageObjectId: PDF_ID }), ctx)).rejects.toBeInstanceOf(
      AiError,
    );
    expect(server.deletedFileIds).toEqual(['file-mock1']);
    expect(server.files.size).toBe(0);
  });

  it('deletes the uploaded file once a stream ends', async () => {
    const { adapter, ctx, server } = setup([pdf()]);
    const events: AiStreamEvent[] = [];

    for await (const event of adapter.responses.stream(request({ type: 'file', storageObjectId: PDF_ID }), ctx)) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe('response.completed');
    expect(responsesBody(server).input[0].content).toContainEqual({ type: 'input_file', file_id: 'file-mock1' });
    expect(server.deletedFileIds).toEqual(['file-mock1']);
  });

  it('deletes the uploaded file when the consumer stops a stream early', async () => {
    const { adapter, ctx, server } = setup([pdf()]);

    for await (const event of adapter.responses.stream(request({ type: 'file', storageObjectId: PDF_ID }), ctx)) {
      if (event.type === 'response.created') break;
    }

    expect(server.deletedFileIds).toEqual(['file-mock1']);
  });

  it('an upload the provider refuses is an AiError; files uploaded before it are still deleted', async () => {
    const { adapter, ctx, server } = setup([pdf(), pdf(CSV_ID, 'rows.csv')]);
    let uploads = 0;

    server.filesWith((operation) => {
      if (operation === 'upload' && ++uploads === 2) {
        return { kind: 'error', status: 400, error: { message: 'bad file', type: 'invalid_request_error', code: null } };
      }
      return undefined;
    });

    const err = await adapter.responses
      .create(request({ type: 'file', storageObjectId: PDF_ID }, { type: 'file', storageObjectId: CSV_ID }), ctx)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiError);
    expect(server.requestsTo('/v1/responses')).toEqual([]);
    expect(server.deletedFileIds).toEqual(['file-mock1']);
  });

  it('a failed delete is logged by file id (never the key) and does not change the result', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { adapter, ctx, server } = setup([pdf()]);

    server.filesWith((operation) =>
      operation === 'delete' ? { kind: 'error', status: 500, error: { message: `key ${KEY}`, type: 'server_error', code: null } } : undefined,
    );

    const res = await adapter.responses.create(request({ type: 'file', storageObjectId: PDF_ID }), ctx);

    expect(res.outputText).toBe('It says: pay on delivery.');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'file-mock1', provider: 'openai' }));

    const logged = JSON.stringify(warn.mock.calls);

    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('presigned-sig');
  });

  it('never logs the presigned URL', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const { adapter, ctx } = setup([image()]);

    await adapter.responses.create(request({ type: 'image', storageObjectId: IMG_ID }), ctx);

    expect(debug).toHaveBeenCalled();
    expect(JSON.stringify(debug.mock.calls)).not.toContain('presigned-sig');
  });

  it('an inline input becomes a data: URL (input_file.file_data)', async () => {
    const inline: AiResolvedStorageInput = {
      storageObjectId: CSV_ID,
      modality: 'file',
      mimeType: 'text/csv',
      filename: 'rows.csv',
      strategy: 'inline',
      read: async () => ({ data: Buffer.from('a,b'), mimeType: 'text/csv', filename: 'rows.csv' }),
    };
    const { adapter, ctx, server } = setup([inline]);

    await adapter.responses.create(request({ type: 'file', storageObjectId: CSV_ID }), ctx);

    expect(responsesBody(server).input[0].content).toContainEqual({
      type: 'input_file',
      file_data: 'data:text/csv;base64,YSxi',
      filename: 'rows.csv',
    });
  });

  it('a storage part the runtime did not resolve is AI_INVALID_REQUEST — nothing is sent', async () => {
    const { adapter, server } = setup([]);

    await expect(
      adapter.responses.create(request({ type: 'file', storageObjectId: PDF_ID }), { apiKey: KEY, requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
    expect(server.requests).toEqual([]);
  });
});
