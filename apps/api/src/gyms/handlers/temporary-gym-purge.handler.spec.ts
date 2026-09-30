import type { Job } from '@prisma/client';

import { JOB_TYPE_LABELS } from '../../jobs/job-type-labels';
import {
  TEMPORARY_GYM_PURGE_BATCH_SIZE,
  TEMPORARY_GYM_PURGE_JOB_TYPE,
  TEMPORARY_GYM_PURGE_MAX_BATCHES,
  TEMPORARY_GYM_RETENTION_DAYS,
} from '../gyms.constants';
import {
  TemporaryGymPurgeHandler,
  isHeldByScanningIntake,
  purgeableTemporaryGymWhere,
} from './temporary-gym-purge.handler';

// =============================================================================
// TemporaryGymPurgeHandler: selection, batching and per-gym outcome (mocked)
// =============================================================================
//
// The reference-safety against real rows (workouts, adaptations by status,
// programs, scanning intakes, storage objects) is proven in
// `test/gyms/temporary-gym-purge.db.spec.ts`.
// =============================================================================

const JOB = { id: 'job-1', type: TEMPORARY_GYM_PURGE_JOB_TYPE } as Job;
const NOW = new Date('2026-09-30T03:30:00.000Z');
const CUTOFF = new Date('2026-08-31T03:30:00.000Z');

describe('TemporaryGymPurgeHandler', () => {
  let findMany: jest.Mock;
  let removeTemporary: jest.Mock;
  let register: jest.Mock;
  let handler: TemporaryGymPurgeHandler;

  const rows = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${String(i).padStart(4, '0')}`, userId: `user-${i % 3}` }));

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    removeTemporary = jest.fn().mockResolvedValue(true);
    register = jest.fn();
    handler = new TemporaryGymPurgeHandler({ register } as never, { gym: { findMany } } as never, { removeTemporary } as never);
  });

  it('self-registers as a server-only type with the permanent name and a label', () => {
    handler.onModuleInit();

    expect(register).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('gyms.temporary.purge');
    expect('nodeResultSchema' in handler).toBe(false);
    expect('persistNodeResult' in handler).toBe(false);
    expect('nodeSecretBroker' in handler).toBe(false);
    expect(JOB_TYPE_LABELS['gyms.temporary.purge']).toBe('Temporary gym purge');
  });

  it('keeps 30 days, batches of 200', () => {
    expect(TEMPORARY_GYM_RETENTION_DAYS).toBe(30);
    expect(TEMPORARY_GYM_PURGE_BATCH_SIZE).toBe(200);
  });

  it('the selection: temporary, older than 30 days, no workout, no live adaptation, no holding plan', () => {
    expect(purgeableTemporaryGymWhere(CUTOFF)).toEqual({
      isTemporary: true,
      updatedAt: { lt: CUTOFF },
      workouts: { none: {} },
      workoutAdaptations: { none: { status: { in: ['queued', 'running', 'ready'] } } },
      programs: { none: { status: { in: ['draft', 'active', 'paused'] } } },
    });
  });

  it('reads candidates by id with the 30-day cutoff and deletes each through GymsService.removeTemporary', async () => {
    findMany.mockResolvedValueOnce([{ id: 'g-1', userId: 'u-1' }]);

    const result = await handler.purge(NOW);

    expect(findMany).toHaveBeenCalledWith({
      where: purgeableTemporaryGymWhere(CUTOFF),
      select: { id: true, userId: true },
      orderBy: { id: 'asc' },
      take: TEMPORARY_GYM_PURGE_BATCH_SIZE,
    });
    expect(removeTemporary).toHaveBeenCalledWith('u-1', 'g-1', {
      where: purgeableTemporaryGymWhere(CUTOFF),
      isHeld: isHeldByScanningIntake,
    });
    expect(result).toEqual({ deleted: 1, skipped: 0, failed: 0 });
  });

  it('pages with an id cursor so a skipped gym is never read twice, and stops on a short batch', async () => {
    const first = rows(TEMPORARY_GYM_PURGE_BATCH_SIZE, 'a');
    findMany.mockResolvedValueOnce(first).mockResolvedValueOnce(rows(3, 'b'));
    removeTemporary.mockImplementation(async (_u: string, id: string) => !id.endsWith('1'));

    const result = await handler.purge(NOW);

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[1][0].where).toEqual({
      ...purgeableTemporaryGymWhere(CUTOFF),
      id: { gt: first[first.length - 1].id },
    });
    expect(result.deleted + result.skipped).toBe(TEMPORARY_GYM_PURGE_BATCH_SIZE + 3);
    expect(result.skipped).toBeGreaterThan(0);
  });

  it('stops at the batch safety limit', async () => {
    findMany.mockImplementation(async () => rows(TEMPORARY_GYM_PURGE_BATCH_SIZE, `x${findMany.mock.calls.length}`));

    await handler.purge(NOW);

    expect(findMany).toHaveBeenCalledTimes(TEMPORARY_GYM_PURGE_MAX_BATCHES);
  });

  it('keeps going past a failing gym, then fails the job so it is visible and retried', async () => {
    findMany.mockResolvedValueOnce([
      { id: 'g-1', userId: 'u-1' },
      { id: 'g-2', userId: 'u-1' },
    ]);
    removeTemporary.mockRejectedValueOnce(new Error('storage down')).mockResolvedValueOnce(true);

    await expect(handler.process(JOB)).rejects.toThrow(/could not delete 1 gym/);
    expect(removeTemporary).toHaveBeenCalledTimes(2);
  });

  it('an empty sweep succeeds', async () => {
    await expect(handler.process(JOB)).resolves.toBeUndefined();
    expect(removeTemporary).not.toHaveBeenCalled();
  });

  it('isHeldByScanningIntake counts only scanning intakes that target this gym', async () => {
    const count = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const tx = { photoIntake: { count } } as never;

    await expect(isHeldByScanningIntake(tx, 'g-1')).resolves.toBe(true);
    await expect(isHeldByScanningIntake(tx, 'g-1')).resolves.toBe(false);
    expect(count).toHaveBeenCalledWith({ where: { subjectType: 'gym', subjectId: 'g-1', status: { in: ['scanning'] } } });
  });
});
