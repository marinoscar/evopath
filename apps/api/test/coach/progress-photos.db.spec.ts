// =============================================================================
// Real-Postgres test: progress photos (E7.9, #249)
// =============================================================================
//
// What only real rows and a real provider can prove:
//   - create reads the STORED bytes back (a real file): a JPEG is accepted, a
//     text file declared `image/jpeg` is refused and no row is written;
//   - another user's object is refused (403) and no row is written;
//   - the keyset list (localDate, createdAt, id) pages newest first without
//     gaps or repeats, filters by pose, and never shows another user's photo;
//   - the `progress_photos` reference checker holds the object while a row
//     exists;
//   - delete removes the row, the object row and the bytes; the id is then a
//     404; the summary counts dates and poses only.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Run with
// `npm run test:db` against a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { StorageObjectReferences } from '../../src/intake/storage-object-references';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { ProgressPhotoObjectReferences } from '../../src/progress-photos/progress-photo-references';
import { ProgressPhotoSummaryService } from '../../src/progress-photos/progress-photo-summary.service';
import { ProgressPhotosService } from '../../src/progress-photos/progress-photos.service';
import { ObjectsService } from '../../src/storage/objects/objects.service';
import { cleanupTmpDir, TmpDirStorageProvider } from '../helpers/tmp-storage-provider.helper';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('progress-photos.db.spec');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF'), Buffer.alloc(64)]);

describeWithDb('progress photos (real Postgres)', () => {
  let client: PrismaClient;
  let baseDir: string;
  let provider: TmpDirStorageProvider;
  let references: StorageObjectReferences;
  let service: ProgressPhotosService;
  let summary: ProgressPhotoSummaryService;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];
  let owner: string;
  let other: string;

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `progress-photos-${label}-${run}@example.com` },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  /** A ready storage object of `userId` whose stored bytes are `bytes`. */
  async function upload(userId: string, bytes: Buffer, mimeType = 'image/jpeg'): Promise<string> {
    const storageKey = `uploads/${userId}/${randomUUID()}`;
    await provider.upload(storageKey, Readable.from([bytes]), { contentType: mimeType } as never);
    const object = await client.storageObject.create({
      data: { name: 'p.jpg', size: BigInt(bytes.length), mimeType, storageKey, status: 'ready', uploadedById: userId },
      select: { id: true },
    });
    return object.id;
  }

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    baseDir = await mkdtemp(join(tmpdir(), 'progress-photos-'));
    provider = new TmpDirStorageProvider(baseDir);
    references = new StorageObjectReferences();
    new ProgressPhotoObjectReferences(references, prisma).onModuleInit();
    const objects = new ObjectsService(
      prisma,
      provider,
      {} as never,
      { get: (_key: string, fallback: unknown) => fallback } as never,
      {} as never,
      {} as never,
    );
    service = new ProgressPhotosService(prisma, objects, references, provider, { progressPhotoChanged: jest.fn() } as never);
    summary = new ProgressPhotoSummaryService(prisma);

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    owner = await makeUser('owner');
    other = await makeUser('other');
  });

  afterAll(async () => {
    await client.auditEvent.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
    await client.storageObject.deleteMany({ where: { uploadedById: { in: createdUserIds } } });
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
    await cleanupTmpDir(baseDir);
    jest.restoreAllMocks();
  });

  it('accepts a real JPEG and refuses text bytes declared as one, writing no row', async () => {
    const good = await upload(owner, JPEG);
    const view = await service.create(owner, { storageObjectId: good, localDate: '2026-09-01', pose: 'front', note: 'Day one' });
    expect(view).toMatchObject({ storageObjectId: good, localDate: '2026-09-01', pose: 'front', note: 'Day one' });

    const fake = await upload(owner, Buffer.from('definitely not a picture'));
    const error = await service.create(owner, { storageObjectId: fake, localDate: '2026-09-01', pose: 'front' }).catch((e) => e);
    expect(error.getResponse().details.reason).toBe('PROGRESS_PHOTO_NOT_IMAGE');
    expect(await client.progressPhoto.count({ where: { storageObjectId: fake } })).toBe(0);
  });

  it("refuses another user's object with 403 and writes no row", async () => {
    const theirs = await upload(other, JPEG);
    await expect(
      service.create(owner, { storageObjectId: theirs, localDate: '2026-09-02', pose: 'side' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await client.progressPhoto.count({ where: { storageObjectId: theirs } })).toBe(0);
  });

  it('pages newest first without gaps or repeats, filters by pose, owner only', async () => {
    // Two photos on one day, so the tie-break on createdAt/id is exercised.
    for (const [day, pose] of [
      ['2026-09-03', 'side'],
      ['2026-09-05', 'front'],
      ['2026-09-05', 'back'],
      ['2026-09-10', 'front'],
    ] as const) {
      await service.create(owner, { storageObjectId: await upload(owner, JPEG), localDate: day, pose });
    }
    await service.create(other, { storageObjectId: await upload(other, JPEG), localDate: '2026-09-20', pose: 'front' });

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.list(owner, { limit: 2, cursor });
      seen.push(...page.items.map((item) => `${item.localDate}:${item.pose}:${item.id}`));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen.map((entry) => entry.split(':')[0])).toEqual([
      '2026-09-10',
      '2026-09-05',
      '2026-09-05',
      '2026-09-03',
      '2026-09-01',
    ]);

    const fronts = await service.list(owner, { limit: 10, pose: 'front' });
    expect(fronts.items.map((item) => item.localDate)).toEqual(['2026-09-10', '2026-09-05', '2026-09-01']);

    await expect(summary.summarize(owner)).resolves.toEqual({
      count: 5,
      lastLocalDate: '2026-09-10',
      byPose: { front: 3, side: 1, back: 1, other: 0 },
    });
  });

  it('holds the object while referenced; delete removes row, object and bytes, then 404', async () => {
    const objectId = await upload(owner, JPEG);
    const photo = await service.create(owner, { storageObjectId: objectId, localDate: '2026-09-11', pose: 'other' });
    const { storageKey } = await client.storageObject.findUniqueOrThrow({ where: { id: objectId } });

    expect(await references.isReferenced(objectId)).toBe(true);
    await expect(service.remove(other, photo.id)).rejects.toBeInstanceOf(NotFoundException);

    await service.remove(owner, photo.id);

    expect(await client.progressPhoto.count({ where: { id: photo.id } })).toBe(0);
    expect(await client.storageObject.count({ where: { id: objectId } })).toBe(0);
    expect(await provider.exists(storageKey)).toBe(false);
    expect(await references.isReferenced(objectId)).toBe(false);
    await expect(service.remove(owner, photo.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
