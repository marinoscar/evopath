import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockTestUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import { DeviceCodeStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';

// -----------------------------------------------------------------------------
// A tiny stateful stand-in for the three tables the device-session lifecycle
// touches (issue #518). The mocked-Prisma tier cannot prove a query's
// semantics, but with rows that actually change, a full collect -> list ->
// revoke -> reject sequence runs through the real controllers, guards and
// services, and the "credential stops working" assertion is about the same
// row the revocation wrote. The real-SQL half of the proof (the list and
// cleanup predicates) lives in test/device-auth/device-session-revocation.db.spec.ts.
// -----------------------------------------------------------------------------
type Row = Record<string, any>;

function matchesValue(actual: any, expected: any): boolean {
  if (expected === null) return actual === null || actual === undefined;
  if (expected instanceof Date) {
    return actual instanceof Date && actual.getTime() === expected.getTime();
  }
  if (typeof expected === 'object') {
    return Object.entries(expected).every(([op, v]: [string, any]) => {
      switch (op) {
        case 'not':
          return !matchesValue(actual, v);
        case 'gt':
          return actual != null && actual > v;
        case 'lt':
          return actual != null && actual < v;
        case 'in':
          return (v as any[]).includes(actual);
        default:
          throw new Error(`fake store: unsupported operator ${op}`);
      }
    });
  }
  return actual === expected;
}

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as Row[]).some((w) => matches(row, w));
    if (key === 'AND') return (value as Row[]).every((w) => matches(row, w));
    return matchesValue(row[key], value);
  });
}

function installDeviceSessionStore(prismaMock: any) {
  const tables = {
    deviceCode: new Map<string, Row>(),
    personalAccessToken: new Map<string, Row>(),
    refreshToken: new Map<string, Row>(),
  };

  const lookupUser = (id: string) => prismaMock.user.findUnique({ where: { id } });

  async function hydrate(model: keyof typeof tables, row: Row | undefined, args: any) {
    if (!row) return null;
    const out: Row = { ...row };
    if (args?.include?.user) out.user = row.userId ? await lookupUser(row.userId) : null;
    if (model === 'refreshToken' && args?.include?.deviceCode) {
      out.deviceCode = row.deviceCodeId
        ? { ...tables.deviceCode.get(row.deviceCodeId) }
        : null;
    }
    return out;
  }

  for (const model of Object.keys(tables) as Array<keyof typeof tables>) {
    const table = tables[model];
    const m = prismaMock[model];
    m.create.mockImplementation(async ({ data }: any) => {
      const row: Row = {
        id: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        revokedAt: null,
        ...(model === 'deviceCode'
          ? { userId: null, patId: null, collectedAt: null, credentialExpiresAt: null }
          : {}),
        ...(model === 'refreshToken' ? { deviceCodeId: null } : {}),
        ...(model === 'personalAccessToken' ? { lastUsedAt: null } : {}),
        ...data,
      };
      table.set(row.id, row);
      return { ...row };
    });
    m.findUnique.mockImplementation(async (args: any) => {
      const row = [...table.values()].find((r) => matches(r, args.where));
      return hydrate(model, row, args);
    });
    m.findFirst.mockImplementation(async (args: any) => {
      const row = [...table.values()].find((r) => matches(r, args.where));
      return hydrate(model, row, args);
    });
    m.findMany.mockImplementation(async (args: any = {}) => {
      const rows = [...table.values()].filter((r) => matches(r, args.where));
      rows.sort((a, b) => b.createdAt - a.createdAt);
      return rows
        .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? rows.length))
        .map((r) => ({ ...r }));
    });
    m.count.mockImplementation(
      async (args: any = {}) =>
        [...table.values()].filter((r) => matches(r, args.where)).length,
    );
    m.update.mockImplementation(async ({ where, data }: any) => {
      const row = [...table.values()].find((r) => matches(r, where));
      if (!row) throw new Error(`fake store: ${model} not found`);
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    });
    m.updateMany.mockImplementation(async ({ where, data }: any) => {
      const rows = [...table.values()].filter((r) => matches(r, where));
      rows.forEach((r) => Object.assign(r, data, { updatedAt: new Date() }));
      return { count: rows.length };
    });
  }

  return tables;
}

describe('Device Auth Controller (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
  });

  describe('POST /api/auth/device/code', () => {
    it('should generate device code successfully (public endpoint)', async () => {
      const mockDeviceCode = {
        id: 'device-code-1',
        deviceCode: 'hashed-device-code',
        userCode: 'ABCD-1234',
        userId: null,
        status: DeviceCodeStatus.pending,
        clientInfo: {},
        scopes: [],
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      context.prismaMock.deviceCode.create.mockResolvedValue(mockDeviceCode);

      const response = await request(context.app.getHttpServer())
        .post('/api/auth/device/code')
        .send({})
        .expect(200);

      expect(response.body.data).toHaveProperty('deviceCode');
      expect(response.body.data).toHaveProperty('userCode');
      expect(response.body.data).toHaveProperty('verificationUri');
      expect(response.body.data).toHaveProperty('verificationUriComplete');
      expect(response.body.data).toHaveProperty('expiresIn');
      expect(response.body.data).toHaveProperty('interval');
    });
  });

  describe('POST /api/auth/device/token', () => {
    it('should require deviceCode in request body', async () => {
      // Test validation - missing deviceCode should return 400
      await request(context.app.getHttpServer())
        .post('/api/auth/device/token')
        .send({})
        .expect(400);
    });
  });

  describe('GET /api/auth/device/activate', () => {
    it('should require authentication', async () => {
      await request(context.app.getHttpServer())
        .get('/api/auth/device/activate')
        .expect(401);
    });

    it('should return verification URI when authenticated', async () => {
      const user = await createMockTestUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/auth/device/activate')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toHaveProperty('verificationUri');
    });
  });

  describe('POST /api/auth/device/authorize', () => {
    it('should require authentication', async () => {
      await request(context.app.getHttpServer())
        .post('/api/auth/device/authorize')
        .send({ userCode: 'ABCD-1234', approve: true })
        .expect(401);
    });

    it('should validate request body format', async () => {
      const user = await createMockTestUser(context);

      // Missing fields
      await request(context.app.getHttpServer())
        .post('/api/auth/device/authorize')
        .set(authHeader(user.accessToken))
        .send({})
        .expect(400);

      // Invalid user code format
      await request(context.app.getHttpServer())
        .post('/api/auth/device/authorize')
        .set(authHeader(user.accessToken))
        .send({ userCode: 'invalid', approve: true })
        .expect(400);
    });
  });

  describe('GET /api/auth/device/sessions', () => {
    it('should require authentication', async () => {
      await request(context.app.getHttpServer())
        .get('/api/auth/device/sessions')
        .expect(401);
    });

    it('should return paginated sessions for authenticated user', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.deviceCode.findMany.mockResolvedValue([]);
      context.prismaMock.deviceCode.count.mockResolvedValue(0);

      const response = await request(context.app.getHttpServer())
        .get('/api/auth/device/sessions')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        sessions: [],
        total: 0,
        page: 1,
        limit: 10,
      });
    });
  });

  describe('DELETE /api/auth/device/sessions/:id', () => {
    it('should require authentication', async () => {
      await request(context.app.getHttpServer())
        .delete('/api/auth/device/sessions/some-id')
        .expect(401);
    });

    it('should return 404 for non-existent session', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.deviceCode.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete('/api/auth/device/sessions/non-existent')
        .set(authHeader(user.accessToken))
        .expect(404);
    });
  });

  describe('device session lifecycle: collect -> list -> revoke (#518)', () => {
    async function startAndApprove(
      user: { accessToken: string },
      clientInfo: Record<string, unknown>,
    ): Promise<string> {
      const code = await request(context.app.getHttpServer())
        .post('/api/auth/device/code')
        .send({ clientInfo })
        .expect(200);

      await request(context.app.getHttpServer())
        .post('/api/auth/device/authorize')
        .set(authHeader(user.accessToken))
        .send({ userCode: code.body.data.userCode, approve: true })
        .expect(200);

      return code.body.data.deviceCode;
    }

    async function listSessions(accessToken: string) {
      const res = await request(context.app.getHttpServer())
        .get('/api/auth/device/sessions')
        .set(authHeader(accessToken))
        .expect(200);
      return res.body.data;
    }

    it('PAT path: the collected PAT is listed, and revoking the session revokes the PAT', async () => {
      const tables = installDeviceSessionStore(context.prismaMock);
      const user = await createMockTestUser(context);

      const deviceCode = await startAndApprove(user, {
        deviceName: 'ci-laptop',
        tokenType: 'pat',
      });

      // Approved but not collected: listed, credentialType null.
      let list = await listSessions(user.accessToken);
      expect(list.total).toBe(1);
      expect(list.sessions[0]).toMatchObject({
        status: 'approved',
        collectedAt: null,
        credentialType: null,
      });

      const poll = await request(context.app.getHttpServer())
        .post('/api/auth/device/token')
        .send({ deviceCode })
        .expect(200);
      const pat: string = poll.body.data.accessToken;
      expect(pat).toMatch(/^pat_/);

      // The device code now records what it issued.
      const [row] = [...tables.deviceCode.values()];
      expect(row.patId).toBe(poll.body.data.tokenId);
      expect(row.collectedAt).toBeInstanceOf(Date);
      expect(row.credentialExpiresAt?.toISOString()).toBe(poll.body.data.expiresAt);

      // Collected sessions are listed now (they used to vanish on collection).
      list = await listSessions(user.accessToken);
      expect(list.total).toBe(1);
      expect(list.sessions[0]).toMatchObject({
        id: row.id,
        collectedAt: expect.any(String),
        credentialExpiresAt: poll.body.data.expiresAt,
        credentialType: 'pat',
      });

      // The PAT works before revocation...
      await request(context.app.getHttpServer())
        .get('/api/auth/device/sessions')
        .set(authHeader(pat))
        .expect(200);

      await request(context.app.getHttpServer())
        .delete(`/api/auth/device/sessions/${row.id}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      // ...and not after.
      expect(tables.personalAccessToken.get(row.patId)!.revokedAt).toBeInstanceOf(Date);
      await request(context.app.getHttpServer())
        .get('/api/auth/device/sessions')
        .set(authHeader(pat))
        .expect(401);

      // Revoked sessions are no longer listed, and revoking again is harmless.
      list = await listSessions(user.accessToken);
      expect(list).toMatchObject({ sessions: [], total: 0 });
      await request(context.app.getHttpServer())
        .delete(`/api/auth/device/sessions/${row.id}`)
        .set(authHeader(user.accessToken))
        .expect(200);
    });

    it('session path: the device access token and refresh token stop working once revoked', async () => {
      const tables = installDeviceSessionStore(context.prismaMock);
      const user = await createMockTestUser(context);

      const deviceCode = await startAndApprove(user, { deviceName: 'smart-tv' });

      const poll = await request(context.app.getHttpServer())
        .post('/api/auth/device/token')
        .send({ deviceCode })
        .expect(200);
      const deviceAccess: string = poll.body.data.accessToken;
      const deviceRefresh: string = poll.body.data.refreshToken;
      expect(poll.body.data).not.toHaveProperty('credentialType');

      const [row] = [...tables.deviceCode.values()];
      const [refreshRow] = [...tables.refreshToken.values()];
      expect(refreshRow.deviceCodeId).toBe(row.id);

      // The device's own token authenticates, and the session is listed.
      const list = await listSessions(deviceAccess);
      expect(list.sessions).toEqual([
        expect.objectContaining({ id: row.id, credentialType: 'session' }),
      ]);

      await request(context.app.getHttpServer())
        .delete(`/api/auth/device/sessions/${row.id}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      // The 7-day access token is rejected immediately, not when it expires.
      await request(context.app.getHttpServer())
        .get('/api/auth/device/sessions')
        .set(authHeader(deviceAccess))
        .expect(401);

      // The refresh token was revoked with it and cannot be rotated...
      expect(refreshRow.revokedAt).toBeInstanceOf(Date);
      await request(context.app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${deviceRefresh}`)
        .expect(401);

      // ...and presenting it did not sign the user out everywhere: the user's
      // own (non-device) token still works.
      await request(context.app.getHttpServer())
        .get('/api/auth/device/sessions')
        .set(authHeader(user.accessToken))
        .expect(200);
    });

    it('session path: a refresh keeps the device link until the session is revoked', async () => {
      const tables = installDeviceSessionStore(context.prismaMock);
      const user = await createMockTestUser(context);

      const deviceCode = await startAndApprove(user, { deviceName: 'kiosk' });
      const poll = await request(context.app.getHttpServer())
        .post('/api/auth/device/token')
        .send({ deviceCode })
        .expect(200);
      const [row] = [...tables.deviceCode.values()];

      const refreshed = await request(context.app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${poll.body.data.refreshToken}`)
        .expect(200);

      const rotated = [...tables.refreshToken.values()].find((r) => !r.revokedAt)!;
      expect(rotated.deviceCodeId).toBe(row.id);
      expect(rotated.expiresAt.getTime()).toBeLessThanOrEqual(
        row.credentialExpiresAt.getTime(),
      );

      await request(context.app.getHttpServer())
        .get('/api/auth/device/sessions')
        .set(authHeader(refreshed.body.data.accessToken))
        .expect(200);

      await request(context.app.getHttpServer())
        .delete(`/api/auth/device/sessions/${row.id}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      // The rotated access token carries the same did, so it dies too.
      await request(context.app.getHttpServer())
        .get('/api/auth/device/sessions')
        .set(authHeader(refreshed.body.data.accessToken))
        .expect(401);
    });

    it("returns 404 and revokes nothing for another user's session", async () => {
      const tables = installDeviceSessionStore(context.prismaMock);
      const owner = await createMockTestUser(context);
      const other = await createMockTestUser(context, { email: 'other@example.com' });

      const deviceCode = await startAndApprove(owner, { tokenType: 'pat' });
      const poll = await request(context.app.getHttpServer())
        .post('/api/auth/device/token')
        .send({ deviceCode })
        .expect(200);
      const [row] = [...tables.deviceCode.values()];

      await request(context.app.getHttpServer())
        .delete(`/api/auth/device/sessions/${row.id}`)
        .set(authHeader(other.accessToken))
        .expect(404);

      expect(row.revokedAt).toBeNull();
      await request(context.app.getHttpServer())
        .get('/api/auth/device/sessions')
        .set(authHeader(poll.body.data.accessToken))
        .expect(200);
    });
  });
});
