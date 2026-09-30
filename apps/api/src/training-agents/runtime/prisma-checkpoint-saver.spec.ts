// Unit coverage for `PrismaCheckpointSaver` over an in-memory stand-in for the
// two Prisma delegates. The stub interprets exactly the `where`/`orderBy`
// shapes the saver issues; the real-Postgres specs under
// `test/training-agents/` prove the same behaviour against the database.

import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';

import { type CheckpointPrisma, PrismaCheckpointSaver } from './prisma-checkpoint-saver';

type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;

  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return (condition as Row[]).every((c) => matches(row, c));
    if (key === 'OR') return (condition as Row[]).some((c) => matches(row, c));

    if (condition !== null && typeof condition === 'object') {
      const c = condition as { equals?: unknown; lt?: string };
      if (c.equals !== undefined && row[key] !== c.equals) return false;
      if (c.lt !== undefined && !(row[key] < c.lt)) return false;
      return true;
    }

    return row[key] === condition;
  });
}

function sorted(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  const keys = ([] as Row[]).concat(orderBy ?? []).flatMap((o) => Object.entries(o));

  return [...rows].sort((a, b) => {
    for (const [key, dir] of keys) {
      if (a[key] === b[key]) continue;
      return (a[key] < b[key] ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

function delegate(primaryKey: string[], defaults: Row = {}) {
  const rows: Row[] = [];
  const keyOf = (row: Row) => primaryKey.map((k) => row[k]).join('\u0000');
  const compoundKey = primaryKey.join('_');

  return {
    rows,
    findUnique: async ({ where }: Row) => {
      const key = where[compoundKey];
      return rows.find((row) => primaryKey.every((k) => row[k] === key[k])) ?? null;
    },
    findFirst: async ({ where, orderBy }: Row) => sorted(rows.filter((r) => matches(r, where)), orderBy)[0] ?? null,
    findMany: async ({ where, orderBy, take }: Row = {}) =>
      sorted(rows.filter((r) => matches(r, where)), orderBy).slice(0, take),
    upsert: async ({ where, create, update }: Row) => {
      const key = where[compoundKey];
      const existing = rows.find((row) => primaryKey.every((k) => row[k] === key[k]));
      if (existing) Object.assign(existing, update);
      else rows.push({ ...defaults, ...create });
    },
    createMany: async ({ data, skipDuplicates }: Row) => {
      for (const row of data as Row[]) {
        if (rows.some((r) => keyOf(r) === keyOf(row))) {
          if (skipDuplicates) continue;
          throw new Error('duplicate key');
        }
        rows.push({ ...row });
      }
    },
    deleteMany: async ({ where }: Row) => {
      for (let i = rows.length - 1; i >= 0; i -= 1) if (matches(rows[i], where)) rows.splice(i, 1);
    },
  };
}

function createStub() {
  const trainingRunCheckpoint = delegate(['threadId', 'checkpointNs', 'checkpointId']);
  const trainingRunCheckpointWrite = delegate(['threadId', 'checkpointNs', 'checkpointId', 'taskId', 'idx']);
  const prisma = {
    trainingRunCheckpoint,
    trainingRunCheckpointWrite,
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };

  return { prisma: prisma as unknown as CheckpointPrisma, checkpoints: trainingRunCheckpoint, writes: trainingRunCheckpointWrite };
}

const ID = (n: number) => `1ef00000-0000-6000-8000-${String(n).padStart(12, '0')}`;
const cp = (n: number, values: Record<string, unknown> = { n }) => ({
  ...emptyCheckpoint(),
  id: ID(n),
  channel_values: values,
});
const meta = (step: number, source: 'input' | 'loop' = 'loop') => ({ source, step, parents: {} });

describe('PrismaCheckpointSaver (in-memory stub)', () => {
  it('returns undefined for an unknown thread and for a config without a thread id', async () => {
    const { prisma } = createStub();
    const saver = new PrismaCheckpointSaver(prisma);

    expect(await saver.getTuple({ configurable: { thread_id: 'nope' } })).toBeUndefined();
    expect(await saver.getTuple({ configurable: {} })).toBeUndefined();
  });

  it('puts and gets the latest checkpoint by id, not by insertion order, with parent linkage', async () => {
    const { prisma } = createStub();
    const saver = new PrismaCheckpointSaver(prisma);
    const base = { configurable: { thread_id: 't1', checkpoint_ns: '' } };

    const c2 = await saver.put(base, cp(2), meta(0), {});
    // Inserted last, but the lower id: "latest" must still be checkpoint 2's child, id 3.
    const c3 = await saver.put(c2, cp(3), meta(1), {});
    await saver.put(base, cp(1), meta(-1, 'input'), {});

    expect(c3.configurable).toEqual({ thread_id: 't1', checkpoint_ns: '', checkpoint_id: ID(3) });

    const latest = await saver.getTuple(base);
    expect(latest?.checkpoint.id).toBe(ID(3));
    expect(latest?.parentConfig?.configurable?.checkpoint_id).toBe(ID(2));
    expect(latest?.metadata).toEqual(meta(1));

    const first = await saver.getTuple({ configurable: { thread_id: 't1', checkpoint_id: ID(1) } });
    expect(first?.parentConfig).toBeUndefined();
  });

  it('lists newest first with limit, before and metadata filter', async () => {
    const { prisma } = createStub();
    const saver = new PrismaCheckpointSaver(prisma);
    const base = { configurable: { thread_id: 't1' } };
    let config: any = base;
    for (let n = 1; n <= 5; n += 1) config = await saver.put(config, cp(n), meta(n - 2, n === 1 ? 'input' : 'loop'), {});

    const ids = async (options?: Parameters<PrismaCheckpointSaver['list']>[1]) => {
      const out: string[] = [];
      for await (const tuple of saver.list(base, options)) out.push(tuple.checkpoint.id);
      return out;
    };

    expect(await ids()).toEqual([5, 4, 3, 2, 1].map(ID));
    expect(await ids({ limit: 2 })).toEqual([5, 4].map(ID));
    expect(await ids({ limit: 0 })).toEqual([]);
    expect(await ids({ before: { configurable: { checkpoint_id: ID(3) } } })).toEqual([2, 1].map(ID));
    expect(await ids({ filter: { source: 'input' } })).toEqual([ID(1)]);
    expect(await ids({ filter: { source: 'loop' }, limit: 2 })).toEqual([5, 4].map(ID));
  });

  it('pages through more rows than one page holds without skipping or repeating', async () => {
    const { prisma } = createStub();
    const saver = new PrismaCheckpointSaver(prisma);
    const base = { configurable: { thread_id: 't1' } };
    let config: any = base;
    for (let n = 1; n <= 230; n += 1) config = await saver.put(config, cp(n), meta(n), {});

    const ids: string[] = [];
    for await (const tuple of saver.list(base)) ids.push(tuple.checkpoint.id);

    expect(ids).toEqual(Array.from({ length: 230 }, (_v, i) => ID(230 - i)));
  });

  it('keeps threads and namespaces apart', async () => {
    const { prisma } = createStub();
    const saver = new PrismaCheckpointSaver(prisma);

    await saver.put({ configurable: { thread_id: 'a' } }, cp(1), meta(0), {});
    await saver.put({ configurable: { thread_id: 'b' } }, cp(2), meta(0), {});
    await saver.put({ configurable: { thread_id: 'a', checkpoint_ns: 'child' } }, cp(3), meta(0), {});

    expect((await saver.getTuple({ configurable: { thread_id: 'a' } }))?.checkpoint.id).toBe(ID(1));
    expect((await saver.getTuple({ configurable: { thread_id: 'a', checkpoint_ns: 'child' } }))?.checkpoint.id).toBe(ID(3));
    expect((await saver.getTuple({ configurable: { thread_id: 'b' } }))?.checkpoint.id).toBe(ID(2));
  });

  it('rejects a put or putWrites without the ids it needs', async () => {
    const { prisma } = createStub();
    const saver = new PrismaCheckpointSaver(prisma);

    await expect(saver.put({ configurable: {} }, cp(1), meta(0), {})).rejects.toThrow(/thread_id/);
    await expect(saver.putWrites({ configurable: { thread_id: 't' } }, [['x', 1]], 'task')).rejects.toThrow(
      /checkpoint_id/,
    );
    await expect(
      saver.putWrites({ configurable: { thread_id: 't', checkpoint_id: ID(1) } }, [['x', 1]], ''),
    ).rejects.toThrow(/task_id/);
    await expect(saver.put({ configurable: { thread_id: 7 as unknown as string } }, cp(1), meta(0), {})).rejects.toThrow(
      /expected a string/,
    );
  });

  it('stores writes idempotently: a regular write keeps its first value, a special channel is overwritten', async () => {
    const { prisma, writes } = createStub();
    const saver = new PrismaCheckpointSaver(prisma);
    const config = await saver.put({ configurable: { thread_id: 't1' } }, cp(1), meta(0), {});

    await saver.putWrites(config, [['drafts', ['first']], ['__interrupt__', 'one']], 'task-a');
    await saver.putWrites(config, [['drafts', ['second']], ['__interrupt__', 'two']], 'task-a');
    await saver.putWrites(config, [['usage', 3]], 'task-b');
    await saver.putWrites(config, [], 'task-c');

    expect(writes.rows).toHaveLength(3);
    // `__interrupt__` maps to a negative index (LangGraph's WRITES_IDX_MAP).
    expect(writes.rows.find((r) => r.channel === '__interrupt__')?.idx).toBeLessThan(0);

    const tuple = await new PrismaCheckpointSaver(prisma).getTuple(config);
    expect(tuple?.pendingWrites).toEqual([
      ['task-a', '__interrupt__', 'two'],
      ['task-a', 'drafts', ['first']],
      ['task-b', 'usage', 3],
    ]);
  });

  it('attaches writes only to their own checkpoint', async () => {
    const { prisma } = createStub();
    const saver = new PrismaCheckpointSaver(prisma);
    const c1 = await saver.put({ configurable: { thread_id: 't1' } }, cp(1), meta(0), {});
    const c2 = await saver.put(c1, cp(2), meta(1), {});
    await saver.putWrites(c1, [['x', 1]], 'task');

    expect((await saver.getTuple(c1))?.pendingWrites).toEqual([['task', 'x', 1]]);
    expect((await saver.getTuple(c2))?.pendingWrites).toEqual([]);
  });

  it('reads back through a fresh saver instance (nothing lives in memory)', async () => {
    const { prisma } = createStub();
    const first = new PrismaCheckpointSaver(prisma);
    const config = await first.put({ configurable: { thread_id: 't1' } }, cp(1, { goal: 'x' }), meta(0), {});
    await first.putWrites(config, [['goal', 'y']], 'task');

    const tuple = await new PrismaCheckpointSaver(prisma).getTuple({ configurable: { thread_id: 't1' } });
    expect(tuple?.checkpoint.channel_values).toEqual({ goal: 'x' });
    expect(tuple?.pendingWrites).toEqual([['task', 'goal', 'y']]);
  });

  it('round-trips a Uint8Array payload byte-exact', async () => {
    const { prisma } = createStub();
    const saver = new PrismaCheckpointSaver(prisma);
    const bytes = Uint8Array.from({ length: 4096 }, (_v, i) => (i * 31) % 256);

    const config = await saver.put({ configurable: { thread_id: 't1' } }, cp(1, { blob: bytes }), meta(0), {});
    const blob = (await saver.getTuple(config))?.checkpoint.channel_values.blob as Uint8Array;

    expect(Buffer.from(blob).equals(Buffer.from(bytes))).toBe(true);
  });

  it('deleteThread removes that thread only, checkpoints and writes', async () => {
    const { prisma, checkpoints, writes } = createStub();
    const saver = new PrismaCheckpointSaver(prisma);
    const a = await saver.put({ configurable: { thread_id: 'a' } }, cp(1), meta(0), {});
    const b = await saver.put({ configurable: { thread_id: 'b' } }, cp(2), meta(0), {});
    await saver.putWrites(a, [['x', 1]], 'task');
    await saver.putWrites(b, [['x', 1]], 'task');

    await saver.deleteThread('a');

    expect(await saver.getTuple(a)).toBeUndefined();
    expect(await saver.getTuple(b)).toBeDefined();
    expect(checkpoints.rows.map((r) => r.threadId)).toEqual(['b']);
    expect(writes.rows.map((r) => r.threadId)).toEqual(['b']);
    await expect(saver.deleteThread('')).rejects.toThrow(/thread_id/);
  });
});
