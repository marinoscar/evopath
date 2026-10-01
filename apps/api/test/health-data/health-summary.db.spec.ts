// =============================================================================
// Real-Postgres test: the opt-in AI health summary (H8, #192)
// =============================================================================
//
// What only real rows, the real queue and the real unique indexes can prove:
//   - a burst of health writes (measurement entries, a profile change) with
//     the consent on enqueues EXACTLY ONE debounced `ai.health.summary` job:
//     the writes emit `health.data.changed`, the listener asks the service,
//     and the queue's active dedup index collapses the rest;
//   - with the consent off, the same writes enqueue nothing;
//   - each generation APPENDS a version (history kept); a post-check failure
//     appends a `failed` version and the training agents keep reading the
//     newest READY one; `(user_id, version)` is unique;
//   - turning the consent off cancels the pending job, is audited, and the
//     training agents get no summary any more;
//   - deleting the user cascades the consent and every summary.
//
// The model is a scripted stand-in for `AiService.forUser` (the handler's
// gateway contract is `health-summary.handler.spec.ts`); the feature
// resolver is a stub. Every user is created with run-unique values and
// removed in `afterAll`.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Run with
// `npm run test:db` against a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, type Job, type PrismaClient } from '@prisma/client';

import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import { HealthSummaryHandler } from '../../src/health-summary/health-summary.handler';
import { HealthSummaryListener } from '../../src/health-summary/health-summary.listener';
import { healthSummaryOutputSchema, type HealthSummaryOutput } from '../../src/health-summary/health-summary.prompt';
import { HealthSummaryReader } from '../../src/health-summary/health-summary.reader';
import { HealthSummaryService } from '../../src/health-summary/health-summary.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobsService } from '../../src/jobs/jobs.service';
import { createMeasurementEntrySchema } from '../../src/measurements/dto/measurement.dto';
import { HEALTH_DATA_CHANGED_EVENT, type HealthDataChangedEvent } from '../../src/measurements/health-data-events';
import { MeasurementsService } from '../../src/measurements/measurements.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('health-summary.db.spec');

const GOOD = (n: number): HealthSummaryOutput => ({
  narrative: `Summary ${n}: blood pressure above the usual range; a clinician follow-up is recommended.`,
  trainingConsiderations: [{ text: 'Keep intensity moderate.', severity: 'caution', conservative: true }],
  dataAsOf: '2026-09-30',
});
const BAD: HealthSummaryOutput = { ...GOOD(0), narrative: 'You have hypertension; take 10 mg of a medication.' };

describeWithDb('AI health summary (real Postgres)', () => {
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];
  let client: PrismaClient;
  let measurements: MeasurementsService;
  let profiles: HealthProfileService;
  let service: HealthSummaryService;
  let reader: HealthSummaryReader;
  let handler: HealthSummaryHandler;
  let respondStructured: jest.Mock;
  let pending: Promise<void>[];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `health-summary-${label}-${run}@example.com` }, select: { id: true } });
    createdUserIds.push(user.id);
    return user.id;
  }

  /** Waits for every listener the writes triggered. */
  async function settleListeners(): Promise<void> {
    const all = pending;
    pending = [];
    await Promise.all(all);
  }

  const summaryJobs = (userId: string) =>
    client.job.findMany({ where: { type: 'ai.health.summary', subjectType: 'health_summary', subjectId: userId } });

  /** Runs one queued summary job the way the worker would, then settles the row. */
  async function runJob(job: Job): Promise<void> {
    await handler.process(job);
    await client.job.update({ where: { id: job.id }, data: { status: 'succeeded', finishedAt: new Date() } });
  }

  async function weigh(userId: string, value: number): Promise<void> {
    await measurements.createEntry(userId, createMeasurementEntrySchema.parse({ readings: [{ metricKey: 'weight', value }] }));
  }

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const events = new EventEmitter2();
    const jobs = new JobsService(prisma);
    const features = {
      resolve: jest.fn(async () => ({
        featureId: 'health_summary',
        state: 'ready',
        model: { provider: 'openai', modelId: 'text-model', displayName: 'Text', keySource: 'user' },
      })),
    };
    reader = new HealthSummaryReader(prisma);
    service = new HealthSummaryService(prisma, jobs, reader, features as never);
    const listener = new HealthSummaryListener(service);
    pending = [];
    events.on(HEALTH_DATA_CHANGED_EVENT, (event: HealthDataChangedEvent) => {
      pending.push(listener.onHealthDataChanged(event));
    });
    measurements = new MeasurementsService(prisma, events);
    profiles = new HealthProfileService(prisma, events);
    respondStructured = jest.fn();
    handler = new HealthSummaryHandler(
      new JobHandlerRegistry(),
      prisma,
      { forUser: () => ({ respondStructured }) } as never,
      features as never,
      reader,
      { healthSummaryGenerated: jest.fn() } as never,
    );

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    await client.job.deleteMany({ where: { type: 'ai.health.summary', subjectId: { in: createdUserIds } } });
    await client.auditEvent.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    respondStructured.mockReset();
  });

  it('a burst of health writes with the consent on enqueues exactly one debounced regeneration', async () => {
    const userId = await makeUser('burst');
    await client.healthSummarySetting.create({ data: { userId, enabled: true, consentedAt: new Date() } });
    const before = Date.now();

    await weigh(userId, 80);
    await weigh(userId, 80.5);
    await weigh(userId, 81);
    await profiles.put(userId, { dateOfBirth: '1985-05-05', sexAtBirth: 'female', unitSystem: 'metric' } as never);
    await settleListeners();

    const jobs = await summaryJobs(userId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'pending', dedupKey: expect.any(String) });
    expect(jobs[0].scheduledFor!.getTime()).toBeGreaterThanOrEqual(before + 110_000);
  });

  it('with the consent off the same writes enqueue nothing', async () => {
    const userId = await makeUser('off');

    await weigh(userId, 70);
    await settleListeners();
    await client.healthSummarySetting.create({ data: { userId, enabled: false } });
    await weigh(userId, 71);
    await settleListeners();

    expect(await summaryJobs(userId)).toHaveLength(0);
  });

  it('each generation appends a version; a post-check failure appends failed and the agents keep the newest ready one', async () => {
    const userId = await makeUser('history');
    await weigh(userId, 90);
    await settleListeners();
    await service.setConsent(userId, true);
    const [first] = await summaryJobs(userId);

    respondStructured.mockResolvedValueOnce({ parsed: healthSummaryOutputSchema.parse(GOOD(1)), usage: {} });
    await runJob(first);

    await weigh(userId, 89);
    await settleListeners();
    await service.refresh(userId);
    const second = (await summaryJobs(userId)).find((j) => j.status === 'pending')!;
    expect(second.scheduledFor).toBeNull();
    respondStructured.mockResolvedValueOnce({ parsed: healthSummaryOutputSchema.parse(GOOD(2)), usage: {} });
    await runJob(second);

    await service.refresh(userId);
    const third = (await summaryJobs(userId)).find((j) => j.status === 'pending')!;
    respondStructured.mockResolvedValue({ parsed: healthSummaryOutputSchema.parse(BAD), usage: {} });
    await runJob(third);

    const rows = await client.healthSummary.findMany({ where: { userId }, orderBy: { version: 'asc' } });
    expect(rows.map((r) => [r.version, r.status, r.regenerations, r.errorCode])).toEqual([
      [1, 'ready', 0, null],
      [2, 'ready', 0, null],
      [3, 'failed', 1, 'HEALTH_SUMMARY_POST_CHECK_REJECTED'],
    ]);
    expect(rows[2].narrative).toBeNull();
    expect(rows[0].inputsHash).not.toBe(rows[1].inputsHash);
    expect(rows[1].dataAsOf).toBeInstanceOf(Date);

    const forTraining = await reader.forTraining(userId);
    expect(forTraining).toMatchObject({ narrative: GOOD(2).narrative, trainingConsiderations: GOOD(2).trainingConsiderations });

    const view = await service.view(userId);
    expect(view).toMatchObject({ enabled: true, stale: false, summary: { version: 2 }, lastAttempt: { version: 3, status: 'failed' } });

    // New data: the view says stale until the next summary.
    await weigh(userId, 88);
    await settleListeners();
    expect((await service.view(userId)).stale).toBe(true);
  });

  it('(user_id, version) is unique', async () => {
    const userId = await makeUser('unique');
    const row = { userId, version: 1, status: 'ready', narrative: 'x', inputsHash: 'h' };
    await client.healthSummary.create({ data: row });

    const error = await client.healthSummary.create({ data: row }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('turning the consent off cancels the pending job, is audited, and the agents get no summary', async () => {
    const userId = await makeUser('consent');
    await weigh(userId, 75);
    await settleListeners();
    await service.setConsent(userId, true);
    await client.healthSummary.create({ data: { userId, version: 1, status: 'ready', narrative: 'Ready.', inputsHash: 'h' } });
    expect(await reader.forTraining(userId)).not.toBeNull();
    expect((await summaryJobs(userId)).filter((j) => j.status === 'pending')).toHaveLength(1);

    await service.setConsent(userId, false);

    expect((await summaryJobs(userId)).filter((j) => j.status === 'pending')).toHaveLength(0);
    expect(await reader.forTraining(userId)).toBeNull();
    const audits = await client.auditEvent.findMany({ where: { actorUserId: userId, action: 'health_summary:consent' }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.meta)).toEqual([{ enabled: true }, { enabled: false }]);
    // The summary history is kept (the owner still sees it); only its use stops.
    expect(await client.healthSummary.count({ where: { userId } })).toBe(1);
  });

  it('deleting the user cascades the consent and every summary', async () => {
    const userId = await makeUser('cascade');
    await client.healthSummarySetting.create({ data: { userId, enabled: true } });
    await client.healthSummary.create({ data: { userId, version: 1, status: 'ready', narrative: 'x', inputsHash: 'h' } });

    await client.user.delete({ where: { id: userId } });

    expect(await client.healthSummarySetting.count({ where: { userId } })).toBe(0);
    expect(await client.healthSummary.count({ where: { userId } })).toBe(0);
  });
});
