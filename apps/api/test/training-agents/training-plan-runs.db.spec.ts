// =============================================================================
// Real-Postgres test: training_plan_runs raw-SQL constraints
// =============================================================================
//
// `training_plan_runs_active_per_user_uniq_idx` and the CHECK constraints exist
// only in migration SQL (Prisma cannot express them). Only a real server proves
// they are applied and behave as documented.
//
// THIS IS A `*.db.spec.ts` FILE: skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('training-plan-runs.db.spec');

describeWithDb('training_plan_runs constraints (real Postgres)', () => {
  let client: PrismaClient;
  const tag = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const u = await client.user.create({
      data: { email: `tpr-${label}-${tag}@example.com` },
      select: { id: true },
    });
    userIds.push(u.id);
    return u.id;
  }

  const makeRun = (userId: string, data: Record<string, unknown> = {}) =>
    client.trainingPlanRun.create({
      data: { userId, kind: 'create', input: {}, tokenCap: 100000, ...data } as never,
    });

  beforeAll(() => {
    client = createDbClient();
  });

  afterAll(async () => {
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  describe('training_plan_runs_active_per_user_uniq_idx', () => {
    it.each(['queued', 'running', 'awaiting_approval'])(
      'refuses a second active run while one is %s',
      async (status) => {
        const u = await makeUser(`dup-${status}`);
        await makeRun(u, { status });
        await expect(makeRun(u)).rejects.toThrow(/training_plan_runs_active_per_user_uniq_idx|Unique constraint/);
      },
    );

    it.each(['interrupted', 'succeeded', 'failed', 'cancelled', 'blocked_safety'])(
      'a %s run does not block a new active run',
      async (status) => {
        const u = await makeUser(`ok-${status}`);
        await makeRun(u, { status });
        await expect(makeRun(u)).resolves.toBeDefined();
      },
    );

    it('is per user: another user may have an active run', async () => {
      const a = await makeUser('a');
      const b = await makeUser('b');
      await makeRun(a);
      await expect(makeRun(b)).resolves.toBeDefined();
    });

    it('frees the slot once the active run goes terminal', async () => {
      const u = await makeUser('free');
      const r = await makeRun(u);
      await client.trainingPlanRun.update({ where: { id: r.id }, data: { status: 'succeeded' } });
      await expect(makeRun(u)).resolves.toBeDefined();
    });
  });

  describe('CHECK constraints', () => {
    it('rejects an unknown kind', async () => {
      const u = await makeUser('kind');
      await expect(makeRun(u, { kind: 'bogus' })).rejects.toThrow(/training_plan_runs_kind_check|check constraint/i);
    });

    it('rejects an unknown status', async () => {
      const u = await makeUser('status');
      await expect(makeRun(u, { status: 'bogus' })).rejects.toThrow(/training_plan_runs_status_check|check constraint/i);
    });

    it('rejects an unknown trigger', async () => {
      const u = await makeUser('trigger');
      await expect(makeRun(u, { trigger: 'bogus' })).rejects.toThrow(/training_plan_runs_trigger_check|check constraint/i);
    });

    it.each([9999, 2000001])('rejects token_cap %i', async (tokenCap) => {
      const u = await makeUser(`cap-${tokenCap}`);
      await expect(makeRun(u, { tokenCap })).rejects.toThrow(/training_plan_runs_token_cap_check|check constraint/i);
    });

    it.each([10000, 2000000])('accepts token_cap %i', async (tokenCap) => {
      const u = await makeUser(`capok-${tokenCap}`);
      await expect(makeRun(u, { tokenCap })).resolves.toBeDefined();
    });

    it('accepts every documented kind and trigger', async () => {
      for (const kind of ['create', 'revise', 'evaluate']) {
        for (const trigger of ['user', 'weekly', 'workout_finished', 'manual', 'resume', 'system']) {
          const u = await makeUser(`v-${kind}-${trigger}`);
          await expect(makeRun(u, { kind, trigger })).resolves.toBeDefined();
        }
      }
    });
  });

  describe('training_run_events', () => {
    it('enforces unique (run_id, seq) and cascades from the run', async () => {
      const u = await makeUser('events');
      const r = await makeRun(u);
      await client.trainingRunEvent.create({ data: { runId: r.id, seq: 1, type: 'run.queued' } });
      await expect(
        client.trainingRunEvent.create({ data: { runId: r.id, seq: 1, type: 'run.started' } }),
      ).rejects.toThrow(/Unique constraint/);
      await client.trainingPlanRun.delete({ where: { id: r.id } });
      expect(await client.trainingRunEvent.count({ where: { runId: r.id } })).toBe(0);
    });
  });
});
