import type { Job } from '@prisma/client';

import {
  ADAPTATIONS_PURGE_BATCH_SIZE,
  ADAPTATIONS_PURGE_JOB_TYPE,
  ADAPTATIONS_PURGE_MAX_BATCHES,
} from '../adaptation.constants';
import { AdaptationsPurgeHandler } from './adaptations-purge.handler';

const JOB = { id: 'job-1', type: ADAPTATIONS_PURGE_JOB_TYPE } as Job;
const NOW = new Date('2026-09-30T03:20:00.000Z');

describe('AdaptationsPurgeHandler (selection and batching)', () => {
  let findMany: jest.Mock;
  let deleteMany: jest.Mock;
  let register: jest.Mock;
  let handler: AdaptationsPurgeHandler;

  const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    findMany = jest.fn();
    deleteMany = jest.fn(async ({ where }) => ({ count: where.id.in.length }));
    register = jest.fn();
    handler = new AdaptationsPurgeHandler({ register } as never, { workoutAdaptation: { findMany, deleteMany } } as never);
  });

  afterEach(() => jest.useRealTimers());

  it('self-registers as a server-only housekeeping type with a declared profile', () => {
    handler.onModuleInit();

    expect(register).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('training.adaptations.purge');
    expect(handler.profile).toEqual({ maxRuntimeMs: 15 * 60_000, maxAttempts: 3 });
    expect('nodeResultSchema' in handler).toBe(false);
    expect('persistNodeResult' in handler).toBe(false);
  });

  it('the batch is 5000 ids', () => {
    expect(ADAPTATIONS_PURGE_BATCH_SIZE).toBe(5000);
  });

  it('selects only rows strictly past expiresAt, oldest first, at most one batch of ids at a time', async () => {
    findMany.mockResolvedValueOnce([]);

    await handler.process(JOB);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: NOW } },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: ADAPTATIONS_PURGE_BATCH_SIZE,
    });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('deletes by the exact ids it read, never by re-running the expiry filter, and reports the total', async () => {
    findMany.mockResolvedValueOnce(ids(ADAPTATIONS_PURGE_BATCH_SIZE, 'a')).mockResolvedValueOnce(ids(3, 'b'));

    const deleted = await handler.purge(NOW);

    expect(deleted).toBe(ADAPTATIONS_PURGE_BATCH_SIZE + 3);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(deleteMany).toHaveBeenCalledTimes(2);
    expect(deleteMany.mock.calls[0][0].where).toEqual({ id: { in: ids(ADAPTATIONS_PURGE_BATCH_SIZE, 'a').map((r) => r.id) } });
    expect(deleteMany.mock.calls[1][0].where).toEqual({ id: { in: ['b-0', 'b-1', 'b-2'] } });
    for (const [args] of deleteMany.mock.calls) expect(JSON.stringify(args)).not.toContain('expiresAt');
  });

  it('a short batch ends the run without another read', async () => {
    findMany.mockResolvedValueOnce(ids(ADAPTATIONS_PURGE_BATCH_SIZE - 1, 'a'));

    await handler.purge(NOW);

    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('exactly one full batch is followed by a read that finds nothing', async () => {
    findMany.mockResolvedValueOnce(ids(ADAPTATIONS_PURGE_BATCH_SIZE, 'a')).mockResolvedValueOnce([]);

    const deleted = await handler.purge(NOW);

    expect(deleted).toBe(ADAPTATIONS_PURGE_BATCH_SIZE);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it('nothing expired: deletes nothing and answers 0', async () => {
    findMany.mockResolvedValue([]);

    await expect(handler.purge(NOW)).resolves.toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('stops at its batch safety limit; the next day\'s run continues', async () => {
    findMany.mockImplementation(async () => ids(ADAPTATIONS_PURGE_BATCH_SIZE, 'x'));

    const deleted = await handler.purge(NOW);

    expect(findMany).toHaveBeenCalledTimes(ADAPTATIONS_PURGE_MAX_BATCHES);
    expect(deleted).toBe(ADAPTATIONS_PURGE_MAX_BATCHES * ADAPTATIONS_PURGE_BATCH_SIZE);
  });

  it('process() purges with the current time and the job id, and a database error fails the job (so the retry applies)', async () => {
    findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(handler.process(JOB)).rejects.toThrow('db down');

    findMany.mockResolvedValueOnce([]);
    await expect(handler.process(JOB)).resolves.toBeUndefined();
    expect(findMany.mock.calls[1][0].where).toEqual({ expiresAt: { lt: NOW } });
  });
});
