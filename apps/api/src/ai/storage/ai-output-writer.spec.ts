// AiOutputWriter and aiErrorFromStorage (issue #437): produced bytes ->
// storage objects the user owns, over the in-memory storage the harness uses.

import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';

import { StorageNotConfiguredError } from '../../storage/config/storage-not-configured.error';
import { AI_OUTPUTS_KEY_PREFIX, STORAGE_KEY_PREFIXES } from '../../storage/storage-key-prefixes';
import { createInMemoryAiStorage } from '../testing/in-memory-ai-storage';
import { AiOutputWriter, aiOutputKeyPrefix, extensionForMime } from './ai-output-writer';
import { aiErrorFromStorage } from './ai-storage-errors';

const USER = '11111111-1111-4111-8111-111111111111';
const RUN = '99999999-9999-4999-8999-999999999999';

function setup() {
  const storage = createInMemoryAiStorage();
  const writer = new AiOutputWriter(storage.prisma as never, storage.provider, storage.storageConfig as never);

  return { storage, writer };
}

describe('AiOutputWriter', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('stores each file as a ready storage object owned by the user, under ai-outputs/<user>/<run>/', async () => {
    const { storage, writer } = setup();

    const stored = await writer.write({
      userId: USER,
      runId: RUN,
      files: [
        { data: Buffer.from('first'), mimeType: 'image/png' },
        { data: new Uint8Array([1, 2, 3]), mimeType: 'image/webp', name: 'custom.webp' },
      ],
      namePrefix: 'ai-image',
      metadata: { provider: 'openai', model: 'gpt-image-1' },
    });

    expect(stored).toEqual([
      { storageObjectId: expect.any(String), name: 'ai-image-1.png', mimeType: 'image/png', size: 5 },
      { storageObjectId: expect.any(String), name: 'custom.webp', mimeType: 'image/webp', size: 3 },
    ]);

    expect(storage.objects).toHaveLength(2);

    for (const [index, row] of storage.objects.entries()) {
      expect(row).toMatchObject({
        id: stored[index].storageObjectId,
        status: 'ready',
        uploadedById: USER,
        size: BigInt(stored[index].size),
        storageProvider: 's3',
        bucket: 'in-memory-bucket',
        metadata: { source: 'ai', runId: RUN, provider: 'openai', model: 'gpt-image-1' },
      });
      expect(row.storageKey.startsWith(aiOutputKeyPrefix(USER, RUN))).toBe(true);
      expect(storage.blobs.get(row.storageKey)?.length).toBe(stored[index].size);
    }

    expect(storage.objects[0].storageKey).toMatch(/\/1-[0-9a-f-]{36}\.png$/);
    expect(storage.objects[1].storageKey).toMatch(/\/2-[0-9a-f-]{36}\.webp$/);
  });

  it('stores a fixed-name output (#439) at <prefix><keyName>', async () => {
    const { storage, writer } = setup();

    const [stored] = await writer.write({
      userId: USER,
      runId: RUN,
      files: [{ data: Buffer.from('ID3'), mimeType: 'audio/mpeg', keyName: 'speech.mp3', name: 'ai-speech.mp3' }],
    });

    expect(stored).toMatchObject({ name: 'ai-speech.mp3', mimeType: 'audio/mpeg', size: 3 });
    expect(storage.objects[0].storageKey).toBe(`${aiOutputKeyPrefix(USER, RUN)}speech.mp3`);
    expect(storage.blobs.get(storage.objects[0].storageKey)?.toString()).toBe('ID3');
  });

  it.each([['../escape.mp3'], ['a/b.mp3'], ['.hidden'], [''], ['sp ace.mp3']])(
    'refuses the key name %j and stores nothing',
    async (keyName) => {
      const { storage, writer } = setup();

      await expect(
        writer.write({ userId: USER, runId: RUN, files: [{ data: Buffer.from('x'), mimeType: 'audio/mpeg', keyName }] }),
      ).rejects.toThrow(/Invalid AI output key name/);
      expect(storage.objects).toEqual([]);
      expect(storage.blobs.size).toBe(0);
    },
  );

  it('writes under a prefix the storage purge knows about', () => {
    expect(aiOutputKeyPrefix(USER, RUN).startsWith(AI_OUTPUTS_KEY_PREFIX)).toBe(true);
    expect(STORAGE_KEY_PREFIXES).toContain(AI_OUTPUTS_KEY_PREFIX);
  });

  it('is all or nothing: a failure part-way removes what it already stored', async () => {
    const { storage, writer } = setup();
    const upload = storage.provider.upload as jest.Mock;
    const real = upload.getMockImplementation()!;

    upload.mockImplementationOnce(real).mockImplementationOnce(async () => {
      throw new Error('bucket went away');
    });

    await expect(
      writer.write({
        userId: USER,
        runId: RUN,
        files: [
          { data: Buffer.from('a'), mimeType: 'image/png' },
          { data: Buffer.from('b'), mimeType: 'image/png' },
        ],
      }),
    ).rejects.toThrow('bucket went away');

    expect(storage.objects).toEqual([]);
    expect(storage.blobs.size).toBe(0);
  });

  it('removes the uploaded object when its row cannot be written', async () => {
    const { storage, writer } = setup();

    storage.prisma.storageObject.create.mockRejectedValueOnce(new Error('db down'));

    await expect(
      writer.write({ userId: USER, runId: RUN, files: [{ data: Buffer.from('a'), mimeType: 'image/png' }] }),
    ).rejects.toThrow('db down');

    expect(storage.blobs.size).toBe(0);
  });

  it('assertWritable passes when storage is configured and throws StorageNotConfiguredError (503) when not', async () => {
    const { storage, writer } = setup();

    await expect(writer.assertWritable()).resolves.toBeUndefined();

    storage.setConfigured(false);

    await expect(writer.assertWritable()).rejects.toBeInstanceOf(StorageNotConfiguredError);
    expect(storage.provider.upload).not.toHaveBeenCalled();
  });

  it('discard deletes the objects and their rows', async () => {
    const { storage, writer } = setup();
    const stored = await writer.write({
      userId: USER,
      runId: RUN,
      files: [{ data: Buffer.from('a'), mimeType: 'image/png' }],
    });

    await writer.discard(stored.map((s) => s.storageObjectId));

    expect(storage.objects).toEqual([]);
    expect(storage.blobs.size).toBe(0);
  });

  it('maps MIME types to extensions, falling back to bin', () => {
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('audio/mpeg')).toBe('mp3');
    expect(extensionForMime('audio/pcm')).toBe('pcm');
    expect(extensionForMime('application/x-unknown')).toBe('bin');
  });
});

describe('aiErrorFromStorage', () => {
  it('maps unconfigured storage to AI_STORAGE_UNAVAILABLE (503) naming the settings page', () => {
    const err = aiErrorFromStorage(StorageNotConfiguredError.missing('s3', ['bucket']));

    expect(err?.code).toBe('AI_STORAGE_UNAVAILABLE');
    expect(err?.toJSON().details).toMatchObject({ storageReason: 'storage_not_configured' });
    expect(err?.getStatus()).toBe(503);
    expect(err?.message).toContain('/admin/settings/storage');
  });

  it.each([
    ['a missing input', new NotFoundException('Storage object not found')],
    ['an input that is no longer the user’s', new ForbiddenException('nope')],
  ])('maps %s to AI_INVALID_REQUEST', (_name, source) => {
    expect(aiErrorFromStorage(source)).toMatchObject({ code: 'AI_INVALID_REQUEST' });
  });

  it('is null for anything else', () => {
    expect(aiErrorFromStorage(new Error('boom'))).toBeNull();
  });
});
