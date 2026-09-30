// =============================================================================
// Real-Postgres smoke test: PrismaCheckpointSaver and a training graph.
// =============================================================================
//
// The minimum proof that the saver round-trips through the real
// `training_run_checkpoints` / `training_run_checkpoint_writes` tables and
// that a training graph pauses and resumes from them on fresh instances. The
// full saver and runtime suites build on this.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { emptyCheckpoint } from '@langchain/langgraph';

import { PrismaCheckpointSaver } from '../../src/training-agents/runtime/prisma-checkpoint-saver';
import { createNodeContextHarness } from '../../src/training-agents/testing/node-context-harness';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { AGENT_NODES, agentScripts } from './agent-graph-support';

const { describeWithDb } = resolveDbSuite('checkpoint-saver.smoke.db.spec');

function checkpoint(id: string) {
  return { ...emptyCheckpoint(), id, channel_values: { goal: `goal-${id}` } };
}


describeWithDb('PrismaCheckpointSaver (real Postgres, smoke)', () => {
  let client: PrismaClient;
  const threads: string[] = [];

  beforeAll(() => {
    client = createDbClient();
  });

  afterAll(async () => {
    await client.trainingRunCheckpointWrite.deleteMany({ where: { threadId: { in: threads } } });
    await client.trainingRunCheckpoint.deleteMany({ where: { threadId: { in: threads } } });
    await client.$disconnect();
  });

  function thread(): string {
    const id = randomUUID();
    threads.push(id);
    return id;
  }

  it('puts, gets the latest, lists newest first with limit/before/filter, and links parents', async () => {
    const saver = new PrismaCheckpointSaver(client);
    const threadId = thread();
    const base = { configurable: { thread_id: threadId, checkpoint_ns: '' } };

    const c1 = await saver.put(base, checkpoint('1ef00000-0000-6000-8000-000000000001'), { source: 'input', step: -1, parents: {} }, {});
    const c2 = await saver.put(c1, checkpoint('1ef00000-0000-6000-8000-000000000002'), { source: 'loop', step: 0, parents: {} }, {});
    await saver.put(c2, checkpoint('1ef00000-0000-6000-8000-000000000003'), { source: 'loop', step: 1, parents: {} }, {});

    const latest = await saver.getTuple(base);
    expect(latest?.checkpoint.id).toBe('1ef00000-0000-6000-8000-000000000003');
    expect(latest?.checkpoint.channel_values).toEqual({ goal: 'goal-1ef00000-0000-6000-8000-000000000003' });
    expect(latest?.parentConfig?.configurable?.checkpoint_id).toBe('1ef00000-0000-6000-8000-000000000002');

    const ids = async (opts?: Parameters<PrismaCheckpointSaver['list']>[1]) => {
      const out: string[] = [];
      for await (const t of saver.list(base, opts)) out.push(t.checkpoint.id);
      return out;
    };

    expect(await ids()).toEqual([
      '1ef00000-0000-6000-8000-000000000003',
      '1ef00000-0000-6000-8000-000000000002',
      '1ef00000-0000-6000-8000-000000000001',
    ]);
    expect(await ids({ limit: 1 })).toEqual(['1ef00000-0000-6000-8000-000000000003']);
    expect(await ids({ before: c2 })).toEqual(['1ef00000-0000-6000-8000-000000000001']);
    expect(await ids({ filter: { source: 'input' } })).toEqual(['1ef00000-0000-6000-8000-000000000001']);
  });

  it('stores writes idempotently per (task, idx), overwrites special channels, and deletes a thread', async () => {
    const saver = new PrismaCheckpointSaver(client);
    const threadId = thread();
    const cfg = await saver.put(
      { configurable: { thread_id: threadId } },
      checkpoint('1ef00000-0000-6000-8000-00000000000a'),
      { source: 'input', step: -1, parents: {} },
      {},
    );

    await saver.putWrites(cfg, [['drafts', ['first']], ['__interrupt__', 'one']], 'task-a');
    await saver.putWrites(cfg, [['drafts', ['second']], ['__interrupt__', 'two']], 'task-a');

    const tuple = await new PrismaCheckpointSaver(client).getTuple(cfg);
    expect(tuple?.pendingWrites).toEqual([
      ['task-a', '__interrupt__', 'two'],
      ['task-a', 'drafts', ['first']],
    ]);

    await saver.deleteThread(threadId);
    expect(await saver.getTuple(cfg)).toBeUndefined();
    expect(await client.trainingRunCheckpointWrite.count({ where: { threadId } })).toBe(0);
  });

  it('runs the evaluate graph to an interrupt, then resumes it to completion on a fresh runner and saver', async () => {
    const h = createNodeContextHarness({ kind: 'evaluate', runId: thread(), scripts: agentScripts() });

    const first = await h.runGraph({
      input: { input: { autonomy: 'ask_first' } },
      nodes: AGENT_NODES,
      checkpointer: new PrismaCheckpointSaver(client),
    });
    expect(first.interrupt?.kind).toBe('approval');

    const second = await h.runGraph({
      resume: { decision: 'approve' },
      nodes: AGENT_NODES,
      checkpointer: new PrismaCheckpointSaver(client),
    });
    expect(second.interrupt).toBeNull();
    expect(second.state).toMatchObject({ approval: { decision: 'approve' }, outcome: { status: 'completed' } });
    // The evaluator ran once: the resume repeated no completed node.
    expect(h.runtime.fake.calls).toHaveLength(1);
    expect(await client.trainingRunCheckpoint.count({ where: { threadId: h.runId } })).toBeGreaterThan(4);
  });
});
