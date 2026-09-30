// =============================================================================
// Real-Postgres smoke test: PrismaCheckpointSaver and the spike handler.
// =============================================================================
//
// The minimum proof that the saver round-trips through the real
// `training_run_checkpoints` / `training_run_checkpoint_writes` tables and
// that the spike graph pauses and resumes from them on fresh instances. The
// full saver and spike scenario suites build on this.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { Job, PrismaClient } from '@prisma/client';
import { emptyCheckpoint } from '@langchain/langgraph';

import { FAKE_TEXT_MODEL_CAPABILITIES } from '../../src/ai/testing/fake-ai-provider';
import { createAiRuntimeHarness, HARNESS_MODEL, HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import type { AiResponseRequest } from '../../src/ai/core/types/responses.types';
import { PrismaCheckpointSaver } from '../../src/training-agents/runtime/prisma-checkpoint-saver';
import { SPIKE_GRAPH_JOB_TYPE, SpikeGraphHandler } from '../../src/training-agents/spike/spike-graph.handler';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('checkpoint-saver.smoke.db.spec');

function checkpoint(id: string) {
  return { ...emptyCheckpoint(), id, channel_values: { goal: `goal-${id}` } };
}

function job(payload: Record<string, unknown>): Job {
  return { id: randomUUID(), type: SPIKE_GRAPH_JOB_TYPE, payload } as unknown as Job;
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

  it('runs the spike job to an interrupt, then resumes it to completion on a fresh handler', async () => {
    let critiques = 0;
    const h = createAiRuntimeHarness({
      models: [
        {
          modelId: HARNESS_MODEL,
          capabilities: {
            ...FAKE_TEXT_MODEL_CAPABILITIES,
            capabilities: [...FAKE_TEXT_MODEL_CAPABILITIES.capabilities, 'hosted_tools'],
          },
        },
      ],
      policy: { hostedTools: { web_search: true } },
      fake: {
        hostedTools: ['web_search'],
        responses: (req: AiResponseRequest) => {
          const usage = { inputTokens: 3, outputTokens: 2 };
          if (req.metadata?.agent === 'researcher') return { outputText: '{"summary":"b","sources":[]}', usage };
          if (req.metadata?.agent === 'planner') {
            return { outputText: '{"title":"W1","sessions":[{"day":1,"focus":"legs"}]}', usage };
          }
          critiques += 1;
          return { outputText: JSON.stringify({ approve: critiques > 1, score: 7, notes: 'n' }), usage };
        },
      },
    });
    const runId = thread();

    const first = await new SpikeGraphHandler({ ai: h.ai, prisma: client, model: HARNESS_MODEL }).execute(
      job({ runId, userId: HARNESS_USER, goal: 'Run a 5k' }),
    );
    expect(first.status).toBe('interrupted');

    const second = await new SpikeGraphHandler({ ai: h.ai, prisma: client, model: HARNESS_MODEL }).execute(
      job({ runId, userId: HARNESS_USER, resume: { decision: 'approve' } }),
    );
    expect(second).toMatchObject({ status: 'completed', state: { approved: true, round: 2 } });
    expect(h.fake.calls).toHaveLength(5);
    expect(await client.trainingRunCheckpoint.count({ where: { threadId: runId } })).toBeGreaterThan(5);
  });
});
