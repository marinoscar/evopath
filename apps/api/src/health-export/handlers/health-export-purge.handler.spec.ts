import { Logger } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JOB_TYPE_LABELS } from '../../jobs/job-type-labels';
import { HealthExportPurgeHandler } from './health-export-purge.handler';

// =============================================================================
// `health.export.purge` over mocks (H7, #191). Real rows and files:
// `test/health-data/health-export.db.spec.ts`.
// =============================================================================

describe('HealthExportPurgeHandler', () => {
  let rows: Array<{ id: string; storageKey: string }>;
  let prisma: any;
  let storage: { delete: jest.Mock };
  let handler: HealthExportPurgeHandler;

  beforeEach(() => {
    rows = [
      { id: 'a', storageKey: 'exports/u/a.pdf' },
      { id: 'b', storageKey: 'exports/u/b.zip' },
    ];
    prisma = {
      storageObject: {
        findMany: jest.fn(async ({ where }: any) => {
          const excluded: string[] = where.id?.notIn ?? [];
          return rows.filter((row) => !excluded.includes(row.id));
        }),
        deleteMany: jest.fn(async ({ where }: any) => {
          rows = rows.filter((row) => row.id !== where.id);
          return { count: 1 };
        }),
      },
    };
    storage = { delete: jest.fn(async () => undefined) };
    handler = new HealthExportPurgeHandler({ register: jest.fn() } as never, prisma, storage as never);
    handler.now = () => new Date('2026-09-30T00:00:00.000Z');
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('is a permanent, labelled, server-only type with a profile', () => {
    expect(handler.type).toBe('health.export.purge');
    expect(JOB_TYPE_LABELS['health.export.purge']).toBeDefined();
    expect((handler as unknown as Record<string, unknown>).nodeResultSchema).toBeUndefined();
    expect(Object.keys(handler.profile).sort()).toEqual(['maxAttempts', 'maxRuntimeMs']);
  });

  it('selects export objects created more than 7 days ago and deletes bytes, then rows', async () => {
    await expect(handler.purge()).resolves.toEqual({ deleted: 2, failed: 0 });

    expect(prisma.storageObject.findMany.mock.calls[0][0].where).toEqual({
      storageKey: { startsWith: 'exports/' },
      createdAt: { lt: new Date('2026-09-23T00:00:00.000Z') },
    });
    expect(storage.delete.mock.calls.map((call) => call[0])).toEqual(['exports/u/a.pdf', 'exports/u/b.zip']);
    expect(rows).toEqual([]);
  });

  it('keeps the row of a file the provider refused, finishes the rest, then fails the run for a retry', async () => {
    storage.delete.mockImplementation(async (key: string) => {
      if (key.endsWith('a.pdf')) throw new Error('provider down');
    });

    await expect(handler.process({ id: 'job' } as Job)).rejects.toThrow(/1 expired health export file/);
    expect(rows.map((row) => row.id)).toEqual(['a']);
  });
});
