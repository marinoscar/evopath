import type { Job } from '@prisma/client';

import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import {
  USER_DATA_RESET_COMPLETED_ACTION,
  USER_DATA_RESET_TYPE,
} from '../user-data.constants';
import { USER_DATA_RESET_CHUNK_SIZE, UserDataResetHandler, chunk } from './user-data-reset.handler';

const USER = 'user-1';

type Call = { model: string; method: string; args: any };

/**
 * A Prisma stand-in that records every call in order. Each model method
 * answers from `responses[model.method]` (a value or a function of the args),
 * falling back to `{ count: 0 }` for writes and `[]`/`null` for reads.
 */
function fakePrisma(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];

  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method: string) =>
          jest.fn(async (args: any) => {
            calls.push({ model: name, method, args });
            const key = `${name}.${method}`;
            if (key in responses) {
              const r = responses[key];
              return typeof r === 'function' ? (r as (a: any) => unknown)(args) : r;
            }
            if (method === 'findMany') return [];
            if (method === 'findUnique' || method === 'findFirst') return null;
            if (method === 'deleteMany' || method === 'updateMany') return { count: 0 };
            return {};
          }),
      },
    );

  const models = new Map<string, unknown>();
  const client: any = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === '$transaction') {
          return jest.fn(async (fn: (tx: unknown) => unknown, options: unknown) => {
            calls.push({ model: '$', method: 'transaction', args: options });
            return fn(client);
          });
        }
        if (!models.has(prop)) models.set(prop, model(prop));
        return models.get(prop);
      },
    },
  );

  const indexOf = (m: string, method: string, from = 0) =>
    calls.findIndex((c, i) => i >= from && c.model === m && c.method === method);

  return { client, calls, indexOf };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: USER_DATA_RESET_TYPE,
    subjectType: 'user',
    subjectId: USER,
    payload: { userId: USER },
    ...overrides,
  } as Job;
}

function setup(responses: Record<string, unknown> = {}, storageOverrides: Record<string, jest.Mock> = {}) {
  const registry = { register: jest.fn() };
  const prisma = fakePrisma(responses);
  const storage = {
    delete: jest.fn().mockResolvedValue(undefined),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    ...storageOverrides,
  };
  const handler = new UserDataResetHandler(
    registry as unknown as JobHandlerRegistry,
    prisma.client,
    storage as never,
  );
  return { handler, registry, prisma, storage };
}

describe('UserDataResetHandler', () => {
  describe('contract', () => {
    it('has the permanent type string and self-registers', () => {
      const { handler, registry } = setup();
      handler.onModuleInit();
      expect(handler.type).toBe('user.data_reset');
      expect(registry.register).toHaveBeenCalledWith(handler);
    });

    it('declares a 15-minute, three-attempt profile', () => {
      const { handler } = setup();
      expect(handler.profile).toEqual({ maxRuntimeMs: 15 * 60_000, maxAttempts: 3 });
    });

    it('is SERVER-ONLY: no node result members and no secret broker', () => {
      const { handler } = setup();
      const members = handler as unknown as Record<string, unknown>;
      expect(members.nodeResultSchema).toBeUndefined();
      expect(members.persistNodeResult).toBeUndefined();
      expect(members.nodeSecretBroker).toBeUndefined();
    });
  });

  describe('input', () => {
    it('refuses a job whose subject is not a user', async () => {
      const { handler, prisma } = setup();
      await expect(handler.process(job({ subjectType: 'gym' }))).rejects.toThrow(/expected subject user/);
      expect(prisma.calls).toHaveLength(0);
    });

    it('refuses a job whose payload names a different user than its subject', async () => {
      const { handler, prisma } = setup();
      await expect(handler.process(job({ payload: { userId: 'someone-else' } }))).rejects.toThrow(
        /does not match/,
      );
      expect(prisma.calls).toHaveLength(0);
    });
  });

  describe('step 1: collecting storage objects', () => {
    it('unions uploaded objects, intake/gym/workout photo links and the avatar setting', async () => {
      const { handler } = setup({
        'storageObject.findMany': [{ id: 'o-up' }, { id: 'o-avatar' }],
        'photoIntakePhoto.findMany': [{ storageObjectId: 'o-intake' }],
        'gymPhoto.findMany': [{ storageObjectId: 'o-gym' }, { storageObjectId: 'o-up' }],
        'workoutPhoto.findMany': [{ storageObjectId: 'o-workout' }],
        'userSettings.findUnique': {
          value: { profile: { imageSource: 'upload', imageObjectId: '11111111-1111-4111-8111-111111111111' } },
        },
      });

      const ids = await handler.collectObjectIds(USER);

      expect(ids.sort()).toEqual(
        ['11111111-1111-4111-8111-111111111111', 'o-avatar', 'o-gym', 'o-intake', 'o-up', 'o-workout'].sort(),
      );
    });

    it('records the collected ids on the payload BEFORE the deletion transaction', async () => {
      const { handler, prisma } = setup({
        'storageObject.findMany': (args: any) => (args.where.uploadedById ? [{ id: 'o-1' }] : []),
      });

      await handler.process(job());

      const firstUpdate = prisma.indexOf('job', 'update');
      const tx = prisma.indexOf('$', 'transaction');
      expect(firstUpdate).toBeGreaterThanOrEqual(0);
      expect(firstUpdate).toBeLessThan(tx);
      expect(prisma.calls[firstUpdate].args).toEqual({
        where: { id: 'job-1' },
        data: { payload: { userId: USER, objectIds: ['o-1'] } },
      });
    });

    it('keeps ids an earlier attempt recorded, even when their links are gone', async () => {
      const { handler, prisma, storage } = setup({
        'storageObject.findMany': (args: any) =>
          args.where.id ? [{ id: 'o-old', storageKey: 'k-old', s3UploadId: null }] : [],
        'storageObject.deleteMany': { count: 1 },
      });

      await handler.process(job({ payload: { userId: USER, objectIds: ['o-old'] } }));

      expect(storage.delete).toHaveBeenCalledWith('k-old');
      const update = prisma.calls[prisma.indexOf('job', 'update')];
      expect(update.args.data.payload.objectIds).toEqual(['o-old']);
    });
  });

  describe('step 2: deleting rows', () => {
    it('runs in one transaction with a raised timeout', async () => {
      const { handler, prisma } = setup();
      await handler.process(job());
      const txs = prisma.calls.filter((c) => c.model === '$');
      expect(txs).toHaveLength(1);
      expect(txs[0].args).toEqual({ timeout: 5 * 60_000 });
    });

    it('deletes every user-owned table, scoped to the caller', async () => {
      const { handler, prisma } = setup();
      await handler.process(job());

      const byUser = [
        'workoutAdaptation',
        'trainingPlanRun',
        'programSession',
        'workout',
        'programChangeLog',
        'program',
        'photoIntake',
        'gym',
        'measurement',
        'healthProfile',
        'aiRun',
        'aiUsageEvent',
        'userAiKey',
        'userCredential',
        'deviceCode',
        'personalAccessToken',
        'pushSubscription',
        'notification',
        'notificationDelivery',
        'userSettings',
      ];
      for (const model of byUser) {
        const call = prisma.calls.find((c) => c.model === model && c.method === 'deleteMany');
        expect({ model, where: call?.args.where }).toEqual({ model, where: { userId: USER } });
      }

      const exercises = prisma.calls.find((c) => c.model === 'exercise' && c.method === 'deleteMany');
      expect(exercises?.args.where).toEqual({
        ownerUserId: USER,
        workoutExercises: { none: {} },
        programExercises: { none: {} },
      });
      const equipment = prisma.calls.find((c) => c.model === 'equipmentType' && c.method === 'deleteMany');
      expect(equipment?.args.where).toEqual({
        ownerUserId: USER,
        gymEquipment: { none: {} },
        exerciseRequirements: { none: {} },
      });
    });

    it('deletes children before the parents they RESTRICT', async () => {
      const { handler, prisma } = setup();
      await handler.process(job());
      const at = (m: string, method = 'deleteMany') => prisma.indexOf(m, method);

      // WorkoutExercise / ProgramExercise RESTRICT a custom exercise.
      expect(at('workout')).toBeLessThan(at('exercise'));
      expect(at('program')).toBeLessThan(at('exercise'));
      // GymEquipment and ExerciseRequirement RESTRICT a custom equipment type.
      expect(at('gym')).toBeLessThan(at('equipmentType'));
      expect(at('exercise')).toBeLessThan(at('equipmentType'));
      // The measurement revision chain is unlinked before it is deleted.
      expect(at('measurement', 'updateMany')).toBeLessThan(at('measurement'));
      expect(prisma.calls[at('measurement', 'updateMany')].args).toEqual({
        where: { userId: USER, supersedesId: { not: null } },
        data: { supersedesId: null },
      });
    });

    it('deletes checkpoints of the user runs and adaptations explicitly (no FK cascade)', async () => {
      const { handler, prisma } = setup({
        'trainingPlanRun.findMany': [{ id: 'run-1' }],
        'workoutAdaptation.findMany': [{ id: 'adapt-1' }],
        'trainingRunCheckpoint.deleteMany': { count: 4 },
      });
      await handler.process(job());

      const writes = prisma.calls.find((c) => c.model === 'trainingRunCheckpointWrite');
      const checkpoints = prisma.calls.find(
        (c) => c.model === 'trainingRunCheckpoint' && c.method === 'deleteMany',
      );
      expect(writes?.args.where).toEqual({ threadId: { in: ['run-1', 'adapt-1'] } });
      expect(checkpoints?.args.where).toEqual({ threadId: { in: ['run-1', 'adapt-1'] } });
      expect(prisma.indexOf('trainingRunCheckpoint', 'deleteMany')).toBeLessThan(
        prisma.indexOf('trainingPlanRun', 'deleteMany'),
      );
    });

    it('cancels only PENDING jobs about deleted rows, never itself', async () => {
      const { handler, prisma } = setup({
        'trainingPlanRun.findMany': [{ id: 'run-1' }],
        'photoIntake.findMany': [{ id: 'intake-1' }],
        'job.deleteMany': { count: 2 },
      });
      await handler.process(job());

      const cancel = prisma.calls.find((c) => c.model === 'job' && c.method === 'deleteMany');
      expect(cancel?.args.where).toEqual({
        status: 'pending',
        subjectId: { in: ['run-1', 'intake-1'] },
        id: { not: 'job-1' },
      });
    });

    it('KEEPS the account, its identities, roles, session, allowlist entry, audit trail and infrastructure', async () => {
      const { handler, prisma } = setup();
      await handler.process(job());

      const kept = [
        'userIdentity',
        'userRole',
        'refreshToken',
        'allowedEmail',
        'workerNode',
        'nodeCredential',
        'systemSettings',
        'credential',
        'aiModel',
        'notificationBroadcast',
        'databaseBackupRun',
      ];
      for (const model of kept) {
        expect(prisma.calls.filter((c) => c.model === model)).toEqual([]);
      }
      expect(prisma.calls.some((c) => c.model === 'user' && /delete/i.test(c.method))).toBe(false);
      expect(prisma.calls.some((c) => c.model === 'auditEvent' && /delete|update/i.test(c.method))).toBe(false);

      // The user row only loses the fields the deleted settings drove.
      const user = prisma.calls.find((c) => c.model === 'user');
      expect(user).toMatchObject({
        method: 'updateMany',
        args: { where: { id: USER }, data: { profileImageUrl: null, displayName: null } },
      });
    });

    it('commits the counts on the payload inside the transaction and adds to an earlier attempt', async () => {
      const { handler, prisma } = setup({
        'workout.deleteMany': { count: 3 },
      });

      await handler.process(
        job({ payload: { userId: USER, objectIds: [], deleted: { workouts: 5, gyms: 2 } } }),
      );

      const updates = prisma.calls.filter((c) => c.model === 'job' && c.method === 'update');
      // [0] objectIds, [1] deleted (in the transaction), [2] result
      expect(updates).toHaveLength(3);
      expect(prisma.calls.indexOf(updates[1])).toBeGreaterThan(prisma.indexOf('$', 'transaction'));
      expect(updates[1].args.data.payload.deleted).toMatchObject({ workouts: 8, gyms: 2 });
    });
  });

  describe('step 3: storage', () => {
    const objects = [
      { id: 'o-1', storageKey: 'k-1', s3UploadId: null },
      { id: 'o-2', storageKey: 'k-2', s3UploadId: 'mp-2' },
      { id: 'o-3', storageKey: 'k-3', s3UploadId: null },
    ];

    function storageSetup(deleteImpl: jest.Mock) {
      return setup(
        {
          'storageObject.findMany': (args: any) =>
            args.where.uploadedById ? objects.map(({ id }) => ({ id })) : objects,
          'storageObject.deleteMany': { count: 1 },
        },
        { delete: deleteImpl },
      );
    }

    it('deletes bytes then the row, aborting an unfinished multipart upload first', async () => {
      const { handler, prisma, storage } = storageSetup(jest.fn().mockResolvedValue(undefined));
      await handler.process(job());

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith('k-2', 'mp-2');
      expect(storage.delete.mock.calls.map((c) => c[0])).toEqual(['k-1', 'k-2', 'k-3']);
      const rowDeletes = prisma.calls.filter((c) => c.model === 'storageObject' && c.method === 'deleteMany');
      expect(rowDeletes.map((c) => c.args.where.id)).toEqual(['o-1', 'o-2', 'o-3']);
      // Only after the row transaction.
      expect(prisma.indexOf('storageObject', 'deleteMany')).toBeGreaterThan(prisma.indexOf('$', 'transaction'));
    });

    it('tolerates a provider failure: counts it, keeps its row, and still succeeds', async () => {
      const failing = jest.fn(async (key: string) => {
        if (key === 'k-2') throw new Error('AccessDenied');
      });
      const { handler, prisma } = storageSetup(failing);

      await expect(handler.process(job())).resolves.toBeUndefined();

      const rowDeletes = prisma.calls.filter((c) => c.model === 'storageObject' && c.method === 'deleteMany');
      expect(rowDeletes.map((c) => c.args.where.id)).toEqual(['o-1', 'o-3']);

      const updates = prisma.calls.filter((c) => c.model === 'job' && c.method === 'update');
      const result = updates[updates.length - 1].args.data.payload.result;
      expect(result).toMatchObject({ storageObjectsDeleted: 2, storageObjectsFailed: 1 });
    });
  });

  describe('completion', () => {
    it('writes the result on the payload and audits user.data_reset.completed', async () => {
      const { handler, prisma } = setup({
        'gym.deleteMany': { count: 2 },
        'notification.deleteMany': { count: 7 },
      });

      await handler.process(job());

      const updates = prisma.calls.filter((c) => c.model === 'job' && c.method === 'update');
      const result = updates[updates.length - 1].args.data.payload.result;
      expect(result).toMatchObject({
        gyms: 2,
        notifications: 7,
        workouts: 0,
        storageObjectsDeleted: 0,
        storageObjectsFailed: 0,
      });

      const audit = prisma.calls.find((c) => c.model === 'auditEvent');
      expect(audit?.args.data).toMatchObject({
        actorUserId: USER,
        action: USER_DATA_RESET_COMPLETED_ACTION,
        targetType: 'user',
        targetId: USER,
        meta: expect.objectContaining({ jobId: 'job-1', gyms: 2 }),
      });
      expect(prisma.calls.indexOf(audit!)).toBe(prisma.calls.length - 1);
    });

    it('throws (so the queue retries) when the transaction fails, before touching storage', async () => {
      const { handler, storage } = setup({
        'gym.deleteMany': () => {
          throw new Error('deadlock detected');
        },
        'storageObject.findMany': (args: any) =>
          args.where.uploadedById ? [{ id: 'o-1' }] : [{ id: 'o-1', storageKey: 'k-1', s3UploadId: null }],
      });

      await expect(handler.process(job())).rejects.toThrow('deadlock detected');
      expect(storage.delete).not.toHaveBeenCalled();
    });
  });

  describe('chunk', () => {
    it('splits long IN lists', () => {
      const ids = Array.from({ length: USER_DATA_RESET_CHUNK_SIZE * 2 + 1 }, (_, i) => String(i));
      expect(chunk(ids).map((c) => c.length)).toEqual([USER_DATA_RESET_CHUNK_SIZE, USER_DATA_RESET_CHUNK_SIZE, 1]);
      expect(chunk([])).toEqual([]);
    });
  });
});
