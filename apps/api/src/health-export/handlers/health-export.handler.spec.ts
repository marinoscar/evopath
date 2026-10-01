import { Readable } from 'node:stream';

import { Logger } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JOB_TYPE_LABELS } from '../../jobs/job-type-labels';
import { HEALTH_EXPORT_JOB_TYPE } from '../health-export.constants';
import { HealthExportHandler } from './health-export.handler';

// =============================================================================
// `health.export` over mocks (H7, #191)
// =============================================================================
//
// The contract: server-only with a profile; the file streams to the key the
// job id derives; the storage object and `payload.result` commit together;
// audit carries format, datasets and counts (never a value); the user is told
// when it is ready, and on the LAST failed attempt only. Real rows and a real
// provider: `test/health-data/health-export.db.spec.ts`.
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const OBJECT = '33333333-3333-4333-8333-333333333333';

function job(overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = {}): Job {
  return {
    id: JOB,
    type: HEALTH_EXPORT_JOB_TYPE,
    subjectType: 'user',
    subjectId: USER,
    attempts: 1,
    payload: {
      userId: USER,
      format: 'json',
      from: '2026-09-01',
      to: '2026-09-30',
      datasets: ['body', 'wellness'],
      includeHistory: false,
      ...payload,
    },
    ...overrides,
  } as unknown as Job;
}

describe('HealthExportHandler', () => {
  let prisma: any;
  let tx: any;
  let storage: { upload: jest.Mock; delete: jest.Mock };
  let notifications: { notify: jest.Mock };
  let metrics: { healthExportSettled: jest.Mock };
  let registry: { register: jest.Mock };
  let uploaded: Buffer | null;
  let handler: HealthExportHandler;

  beforeEach(() => {
    uploaded = null;
    tx = {
      storageObject: { upsert: jest.fn(async () => ({ id: OBJECT })) },
      job: { update: jest.fn(async () => ({})) },
    };
    prisma = {
      user: { findUnique: jest.fn(async () => ({ displayName: 'Ana', providerDisplayName: null })) },
      healthProfile: { findUnique: jest.fn(async () => null) },
      measurement: {
        findMany: jest.fn(async () => [
          {
            id: 'm1',
            entryId: 'e1',
            metricKey: 'weight',
            value: 70.5,
            unit: 'kg',
            measuredAt: new Date('2026-09-10T07:00:00Z'),
            localDate: null,
            method: 'scale',
            origin: 'manual',
            notes: null,
            referenceLow: null,
            referenceHigh: null,
            referenceText: null,
            flag: null,
            revision: 1,
            supersededAt: null,
          },
        ]),
      },
      healthDocument: { findMany: jest.fn(async () => []) },
      auditEvent: { create: jest.fn(async () => ({})) },
      $transaction: jest.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
    };
    storage = {
      upload: jest.fn(async (key: string, stream: Readable) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        uploaded = Buffer.concat(chunks);
        return { key, bucket: 'b', location: key };
      }),
      delete: jest.fn(async () => undefined),
    };
    notifications = { notify: jest.fn(async () => undefined) };
    metrics = { healthExportSettled: jest.fn() };
    registry = { register: jest.fn() };
    handler = new HealthExportHandler(
      registry as never,
      prisma as never,
      storage as never,
      { activeProvider: jest.fn(async () => 's3') } as never,
      notifications as never,
      metrics as never,
    );
    handler.now = () => new Date('2026-09-30T12:00:00.000Z');
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('registers its permanent type, is server-only and declares a profile', () => {
    handler.onModuleInit();

    expect(registry.register).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('health.export');
    expect(JOB_TYPE_LABELS['health.export']).toBeDefined();
    expect((handler as unknown as Record<string, unknown>).nodeResultSchema).toBeUndefined();
    expect((handler as unknown as Record<string, unknown>).persistNodeResult).toBeUndefined();
    expect(Object.keys(handler.profile).sort()).toEqual(['maxAttempts', 'maxRuntimeMs']);
  });

  it('streams the file to exports/<userId>/<jobId>.<ext> and commits the object and the result together', async () => {
    await handler.process(job());

    expect(storage.upload).toHaveBeenCalledWith(`exports/${USER}/${JOB}.json`, expect.anything(), {
      mimeType: 'application/json',
    });
    const file = JSON.parse(uploaded!.toString('utf8'));
    expect(file.datasets.body[0]).toMatchObject({ weight_kg: 70.5 });

    expect(tx.storageObject.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storageKey: `exports/${USER}/${JOB}.json` },
        create: expect.objectContaining({
          uploadedById: USER,
          status: 'ready',
          size: BigInt(uploaded!.length),
          name: expect.stringMatching(/-health-2026-09-01-2026-09-30\.json$/),
          metadata: { source: 'health_export', exportId: JOB, format: 'json' },
        }),
      }),
    );
    const payload = tx.job.update.mock.calls[0][0].data.payload;
    expect(payload.result).toEqual({
      storageObjectId: OBJECT,
      fileName: expect.stringMatching(/\.json$/),
      mimeType: 'application/json',
      sizeBytes: uploaded!.length,
      rowCounts: { profile: 0, body: 1, vitals: 0, labs: 0, wellness: 0, documents: 0 },
      completedAt: '2026-09-30T12:00:00.000Z',
      expiresAt: '2026-10-07T12:00:00.000Z',
    });
  });

  it('audits format, datasets and row counts without a value, counts it and notifies ready', async () => {
    await handler.process(job());

    const audit = prisma.auditEvent.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      actorUserId: USER,
      action: 'health:export:create',
      targetType: 'health_export',
      targetId: JOB,
      meta: { format: 'json', datasets: ['body', 'wellness'], rowCounts: expect.objectContaining({ body: 1 }) },
    });
    expect(JSON.stringify(audit)).not.toContain('70.5');
    expect(metrics.healthExportSettled).toHaveBeenCalledWith('json', 'completed', expect.any(Number), uploaded!.length);
    expect(notifications.notify).toHaveBeenCalledWith('health.export_ready', USER, { exportId: JOB, format: 'json' });
  });

  it('does nothing when an earlier attempt already committed the result', async () => {
    await handler.process(job({}, { result: { storageObjectId: OBJECT } }));

    expect(storage.upload).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('refuses a payload whose user is not the subject', async () => {
    await expect(handler.process(job({ subjectId: OBJECT }))).rejects.toThrow(/does not match the subject/);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('deletes the partial object, counts and rethrows a failed upload; notifies only on the last attempt', async () => {
    storage.upload.mockRejectedValue(new Error('storage outage'));

    await expect(handler.process(job({ attempts: 1 }))).rejects.toThrow('storage outage');
    expect(storage.delete).toHaveBeenCalledWith(`exports/${USER}/${JOB}.json`);
    expect(metrics.healthExportSettled).toHaveBeenCalledWith('json', 'failed', expect.any(Number));
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(tx.job.update).not.toHaveBeenCalled();

    await expect(handler.process(job({ attempts: handler.profile.maxAttempts }))).rejects.toThrow('storage outage');
    expect(notifications.notify).toHaveBeenCalledWith('health.export_failed', USER, { exportId: JOB, format: 'json' });
  });

  it('deletes the stored file when the commit fails', async () => {
    prisma.$transaction.mockRejectedValue(new Error('deadlock'));

    await expect(handler.process(job())).rejects.toThrow('deadlock');
    expect(storage.delete).toHaveBeenCalledWith(`exports/${USER}/${JOB}.json`);
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it('keeps a committed export when the audit write fails', async () => {
    prisma.auditEvent.create.mockRejectedValue(new Error('audit down'));

    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(notifications.notify).toHaveBeenCalledWith('health.export_ready', USER, expect.anything());
  });

  it.each(['csv', 'xlsx', 'pdf'] as const)('writes %s under its extension', async (format) => {
    await handler.process(job({}, { format }));

    const ext = { csv: 'zip', xlsx: 'xlsx', pdf: 'pdf' }[format];
    expect(storage.upload.mock.calls[0][0]).toBe(`exports/${USER}/${JOB}.${ext}`);
    expect(uploaded!.length).toBeGreaterThan(100);
  });
});
