import { NotFoundException } from '@nestjs/common';

import { DEFAULT_SYSTEM_SETTINGS } from '../../../common/types/settings.types';
import { StorageObjectReferences } from '../../../intake/storage-object-references';
import { CoachAudioPurgeHandler } from './coach-audio-purge.handler';

// =============================================================================
// coach.audio.purge (E7.6, #246): old audio deleted, text kept, newer audio
// untouched, storage errors keep the row, stuck pending messages re-queued.
// =============================================================================

const USER = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-10-01T03:23:00Z');
const DAY = 24 * 60 * 60 * 1000;

function row(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-00000000010${n}`,
    userId: USER,
    audioStorageObjectId: `00000000-0000-4000-8000-00000000020${n}`,
    data: { momentKey: `k${n}`, voice: 'coral' },
    createdAt: new Date(NOW.getTime() - (40 + n) * DAY),
    ...overrides,
  };
}

function setup(
  opts: {
    rows?: ReturnType<typeof row>[];
    stale?: Array<{ id: string; createdAt: Date; data: unknown }>;
    retentionDays?: number;
  } = {},
) {
  const batches = [opts.rows ?? [row(1), row(2)], []];
  const prisma = {
    coachMessage: {
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        'audioStatus' in args.where ? (opts.stale ?? []) : (batches.shift() ?? []),
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const systemSettings = {
    getCoachPolicy: jest.fn(async () => ({ ...DEFAULT_SYSTEM_SETTINGS.coach, audioRetentionDays: opts.retentionDays ?? 30 })),
  };
  const objects = { delete: jest.fn(async () => undefined) };
  const references = new StorageObjectReferences();
  const audio = { enqueueSettle: jest.fn(async () => undefined) };
  const registry = { register: jest.fn() };
  const metrics = { coachAudioPurge: jest.fn() };
  const handler = new CoachAudioPurgeHandler(
    registry as never,
    prisma as never,
    systemSettings as never,
    objects as never,
    references,
    audio as never,
    metrics as never,
  );
  return { handler, prisma, objects, references, audio, registry, metrics };
}

describe('CoachAudioPurgeHandler', () => {
  it('is a registered, server-only job with a 10-minute / 2-attempt profile', () => {
    const t = setup();
    t.handler.onModuleInit();
    expect(t.registry.register).toHaveBeenCalledWith(t.handler);
    expect(t.handler.type).toBe('coach.audio.purge');
    expect(t.handler.profile).toEqual({ maxRuntimeMs: 600_000, maxAttempts: 2 });
    expect('nodeResultSchema' in t.handler).toBe(false);
    expect('persistNodeResult' in t.handler).toBe(false);
  });

  it('selects only audio older than audioRetentionDays, deletes each object and clears the pointer, keeping the text', async () => {
    const t = setup({ retentionDays: 30 });
    await expect(t.handler.run(NOW)).resolves.toEqual({ purged: 2, failed: 0, stalePending: 0 });

    const first = t.prisma.coachMessage.findMany.mock.calls[0][0] as any;
    expect(first.where).toMatchObject({
      audioStorageObjectId: { not: null },
      createdAt: { lt: new Date(NOW.getTime() - 30 * DAY) },
    });

    expect(t.objects.delete).toHaveBeenCalledWith(row(1).audioStorageObjectId, USER);
    expect(t.objects.delete).toHaveBeenCalledWith(row(2).audioStorageObjectId, USER);
    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledWith({
      where: { id: row(1).id, OR: [{ audioStorageObjectId: row(1).audioStorageObjectId }, { audioStorageObjectId: null }] },
      data: {
        audioStatus: 'none',
        audioStorageObjectId: null,
        data: { momentKey: 'k1', voice: 'coral', audioPurgedAt: NOW.toISOString() },
      },
    });
    // Never touches title or body.
    for (const [args] of t.prisma.coachMessage.updateMany.mock.calls as any[]) {
      expect(args.data).not.toHaveProperty('body');
      expect(args.data).not.toHaveProperty('title');
    }
    expect(t.metrics.coachAudioPurge).toHaveBeenCalledWith(2);
  });

  it('a storage error keeps the row for the next run and continues with the rest', async () => {
    const t = setup();
    t.objects.delete.mockRejectedValueOnce(new Error('S3 unavailable'));
    await expect(t.handler.run(NOW)).resolves.toMatchObject({ purged: 1, failed: 1 });
    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledTimes(1);
    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: row(2).id }) }));
  });

  it('an object already gone only clears the pointer', async () => {
    const t = setup({ rows: [row(1)] });
    t.objects.delete.mockRejectedValueOnce(new NotFoundException());
    await expect(t.handler.run(NOW)).resolves.toMatchObject({ purged: 1, failed: 0 });
    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledTimes(1);
  });

  it('keeps an object another feature still references, detaching it from the message', async () => {
    const t = setup({ rows: [row(1)] });
    t.references.register({ name: 'other', isReferenced: async () => true });
    await t.handler.run(NOW);
    expect(t.objects.delete).not.toHaveBeenCalled();
    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledTimes(1);
  });

  it('re-queues a timeout settle for a message stuck pending past 10 minutes (safety net), delivered or not', async () => {
    const old = new Date(NOW.getTime() - 11 * 60_000);
    const t = setup({
      rows: [],
      stale: [
        { id: 'stuck-1', createdAt: old, data: {} },
        // On demand on an old message, requested 20 minutes ago: stuck.
        { id: 'stuck-2', createdAt: new Date(NOW.getTime() - 9 * DAY), data: { audioOnDemand: true, audioRequestedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString() } },
        // On demand on an old message, requested 2 minutes ago: NOT stale (#259).
        { id: 'fresh-1', createdAt: new Date(NOW.getTime() - 9 * DAY), data: { audioOnDemand: true, audioRequestedAt: new Date(NOW.getTime() - 2 * 60_000).toISOString() } },
      ],
    });
    await expect(t.handler.run(NOW)).resolves.toEqual({ purged: 0, failed: 0, stalePending: 2 });
    const staleQuery = t.prisma.coachMessage.findMany.mock.calls.find(([a]: any) => 'audioStatus' in a.where)![0] as any;
    expect(staleQuery.where).toEqual({
      audioStatus: 'pending',
      createdAt: { lt: new Date(NOW.getTime() - 10 * 60_000) },
    });
    expect(t.audio.enqueueSettle).toHaveBeenCalledWith('stuck-1', 'timeout');
    expect(t.audio.enqueueSettle).toHaveBeenCalledWith('stuck-2', 'timeout');
    expect(t.audio.enqueueSettle).not.toHaveBeenCalledWith('fresh-1', 'timeout');
  });

  it('keeps audio generated on demand inside the window even when the message itself is older (#259)', async () => {
    const recent = row(1, { data: { voice: 'coral', audioOnDemand: true, audioRequestedAt: new Date(NOW.getTime() - DAY).toISOString() } });
    const t = setup({ rows: [recent, row(2)] });
    await expect(t.handler.run(NOW)).resolves.toMatchObject({ purged: 1, failed: 0 });
    expect(t.objects.delete).toHaveBeenCalledTimes(1);
    expect(t.objects.delete).toHaveBeenCalledWith(row(2).audioStorageObjectId, USER);
  });
});
