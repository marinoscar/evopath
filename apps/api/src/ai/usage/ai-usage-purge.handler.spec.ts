import type { Job } from '@prisma/client';

import {
  AI_USAGE_PURGE_BATCH_SIZE,
  AI_USAGE_PURGE_TYPE,
  AiUsagePurgeHandler,
} from './ai-usage-purge.handler';

const DAY_MS = 24 * 60 * 60 * 1000;
const JOB = { id: 'job-1', type: AI_USAGE_PURGE_TYPE } as Job;

describe('AiUsagePurgeHandler', () => {
  let findMany: jest.Mock;
  let deleteMany: jest.Mock;
  let getAiPolicy: jest.Mock;
  let register: jest.Mock;
  let handler: AiUsagePurgeHandler;

  const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-26T05:00:00.000Z') });
    findMany = jest.fn();
    deleteMany = jest.fn(async ({ where }) => ({ count: where.id.in.length }));
    getAiPolicy = jest.fn().mockResolvedValue({ usageRetentionDays: 180 });
    register = jest.fn();
    handler = new AiUsagePurgeHandler(
      { register } as never,
      { aiUsageEvent: { findMany, deleteMany } } as never,
      { getAiPolicy } as never,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('self-registers as a server-only ai.* type with a declared profile', () => {
    handler.onModuleInit();

    expect(register).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('ai.usage.purge');
    expect(handler.profile).toEqual({ maxRuntimeMs: 30 * 60_000, maxAttempts: 3 });
    expect('nodeResultSchema' in handler).toBe(false);
    expect('persistNodeResult' in handler).toBe(false);
  });

  it('deletes rows older than the retention cutoff, batch by batch, by the exact ids read', async () => {
    findMany
      .mockResolvedValueOnce(ids(AI_USAGE_PURGE_BATCH_SIZE, 'a'))
      .mockResolvedValueOnce(ids(3, 'b'));

    await handler.process(JOB);

    const cutoff = new Date(Date.now() - 180 * DAY_MS);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: AI_USAGE_PURGE_BATCH_SIZE,
    });
    expect(deleteMany).toHaveBeenCalledTimes(2);
    expect(deleteMany.mock.calls[1][0]).toEqual({ where: { id: { in: ['b-0', 'b-1', 'b-2'] } } });
  });

  it('uses the configured retention', async () => {
    getAiPolicy.mockResolvedValue({ usageRetentionDays: 7 });
    findMany.mockResolvedValueOnce([]);

    await handler.process(JOB);

    expect(findMany.mock.calls[0][0].where.createdAt.lt).toEqual(new Date(Date.now() - 7 * DAY_MS));
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('lets a database error escape so the queue retries', async () => {
    findMany.mockRejectedValueOnce(new Error('connection reset'));

    await expect(handler.process(JOB)).rejects.toThrow('connection reset');
  });
});
