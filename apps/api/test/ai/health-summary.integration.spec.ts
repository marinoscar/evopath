// =============================================================================
// /api/ai/training/health-summary over HTTP (H8, #192)
// =============================================================================
//
// The opt-in AI health summary's routes: RBAC (`ai:use` plus `health_data:*`),
// the kill switch, validation, the audited consent switch and the refresh
// refusals. Mocked Prisma; the real-database behaviour (append, history,
// debounce) is `test/health-data/health-summary.db.spec.ts`.
// =============================================================================

import request from 'supertest';

import { HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { authHeader, createMockTestUser, createMockViewerUser, type TestUser } from '../helpers/auth-mock.helper';
import { createAiHttpTestApp, type AiHttpTestApp } from './ai-http.helper';

const PATH = '/api/ai/training/health-summary';

const WEIGHT = {
  metricKey: 'weight',
  value: 80,
  measuredAt: new Date('2026-09-30T08:00:00Z'),
  localDate: null,
  flag: null,
  referenceLow: null,
  referenceHigh: null,
};

describe('/api/ai/training/health-summary (H8, #192)', () => {
  let t: AiHttpTestApp;
  let alice: TestUser;

  beforeAll(async () => {
    // The `health_summary` feature resolved over the harness (models, keys, policy).
    t = await createAiHttpTestApp({}, { harnessFeatureResolver: true });
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    alice = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    const prisma = t.context.prismaMock as any;
    prisma.healthSummarySetting.findUnique.mockResolvedValue(null);
    prisma.healthSummary.findFirst.mockResolvedValue(null);
    prisma.healthProfile.findUnique.mockResolvedValue(null);
    prisma.measurement.findMany.mockResolvedValue([WEIGHT]);
    prisma.job.count.mockResolvedValue(0);
    prisma.job.create.mockResolvedValue({ id: 'job-1', status: 'pending', scheduledFor: null });
  });

  const server = () => t.context.app.getHttpServer();

  it('GET: off by default, with what would be shared and no summary', async () => {
    const res = await request(server()).get(PATH).set(authHeader(alice.accessToken)).expect(200);

    expect(res.body.data).toMatchObject({
      enabled: false,
      consentedAt: null,
      summary: null,
      lastAttempt: null,
      hasData: true,
      stale: true,
      pending: false,
      sharing: { neverShared: expect.arrayContaining(['Documents, photos and file names']) },
    });
    expect(res.body.data.sharing.shared.length).toBeGreaterThan(0);
  });

  it('PUT consent: turns it on, audits the change and queues a summary', async () => {
    const prisma = t.context.prismaMock as any;

    await request(server()).put(`${PATH}/consent`).set(authHeader(alice.accessToken)).send({ enabled: true }).expect(200);

    expect(prisma.healthSummarySetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: HARNESS_USER }, create: expect.objectContaining({ enabled: true }) }),
    );
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorUserId: HARNESS_USER, action: 'health_summary:consent', meta: { enabled: true } }),
    });
    expect(prisma.job.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'ai.health.summary', subjectType: 'health_summary', subjectId: HARNESS_USER }),
    });
  });

  it('PUT consent: a body other than { enabled: boolean } is a 400', async () => {
    for (const body of [{}, { enabled: 'yes' }, { enabled: true, extra: 1 }]) {
      await request(server()).put(`${PATH}/consent`).set(authHeader(alice.accessToken)).send(body).expect(400);
    }
  });

  it('POST refresh: 409 HEALTH_SUMMARY_CONSENT_OFF while the consent is off', async () => {
    const res = await request(server()).post(`${PATH}/refresh`).set(authHeader(alice.accessToken)).expect(409);

    expect(res.body.details).toMatchObject({ reason: 'HEALTH_SUMMARY_CONSENT_OFF' });
  });

  it('POST refresh: 202 and a queued job while the consent is on', async () => {
    const prisma = t.context.prismaMock as any;
    prisma.healthSummarySetting.findUnique.mockResolvedValue({ enabled: true, consentedAt: new Date() });

    await request(server()).post(`${PATH}/refresh`).set(authHeader(alice.accessToken)).expect(202);

    expect(prisma.job.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'ai.health.summary', payload: { force: true } }),
    });
  });

  it('a viewer (no ai:use) is refused every route; unauthenticated is 401', async () => {
    const viewer = await createMockViewerUser(t.context);

    await request(server()).get(PATH).set(authHeader(viewer.accessToken)).expect(403);
    await request(server()).put(`${PATH}/consent`).set(authHeader(viewer.accessToken)).send({ enabled: true }).expect(403);
    await request(server()).post(`${PATH}/refresh`).set(authHeader(viewer.accessToken)).expect(403);
    await request(server()).get(PATH).expect(401);
  });

  it('while AI is off every route answers 403 AI_DISABLED', async () => {
    t.harness.setPolicy({ enabled: false });

    const res = await request(server()).get(PATH).set(authHeader(alice.accessToken)).expect(403);

    expect(res.body.details).toMatchObject({ reason: 'AI_DISABLED' });
  });
});
