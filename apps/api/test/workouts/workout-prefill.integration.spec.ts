// =============================================================================
// "Prefill from photo" (E4.5) over HTTP — wiring, RBAC and the AI gates
// =============================================================================
//
// The real application (mocked Prisma, the AI runtime harness): the
// `workout_prefill` kind, its `ai.workout.prefill` job and the workout photo
// reference checker are registered by `WorkoutsModule`; a viewer (no
// `ai:use`) can still create an intake and use it manually but cannot
// analyze; AI off refuses analyze with `AI_DISABLED`; another user's workout
// is a 404. The real-database flow is `workout-prefill.db.spec.ts`.
// =============================================================================

import request from 'supertest';

import { HARNESS_MODEL, HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { IntakeKindRegistry } from '../../src/intake/intake-kind.registry';
import { StorageObjectReferences } from '../../src/intake/storage-object-references';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { type AiHttpTestApp, createAiHttpTestApp } from '../ai/ai-http.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { mockPrismaTransaction } from '../mocks/prisma.mock';

const INTAKE = '33333333-3333-4333-8333-333333333333';
const WORKOUT = '44444444-4444-4444-8444-444444444444';
const JOB = '66666666-6666-4666-8666-666666666666';
const VIEWER = '77777777-7777-4777-8777-777777777777';

function intakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INTAKE,
    userId: HARNESS_USER,
    kind: 'workout_prefill',
    status: 'draft',
    subjectType: 'workout',
    subjectId: WORKOUT,
    context: { workoutId: WORKOUT, sourceHint: 'notebook' },
    provider: null,
    modelId: null,
    jobId: null,
    errorCode: null,
    errorMessage: null,
    resultMeta: null,
    createdAt: new Date('2026-09-29T10:00:00.000Z'),
    updatedAt: new Date('2026-09-29T10:00:00.000Z'),
    completedAt: null,
    photos: [],
    items: [],
    ...overrides,
  };
}

describe('"Prefill from photo" over HTTP (E4.5)', () => {
  let t: AiHttpTestApp;
  let prisma: any;
  let contributor: string;
  let viewer: string;

  beforeAll(async () => {
    t = await createAiHttpTestApp({}, { harnessUsableModels: true });
    prisma = t.context.prismaMock;
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    mockPrismaTransaction();
    contributor = (await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' })).accessToken;
    viewer = (await createMockTestUser(t.context, { id: VIEWER, roleName: 'viewer' })).accessToken;
    prisma.photoIntake.findMany.mockResolvedValue([]);
  });

  const server = () => t.context.app.getHttpServer();

  /** The caller's workout exists (`findFirst` honours the `userId` filter). */
  function workoutOf(ownerId: string, status = 'in_progress') {
    prisma.workout.findFirst.mockImplementation(async (args: any) =>
      args?.where?.id === WORKOUT && args?.where?.userId === ownerId ? { status } : null,
    );
  }

  /** One stored intake (`findFirst` honours the `userId` filter). */
  function storeIntake(row: ReturnType<typeof intakeRow>) {
    prisma.photoIntake.findFirst.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      if (where.id !== undefined && where.id !== row.id) return null;
      if (where.userId !== undefined && where.userId !== row.userId) return null;
      return args?.select ? { status: row.status } : row;
    });
  }

  it('WorkoutsModule registers the kind, the server-only job and the photo reference checker', () => {
    const kind = t.context.app.get(IntakeKindRegistry).get('workout_prefill');
    const jobs = t.context.app.get(JobHandlerRegistry);

    expect(kind).toMatchObject({ analyzeJobType: 'ai.workout.prefill', maxPhotos: 32, itemKinds: ['exercise'] });
    expect(kind!.requiredPermissions).toEqual({
      read: ['workouts:read'],
      write: ['workouts:write', 'exercises:write'],
    });
    expect(jobs.get('ai.workout.prefill')).toBeDefined();
    expect(jobs.serverOnlyTypes()).toContain('ai.workout.prefill');
    expect(t.context.app.get(StorageObjectReferences).list()).toEqual(
      expect.arrayContaining(['gym_photos', 'workout_photos']),
    );
  });

  describe('POST /api/intakes (kind workout_prefill)', () => {
    const create = (token: string, context: object) =>
      request(server()).post('/api/intakes').set(authHeader(token)).send({ kind: 'workout_prefill', context });

    it('creates a draft whose subject is the workout, for any role with the workout permissions (the viewer too)', async () => {
      workoutOf(VIEWER);
      prisma.photoIntake.create.mockImplementation(async (args: any) => ({ ...intakeRow({ userId: VIEWER }), ...args.data }));

      const res = await create(viewer, { workoutId: WORKOUT, sourceHint: 'whiteboard' }).expect(201);

      expect(prisma.photoIntake.create.mock.calls[0][0].data).toMatchObject({
        userId: VIEWER,
        kind: 'workout_prefill',
        status: 'draft',
        subjectType: 'workout',
        subjectId: WORKOUT,
        context: { workoutId: WORKOUT, sourceHint: 'whiteboard' },
      });
      expect(res.body.data.kind).toBe('workout_prefill');
    });

    it("answers 404 for another user's workout and creates nothing", async () => {
      workoutOf(VIEWER);

      await create(contributor, { workoutId: WORKOUT }).expect(404);

      expect(prisma.photoIntake.create).not.toHaveBeenCalled();
    });

    it('answers 400 for an unknown source hint or a stray property', async () => {
      workoutOf(HARNESS_USER);

      const res = await create(contributor, { workoutId: WORKOUT, sourceHint: 'napkin' }).expect(400);
      expect(res.body.details.issues[0].path).toBe('context.sourceHint');
      await create(contributor, { workoutId: WORKOUT, gymId: WORKOUT }).expect(400);
      expect(prisma.photoIntake.create).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/intakes/:id/analyze', () => {
    const analyze = (token: string) =>
      request(server())
        .post(`/api/intakes/${INTAKE}/analyze`)
        .set(authHeader(token))
        .send({ provider: 'openai', modelId: HARNESS_MODEL });

    beforeEach(() => {
      storeIntake(intakeRow());
      prisma.photoIntakePhoto.count.mockResolvedValue(1);
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });
      prisma.job.create.mockImplementation(async (args: any) => ({ id: JOB, status: 'pending', ...args.data }));
    });

    it('a viewer (no ai:use) is refused with 403 and nothing is queued', async () => {
      const res = await analyze(viewer).expect(403);

      expect(res.body.message).toContain('ai:use');
      expect(prisma.job.create).not.toHaveBeenCalled();
    });

    it('AI off: 403 AI_DISABLED and nothing is queued', async () => {
      t.harness.setPolicy({ enabled: false });

      const res = await analyze(contributor).expect(403);

      expect(res.body.details.reason).toBe('AI_DISABLED');
      expect(prisma.job.create).not.toHaveBeenCalled();
    });

    it('queues ai.workout.prefill for the intake', async () => {
      const res = await analyze(contributor).expect(202);

      expect(res.body.data).toEqual({ intakeId: INTAKE, jobId: JOB });
      expect(prisma.job.create.mock.calls[0][0].data).toMatchObject({
        type: 'ai.workout.prefill',
        subjectType: 'photo_intake',
        subjectId: INTAKE,
        payload: { intakeId: INTAKE },
      });
    });
  });
});
