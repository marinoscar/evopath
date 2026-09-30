// =============================================================================
// Admin model assignments and feature resolution over HTTP (#173)
// =============================================================================
//
//   GET/PUT /api/admin/ai/assignments   ai_config:read / ai_config:write
//   GET     /api/ai/features            ai:use (+ AiEnabledGuard)
//
// The real controllers, guards and services; the feature resolver over the AI
// runtime harness's in-memory keys and models. The RBAC matrix and kill-switch
// suites cover these routes by discovery too; this suite checks the contracts
// and that an administrator's assignment reaches the caller's resolution.
// =============================================================================

import request from 'supertest';

import { HARNESS_MODEL, HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES } from '../../src/ai/testing/fake-ai-provider';
import { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { authHeader, createMockTestUser, type TestUser } from '../helpers/auth-mock.helper';
import { createAiHttpTestApp, type AiHttpTestApp } from './ai-http.helper';

const OTHER_VISION = 'b-vision';

function catalogRow(modelId: string, enabled = true) {
  return {
    id: `id-${modelId}`,
    provider: 'openai',
    modelId,
    displayName: modelId,
    capabilities: FAKE_TEXT_MODEL_CAPABILITIES,
    enabled,
    deprecatedAt: null,
  };
}

describe('AI model assignments over HTTP (#173)', () => {
  let t: AiHttpTestApp;
  let admin: TestUser;
  let contributor: TestUser;
  let viewer: TestUser;

  beforeAll(async () => {
    t = await createAiHttpTestApp(
      {
        models: [
          { modelId: HARNESS_MODEL, capabilities: FAKE_TEXT_MODEL_CAPABILITIES },
          { modelId: OTHER_VISION, capabilities: FAKE_TEXT_MODEL_CAPABILITIES },
        ],
      },
      { harnessFeatureResolver: true },
    );
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    admin = await createMockTestUser(t.context, { roleName: 'admin' });
    contributor = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    viewer = await createMockTestUser(t.context, { roleName: 'viewer' });

    // The admin service reads the catalog and the settings row's provenance
    // from the container's (mocked) Prisma.
    const prisma = t.context.prismaMock;
    prisma.aiModel.findMany.mockResolvedValue([catalogRow(HARNESS_MODEL), catalogRow(OTHER_VISION), catalogRow('off', false)]);
    prisma.systemSettings.findUnique.mockResolvedValue({ version: 4, updatedAt: new Date(), updatedByUser: null });
    prisma.auditEvent.create.mockResolvedValue({});

    // The write lands in the harness policy the resolver reads.
    jest
      .spyOn(t.context.app.get(SystemSettingsService), 'patchSettings')
      .mockImplementation(async (dto: any) => {
        t.harness.setAssignments(dto.ai.assignments);
        return {} as never;
      });
  });

  afterEach(() => jest.restoreAllMocks());

  const server = () => t.context.app.getHttpServer();
  const as = (user: TestUser) => authHeader(user.accessToken);

  it('GET /api/admin/ai/assignments: stored value, eligible models per feature, version', async () => {
    const res = await request(server()).get('/api/admin/ai/assignments').set(as(admin)).expect(200);
    const data = res.body.data;

    expect(data.assignments).toEqual({
      default: null,
      features: {
        gym_scan: null,
        workout_prefill: null,
        body_metric_reading: null,
        'training.researcher': null,
        'training.planner': null,
        'training.critic': null,
        'training.evaluator': null,
      },
    });
    expect(data.features.map((f: { featureId: string }) => f.featureId)).toHaveLength(7);
    expect(data.features[0]).toMatchObject({
      featureId: 'gym_scan',
      group: 'photo',
      needs: ['vision_input', 'structured_output'],
      inputModalities: ['image'],
      eligibleModels: [{ modelId: OTHER_VISION }, { modelId: HARNESS_MODEL }],
      warning: null,
    });
    expect(data.version).toBe(4);
  });

  it('PUT then GET /api/ai/features: the assignment reaches the caller, locked to the admin source', async () => {
    await request(server())
      .put('/api/admin/ai/assignments')
      .set(as(admin))
      .set('If-Match', '4')
      .send({ default: null, features: { gym_scan: { provider: 'openai', modelId: OTHER_VISION } } })
      .expect(200);

    const res = await request(server()).get('/api/ai/features').set(as(contributor)).expect(200);
    const gym = res.body.data.features.find((f: { featureId: string }) => f.featureId === 'gym_scan');
    const prefill = res.body.data.features.find((f: { featureId: string }) => f.featureId === 'workout_prefill');

    expect(gym).toMatchObject({
      featureId: 'gym_scan',
      label: expect.any(String),
      group: 'photo',
      state: 'ready',
      source: 'admin_feature',
      model: { provider: 'openai', modelId: OTHER_VISION, keySource: 'user' },
      fix: null,
    });
    expect(prefill).toMatchObject({ state: 'auto', source: 'auto' });
    expect(JSON.stringify(res.body)).not.toContain('sk-');
  });

  it('PUT refuses an invalid assignment with 400 AI_ASSIGNMENT_INVALID and details.errors', async () => {
    const res = await request(server())
      .put('/api/admin/ai/assignments')
      .set(as(admin))
      .send({ default: null, features: { gym_scan: { provider: 'openai', modelId: 'off' } } })
      .expect(400);

    expect(res.body.details).toMatchObject({
      reason: 'AI_ASSIGNMENT_INVALID',
      errors: [{ field: 'features.gym_scan', provider: 'openai', modelId: 'off', code: 'AI_ASSIGNMENT_MODEL_DISABLED' }],
    });
  });

  it('PUT refuses an unknown feature id and a stale If-Match', async () => {
    await request(server())
      .put('/api/admin/ai/assignments')
      .set(as(admin))
      .send({ default: null, features: { nope: { provider: 'openai', modelId: HARNESS_MODEL } } })
      .expect(400);

    await request(server()).put('/api/admin/ai/assignments').set(as(admin)).set('If-Match', '1').send({ default: null, features: {} }).expect(409);
  });

  it('RBAC: a contributor cannot read or write assignments; a viewer cannot read features', async () => {
    await request(server()).get('/api/admin/ai/assignments').set(as(contributor)).expect(403);
    await request(server()).put('/api/admin/ai/assignments').set(as(contributor)).send({ default: null, features: {} }).expect(403);
    await request(server()).get('/api/ai/features').set(as(viewer)).expect(403);
    await request(server()).get('/api/ai/features').expect(401);
  });

  it('kill switch: /api/ai/features is AI_DISABLED, the admin routes stay reachable', async () => {
    t.harness.setPolicy({ enabled: false });

    const res = await request(server()).get('/api/ai/features').set(as(contributor)).expect(403);
    expect(res.body.details.reason).toBe('AI_DISABLED');

    await request(server()).get('/api/admin/ai/assignments').set(as(admin)).expect(200);
  });
});
