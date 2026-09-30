// =============================================================================
// POST /api/nodes/:id/telemetry over the real HTTP stack (issue #133)
// =============================================================================
//
// `src/nodes/node-telemetry.service.spec.ts` proves what the relay decides and
// emits. This suite proves the wire around it: a `nod_` credential is admitted
// with NO change to the guard's allowlist, the strict body is enforced by the
// global Zod pipe (400 for an unknown key, a bad name, an oversized batch), a
// node owned by somebody else is 403, and the `{ accepted, dropped }` answer
// survives the response envelope.
// =============================================================================

import { createHash, randomUUID } from 'crypto';
import request from 'supertest';

import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockAdminUser, createMockViewerUser } from '../helpers/auth-mock.helper';
import { closeTestApp, createTestApp, TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

describe('Node span relay (Integration)', () => {
  let context: TestContext;

  const NODE_TOKEN = 'nod_telemetry_integration_fixture';
  const NODE_ID = '11111111-1111-4111-8111-111111111111';
  const HELD_JOB = '22222222-2222-4222-8222-222222222222';
  const FOREIGN_JOB = '33333333-3333-4333-8333-333333333333';
  const OTHER_NODE = '99999999-9999-4999-8999-999999999999';

  const url = `/api/nodes/${NODE_ID}/telemetry`;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
  });

  const server = () => context.app.getHttpServer();

  /** A live `nod_` credential resolving to `userId`, as `validateToken` would. */
  async function givenNodeCredentialFor(userId: string): Promise<void> {
    const fullUser = await (context.prismaMock.user.findUnique as jest.Mock)({
      where: { id: userId },
    });
    const expected = createHash('sha256').update(NODE_TOKEN).digest('hex');

    (context.prismaMock.nodeCredential.findUnique as jest.Mock).mockImplementation(
      async ({ where }: { where: { tokenHash: string } }) =>
        where.tokenHash !== expected
          ? null
          : {
              id: randomUUID(),
              userId,
              name: 'telemetry fixture',
              tokenHash: expected,
              tokenPrefix: NODE_TOKEN.slice(0, 8),
              expiresAt: null,
              lastUsedAt: null,
              createdAt: new Date(),
              revokedAt: null,
              user: fullUser,
            },
    );
    (context.prismaMock.nodeCredential.update as jest.Mock).mockResolvedValue({});
  }

  function givenNodeOwnedBy(ownerId: string): void {
    (context.prismaMock.workerNode.findUnique as jest.Mock).mockResolvedValue({
      id: NODE_ID,
      name: 'prod-worker-1',
      hostname: 'box-a',
      platform: 'linux-x64',
      cliVersion: '1.0.0',
      eligibleTypes: [],
      concurrency: 1,
      status: 'online',
      capabilities: null,
      registeredAt: new Date(),
      lastHeartbeatAt: null,
      createdById: ownerId,
    });
  }

  function givenJobs(): void {
    (context.prismaMock.job.findMany as jest.Mock).mockResolvedValue([
      { id: HELD_JOB, type: 'example.checksum', claimedByNodeId: NODE_ID, traceContext: null },
      { id: FOREIGN_JOB, type: 'example.checksum', claimedByNodeId: OTHER_NODE, traceContext: null },
    ]);
  }

  const span = (jobId: string, overrides: Record<string, unknown> = {}) => ({
    jobId,
    name: 'job.execute',
    startTimeUnixMs: Date.now() - 5_000,
    durationMs: 1_000,
    status: 'ok',
    ...overrides,
  });

  const nodeHeader = () => ({ Authorization: `Bearer ${NODE_TOKEN}` });

  it('admits a nod_ credential and answers { accepted, dropped }', async () => {
    const admin = await createMockAdminUser(context);
    await givenNodeCredentialFor(admin.id);
    givenNodeOwnedBy(admin.id);
    givenJobs();

    const response = await request(server())
      .post(url)
      .set(nodeHeader())
      .send({ spans: [span(HELD_JOB), span(FOREIGN_JOB)] })
      .expect(200);

    expect(response.body.data).toEqual({ accepted: 1, dropped: 1 });
    expect(context.prismaMock.nodeCredential.findUnique).toHaveBeenCalled();
  });

  it('401 unauthenticated, 403 for a viewer (nodes:write)', async () => {
    await request(server()).post(url).send({ spans: [span(HELD_JOB)] }).expect(401);

    const viewer = await createMockViewerUser(context);
    await request(server())
      .post(url)
      .set(authHeader(viewer.accessToken))
      .send({ spans: [span(HELD_JOB)] })
      .expect(403);
  });

  it('403 for a node owned by another user, reading no job', async () => {
    const admin = await createMockAdminUser(context);
    await givenNodeCredentialFor(admin.id);
    givenNodeOwnedBy('some-other-owner');
    givenJobs();

    await request(server()).post(url).set(nodeHeader()).send({ spans: [span(HELD_JOB)] }).expect(403);

    expect(context.prismaMock.job.findMany).not.toHaveBeenCalled();
  });

  it('404 for a node that does not exist', async () => {
    const admin = await createMockAdminUser(context);
    await givenNodeCredentialFor(admin.id);
    (context.prismaMock.workerNode.findUnique as jest.Mock).mockResolvedValue(null);

    await request(server()).post(url).set(nodeHeader()).send({ spans: [span(HELD_JOB)] }).expect(404);
  });

  describe('400 for a body outside the contract', () => {
    const cases: Array<[string, unknown]> = [
      ['an oversized batch', { spans: Array.from({ length: 51 }, () => span(HELD_JOB)) }],
      ['an empty batch', { spans: [] }],
      ['an unknown top-level key', { spans: [span(HELD_JOB)], nodeId: OTHER_NODE }],
      ['an unknown span key', { spans: [span(HELD_JOB, { message: 'boom at /etc/passwd' })] }],
      ['a span name outside the enum', { spans: [span(HELD_JOB, { name: 'job.anything' })] }],
      ['a non-allowlisted attribute', { spans: [span(HELD_JOB, { attributes: { url: 1 } })] }],
      ['a free-form errorType', { spans: [span(HELD_JOB, { status: 'error', errorType: 'no such file' })] }],
      ['a start two days ago', { spans: [span(HELD_JOB, { startTimeUnixMs: Date.now() - 2 * 86_400_000 })] }],
    ];

    it.each(cases)('%s', async (_label, body) => {
      const admin = await createMockAdminUser(context);
      await givenNodeCredentialFor(admin.id);
      givenNodeOwnedBy(admin.id);
      givenJobs();

      await request(server()).post(url).set(nodeHeader()).send(body as object).expect(400);

      expect(context.prismaMock.job.findMany).not.toHaveBeenCalled();
    });
  });

  // LAST ON PURPOSE: it exhausts this node's in-memory budget for the rest of
  // the app's life, and every case above shares the node id.
  it('429 with TOO_MANY_REQUESTS once the node exceeds its request budget', async () => {
    const admin = await createMockAdminUser(context);
    await givenNodeCredentialFor(admin.id);
    givenNodeOwnedBy(admin.id);
    givenJobs();

    let last: request.Response | undefined;
    for (let i = 0; i < 61; i += 1) {
      last = await request(server()).post(url).set(nodeHeader()).send({ spans: [span(HELD_JOB)] });
      if (last.status === 429) break;
    }

    expect(last?.status).toBe(429);
    expect(last?.body.code).toBe('TOO_MANY_REQUESTS');
    expect(last?.body.details).toMatchObject({ reason: 'rate_limited' });
  });
});
