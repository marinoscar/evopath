// =============================================================================
// /api/admin/coach/settings over HTTP (E7.2, #242)
// =============================================================================
//
// `ai_config:read` / `ai_config:write`, NOT behind `AiEnabledGuard`: the
// routes work while AI is off. Validation of the system `coach` setting.
// =============================================================================

import request from 'supertest';

import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { authHeader, createMockTestUser, type TestUser } from '../helpers/auth-mock.helper';
import { createAiHttpTestApp, type AiHttpTestApp } from '../ai/ai-http.helper';
import { useSystemCoachPolicy } from './coach-test.helper';

const PATH = '/api/admin/coach/settings';

describe('/api/admin/coach/settings (E7.2)', () => {
  let t: AiHttpTestApp;
  let admin: TestUser;
  let contributor: TestUser;

  const server = () => t.context.app.getHttpServer();

  beforeAll(async () => {
    t = await createAiHttpTestApp();
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    admin = await createMockTestUser(t.context, { roleName: 'admin' });
    contributor = await createMockTestUser(t.context, { roleName: 'contributor' });
    useSystemCoachPolicy(t.context);
  });

  it('GET answers the system coach setting', async () => {
    const res = await request(server()).get(PATH).set(authHeader(admin.accessToken)).expect(200);

    expect(res.body.data).toEqual(DEFAULT_SYSTEM_SETTINGS.coach);
  });

  it('PUT stores a partial change, keeps the rest and audits it', async () => {
    const prisma = t.context.prismaMock as any;

    const res = await request(server())
      .put(PATH)
      .set(authHeader(admin.accessToken))
      .send({ allowProfanePersonas: true, maxNudgesPerDayCeiling: 2 })
      .expect(200);

    expect(res.body.data).toEqual({ ...DEFAULT_SYSTEM_SETTINGS.coach, allowProfanePersonas: true, maxNudgesPerDayCeiling: 2 });
    expect((await request(server()).get(PATH).set(authHeader(admin.accessToken)).expect(200)).body.data.allowProfanePersonas).toBe(true);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorUserId: admin.id, action: 'system_settings:patch' }),
    });
  });

  it('PUT refuses an invalid value with Zod issues', async () => {
    for (const body of [
      { inactiveStopDays: 0 },
      { maxNudgesPerDayCeiling: 5 },
      { audioRetentionDays: -1 },
      { allowAudio: 'yes' },
      { unknownKey: true },
    ]) {
      const res = await request(server()).put(PATH).set(authHeader(admin.accessToken)).send(body).expect(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    }
    const res = await request(server()).put(PATH).set(authHeader(admin.accessToken)).send({ inactiveStopDays: 0 }).expect(400);
    expect(res.body.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'inactiveStopDays' })]));
  });

  it('works while AI is switched off', async () => {
    t.harness.setPolicy({ enabled: false });

    await request(server()).get(PATH).set(authHeader(admin.accessToken)).expect(200);
    await request(server()).put(PATH).set(authHeader(admin.accessToken)).send({ enabled: false }).expect(200);
  });

  it('403 without ai_config:read / ai_config:write; 401 unauthenticated', async () => {
    await request(server()).get(PATH).set(authHeader(contributor.accessToken)).expect(403);
    await request(server()).put(PATH).set(authHeader(contributor.accessToken)).send({ enabled: false }).expect(403);
    await request(server()).get(PATH).expect(401);
    await request(server()).put(PATH).send({}).expect(401);
  });
});
