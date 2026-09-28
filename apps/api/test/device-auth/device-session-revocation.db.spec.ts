// =============================================================================
// Real-Postgres test: device-session revocation reaches the issued credential
// (issue #518)
// =============================================================================
//
// What only a real server can prove: that the sessions-list predicate
// (`revokedAt IS NULL AND (approved-uncollected OR collected-unexpired)`) and
// the cleanup predicate select the rows they are meant to against the actual
// columns the migration added, and that the revocation transaction really
// revokes the PAT and the refresh tokens linked through the new foreign keys.
// The services are the real ones, wired by hand onto a real Prisma client;
// only the collaborators with no bearing on this (notifications, allowlist,
// admin bootstrap) are stubbed.
//
// Every user is created with a run-unique email and deleted in `afterAll`
// (device codes, PATs and refresh tokens cascade with it).
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Run with `npm run test:db`
// against a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DeviceCodeStatus, type PrismaClient } from '@prisma/client';

import { AuthService } from '../../src/auth/auth.service';
import { DeviceAuthService } from '../../src/device-auth/device-auth.service';
import { PatService } from '../../src/pat/pat.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('device-session-revocation.db.spec');

const DAY_MS = 24 * 60 * 60 * 1000;

describeWithDb('device session revocation (real Postgres, #518)', () => {
  let client: PrismaClient;
  let jwt: JwtService;
  let auth: AuthService;
  let deviceAuth: DeviceAuthService;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];

  async function makeUser(label: string) {
    const user = await client.user.create({
      data: { email: `${label}-${run}@example.com`, isActive: true },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  /** Runs the public flow up to approval and returns the raw device code. */
  async function approvedDeviceCode(
    userId: string,
    clientInfo: Record<string, unknown>,
  ): Promise<{ deviceCode: string; id: string }> {
    const issued = await deviceAuth.generateDeviceCode(clientInfo);
    await deviceAuth.authorizeDevice(userId, issued.userCode, true);
    const row = await client.deviceCode.findUniqueOrThrow({
      where: { userCode: issued.userCode },
      select: { id: true },
    });
    return { deviceCode: issued.deviceCode, id: row.id };
  }

  beforeAll(() => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const config = new ConfigService({
      jwt: { accessTtlMinutes: 15, refreshTtlDays: 14 },
      deviceAuth: {
        expiryMinutes: 15,
        pollInterval: 0,
        tokenExpiryDays: 7,
        patExpiryDays: 90,
      },
      appUrl: 'http://localhost:3535',
    });
    jwt = new JwtService({ secret: 'device-session-revocation-db-spec' });
    auth = new AuthService(
      prisma,
      jwt,
      config,
      {} as never,
      {} as never,
      {} as never,
    );
    deviceAuth = new DeviceAuthService(
      prisma,
      auth,
      config,
      new PatService(prisma),
    );
  });

  afterAll(async () => {
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
  });

  it('session path: lists the collected session, then revocation kills the JWT and refresh token', async () => {
    const userId = await makeUser('session');
    const { deviceCode, id } = await approvedDeviceCode(userId, {
      deviceName: 'tv',
    });

    const tokens = await deviceAuth.pollForToken(deviceCode);
    const payload = jwt.verify(tokens.accessToken);
    expect(payload.did).toBe(id);

    const row = await client.deviceCode.findUniqueOrThrow({ where: { id } });
    expect(row.collectedAt).not.toBeNull();
    expect(row.credentialExpiresAt!.getTime() - row.collectedAt!.getTime()).toBe(
      7 * DAY_MS,
    );
    const refreshRows = await client.refreshToken.findMany({
      where: { deviceCodeId: id },
    });
    expect(refreshRows).toHaveLength(1);

    const listed = await deviceAuth.getUserDeviceSessions(userId);
    expect(listed.total).toBe(1);
    expect(listed.sessions[0]).toMatchObject({ id, credentialType: 'session' });
    await expect(auth.validateJwtPayload(payload)).resolves.toMatchObject({
      id: userId,
    });

    // Rotation keeps the chain a device chain.
    const rotated = await auth.refreshAccessToken(tokens.refreshToken!);
    expect(jwt.verify(rotated.accessToken).did).toBe(id);
    const live = await client.refreshToken.findMany({
      where: { deviceCodeId: id, revokedAt: null },
    });
    expect(live).toHaveLength(1);
    expect(live[0].expiresAt.getTime()).toBeLessThanOrEqual(
      row.credentialExpiresAt!.getTime(),
    );

    await deviceAuth.revokeDeviceSession(userId, id);

    await expect(auth.validateJwtPayload(payload)).resolves.toBeNull();
    await expect(
      client.refreshToken.count({ where: { deviceCodeId: id, revokedAt: null } }),
    ).resolves.toBe(0);
    await expect(auth.refreshAccessToken(rotated.refreshToken!)).rejects.toThrow(
      'Refresh token has been revoked',
    );
    await expect(deviceAuth.getUserDeviceSessions(userId)).resolves.toMatchObject({
      sessions: [],
      total: 0,
    });
  });

  it('PAT path: revoking the session revokes the PAT, idempotently', async () => {
    const userId = await makeUser('pat');
    const { deviceCode, id } = await approvedDeviceCode(userId, {
      deviceName: 'cli',
      tokenType: 'pat',
    });

    const issued = await deviceAuth.pollForToken(deviceCode);
    const row = await client.deviceCode.findUniqueOrThrow({ where: { id } });
    expect(row.patId).toBe(issued.tokenId);
    expect(row.credentialExpiresAt!.toISOString()).toBe(issued.expiresAt);

    const listed = await deviceAuth.getUserDeviceSessions(userId);
    expect(listed.sessions).toEqual([
      expect.objectContaining({ id, credentialType: 'pat' }),
    ]);

    const pats = new PatService(client as unknown as PrismaService);
    await expect(pats.validateToken(issued.accessToken)).resolves.not.toBeNull();

    await deviceAuth.revokeDeviceSession(userId, id);
    await expect(pats.validateToken(issued.accessToken)).resolves.toBeNull();

    // A second revoke (PAT already revoked) is not an error.
    await expect(deviceAuth.revokeDeviceSession(userId, id)).resolves.toMatchObject({
      success: true,
    });
  });

  it('lists exactly the live sessions and cleanup keeps collected rows until their credential expires', async () => {
    const userId = await makeUser('list');
    const past = new Date(Date.now() - DAY_MS);
    const future = new Date(Date.now() + DAY_MS);
    const base = {
      userId,
      scopes: [],
      clientInfo: {},
      // The CODE expired long ago for every row: only the credential matters
      // once collected.
      expiresAt: new Date(Date.now() - 2 * DAY_MS),
    };
    const mk = (label: string, data: Record<string, unknown>) =>
      client.deviceCode.create({
        data: {
          ...base,
          deviceCode: `${label}-${run}-${randomUUID()}`,
          userCode: `${label.slice(0, 4).toUpperCase()}-${randomUUID().slice(0, 4)}`,
          ...data,
        } as never,
        select: { id: true },
      });

    const approved = await mk('appr', { status: DeviceCodeStatus.approved });
    const collectedLive = await mk('live', {
      status: DeviceCodeStatus.expired,
      collectedAt: past,
      credentialExpiresAt: future,
    });
    await mk('dead', {
      status: DeviceCodeStatus.expired,
      collectedAt: past,
      credentialExpiresAt: past,
    });
    const revoked = await mk('revk', {
      status: DeviceCodeStatus.expired,
      collectedAt: past,
      credentialExpiresAt: future,
      revokedAt: past,
    });
    await mk('deny', { status: DeviceCodeStatus.denied });

    const listed = await deviceAuth.getUserDeviceSessions(userId, 1, 50);
    expect(listed.sessions.map((s) => s.id).sort()).toEqual(
      [approved.id, collectedLive.id].sort(),
    );
    expect(listed.total).toBe(2);

    await deviceAuth.cleanupExpiredCodes();

    const remaining = await client.deviceCode.findMany({
      where: { userId },
      select: { id: true },
    });
    // Uncollected codes past their own expiry go (approved, denied); a
    // collected row whose credential expired goes; collected rows with a live
    // credential stay — revoked or not — because they anchor it.
    expect(remaining.map((r) => r.id).sort()).toEqual(
      [collectedLive.id, revoked.id].sort(),
    );
  });
});
