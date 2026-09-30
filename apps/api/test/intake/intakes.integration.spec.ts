// =============================================================================
// Integration: /api/intakes (E3.1) — full AppModule, mocked Prisma, AI harness
// =============================================================================
//
// The HTTP contract end to end through the real guards (`AiEnabledGuard`,
// JWT, `PermissionsGuard`), pipes, interceptor and exception filter:
//
//   - an RBAC matrix over every `/api/intakes*` route DISCOVERED from the
//     OpenAPI document (never hand-listed; the technique of
//     `storage-rbac-matrix.integration.spec.ts`), crossed with Admin /
//     Contributor / Viewer / unauthenticated, the expected grant read from
//     `prisma/seed-data.ts`'s `ROLE_PERMISSIONS`;
//   - ownership: another user's intake is a 404 on every parameterised route;
//   - the analyze gate: AI off, no `ai:use`, a client model other than the
//     administrator-resolved one (#173), no usable model, success (a job of
//     the kind's `analyzeJobType`), and a second analyze while scanning —
//     over the #432 AI harness
//     (`ai-http.helper.ts`), whose `UsableModelsService` answers the model
//     gate from its in-memory catalog;
//   - the attach refusals and the item/apply refusals a client sees.
//
// A TEST-ONLY stub kind (`test_stub`) is registered on the app's own
// `IntakeKindRegistry`; no production kind exists yet (E3.4 adds the first).
// Real-row semantics are in `intakes.db.spec.ts`.
// =============================================================================

import request from 'supertest';
import { z } from 'zod';

import { ROLE_PERMISSIONS } from '../../prisma/seed-data';
import { RBAC_EXTENSION_KEY, type RbacExtension } from '../../src/auth/decorators/auth.decorator';
import {
  HARNESS_EMBEDDING_MODEL,
  HARNESS_MODEL,
  HARNESS_OTHER_USER,
  HARNESS_USER,
} from '../../src/ai/testing/ai-runtime-harness';
import { draftItemViewSchema, photoIntakeViewSchema } from '../../src/intake/dto/intake.dto';
import type { IntakeKind } from '../../src/intake/intake-kind.interface';
import { IntakeKindRegistry } from '../../src/intake/intake-kind.registry';
import { createOpenApiDocument } from '../../src/openapi/document';
import { forEachOperation, type MutableDocument } from '../../src/openapi/types';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { mockPrismaTransaction } from '../mocks/prisma.mock';
import { type AiHttpTestApp, createAiHttpTestApp } from '../ai/ai-http.helper';
import { JPEG_BYTES } from '../../src/intake/testing/pdf-bytes';

const INTAKE = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const OBJECT = '55555555-5555-4555-8555-555555555555';
const JOB = '66666666-6666-4666-8666-666666666666';
const VIEWER = '77777777-7777-4777-8777-777777777777';
const ADMIN = '88888888-8888-4888-8888-888888888888';

const STUB_JOB_TYPE = 'test.intake.analyze';

const applySpy = jest.fn(async ({ accepted }: { accepted: unknown[] }) => ({ applied: accepted.length }));

const stubKind: IntakeKind = {
  kind: 'test_stub',
  contextSchema: z.object({ label: z.string().max(20) }).strict().optional(),
  valueSchema: z.object({ name: z.string().min(1).max(100) }).strict(),
  analyzeJobType: STUB_JOB_TYPE,
  aiFeature: 'gym_scan',
  itemKinds: ['thing'],
  apply: applySpy,
};

function intakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INTAKE,
    userId: HARNESS_USER,
    kind: 'test_stub',
    status: 'draft',
    subjectType: null,
    subjectId: null,
    context: null,
    provider: null,
    modelId: null,
    jobId: null,
    errorCode: null,
    errorMessage: null,
    resultMeta: null,
    createdAt: new Date('2026-09-29T10:00:00.000Z'),
    updatedAt: new Date('2026-09-29T10:00:00.000Z'),
    completedAt: null,
    ...overrides,
  };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM,
    intakeId: INTAKE,
    kind: 'thing',
    origin: 'ai',
    status: 'pending',
    confidence: 'low',
    uncertain: true,
    uncertaintyNote: 'Partly hidden',
    sourcePhotoIds: [OBJECT],
    userVerified: false,
    value: { name: 'Leg press' },
    originalAiValue: null,
    sortOrder: 0,
    createdAt: new Date('2026-09-29T10:00:00.000Z'),
    updatedAt: new Date('2026-09-29T10:00:00.000Z'),
    ...overrides,
  };
}

interface IntakeRoute {
  path: string;
  method: string;
  permissions: string[];
}

type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

const concretePath = (path: string) =>
  path.replace('{id}', INTAKE).replace('{itemId}', ITEM).replace('{storageObjectId}', OBJECT);

/** True when the response is `PermissionsGuard`'s own, reason-less denial. */
function isPermissionDenied(res: request.Response): boolean {
  return res.status === 403 && typeof res.body?.message === 'string' && res.body.message.startsWith('Missing permissions:');
}

/** A body each route's DTO accepts, so an ownership check is not pre-empted by a 400. */
const VALID_BODIES: Record<string, object> = {
  'POST /api/intakes/{id}/photos': { storageObjectId: OBJECT },
  'POST /api/intakes/{id}/analyze': {},
  'POST /api/intakes/{id}/items': { kind: 'thing', value: { name: 'Bench' } },
  'PATCH /api/intakes/{id}/items/{itemId}': { status: 'accepted' },
  'PATCH /api/intakes/{id}': { context: { label: 'Gym' } },
};

const ROLES = ['admin', 'contributor', 'viewer'] as const;

describe('/api/intakes over HTTP (E3.1)', () => {
  let t: AiHttpTestApp;
  let prisma: any;
  let routes: IntakeRoute[];
  const tokens: Record<(typeof ROLES)[number], string> = { admin: '', contributor: '', viewer: '' };

  beforeAll(async () => {
    t = await createAiHttpTestApp({}, { harnessUsableModels: true });
    prisma = t.context.prismaMock;
    t.context.app.get(IntakeKindRegistry).register(stubKind);

    const document = createOpenApiDocument(t.context.app) as unknown as MutableDocument;
    routes = [];
    forEachOperation(document, (operation, path, method) => {
      if (!path.startsWith('/api/intakes')) return;
      const rbac = operation[RBAC_EXTENSION_KEY] as RbacExtension | undefined;
      routes.push({ path, method: method.toUpperCase(), permissions: rbac?.permissions ?? [] });
    });
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    mockPrismaTransaction();
    applySpy.mockClear();

    tokens.contributor = (await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' })).accessToken;
    tokens.viewer = (await createMockTestUser(t.context, { id: VIEWER, roleName: 'viewer' })).accessToken;
    tokens.admin = (await createMockTestUser(t.context, { id: ADMIN, roleName: 'admin' })).accessToken;

    // Quiet defaults: nothing exists.
    prisma.photoIntake.findMany.mockResolvedValue([]);
    prisma.photoIntake.findFirst.mockResolvedValue(null);
  });

  const server = () => t.context.app.getHttpServer();
  const call = (method: HttpMethod, path: string, token: string, body: object = {}) =>
    request(server())[method](path).set(authHeader(token)).send(body);

  /** `findFirst` that honours the `userId` filter over one stored row. */
  function storeIntake(row: ReturnType<typeof intakeRow>): void {
    prisma.photoIntake.findFirst.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      if (where.id !== undefined && where.id !== row.id) return null;
      if (where.userId !== undefined && where.userId !== row.userId) return null;
      return args?.select ? { status: row.status } : row;
    });
  }

  // ---------------------------------------------------------------------------
  // RBAC matrix
  // ---------------------------------------------------------------------------

  describe('RBAC matrix', () => {
    it('discovers every intake route, each declaring intakes:read or intakes:write (analyze also ai:use)', () => {
      expect(routes.length).toBe(13);

      const failures = routes
        .filter((route) => {
          const [first, ...rest] = route.permissions;
          if (route.path.endsWith('/analyze')) {
            return !(first === 'intakes:write' && rest.length === 1 && rest[0] === 'ai:use');
          }
          return !(route.permissions.length === 1 && ['intakes:read', 'intakes:write'].includes(first));
        })
        .map((route) => `${route.method} ${route.path}: ${JSON.stringify(route.permissions)}`);

      expect(failures).toEqual([]);
    });

    it('every route answers 401 without a token', async () => {
      const failures: string[] = [];

      for (const route of routes) {
        const res = await request(server())[route.method.toLowerCase() as HttpMethod](concretePath(route.path)).send({});
        if (res.status !== 401) failures.push(`${route.method} ${route.path}: expected 401, got ${res.status}`);
      }

      expect(failures).toEqual([]);
    });

    it.each(ROLES)('%s is granted or denied exactly as ROLE_PERMISSIONS says, on every route', async (role) => {
      const granted = new Set(ROLE_PERMISSIONS[role]);
      const failures: string[] = [];

      for (const route of routes) {
        const shouldHold = route.permissions.every((p) => granted.has(p));
        const res = await call(
          route.method.toLowerCase() as HttpMethod,
          concretePath(route.path),
          tokens[role],
          VALID_BODIES[`${route.method} ${route.path}`] ?? {},
        );
        const denied = isPermissionDenied(res);

        if (shouldHold && denied) failures.push(`${route.method} ${route.path}: ${role} was denied`);
        if (!shouldHold && !denied) failures.push(`${route.method} ${route.path}: ${role} was not denied (${res.status})`);
      }

      expect(failures).toEqual([]);
    });

    it('the viewer holds intakes:* but not ai:use, so only analyze is refused', () => {
      expect(ROLE_PERMISSIONS.viewer).toEqual(expect.arrayContaining(['intakes:read', 'intakes:write']));
      expect(ROLE_PERMISSIONS.viewer).not.toContain('ai:use');
    });
  });

  // ---------------------------------------------------------------------------
  // Ownership
  // ---------------------------------------------------------------------------

  describe('ownership', () => {
    it("answers 404 on every parameterised route for another user's intake", async () => {
      storeIntake(intakeRow({ userId: HARNESS_OTHER_USER }));
      const failures: string[] = [];

      for (const route of routes.filter((r) => r.path.includes('{id}'))) {
        const res = await call(
          route.method.toLowerCase() as HttpMethod,
          concretePath(route.path),
          tokens.contributor,
          VALID_BODIES[`${route.method} ${route.path}`] ?? {},
        );
        if (res.status !== 404) failures.push(`${route.method} ${route.path}: expected 404, got ${res.status}`);
      }

      expect(failures).toEqual([]);
    });

    it('GET /api/intakes lists only the caller\'s intakes', async () => {
      await call('get', '/api/intakes?status=draft,ready&limit=5', tokens.contributor).expect(200);

      expect(prisma.photoIntake.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: HARNESS_USER, status: { in: ['draft', 'ready'] } }, take: 5 }),
      );
    });

    it.each([
      ['an unknown status', 'status=done'],
      ['a limit above 50', 'limit=51'],
    ])('GET /api/intakes refuses %s with 400', async (_label, query) => {
      await call('get', `/api/intakes?${query}`, tokens.contributor).expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Create and read
  // ---------------------------------------------------------------------------

  describe('POST /api/intakes', () => {
    it('refuses an unregistered kind with 400 UNKNOWN_INTAKE_KIND', async () => {
      const res = await call('post', '/api/intakes', tokens.contributor, { kind: 'no_such_kind' }).expect(400);

      expect(res.body.details.reason).toBe('UNKNOWN_INTAKE_KIND');
      expect(prisma.photoIntake.create).not.toHaveBeenCalled();
    });

    it('creates a draft of a registered kind (201, the PhotoIntakeView contract)', async () => {
      prisma.photoIntake.create.mockResolvedValue({ ...intakeRow({ context: { label: 'Home' } }), photos: [], items: [] });

      const res = await call('post', '/api/intakes', tokens.contributor, { kind: 'test_stub', context: { label: 'Home' } }).expect(201);

      expect(photoIntakeViewSchema.safeParse(res.body.data).success).toBe(true);
      expect(res.body.data).toMatchObject({ kind: 'test_stub', status: 'draft', context: { label: 'Home' } });
    });

    it('refuses server-owned fields in the body with 400', async () => {
      await call('post', '/api/intakes', tokens.contributor, { kind: 'test_stub', status: 'ready' }).expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Photos
  // ---------------------------------------------------------------------------

  describe('PATCH /api/intakes/:id (context)', () => {
    const patch = (token: string, body: object) => call('patch', `/api/intakes/${INTAKE}`, token, body);

    it('replaces the context, validated by the kind, and answers the intake', async () => {
      const row = intakeRow({ status: 'ready', context: { label: 'Home' } });
      storeIntake(row);
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });
      prisma.photoIntake.findFirst.mockImplementation(async (args: any) =>
        args?.include ? { ...row, context: { label: 'Gym' }, photos: [], items: [] } : row,
      );

      const res = await patch(tokens.contributor, { context: { label: 'Gym' } }).expect(200);

      expect(res.body.data.context).toEqual({ label: 'Gym' });
      expect(prisma.photoIntake.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: INTAKE, userId: HARNESS_USER, status: { in: ['draft', 'ready', 'failed'] } },
        data: { context: { label: 'Gym' } },
      });
    });

    it('answers 400 with context-prefixed issues for a context the kind refuses', async () => {
      storeIntake(intakeRow());

      const res = await patch(tokens.contributor, { context: { label: 'x'.repeat(21) } }).expect(400);

      expect(res.body.details.issues[0].path).toBe('context.label');
      expect(prisma.photoIntake.updateMany).not.toHaveBeenCalled();
    });

    it('answers 409 while scanning or once applied, and 404 for another user\'s intake', async () => {
      storeIntake(intakeRow({ status: 'scanning' }));
      expect((await patch(tokens.contributor, { context: {} }).expect(409)).body.details.reason).toBe('INTAKE_SCANNING');

      storeIntake(intakeRow({ status: 'applied' }));
      expect((await patch(tokens.contributor, { context: {} }).expect(409)).body.details.reason).toBe('ALREADY_APPLIED');

      storeIntake(intakeRow({ userId: VIEWER }));
      await patch(tokens.contributor, { context: {} }).expect(404);
      expect(prisma.photoIntake.updateMany).not.toHaveBeenCalled();
    });

    it('refuses unknown properties', async () => {
      storeIntake(intakeRow());
      await patch(tokens.contributor, { context: {}, kind: 'other' }).expect(400);
    });
  });

  describe('POST /api/intakes/:id/photos', () => {
    const readyImage = {
      id: OBJECT,
      name: 'rack.jpg',
      status: 'ready',
      mimeType: 'image/jpeg',
      size: BigInt(2 * 1024 * 1024),
      uploadedById: HARNESS_USER,
    };

    beforeEach(() => {
      storeIntake(intakeRow());
      prisma.photoIntakePhoto.count.mockResolvedValue(0);
      prisma.photoIntakePhoto.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
    });

    it('attaches a ready image the caller owns (201)', async () => {
      // The attach reads the stored bytes back (magic bytes, H2 #186).
      const stored = t.harness.storage.addObject({ uploadedById: HARNESS_USER, mimeType: 'image/jpeg', bytes: JPEG_BYTES });
      prisma.storageObject.findUnique.mockResolvedValue({ ...readyImage, storageKey: stored.storageKey });
      prisma.photoIntakePhoto.create.mockResolvedValue({
        id: '99999999-9999-4999-8999-999999999999',
        intakeId: INTAKE,
        storageObjectId: OBJECT,
        sortOrder: 0,
        createdAt: new Date(),
        storageObject: { name: 'rack.jpg' },
      });

      const res = await call('post', `/api/intakes/${INTAKE}/photos`, tokens.contributor, { storageObjectId: OBJECT }).expect(201);

      expect(res.body.data).toEqual({
        id: '99999999-9999-4999-8999-999999999999',
        storageObjectId: OBJECT,
        name: 'rack.jpg',
        sortOrder: 0,
        // `gym_equipment` is not a health intake kind: no health document.
        healthDocumentId: null,
        retention: null,
      });
    });

    it.each([
      ["another user's object", { uploadedById: HARNESS_OTHER_USER }, 404, undefined],
      ['a non-ready object', { status: 'uploading' }, 400, 'OBJECT_NOT_READY'],
      ['a non-image object', { mimeType: 'text/plain' }, 400, 'UNSUPPORTED_MEDIA_TYPE'],
      ['a 21 MiB object', { size: BigInt(21 * 1024 * 1024) }, 400, 'OBJECT_TOO_LARGE'],
    ])('refuses %s', async (_label, override, status, reason) => {
      prisma.storageObject.findUnique.mockResolvedValue({ ...readyImage, ...override });

      const res = await call('post', `/api/intakes/${INTAKE}/photos`, tokens.contributor, { storageObjectId: OBJECT }).expect(status);

      if (reason) expect(res.body.details.reason).toBe(reason);
      expect(prisma.photoIntakePhoto.create).not.toHaveBeenCalled();
    });

    it('refuses the 49th photo (the default cap is 48)', async () => {
      prisma.storageObject.findUnique.mockResolvedValue(readyImage);
      prisma.photoIntakePhoto.count.mockResolvedValue(48);

      const res = await call('post', `/api/intakes/${INTAKE}/photos`, tokens.contributor, { storageObjectId: OBJECT }).expect(400);

      expect(res.body.details).toMatchObject({ reason: 'TOO_MANY_PHOTOS', maxPhotos: 48 });
    });
  });

  // ---------------------------------------------------------------------------
  // Analyze gate
  // ---------------------------------------------------------------------------

  describe('POST /api/intakes/:id/analyze', () => {
    const analyze = (token: string, body: object = {}) =>
      call('post', `/api/intakes/${INTAKE}/analyze`, token, body);

    beforeEach(() => {
      storeIntake(intakeRow({ status: 'draft' }));
      prisma.photoIntakePhoto.count.mockResolvedValue(2);
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });
      prisma.job.create.mockImplementation(async (args: any) => ({ id: JOB, status: 'pending', ...args.data }));
    });

    it('answers 403 details.reason AI_DISABLED while AI is off, before anything else', async () => {
      t.harness.setPolicy({ enabled: false });

      const res = await analyze(tokens.contributor).expect(403);

      expect(res.body.details.reason).toBe('AI_DISABLED');
      expect(prisma.job.create).not.toHaveBeenCalled();
    });

    it('answers 403 to a viewer (no ai:use)', async () => {
      const res = await analyze(tokens.viewer).expect(403);

      expect(isPermissionDenied(res)).toBe(true);
      expect(res.body.message).toContain('ai:use');
    });

    it('answers 409 AI_MODEL_ASSIGNMENT_LOCKED for a client model other than the resolved one (#173)', async () => {
      const res = await analyze(tokens.contributor, { provider: 'openai', modelId: HARNESS_EMBEDDING_MODEL }).expect(409);

      expect(res.body.details).toMatchObject({
        reason: 'AI_MODEL_ASSIGNMENT_LOCKED',
        featureId: 'gym_scan',
        provider: 'openai',
        modelId: HARNESS_MODEL,
      });
      expect(prisma.job.create).not.toHaveBeenCalled();
    });

    it('accepts a client model equal to the resolved one (an older client)', async () => {
      await analyze(tokens.contributor, { provider: 'openai', modelId: HARNESS_MODEL }).expect(202);
    });

    it('answers 400 when only one of provider and modelId is sent', async () => {
      await analyze(tokens.contributor, { provider: 'openai' }).expect(400);
    });

    it('answers 409 AI_FEATURE_UNAVAILABLE with the state when no model is usable (#173)', async () => {
      const spy = jest.spyOn(t.harness.usableModels, 'listForUser').mockResolvedValue([]);

      try {
        const res = await analyze(tokens.contributor).expect(409);

        expect(res.body.details).toMatchObject({ reason: 'AI_FEATURE_UNAVAILABLE', featureId: 'gym_scan', state: 'no_models', fix: 'admin' });
        expect(prisma.job.create).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("an unusable administrator assignment falls through to the auto pick rather than blocking", async () => {
      t.harness.setAssignments({ default: null, features: { gym_scan: { provider: 'openai', modelId: 'not-enabled' } } });

      await analyze(tokens.contributor).expect(202);

      expect(prisma.photoIntake.updateMany.mock.calls[0][0].data).toMatchObject({ provider: 'openai', modelId: HARNESS_MODEL });
    });

    it("answers 202 { intakeId, jobId } and queues a pending job of the kind's analyzeJobType", async () => {
      const res = await analyze(tokens.contributor).expect(202);

      expect(res.body.data).toEqual({ intakeId: INTAKE, jobId: JOB });
      expect(prisma.job.create).toHaveBeenCalledTimes(1);
      expect(prisma.job.create.mock.calls[0][0].data).toMatchObject({
        type: STUB_JOB_TYPE,
        reason: 'upload',
        subjectType: 'photo_intake',
        subjectId: INTAKE,
        payload: { intakeId: INTAKE },
      });
      expect(prisma.photoIntake.updateMany.mock.calls[0][0].data).toMatchObject({
        status: 'scanning',
        provider: 'openai',
        modelId: HARNESS_MODEL,
      });
      expect(prisma.photoIntake.update).toHaveBeenCalledWith({ where: { id: INTAKE }, data: { jobId: JOB } });
    });

    it('answers 409 to a second analyze while scanning', async () => {
      storeIntake(intakeRow({ status: 'scanning' }));

      const res = await analyze(tokens.contributor).expect(409);

      expect(res.body.details.reason).toBe('INTAKE_SCANNING');
      expect(prisma.job.create).not.toHaveBeenCalled();
    });

    it('answers 400 NO_PHOTOS for an intake without photos', async () => {
      prisma.photoIntakePhoto.count.mockResolvedValue(0);

      const res = await analyze(tokens.contributor).expect(400);

      expect(res.body.details.reason).toBe('NO_PHOTOS');
    });
  });

  // ---------------------------------------------------------------------------
  // Items and apply
  // ---------------------------------------------------------------------------

  describe('items and apply', () => {
    beforeEach(() => {
      storeIntake(intakeRow({ status: 'ready' }));
    });

    it('PATCH returns the full DraftItemView with originalAiValue kept from the first edit', async () => {
      prisma.draftItem.findFirst.mockResolvedValue(itemRow());
      prisma.draftItem.update.mockResolvedValue(
        itemRow({ value: { name: 'Seated leg press' }, originalAiValue: { name: 'Leg press' }, userVerified: true }),
      );

      const res = await call('patch', `/api/intakes/${INTAKE}/items/${ITEM}`, tokens.contributor, {
        value: { name: 'Seated leg press' },
      }).expect(200);

      expect(draftItemViewSchema.safeParse(res.body.data).success).toBe(true);
      expect(res.body.data).toMatchObject({
        value: { name: 'Seated leg press' },
        originalAiValue: { name: 'Leg press' },
        userVerified: true,
        confidence: 'low',
      });
    });

    it('PATCH refuses provenance fields in the body with 400', async () => {
      await call('patch', `/api/intakes/${INTAKE}/items/${ITEM}`, tokens.contributor, { userVerified: true }).expect(400);
    });

    it('DELETE of an AI item answers 409 USE_REJECT; of a user item 204', async () => {
      prisma.draftItem.findFirst.mockResolvedValueOnce(itemRow());
      const refused = await call('delete', `/api/intakes/${INTAKE}/items/${ITEM}`, tokens.contributor).expect(409);
      expect(refused.body.details.reason).toBe('USE_REJECT');

      prisma.draftItem.findFirst.mockResolvedValueOnce(itemRow({ origin: 'user', confidence: null, userVerified: true }));
      await call('delete', `/api/intakes/${INTAKE}/items/${ITEM}`, tokens.contributor).expect(204);
      expect(prisma.draftItem.deleteMany).toHaveBeenCalledTimes(1);
    });

    it('apply with a pending item answers 400 PENDING_ITEMS with the count', async () => {
      prisma.draftItem.count.mockResolvedValue(3);

      const res = await call('post', `/api/intakes/${INTAKE}/apply`, tokens.contributor).expect(400);

      expect(res.body.details).toEqual({ reason: 'PENDING_ITEMS', count: 3 });
      expect(applySpy).not.toHaveBeenCalled();
    });

    it("apply with none pending answers 200 with the kind's result", async () => {
      prisma.draftItem.count.mockResolvedValue(0);
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });
      prisma.draftItem.findMany.mockResolvedValue([itemRow({ status: 'accepted', userVerified: true })]);

      const res = await call('post', `/api/intakes/${INTAKE}/apply`, tokens.contributor).expect(200);

      expect(res.body.data).toEqual({ applied: 1 });
      expect(applySpy).toHaveBeenCalledTimes(1);
    });

    it('apply on an applied intake answers 409 ALREADY_APPLIED', async () => {
      storeIntake(intakeRow({ status: 'applied' }));

      const res = await call('post', `/api/intakes/${INTAKE}/apply`, tokens.contributor).expect(409);

      expect(res.body.details.reason).toBe('ALREADY_APPLIED');
    });
  });
});
