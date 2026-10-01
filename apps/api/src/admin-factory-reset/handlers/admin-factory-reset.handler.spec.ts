import type { Job } from '@prisma/client';

import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import {
  ADMIN_FACTORY_RESET_COMPLETED_ACTION,
  ADMIN_FACTORY_RESET_TYPE,
} from '../admin-factory-reset.constants';
import { AdminFactoryResetHandler, ZERO_FACTORY_RESET_COUNTS } from './admin-factory-reset.handler';

const ACTOR = 'actor-1';
const ACTOR_EMAIL = 'admin@example.com';
const JOB_ID = 'job-1';

type Call = { model: string; method: string; args: any };

/**
 * A Prisma stand-in that records every call in order. Each model method
 * answers from `responses[model.method]` (a value, or a function of the args
 * and the call index), falling back to `{ count: 0 }` for writes and
 * `[]`/`null` for reads.
 */
function fakePrisma(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const seen = new Map<string, number>();

  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method: string) =>
          jest.fn(async (args: any) => {
            calls.push({ model: name, method, args });
            const key = `${name}.${method}`;
            const n = seen.get(key) ?? 0;
            seen.set(key, n + 1);
            if (key in responses) {
              const r = responses[key];
              return typeof r === 'function' ? (r as (a: any, n: number) => unknown)(args, n) : r;
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

  const find = (m: string, method: string) => calls.filter((c) => c.model === m && c.method === method);
  const indexOf = (m: string, method: string, from = 0) =>
    calls.findIndex((c, i) => i >= from && c.model === m && c.method === method);

  return { client, calls, find, indexOf };
}

/** Answers the first call with `rows` and every later call with `[]`. */
const once = (rows: unknown[]) => (_args: unknown, n: number) => (n === 0 ? rows : []);

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    type: ADMIN_FACTORY_RESET_TYPE,
    subjectType: null,
    subjectId: null,
    payload: { actorUserId: ACTOR },
    ...overrides,
  } as Job;
}

function setup(responses: Record<string, unknown> = {}, storageOverrides: Record<string, jest.Mock> = {}) {
  const registry = { register: jest.fn() };
  const prisma = fakePrisma({
    'user.findUnique': { id: ACTOR, email: ACTOR_EMAIL },
    ...responses,
  });
  const storage = {
    delete: jest.fn().mockResolvedValue(undefined),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    ...storageOverrides,
  };
  const handler = new AdminFactoryResetHandler(
    registry as unknown as JobHandlerRegistry,
    prisma.client,
    storage as never,
  );
  return { handler, registry, prisma, storage };
}

/** The last payload the handler wrote onto its own job row. */
function lastPayload(prisma: ReturnType<typeof fakePrisma>) {
  const updates = prisma.find('job', 'update');
  return updates[updates.length - 1].args.data.payload;
}

describe('AdminFactoryResetHandler', () => {
  describe('contract', () => {
    it('has the permanent type string and self-registers', () => {
      const { handler, registry } = setup();
      handler.onModuleInit();
      expect(handler.type).toBe('admin.factory_reset');
      expect(registry.register).toHaveBeenCalledWith(handler);
    });

    it('declares a 30-minute, three-attempt profile', () => {
      const { handler } = setup();
      expect(handler.profile).toEqual({ maxRuntimeMs: 30 * 60_000, maxAttempts: 3 });
    });

    it('is SERVER-ONLY: no node result members and no secret broker', () => {
      const members = setup().handler as unknown as Record<string, unknown>;
      expect(members.nodeResultSchema).toBeUndefined();
      expect(members.persistNodeResult).toBeUndefined();
      expect(members.nodeSecretBroker).toBeUndefined();
    });
  });

  describe('input', () => {
    it('refuses a job without an actorUserId and deletes nothing', async () => {
      const { handler, prisma } = setup();
      await expect(handler.process(job({ payload: {} }))).rejects.toThrow(/no actorUserId/);
      expect(prisma.calls.some((c) => c.method === 'deleteMany')).toBe(false);
    });

    it('refuses a job whose actor no longer exists and deletes nothing', async () => {
      const { handler, prisma } = setup({ 'user.findUnique': null });
      await expect(handler.process(job())).rejects.toThrow(/does not exist/);
      expect(prisma.calls.some((c) => c.method === 'deleteMany')).toBe(false);
    });
  });

  describe('step 1: jobs', () => {
    it('deletes pending and finished jobs, never itself, running ones or backup-linked ones', async () => {
      const { handler, prisma } = setup({
        'job.findMany': once([{ id: 'j1' }, { id: 'j2' }]),
        'job.deleteMany': { count: 2 },
      });
      await handler.process(job());

      const [read] = prisma.find('job', 'findMany');
      expect(read.args.where).toEqual({
        id: { not: JOB_ID },
        status: { in: ['pending', 'succeeded', 'failed'] },
        backupRun: { is: null },
      });
      const deletes = prisma.find('job', 'deleteMany').filter((c) => Array.isArray(c.args.where.id?.in));
      expect(deletes[0].args.where).toEqual({
        id: { in: ['j1', 'j2'] },
        status: { in: ['pending', 'succeeded', 'failed'] },
        backupRun: { is: null },
      });
      expect(lastPayload(prisma).result.jobs).toBe(2);
    });
  });

  describe('step 2: every user', () => {
    it('runs the shared per-user deletion for every user, the actor included, one transaction each', async () => {
      const { handler, prisma } = setup({
        'user.findMany': (args: any, n: number) => {
          // Step 2 pages without a `where`; step 5 asks for everyone but the actor.
          if (!args.where) return n === 0 ? [{ id: ACTOR }, { id: 'u2' }] : [];
          return [];
        },
      });
      await handler.process(job());

      const perUser = prisma.find('workout', 'deleteMany').map((c) => c.args.where.userId);
      expect(perUser).toEqual([ACTOR, 'u2']);
      // Each per-user deletion commits its counts with it.
      const txBeforeWorkouts = prisma.calls
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.model === 'workout' && c.method === 'deleteMany')
        .map(({ i }) => prisma.calls.slice(0, i).map((c) => c.model).lastIndexOf('$'));
      expect(new Set(txBeforeWorkouts).size).toBe(2);
    });
  });

  describe('step 3: custom catalog rows', () => {
    it('deletes unreferenced custom exercises before custom equipment', async () => {
      const { handler, prisma } = setup();
      await handler.process(job());

      const exercise = prisma.calls.findIndex(
        (c) => c.model === 'exercise' && c.method === 'deleteMany' && c.args.where.ownerUserId?.not === null,
      );
      const equipment = prisma.calls.findIndex(
        (c) => c.model === 'equipmentType' && c.method === 'deleteMany' && c.args.where.ownerUserId?.not === null,
      );
      expect(exercise).toBeGreaterThan(-1);
      expect(equipment).toBeGreaterThan(exercise);
    });
  });

  describe('step 4: nodes', () => {
    it("hands other users' nodes and node credentials to the actor, except a name the actor already uses", async () => {
      const { handler, prisma } = setup({
        'workerNode.findMany': (args: any) =>
          args.where.createdById === ACTOR
            ? [{ name: 'box-1' }]
            : [
                { id: 'n1', name: 'box-1' },
                { id: 'n2', name: 'box-2' },
                { id: 'n3', name: 'box-2' },
              ],
        'nodeCredential.updateMany': { count: 4 },
      });
      await handler.process(job());

      expect(prisma.find('workerNode', 'update').map((c) => c.args)).toEqual([
        { where: { id: 'n2' }, data: { createdById: ACTOR } },
      ]);
      expect(prisma.find('nodeCredential', 'updateMany')[0].args).toEqual({
        where: { userId: { not: ACTOR } },
        data: { userId: ACTOR },
      });
      const result = lastPayload(prisma).result;
      expect(result.workerNodesReassigned).toBe(1);
      expect(result.workerNodesRemoved).toBe(2);
      expect(result.nodeCredentialsReassigned).toBe(4);
    });

    it('reassigns nodes BEFORE other users are deleted', async () => {
      const { handler, prisma } = setup({
        'user.findMany': (args: any, n: number) => (args.where && n < 2 ? [{ id: 'u2' }] : []),
        'user.deleteMany': { count: 1 },
      });
      await handler.process(job());
      expect(prisma.indexOf('nodeCredential', 'updateMany')).toBeLessThan(prisma.indexOf('user', 'deleteMany'));
    });
  });

  describe('step 5: other users', () => {
    it('deletes every user but the actor, in chunks, after their data', async () => {
      const { handler, prisma } = setup({
        'user.findMany': (args: any, n: number) => (args.where && n < 3 ? [{ id: 'u2' }, { id: 'u3' }] : []),
        'user.deleteMany': (_args: unknown, n: number) => ({ count: n === 0 ? 2 : 0 }),
      });
      await handler.process(job());

      const [del] = prisma.find('user', 'deleteMany');
      expect(del.args.where).toEqual({ id: { in: ['u2', 'u3'], not: ACTOR } });
      expect(prisma.find('user', 'findMany').filter((c) => c.args.where)[0].args.where).toEqual({
        id: { not: ACTOR },
      });
      expect(prisma.indexOf('workout', 'deleteMany')).toBeLessThan(prisma.indexOf('user', 'deleteMany'));
      expect(lastPayload(prisma).result.usersDeleted).toBe(2);
    });
  });

  describe('step 6: deployment-wide leftovers', () => {
    it("keeps the actor's allowlist entry and deletes the rest of the deployment-level rows", async () => {
      const { handler, prisma } = setup({
        'allowedEmail.deleteMany': { count: 3 },
        'notificationBroadcast.deleteMany': { count: 2 },
        'jobStatsRollup.deleteMany': { count: 5 },
      });
      await handler.process(job());

      expect(prisma.find('allowedEmail', 'deleteMany')[0].args).toEqual({
        where: {
          NOT: { email: { equals: ACTOR_EMAIL, mode: 'insensitive' } },
          OR: [{ claimedById: null }, { claimedById: { not: ACTOR } }],
        },
      });
      for (const m of [
        'notificationBroadcast',
        'notification',
        'notificationDelivery',
        'pushSubscription',
        'aiRun',
        'aiUsageEvent',
        'deviceCode',
        'jobStatsRollup',
      ]) {
        // An unfiltered delete: every row of the table.
        expect({ m, all: prisma.find(m, 'deleteMany').some((c) => c.args.where === undefined) }).toEqual({ m, all: true });
      }
      const result = lastPayload(prisma).result;
      expect(result).toMatchObject({ allowlistEntries: 3, broadcasts: 2, jobStatsRollups: 5 });
    });

    it('never touches the tables a factory reset keeps', async () => {
      const { handler, prisma } = setup();
      await handler.process(job());

      const writes = prisma.calls.filter((c) => /^(delete|update|create|upsert)/.test(c.method));
      const kept = [
        'role',
        'permission',
        'rolePermission',
        'userRole',
        'userIdentity',
        'refreshToken',
        'systemSettings',
        'credential',
        'aiModel',
        'capability',
        'databaseBackupRun',
        'jobNodeSecret',
        'workerNode',
      ];
      for (const m of kept) {
        expect({ m, deletes: writes.filter((c) => c.model === m && c.method.startsWith('delete')).length }).toEqual({
          m,
          deletes: 0,
        });
      }
      // The only audit write is the completion record.
      expect(writes.filter((c) => c.model === 'auditEvent').map((c) => c.method)).toEqual(['create']);
    });
  });

  describe('step 7: storage', () => {
    const objects = [
      { id: 'o1', storageKey: 'uploads/o1', s3UploadId: null },
      { id: 'o2', storageKey: 'uploads/o2', s3UploadId: 'mpu-2' },
      { id: 'o3', storageKey: 'uploads/o3', s3UploadId: null },
    ];

    function storageResponses() {
      return {
        'databaseBackupRun.findMany': [{ storageKey: 'database-backups/a.dump' }],
        'storageObject.findMany': (args: any) => {
          // The id page (select id only) vs the shared delete's lookup.
          if (args.select && !args.select.storageKey) return args.where.id?.gt ? [] : objects.map(({ id }) => ({ id }));
          return objects.filter((o) => args.where.id.in.includes(o.id));
        },
        'storageObject.deleteMany': { count: 1 },
      };
    }

    it('deletes every object except backup archives, bytes then row, and tolerates a provider failure', async () => {
      const { handler, prisma, storage } = setup(storageResponses(), {
        delete: jest.fn(async (key: string) => {
          if (key === 'uploads/o3') throw new Error('AccessDenied');
        }),
      });
      await handler.process(job());

      const [page] = prisma.find('storageObject', 'findMany');
      expect(page.args.where).toEqual({ storageKey: { notIn: ['database-backups/a.dump'] } });
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith('uploads/o2', 'mpu-2');
      expect(storage.delete).toHaveBeenCalledTimes(3);
      // The refused object's row is kept.
      expect(prisma.find('storageObject', 'deleteMany').map((c) => c.args.where.id)).toEqual(['o1', 'o2']);

      const result = lastPayload(prisma).result;
      expect(result.storageObjectsDeleted).toBe(2);
      expect(result.storageObjectsFailed).toBe(1);
    });

    it('pages forward by id so a kept (failed) object is not retried forever', async () => {
      const { handler, prisma } = setup(storageResponses());
      await handler.process(job());
      const pages = prisma.find('storageObject', 'findMany').filter((c) => !c.args.select.storageKey);
      expect(pages[1].args.where.id).toEqual({ gt: 'o3' });
    });
  });

  describe('retry safety and completion', () => {
    it('commits counts inside each step transaction and adds to an earlier attempt', async () => {
      const { handler, prisma } = setup({ 'allowedEmail.deleteMany': { count: 1 } });
      await handler.process(
        job({ payload: { actorUserId: ACTOR, deleted: { ...ZERO_FACTORY_RESET_COUNTS, allowlistEntries: 4 } } }),
      );

      // Every job.update but the final result write happens inside a transaction.
      const updates = prisma.calls
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.model === 'job' && c.method === 'update');
      expect(updates.length).toBeGreaterThan(1);
      expect(lastPayload(prisma).result.allowlistEntries).toBe(5);
      expect(lastPayload(prisma).actorUserId).toBe(ACTOR);
    });

    it('writes the result and audits admin.factory_reset.completed', async () => {
      const { handler, prisma } = setup();
      await handler.process(job());

      const result = lastPayload(prisma).result;
      expect(Object.keys(result).sort()).toEqual(
        [...Object.keys(ZERO_FACTORY_RESET_COUNTS), 'storageObjectsDeleted', 'storageObjectsFailed'].sort(),
      );
      expect(prisma.find('auditEvent', 'create')[0].args.data).toEqual(
        expect.objectContaining({
          actorUserId: ACTOR,
          action: ADMIN_FACTORY_RESET_COMPLETED_ACTION,
          targetType: 'job',
          targetId: JOB_ID,
        }),
      );
    });

    it('throws (so the queue retries) when a step fails, before touching storage', async () => {
      const { handler, prisma, storage } = setup({
        'user.deleteMany': () => {
          throw new Error('deadlock detected');
        },
        'user.findMany': (args: any, n: number) => (args.where && n < 5 ? [{ id: 'u2' }] : []),
      });
      await expect(handler.process(job())).rejects.toThrow('deadlock detected');
      expect(storage.delete).not.toHaveBeenCalled();
      expect(prisma.find('auditEvent', 'create')).toHaveLength(0);
    });
  });
});
