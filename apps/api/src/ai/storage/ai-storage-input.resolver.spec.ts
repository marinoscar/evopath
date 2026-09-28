// AiStorageInputResolver (issue #437): a storage object id -> an
// ownership-checked AI input, over the in-memory storage the harness uses.

import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { AiError } from '../core/ai-error';
import { createInMemoryAiStorage } from '../testing/in-memory-ai-storage';
import { AiStorageInputResolver } from './ai-storage-input.resolver';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function setup() {
  const storage = createInMemoryAiStorage();
  const resolver = new AiStorageInputResolver(storage.prisma as never, storage.provider);

  return { storage, resolver };
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }

  throw new Error('expected a rejection');
}

describe('AiStorageInputResolver', () => {
  describe('resolve', () => {
    it("resolves the caller's own ready object from its row, without touching storage", async () => {
      const { storage, resolver } = setup();
      const row = storage.addObject({ uploadedById: OWNER, mimeType: 'image/PNG; charset=binary', name: 'cat.png' });

      const input = await resolver.resolve(OWNER, row.id, { mimeTypes: ['image/png'] });

      expect(input).toEqual({
        id: row.id,
        name: 'cat.png',
        mimeType: 'image/png',
        size: Number(row.size),
        storageKey: row.storageKey,
      });
      expect(storage.provider.download).not.toHaveBeenCalled();
    });

    it("answers another user's object with 403 (as ObjectsService does), carrying the id in details", async () => {
      const { storage, resolver } = setup();
      const row = storage.addObject({ uploadedById: OTHER });

      const err = await caught(() => resolver.resolve(OWNER, row.id));

      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({ details: { storageObjectId: row.id } });
    });

    it('refuses a non-owner regardless of role or permission — #516 removed the unseeded `storage:read_any` bypass, so no grant lets a caller reach another user\'s object here any more', async () => {
      const { storage, resolver } = setup();
      const row = storage.addObject({ uploadedById: OTHER });

      await expect(resolver.resolve(OWNER, row.id)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
      ['an unknown id', '33333333-3333-4333-8333-333333333333'],
      ['a malformed id', 'not-a-uuid'],
    ])('answers %s with 404', async (_name, id) => {
      const { resolver } = setup();

      await expect(resolver.resolve(OWNER, id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses an object that is not ready yet', async () => {
      const { storage, resolver } = setup();
      const row = storage.addObject({ uploadedById: OWNER, status: 'pending' });

      const err = await caught(() => resolver.resolve(OWNER, row.id, { label: 'image' }));

      expect(err).toBeInstanceOf(AiError);
      expect(err).toMatchObject({ code: 'AI_INVALID_REQUEST' });
      expect((err as AiError).message).toMatch(/image storage object is not ready/);
    });

    it('refuses a disallowed MIME type', async () => {
      const { storage, resolver } = setup();
      const row = storage.addObject({ uploadedById: OWNER, mimeType: 'application/pdf' });

      await expect(resolver.resolve(OWNER, row.id, { mimeTypes: ['image/png', 'image/jpeg'] })).rejects.toMatchObject({
        code: 'AI_INVALID_REQUEST',
      });
    });

    it('understands `type/*` wildcards (#438): any audio subtype, but not a lookalike', async () => {
      const { storage, resolver } = setup();
      const allowed = ['audio/*', 'video/mp4', 'video/webm'];

      for (const mimeType of ['audio/mpeg', 'audio/x-m4a', 'AUDIO/WAV; codecs=1', 'video/mp4', 'video/webm']) {
        const row = storage.addObject({ uploadedById: OWNER, mimeType });

        await expect(resolver.resolve(OWNER, row.id, { mimeTypes: allowed })).resolves.toMatchObject({ id: row.id });
      }

      for (const mimeType of ['video/quicktime', 'audiox/mpeg', 'audio/', 'image/png', 'application/ogg']) {
        const row = storage.addObject({ uploadedById: OWNER, mimeType });

        await expect(resolver.resolve(OWNER, row.id, { mimeTypes: allowed, label: 'audio' })).rejects.toMatchObject({
          code: 'AI_INVALID_REQUEST',
        });
      }
    });

    it('refuses an object whose recorded size exceeds the cap', async () => {
      const { storage, resolver } = setup();
      const row = storage.addObject({ uploadedById: OWNER, bytes: Buffer.alloc(100) });

      const err = (await caught(() => resolver.resolve(OWNER, row.id, { maxBytes: 99 }))) as AiError;

      expect(err.code).toBe('AI_INVALID_REQUEST');
      expect(err.toJSON().details).toMatchObject({ maxBytes: 99 });
    });
  });

  describe('read', () => {
    it('buffers the bytes with the MIME type and the name', async () => {
      const { storage, resolver } = setup();
      const bytes = Buffer.from('hello image');
      const row = storage.addObject({ uploadedById: OWNER, bytes, name: 'a.png' });

      const payload = await resolver.read(await resolver.resolve(OWNER, row.id));

      expect(Buffer.from(payload.data).equals(bytes)).toBe(true);
      expect(payload).toMatchObject({ mimeType: 'image/png', filename: 'a.png' });
    });

    it('enforces the cap while reading, whatever the row claimed (a simple upload records size 0)', async () => {
      const { storage, resolver } = setup();
      const row = storage.addObject({ uploadedById: OWNER, bytes: Buffer.alloc(64), size: 0 });
      const input = await resolver.resolve(OWNER, row.id, { maxBytes: 32 });

      await expect(resolver.read(input, { maxBytes: 32 })).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
    });

    it('open streams the bytes, and with maxBytes fails AI_INVALID_REQUEST past the cap (#441)', async () => {
      const { storage, resolver } = setup();
      const row = storage.addObject({ uploadedById: OWNER, bytes: Buffer.alloc(64, 1), size: 0 });
      const input = await resolver.resolve(OWNER, row.id);

      const chunks: Buffer[] = [];
      for await (const chunk of await resolver.open(input, { maxBytes: 64 })) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks)).toHaveLength(64);

      const capped = await resolver.open(input, { maxBytes: 32, label: 'file' });
      const err = await caught(async () => {
        for await (const _chunk of capped) {
          // drain
        }
      });

      expect(err).toMatchObject({ code: 'AI_INVALID_REQUEST' });
      expect((err as AiError).toJSON().details).toMatchObject({ maxBytes: 32, storageObjectId: row.id });
    });

    it('presign asks the storage provider for a signed GET of the object with the given lifetime (#441)', async () => {
      const { storage, resolver } = setup();
      const row = storage.addObject({ uploadedById: OWNER });
      const input = await resolver.resolve(OWNER, row.id);

      const url = await resolver.presign(input, 600);

      expect(storage.provider.getSignedDownloadUrl).toHaveBeenCalledWith(row.storageKey, { expiresIn: 600 });
      expect(url).toContain('X-Amz-Expires=600');
    });

    it('presign surfaces unconfigured storage as the storage layer’s own error (#441)', async () => {
      const { storage, resolver } = setup();
      const row = storage.addObject({ uploadedById: OWNER });
      const input = await resolver.resolve(OWNER, row.id);

      storage.setConfigured(false);

      await expect(resolver.presign(input, 600)).rejects.toMatchObject({ status: 503 });
    });

    it('surfaces unconfigured storage as the storage layer’s own error', async () => {
      const { storage, resolver } = setup();
      const row = storage.addObject({ uploadedById: OWNER });
      const input = await resolver.resolve(OWNER, row.id);

      storage.setConfigured(false);

      await expect(resolver.read(input)).rejects.toMatchObject({ status: 503 });
    });
  });

  describe('openCapped', () => {
    async function drain(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
      const chunks: Buffer[] = [];

      for await (const chunk of stream) chunks.push(Buffer.from(chunk));

      return Buffer.concat(chunks);
    }

    it('streams the bytes through unchanged while they stay within the cap', async () => {
      const { storage, resolver } = setup();
      const bytes = Buffer.from('a short recording');
      const row = storage.addObject({ uploadedById: OWNER, bytes, mimeType: 'audio/mpeg' });
      const capped = await resolver.openCapped(await resolver.resolve(OWNER, row.id), { maxBytes: bytes.length });

      expect((await drain(capped.stream)).equals(bytes)).toBe(true);
      expect(capped.exceeded()).toBeUndefined();
      capped.close();
    });

    it('fails the stream past the cap, whatever the row claimed, and names that error afterwards', async () => {
      const { storage, resolver } = setup();
      const row = storage.addObject({ uploadedById: OWNER, bytes: Buffer.alloc(64), size: 16, mimeType: 'audio/mpeg' });
      const capped = await resolver.openCapped(await resolver.resolve(OWNER, row.id), { maxBytes: 32, label: 'audio' });

      const err = (await caught(() => drain(capped.stream))) as AiError;

      expect(err).toBeInstanceOf(AiError);
      expect(err.code).toBe('AI_INVALID_REQUEST');
      expect(err.message).toContain('audio');
      expect(capped.exceeded()).toBe(err);
      capped.close();
    });
  });
});
