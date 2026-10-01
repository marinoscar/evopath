// =============================================================================
// Real-Postgres test: on-demand coach audio (#259)
// =============================================================================
//
// What only a real server can prove for `POST /api/coach/messages/:id/audio`:
//
//   - the GUARDED `none | failed -> pending` claim is a single conditional
//     UPDATE, so concurrent presses on one message reach `speak()` exactly
//     once, and every press answers `pending` (the losers re-read the row);
//   - `ready` with its object short-circuits (no claim, no run), while
//     `ready` whose object was deleted (`ON DELETE SET NULL`) is claimable;
//   - the settle of an on-demand run moves the row `pending -> ready` and
//     NEVER queues `coach.message.deliver` (no notification), for a delivered
//     nudge and for a chat reply that has no `delivered_at` at all; the
//     wait cap it queued through the real queue is pinned to the run.
//
// `speak()` is a stand-in that writes a real `ai_runs` row (what the AI
// runtime does when it queues `ai.audio.speech`); provider calls are not
// part of what this suite proves.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { CoachAudioService } from '../../src/coach/audio/coach-audio.service';
import { CoachListenRateLimiter } from '../../src/coach/audio/coach-listen-rate-limiter';
import { CoachMessageAudioService } from '../../src/coach/audio/coach-message-audio.service';
import { CoachAudioSettleHandler } from '../../src/coach/audio/handlers/coach-audio-settle.handler';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { JobsService } from '../../src/jobs/jobs.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('coach-message-audio.db.spec');

const NOW = new Date('2026-10-01T10:00:00.000Z');

describeWithDb('on-demand coach audio (real Postgres)', () => {
  let client: PrismaClient;
  let service: CoachMessageAudioService;
  let settle: CoachAudioSettleHandler;
  let speak: jest.Mock;
  let limiter: CoachListenRateLimiter;
  const run = randomUUID().slice(0, 8);
  const objectIds: string[] = [];
  let userId: string;

  async function message(over: Record<string, unknown> = {}): Promise<string> {
    const row = await client.coachMessage.create({
      data: {
        userId,
        role: 'coach',
        kind: 'nudge',
        moment: 'missed_twice',
        personaId: 'coach',
        intensity: 2,
        title: 'Keep going',
        body: 'The text that is spoken.',
        audioStatus: 'none',
        deliveredAt: new Date(NOW.getTime() - 3_600_000),
        data: { momentKey: `k-${randomUUID()}`, audioScript: 'Spoken script.' },
        ...over,
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  async function audioObject(): Promise<string> {
    const object = await client.storageObject.create({
      data: { name: 'voice.mp3', size: 30_000, mimeType: 'audio/mpeg', storageKey: `coach-audio/${run}/${randomUUID()}`, uploadedById: userId },
      select: { id: true },
    });
    objectIds.push(object.id);
    return object.id;
  }

  const load = (id: string) => client.coachMessage.findUniqueOrThrow({ where: { id } });
  const jobsFor = (messageId: string, type: string) => client.job.findMany({ where: { type, subjectId: messageId } });

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    userId = (await client.user.create({ data: { email: `listen-${run}@example.com` }, select: { id: true } })).id;
    await client.userSettings.create({
      data: { userId, value: { coach: { enabled: true, audio: { enabled: true, voice: 'alloy', speed: 1 } } } } as never,
    });

    speak = jest.fn(async () => {
      // Lets the concurrent presses interleave before the run exists.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const aiRun = await client.aiRun.create({
        data: { userId, provider: 'openai', modelId: 'tts', status: 'pending', request: { kind: 'speech' } },
        select: { id: true },
      });
      return { runId: aiRun.id, jobId: randomUUID() };
    });
    const ai = { forUser: () => ({ speak }) };
    const jobs = new JobsService(prisma);
    const metrics = { coachAudioRequest: jest.fn(), coachAudioReady: jest.fn(), coachAudioFailure: jest.fn() };
    const audio = new CoachAudioService(prisma, ai as never, { cancel: jest.fn() } as never, {} as never, jobs, metrics as never);
    limiter = new CoachListenRateLimiter();
    service = new CoachMessageAudioService(
      prisma,
      { getCoachPolicy: async () => ({ ...DEFAULT_SYSTEM_SETTINGS.coach, allowAudio: true }) } as never,
      { resolve: async () => ({ state: 'ready', model: { provider: 'openai', modelId: 'tts' } }) } as never,
      audio,
      limiter,
      metrics as never,
    );
    settle = new CoachAudioSettleHandler({ register: jest.fn() } as never, audio);
  });

  afterAll(async () => {
    if (!client) return;
    await client.job.deleteMany({
      where: { type: { in: ['coach.audio.settle', 'coach.message.deliver'] }, subjectType: 'coach_message' },
    });
    await client.aiRun.deleteMany({ where: { userId } });
    await client.user.deleteMany({ where: { id: userId } });
    await client.storageObject.deleteMany({ where: { id: { in: objectIds } } });
    await client.$disconnect();
  });

  beforeEach(() => {
    speak.mockClear();
    limiter.reset();
  });

  it('five concurrent presses claim the row once: one speak(), every answer pending with the same run', async () => {
    const id = await message();

    const answers = await Promise.all(Array.from({ length: 5 }, () => service.request(userId, id, NOW)));

    expect(speak).toHaveBeenCalledTimes(1);
    for (const answer of answers) expect(answer.status).toBe('pending');
    const row = await load(id);
    expect(row.audioStatus).toBe('pending');
    expect(row.audioRunId).toEqual(expect.any(String));
    expect(row.data).toMatchObject({ audioOnDemand: true, audioRequestedAt: NOW.toISOString() });
    // The winner answers with its run; a loser may have re-read before the run id was stored.
    expect(answers.some((a) => a.runId === row.audioRunId)).toBe(true);

    const caps = await jobsFor(id, 'coach.audio.settle');
    expect(caps).toHaveLength(1);
    expect(caps[0].payload).toMatchObject({ messageId: id, cause: 'timeout', runId: row.audioRunId });
  });

  it('settling an on-demand run sets ready and never queues a delivery, delivered nudge or chat reply', async () => {
    for (const over of [{}, { kind: 'chat', moment: null, deliveredAt: null }]) {
      const id = await message(over);
      const started = await service.request(userId, id, NOW);
      expect(started.status).toBe('pending');
      const { audioRunId } = await load(id);

      const objectId = await audioObject();
      await client.aiRun.update({
        where: { id: audioRunId! },
        data: {
          status: 'succeeded',
          output: { type: 'speech', storageObjectId: objectId, mimeType: 'audio/mpeg', size: 30_000, voice: 'alloy' },
        },
      });

      const outcome = await settle.run(id, 'settled', NOW, true, audioRunId);
      expect(outcome).toMatchObject({ status: 'ready', deliver: false });
      const row = await load(id);
      expect(row).toMatchObject({ audioStatus: 'ready', audioStorageObjectId: objectId });
      expect(row.deliveredAt === null).toBe(over.deliveredAt === null);
      expect(await jobsFor(id, 'coach.message.deliver')).toHaveLength(0);

      // Pressing again now answers ready, with no new run.
      await expect(service.request(userId, id, NOW)).resolves.toEqual({ status: 'ready', storageObjectId: objectId, voice: 'alloy' });
      expect(speak).toHaveBeenCalledTimes(1);
      speak.mockClear();
    }
  });

  it('a failed attempt and ready audio whose object was deleted are claimable again', async () => {
    const failed = await message({ audioStatus: 'failed', data: { audioFailure: { reason: 'refusal' } } });
    await expect(service.request(userId, failed, NOW)).resolves.toMatchObject({ status: 'pending' });
    expect((await load(failed)).data).not.toHaveProperty('audioFailure');

    const objectId = await audioObject();
    const orphaned = await message({ audioStatus: 'ready', audioStorageObjectId: objectId });
    await client.storageObject.delete({ where: { id: objectId } }); // ON DELETE SET NULL
    expect((await load(orphaned)).audioStorageObjectId).toBeNull();
    await expect(service.request(userId, orphaned, NOW)).resolves.toMatchObject({ status: 'pending' });
    expect(speak).toHaveBeenCalledTimes(2);
  });
});
