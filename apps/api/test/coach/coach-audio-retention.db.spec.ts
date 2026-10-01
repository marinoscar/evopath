// =============================================================================
// Real-Postgres test: coach voice-note retention (E7.6, #246; E7.13, #253)
// =============================================================================
//
// What only a real server can prove for `coach.audio.purge`:
//
//   - the retention scan (`audio_storage_object_id IS NOT NULL AND created_at <
//     cutoff`, keyset-paged on (created_at, id));
//   - the foreign key `coach_messages.audio_storage_object_id ... ON DELETE SET
//     NULL`: deleting the storage object (what `ObjectsService.delete` does)
//     nulls the pointer BY ITSELF, so the handler's own update has to cope with
//     a row whose pointer is already gone (the message must still end up
//     `audio_status = 'none'` with `data.audioPurgedAt`);
//   - objects another feature still references survive (the cascade from a
//     delete would take that feature's row with it);
//   - the safety net's `audio_status = 'pending' AND created_at < now - 10 min`
//     scan, aged in code from `data.audioRequestedAt` for an on-demand request
//     (#259), and the `timeout` settle job it queues through the real queue.
//
// The storage object is deleted through a stand-in with `ObjectsService
// .delete`'s database effect (`prisma.storageObject.delete`); the bytes
// provider is not part of what this suite proves.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { CoachAudioPurgeHandler } from '../../src/coach/audio/handlers/coach-audio-purge.handler';
import { CoachAudioService } from '../../src/coach/audio/coach-audio.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { StorageObjectReferences } from '../../src/intake/storage-object-references';
import { JobsService } from '../../src/jobs/jobs.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('coach-audio-retention.db.spec');

const NOW = new Date('2026-10-01T03:23:00.000Z');
const DAY = 24 * 3_600_000;
const MIN = 60_000;

describeWithDb('coach audio retention (real Postgres)', () => {
  let client: PrismaClient;
  let handler: CoachAudioPurgeHandler;
  let deleteObject: jest.Mock;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const objectIds: string[] = [];
  let userId: string;

  async function audioObject(): Promise<string> {
    const object = await client.storageObject.create({
      data: { name: 'voice.mp3', size: 10, mimeType: 'audio/mpeg', storageKey: `coach-audio/${run}/${randomUUID()}`, uploadedById: userId },
      select: { id: true },
    });
    objectIds.push(object.id);
    return object.id;
  }

  async function message(
    createdAt: Date,
    over: { audioStatus?: string; objectId?: string | null; deliveredAt?: Date | null; data?: Record<string, unknown> } = {},
  ): Promise<string> {
    const row = await client.coachMessage.create({
      data: {
        userId,
        role: 'coach',
        kind: 'nudge',
        moment: 'missed_twice',
        title: 'Keep going',
        body: 'The text that must survive.',
        audioStatus: over.audioStatus ?? 'ready',
        audioStorageObjectId: over.objectId ?? null,
        deliveredAt: over.deliveredAt === undefined ? createdAt : over.deliveredAt,
        createdAt,
        data: (over.data ?? { momentKey: `k-${randomUUID()}` }) as never,
      },
      select: { id: true },
    });
    return row.id;
  }

  const load = (id: string) => client.coachMessage.findUniqueOrThrow({ where: { id } });
  const objectExists = async (id: string) => (await client.storageObject.count({ where: { id } })) === 1;
  const settleJobs = (messageId: string) =>
    client.job.findMany({ where: { type: 'coach.audio.settle', subjectId: messageId } });

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    userId = (await client.user.create({ data: { email: `audio-${run}@example.com` }, select: { id: true } })).id;
    userIds.push(userId);

    const references = new StorageObjectReferences();
    // Stands in for the progress-photo / gym-photo checkers that real features register.
    references.register({
      name: 'progress_photos',
      isReferenced: async (id) => (await client.progressPhoto.count({ where: { storageObjectId: id } })) > 0,
    });
    deleteObject = jest.fn(async (id: string) => {
      await client.storageObject.delete({ where: { id } });
    });
    const audio = new CoachAudioService(prisma, {} as never, {} as never, {} as never, new JobsService(prisma));
    handler = new CoachAudioPurgeHandler(
      { register: jest.fn() } as never,
      prisma,
      { getCoachPolicy: async () => ({ ...DEFAULT_SYSTEM_SETTINGS.coach, audioRetentionDays: 30 }) } as never,
      { delete: deleteObject } as never,
      references,
      audio,
      { coachAudioPurge: jest.fn() } as never,
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.job.deleteMany({ where: { type: 'coach.audio.settle', subjectType: 'coach_message' } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.storageObject.deleteMany({ where: { id: { in: objectIds } } });
    await client.$disconnect();
  });

  beforeEach(() => deleteObject.mockClear());

  it('purges old ready audio: object deleted, pointer cleared, status none, text kept, audioPurgedAt stamped', async () => {
    const objectId = await audioObject();
    const id = await message(new Date(NOW.getTime() - 40 * DAY), { objectId, data: { momentKey: 'old', voice: 'coral' } });

    const result = await handler.run(NOW);
    expect(result.purged).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    const row = await load(id);
    expect(row).toMatchObject({ audioStatus: 'none', audioStorageObjectId: null, title: 'Keep going', body: 'The text that must survive.' });
    expect(row.data).toEqual({ momentKey: 'old', voice: 'coral', audioPurgedAt: NOW.toISOString() });
    expect(await objectExists(objectId)).toBe(false);
  });

  it('keeps audio newer than the retention window, and a message without audio is not touched', async () => {
    const objectId = await audioObject();
    const recent = await message(new Date(NOW.getTime() - 10 * DAY), { objectId });
    const edge = await audioObject();
    const justInside = await message(new Date(NOW.getTime() - 30 * DAY + 1), { objectId: edge }); // 1 ms inside
    const textOnly = await message(new Date(NOW.getTime() - 90 * DAY), { audioStatus: 'none' });

    await handler.run(NOW);

    expect(await load(recent)).toMatchObject({ audioStatus: 'ready', audioStorageObjectId: objectId });
    expect(await load(justInside)).toMatchObject({ audioStatus: 'ready', audioStorageObjectId: edge });
    expect(await objectExists(objectId)).toBe(true);
    expect(await load(textOnly)).toMatchObject({ audioStatus: 'none', audioStorageObjectId: null });
    expect((await load(textOnly)).data).not.toHaveProperty('audioPurgedAt');
  });

  it('lets go of an object another feature still references, without deleting it', async () => {
    const objectId = await audioObject();
    await client.progressPhoto.create({ data: { userId, storageObjectId: objectId, localDate: new Date('2026-08-01') } });
    const id = await message(new Date(NOW.getTime() - 45 * DAY), { objectId });

    await handler.run(NOW);

    expect(deleteObject).not.toHaveBeenCalledWith(objectId, expect.anything());
    expect(await objectExists(objectId)).toBe(true);
    expect(await load(id)).toMatchObject({ audioStatus: 'none', audioStorageObjectId: null });
    expect(((await load(id)).data as Record<string, unknown>).audioPurgedAt).toBe(NOW.toISOString());
  });

  it('leaves a row untouched when the storage delete fails, so the next run retries it', async () => {
    const objectId = await audioObject();
    const id = await message(new Date(NOW.getTime() - 50 * DAY), { objectId });
    deleteObject.mockRejectedValueOnce(new Error('storage down'));

    const first = await handler.run(NOW);
    expect(first.failed).toBe(1);
    expect(await load(id)).toMatchObject({ audioStatus: 'ready', audioStorageObjectId: objectId });
    expect(await objectExists(objectId)).toBe(true);

    const second = await handler.run(NOW);
    expect(second.failed).toBe(0);
    expect(await load(id)).toMatchObject({ audioStatus: 'none', audioStorageObjectId: null });
    expect(await objectExists(objectId)).toBe(false);
  });

  it('re-queues a message stuck pending past the 10-minute wait cap with a timeout settle job', async () => {
    const stuck = await message(new Date(NOW.getTime() - 11 * MIN), { audioStatus: 'pending', deliveredAt: null });
    const fresh = await message(new Date(NOW.getTime() - 5 * MIN), { audioStatus: 'pending', deliveredAt: null });
    // #259: an on-demand request on a delivered message is swept too, aged from its request.
    const delivered = await message(new Date(NOW.getTime() - 20 * MIN), {
      audioStatus: 'pending',
      deliveredAt: new Date(NOW.getTime() - 15 * MIN),
      data: { audioOnDemand: true, audioRequestedAt: new Date(NOW.getTime() - 12 * MIN).toISOString() },
    });
    const listening = await message(new Date(NOW.getTime() - 5 * DAY), {
      audioStatus: 'pending',
      data: { audioOnDemand: true, audioRequestedAt: new Date(NOW.getTime() - 1 * MIN).toISOString() },
    });
    const ready = await message(new Date(NOW.getTime() - 20 * MIN), { audioStatus: 'ready', deliveredAt: null });

    const result = await handler.run(NOW);
    expect(result.stalePending).toBeGreaterThanOrEqual(2);

    const jobs = await settleJobs(stuck);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({ messageId: stuck, cause: 'timeout' });
    expect(await settleJobs(delivered)).toHaveLength(1);
    expect(await settleJobs(fresh)).toHaveLength(0);
    expect(await settleJobs(listening)).toHaveLength(0);
    expect(await settleJobs(ready)).toHaveLength(0);
  });
});
