// =============================================================================
// Real-Postgres coverage for `PrismaCheckpointSaver`.
// =============================================================================
//
// What a mocked Prisma client cannot prove: ordering by the checkpoint id
// string (not `createdAt`), the composite primary keys that make `putWrites`
// idempotent under concurrency, `Bytes` round trips above the driver's
// comfortable size, and that a thread deletes cleanly. LangGraph's own
// conformance suite runs against this saver in
// `prisma-checkpoint-saver.validation.db.spec.ts`; the handler scenarios live
// in `training-runtime.db.spec.ts`.
//
// THIS IS A `*.db.spec.ts` FILE: skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { emptyCheckpoint } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';

import { PrismaCheckpointSaver } from '../../src/training-agents/runtime/prisma-checkpoint-saver';
import { createNodeContextHarness } from '../../src/training-agents/testing/node-context-harness';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { AGENT_NODES, agentScripts } from './agent-graph-support';

const { describeWithDb } = resolveDbSuite('prisma-checkpoint-saver.db.spec');

const ID = (n: number) => `1ef00000-0000-6000-8000-${String(n).padStart(12, '0')}`;
const cp = (n: number, values: Record<string, unknown> = { n }) => ({
  ...emptyCheckpoint(),
  id: ID(n),
  channel_values: values,
});
const meta = (step: number, source: 'input' | 'loop' = 'loop') => ({ source, step, parents: {} });

describeWithDb('PrismaCheckpointSaver (real Postgres)', () => {
  let client: PrismaClient;
  let saver: PrismaCheckpointSaver;
  const threads: string[] = [];

  beforeAll(async () => {
    client = createDbClient();
    await client.$connect();
    saver = new PrismaCheckpointSaver(client);
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

  it('orders "latest" and list by checkpoint id, not by insertion time or createdAt', async () => {
    const threadId = thread();
    const base: RunnableConfig = { configurable: { thread_id: threadId, checkpoint_ns: '' } };

    // Insert out of id order: 3, 1, 2. createdAt says 2 is newest; the id says 3 is.
    await saver.put(base, cp(3), meta(1), {});
    await saver.put(base, cp(1), meta(-1, 'input'), {});
    await saver.put(base, cp(2), meta(0), {});

    expect((await saver.getTuple(base))?.checkpoint.id).toBe(ID(3));

    const ids: string[] = [];
    for await (const tuple of saver.list(base)) ids.push(tuple.checkpoint.id);
    expect(ids).toEqual([ID(3), ID(2), ID(1)]);
  });

  it('links each checkpoint to its parent and returns no parent for the first', async () => {
    const threadId = thread();
    const c1 = await saver.put({ configurable: { thread_id: threadId } }, cp(1), meta(-1, 'input'), {});
    const c2 = await saver.put(c1, cp(2), meta(0), {});
    await saver.put(c2, cp(3), meta(1), {});

    const chain: Array<string | undefined> = [];
    for await (const tuple of saver.list({ configurable: { thread_id: threadId } })) {
      chain.push(tuple.parentConfig?.configurable?.checkpoint_id);
    }

    expect(chain).toEqual([ID(2), ID(1), undefined]);
  });

  it('lists across pages (more rows than one read page) without skipping or repeating', async () => {
    const threadId = thread();
    await client.trainingRunCheckpoint.createMany({
      data: Array.from({ length: 230 }, (_v, i) => ({
        threadId,
        checkpointNs: '',
        checkpointId: ID(i + 1),
        type: 'json',
        checkpoint: Buffer.from(JSON.stringify({ ...cp(i + 1) })),
        metadata: Buffer.from(JSON.stringify(meta(i))),
      })),
    });

    const ids: string[] = [];
    for await (const tuple of saver.list({ configurable: { thread_id: threadId } })) ids.push(tuple.checkpoint.id);

    expect(ids).toEqual(Array.from({ length: 230 }, (_v, i) => ID(230 - i)));
  });

  it('stores writes idempotently, overwrites special channels, and orders pending writes by (task, idx)', async () => {
    const threadId = thread();
    const config = await saver.put({ configurable: { thread_id: threadId } }, cp(1), meta(0), {});

    await saver.putWrites(config, [['drafts', ['first']], ['__interrupt__', 'one']], 'task-b');
    await saver.putWrites(config, [['drafts', ['second']], ['__interrupt__', 'two']], 'task-b');
    await saver.putWrites(config, [['usage', 3]], 'task-a');

    const rows = await client.trainingRunCheckpointWrite.findMany({ where: { threadId } });
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.channel === '__interrupt__')?.idx).toBeLessThan(0);

    const tuple = await new PrismaCheckpointSaver(client).getTuple(config);
    expect(tuple?.pendingWrites).toEqual([
      ['task-a', 'usage', 3],
      ['task-b', '__interrupt__', 'two'],
      ['task-b', 'drafts', ['first']],
    ]);
  });

  it('survives concurrent putWrites from parallel tasks, and a concurrent retry of the same task, with no deadlock or duplicate', async () => {
    const threadId = thread();
    const config = await saver.put({ configurable: { thread_id: threadId } }, cp(1), meta(0), {});

    await Promise.all([
      ...Array.from({ length: 12 }, (_v, i) =>
        saver.putWrites(config, [['a', i], ['b', i], ['__error__', `e${i}`]], `task-${i % 4}`),
      ),
      ...Array.from({ length: 6 }, () => saver.putWrites(config, [['a', 'same'], ['__interrupt__', 'same']], 'task-same')),
    ]);

    const rows = await client.trainingRunCheckpointWrite.findMany({ where: { threadId } });
    const keys = rows.map((r) => `${r.taskId}/${r.idx}`);

    expect(new Set(keys).size).toBe(rows.length);
    // 4 tasks x (a, b, __error__) plus task-same x (a, __interrupt__).
    expect(rows).toHaveLength(4 * 3 + 2);
    expect(rows.filter((r) => r.taskId === 'task-same' && r.channel === '__interrupt__')).toHaveLength(1);
  });

  it('round-trips checkpoint and write blobs over 1 MB byte-exact', async () => {
    const threadId = thread();
    // A big string (the realistic case: a long model output kept in state) and
    // a Uint8Array (serialised as a JSON number list, about 3.5x its size).
    const text = Array.from({ length: 2 * 1024 * 1024 }, (_v, i) => String.fromCharCode(33 + ((i * 7) % 90))).join('');
    const bytes = new Uint8Array(400_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + (i >> 8)) % 256;

    const config = await saver.put({ configurable: { thread_id: threadId } }, cp(1, { text, bytes }), meta(0), {});
    // A write value that is a bare Uint8Array is stored raw (type "bytes").
    const rawWrite = new Uint8Array(1_500_000);
    for (let i = 0; i < rawWrite.length; i += 1) rawWrite[i] = (i * 17 + (i >> 9)) % 256;
    await saver.putWrites(config, [['raw', rawWrite]], 'task');

    const row = await client.trainingRunCheckpoint.findFirstOrThrow({ where: { threadId } });
    expect(row.checkpoint.byteLength).toBeGreaterThan(3 * 1024 * 1024);
    const writeRow = await client.trainingRunCheckpointWrite.findFirstOrThrow({ where: { threadId } });
    expect(writeRow.value.byteLength).toBeGreaterThan(1024 * 1024);

    const tuple = await new PrismaCheckpointSaver(client).getTuple(config);
    const values = tuple?.checkpoint.channel_values as { text: string; bytes: Uint8Array };
    const fromWrite = tuple?.pendingWrites?.[0]?.[2] as Uint8Array;

    expect(values.text === text).toBe(true);
    expect(Buffer.from(values.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(fromWrite.byteLength).toBe(rawWrite.byteLength);
    expect(Buffer.from(fromWrite).equals(Buffer.from(rawWrite))).toBe(true);
  }, 60_000);

  it('deleteThread removes that thread`s checkpoints and writes and leaves other threads alone', async () => {
    const doomed = thread();
    const kept = thread();
    const a = await saver.put({ configurable: { thread_id: doomed } }, cp(1), meta(0), {});
    const b = await saver.put({ configurable: { thread_id: kept } }, cp(1), meta(0), {});
    await saver.putWrites(a, [['x', 1]], 'task');
    await saver.putWrites(b, [['x', 1]], 'task');

    await saver.deleteThread(doomed);

    expect(await saver.getTuple(a)).toBeUndefined();
    expect(await client.trainingRunCheckpoint.count({ where: { threadId: doomed } })).toBe(0);
    expect(await client.trainingRunCheckpointWrite.count({ where: { threadId: doomed } })).toBe(0);
    expect(await client.trainingRunCheckpoint.count({ where: { threadId: kept } })).toBe(1);
    expect(await client.trainingRunCheckpointWrite.count({ where: { threadId: kept } })).toBe(1);
  });

  it('stores no provider continuation state: blobs from whole graph runs carry node outputs only', async () => {
    // A create run whose nodes call the (fake) model, and an evaluate run
    // through an interrupt and its resume (so interrupt and resume writes exist).
    const create = createNodeContextHarness({ kind: 'create', runId: thread(), scripts: agentScripts({ rejections: 1 }) });
    const evaluate = createNodeContextHarness({ kind: 'evaluate', runId: thread(), scripts: agentScripts() });
    const runIds = [create.runId, evaluate.runId];

    await create.runGraph({ input: {}, nodes: AGENT_NODES, checkpointer: new PrismaCheckpointSaver(client) });
    await evaluate.runGraph({
      input: { input: { autonomy: 'ask_first' } },
      nodes: AGENT_NODES,
      checkpointer: new PrismaCheckpointSaver(client),
    });
    await evaluate.runGraph({
      resume: { decision: 'approve' },
      nodes: AGENT_NODES,
      checkpointer: new PrismaCheckpointSaver(client),
    });

    const h = { fake: { calls: [...create.runtime.fake.calls, ...evaluate.runtime.fake.calls] } };
    const runId = { in: runIds };

    const [checkpoints, writes] = await Promise.all([
      client.trainingRunCheckpoint.findMany({ where: { threadId: runId } }),
      client.trainingRunCheckpointWrite.findMany({ where: { threadId: runId } }),
    ]);
    expect(checkpoints.length).toBeGreaterThan(5);
    expect(writes.length).toBeGreaterThan(0);

    const text = [...checkpoints.flatMap((r) => [r.checkpoint, r.metadata]), ...writes.map((w) => w.value)]
      .map((bytes) => Buffer.from(bytes).toString('utf8'))
      .join('\n');

    // The scripted node outputs are in there (so this is not scanning empty blobs)...
    expect(text).toContain('Week 1');
    // ...and nothing that would resume a provider conversation is.
    for (const marker of ['previousResponseId', 'previous_response_id', 'ai.providerState', 'providerState', 'reasoning', 'Draft the plan']) {
      expect(text).not.toContain(marker);
    }
    for (const call of h.fake.calls) expect(text).not.toContain(call.requestId);
  });
});
