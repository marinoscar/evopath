import type { Prisma, PrismaClient } from '@prisma/client';
import type { RunnableConfig } from '@langchain/core/runnables';
import type {
  ChannelVersions,
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointPendingWrite,
  CheckpointTuple,
  PendingWrite,
  SerializerProtocol,
} from '@langchain/langgraph-checkpoint';
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  copyCheckpoint,
  getCheckpointId,
} from '@langchain/langgraph-checkpoint';

/**
 * The slice of Prisma this saver uses. Narrower than `PrismaService` so a unit
 * spec can hand in an in-memory stub with just these members.
 */
export type CheckpointPrisma = Pick<
  PrismaClient,
  'trainingRunCheckpoint' | 'trainingRunCheckpointWrite' | '$transaction'
>;

type CheckpointRow = {
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  parentCheckpointId: string | null;
  type: string;
  checkpoint: Uint8Array;
  metadata: Uint8Array;
};

type WriteRow = {
  checkpointId: string;
  checkpointNs: string;
  threadId: string;
  taskId: string;
  idx: number;
  channel: string;
  type: string;
  value: Uint8Array;
};

/** Rows read per round trip while `list` walks a thread. */
const LIST_PAGE_SIZE = 100;

const CHECKPOINT_SELECT = {
  threadId: true,
  checkpointNs: true,
  checkpointId: true,
  parentCheckpointId: true,
  type: true,
  checkpoint: true,
  metadata: true,
} as const;

/**
 * LangGraph checkpoint saver over two Prisma-owned tables,
 * `training_run_checkpoints` and `training_run_checkpoint_writes`.
 *
 * It exists instead of `PostgresSaver` because that one's `setup()` creates
 * its own tables outside Prisma migrations. Behaviour follows the reference
 * savers of the installed `@langchain/langgraph-checkpoint`:
 *
 * - `thread_id` is the training run id; `checkpoint_ns` defaults to `""`.
 * - Checkpoint ids are LangGraph's monotonic uuid6 strings. "Latest" and
 *   `list` ordering use them (descending), never `createdAt`.
 * - `put` is one upsert: the checkpoint and its parent link are a single row,
 *   so an abort mid-write leaves the old or the new checkpoint, never half.
 * - `putWrites` is idempotent per `(taskId, idx)`. A regular write keeps the
 *   first value stored (a retried task does not overwrite it); a special
 *   channel (`__error__`, `__scheduled__`, `__interrupt__`, `__resume__`) maps
 *   to its negative `WRITES_IDX_MAP` index and is overwritten, exactly as
 *   `MemorySaver` and `PostgresSaver` do.
 * - Pending writes come back ordered by `(taskId, idx)`, like `PostgresSaver`.
 *
 * Values go through `this.serde.dumpsTyped` / `loadsTyped`, and the type tag
 * is stored beside each blob. Storage rule for callers: the graph state holds
 * node outputs only, never raw provider messages, so provider continuation
 * state is never serialised here.
 *
 * Checkpoints older than format v4 (with `TASKS` pending sends to migrate)
 * never exist in these tables, which were created for a v4 runtime, so the
 * `MemorySaver` migration path for them is deliberately absent.
 */
export class PrismaCheckpointSaver extends BaseCheckpointSaver {
  constructor(
    private readonly prisma: CheckpointPrisma,
    serde?: SerializerProtocol,
  ) {
    super(serde);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = optionalKey(config.configurable?.thread_id, 'thread_id');
    if (threadId === undefined) return undefined;

    const checkpointNs = namespaceOf(config);
    const checkpointId = getCheckpointId(config) || undefined;

    const row = checkpointId
      ? await this.prisma.trainingRunCheckpoint.findUnique({
          where: { threadId_checkpointNs_checkpointId: { threadId, checkpointNs, checkpointId } },
          select: CHECKPOINT_SELECT,
        })
      : await this.prisma.trainingRunCheckpoint.findFirst({
          where: { threadId, checkpointNs },
          orderBy: { checkpointId: 'desc' },
          select: CHECKPOINT_SELECT,
        });

    if (!row) return undefined;

    const writes = await this.prisma.trainingRunCheckpointWrite.findMany({
      where: { threadId, checkpointNs, checkpointId: row.checkpointId },
      orderBy: [{ taskId: 'asc' }, { idx: 'asc' }],
    });

    return this.toTuple(row, writes);
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { before, filter } = options ?? {};
    let remaining = options?.limit;
    if (remaining !== undefined && remaining <= 0) return;

    const threadId = optionalKey(config.configurable?.thread_id, 'thread_id');
    const checkpointNs = optionalNamespace(config.configurable?.checkpoint_ns);
    const checkpointId = optionalKey(config.configurable?.checkpoint_id, 'checkpoint_id') || undefined;
    const beforeId = optionalKey(before?.configurable?.checkpoint_id, 'checkpoint_id') || undefined;

    const base: Prisma.TrainingRunCheckpointWhereInput = {
      ...(threadId !== undefined ? { threadId } : {}),
      ...(checkpointNs !== undefined ? { checkpointNs } : {}),
      ...(checkpointId !== undefined || beforeId !== undefined
        ? {
            checkpointId: {
              ...(checkpointId !== undefined ? { equals: checkpointId } : {}),
              ...(beforeId !== undefined ? { lt: beforeId } : {}),
            },
          }
        : {}),
    };

    // Keyset pagination over (checkpointId, threadId, checkpointNs) descending,
    // so a checkpoint written while the caller iterates cannot shift a page.
    let cursor: CheckpointRow | undefined;

    for (;;) {
      // Without a metadata filter every row read is yielded, so the limit can
      // bound the read; with one, rows are filtered after deserialising.
      const take =
        filter === undefined && remaining !== undefined ? Math.min(remaining, LIST_PAGE_SIZE) : LIST_PAGE_SIZE;
      const page: CheckpointRow[] = await this.prisma.trainingRunCheckpoint.findMany({
        where: cursor ? { AND: [base, after(cursor)] } : base,
        orderBy: [{ checkpointId: 'desc' }, { threadId: 'desc' }, { checkpointNs: 'desc' }],
        take,
        select: CHECKPOINT_SELECT,
      });

      if (page.length === 0) return;
      cursor = page[page.length - 1];

      const writes = await this.prisma.trainingRunCheckpointWrite.findMany({
        where: {
          OR: page.map((row) => ({
            threadId: row.threadId,
            checkpointNs: row.checkpointNs,
            checkpointId: row.checkpointId,
          })),
        },
        orderBy: [{ taskId: 'asc' }, { idx: 'asc' }],
      });

      for (const row of page) {
        const rowWrites = writes.filter(
          (write) =>
            write.threadId === row.threadId &&
            write.checkpointNs === row.checkpointNs &&
            write.checkpointId === row.checkpointId,
        );
        const tuple = await this.toTuple(row, rowWrites);

        if (filter && !matchesFilter(tuple.metadata, filter)) continue;

        yield tuple;

        if (remaining !== undefined) {
          remaining -= 1;
          if (remaining <= 0) return;
        }
      }

      if (page.length < take) return;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    // Unused: channel values are stored inside the checkpoint blob, not as
    // separate per-version blobs the way `PostgresSaver` stores them.
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = requiredKey(config.configurable?.thread_id, 'thread_id', 'put checkpoint');
    const checkpointNs = namespaceOf(config);
    const checkpointId = requiredKey(checkpoint.id, 'checkpoint.id', 'put checkpoint');
    const parentCheckpointId = optionalKey(config.configurable?.checkpoint_id, 'checkpoint_id') || null;

    const [[type, serializedCheckpoint], [metadataType, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);

    if (metadataType !== 'json') {
      throw new Error(`Checkpoint metadata serialised as "${metadataType}", expected "json"`);
    }

    const data = {
      parentCheckpointId,
      type,
      checkpoint: toBytes(serializedCheckpoint),
      metadata: toBytes(serializedMetadata),
    };

    // One row holds the checkpoint and its parent link, so this single
    // statement is the whole write: atomic without an explicit transaction.
    await this.prisma.trainingRunCheckpoint.upsert({
      where: { threadId_checkpointNs_checkpointId: { threadId, checkpointNs, checkpointId } },
      create: { threadId, checkpointNs, checkpointId, ...data },
      update: data,
    });

    return { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpointId } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = requiredKey(config.configurable?.thread_id, 'thread_id', 'put writes');
    const checkpointNs = namespaceOf(config);
    const checkpointId = requiredKey(config.configurable?.checkpoint_id, 'checkpoint_id', 'put writes');
    requiredKey(taskId, 'task_id', 'put writes');

    if (writes.length === 0) return;

    const rows = await Promise.all(
      writes.map(async ([channel, value], index) => {
        const [type, serialized] = await this.serde.dumpsTyped(value);
        return {
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          idx: WRITES_IDX_MAP[channel] ?? index,
          channel,
          type,
          value: toBytes(serialized),
        };
      }),
    );

    const special = rows.filter((row) => row.idx < 0);
    const regular = rows.filter((row) => row.idx >= 0);

    // Each statement is an INSERT ... ON CONFLICT, so parallel tasks writing
    // to the same checkpoint neither deadlock nor duplicate.
    await this.prisma.$transaction([
      ...(regular.length > 0
        ? [this.prisma.trainingRunCheckpointWrite.createMany({ data: regular, skipDuplicates: true })]
        : []),
      ...special.map(({ threadId: t, checkpointNs: ns, checkpointId: id, taskId: task, idx, ...rest }) =>
        this.prisma.trainingRunCheckpointWrite.upsert({
          where: {
            threadId_checkpointNs_checkpointId_taskId_idx: {
              threadId: t,
              checkpointNs: ns,
              checkpointId: id,
              taskId: task,
              idx,
            },
          },
          create: { threadId: t, checkpointNs: ns, checkpointId: id, taskId: task, idx, ...rest },
          update: rest,
        }),
      ),
    ]);
  }

  async deleteThread(threadId: string): Promise<void> {
    requiredKey(threadId, 'thread_id', 'delete thread');

    await this.prisma.$transaction([
      this.prisma.trainingRunCheckpointWrite.deleteMany({ where: { threadId } }),
      this.prisma.trainingRunCheckpoint.deleteMany({ where: { threadId } }),
    ]);
  }

  private async toTuple(row: CheckpointRow, writes: WriteRow[]): Promise<CheckpointTuple> {
    const [checkpoint, metadata, pendingWrites] = await Promise.all([
      this.serde.loadsTyped(row.type, row.checkpoint) as Promise<Checkpoint>,
      this.serde.loadsTyped('json', row.metadata) as Promise<CheckpointMetadata>,
      Promise.all(
        writes.map(
          async (write): Promise<CheckpointPendingWrite> => [
            write.taskId,
            write.channel,
            await this.serde.loadsTyped(write.type, write.value),
          ],
        ),
      ),
    ]);

    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: row.threadId,
          checkpoint_ns: row.checkpointNs,
          checkpoint_id: row.checkpointId,
        },
      },
      checkpoint,
      metadata,
      pendingWrites,
    };

    if (row.parentCheckpointId !== null) {
      tuple.parentConfig = {
        configurable: {
          thread_id: row.threadId,
          checkpoint_ns: row.checkpointNs,
          checkpoint_id: row.parentCheckpointId,
        },
      };
    }

    return tuple;
  }
}

/** Rows strictly after `cursor` in (checkpointId, threadId, checkpointNs) descending order. */
function after(cursor: CheckpointRow): Prisma.TrainingRunCheckpointWhereInput {
  return {
    OR: [
      { checkpointId: { lt: cursor.checkpointId } },
      { checkpointId: cursor.checkpointId, threadId: { lt: cursor.threadId } },
      {
        checkpointId: cursor.checkpointId,
        threadId: cursor.threadId,
        checkpointNs: { lt: cursor.checkpointNs },
      },
    ],
  };
}

function matchesFilter(metadata: CheckpointMetadata | undefined, filter: Record<string, unknown>): boolean {
  const record = (metadata ?? {}) as Record<string, unknown>;
  return Object.entries(filter).every(([key, value]) => record[key] === value);
}

function namespaceOf(config: RunnableConfig): string {
  return optionalNamespace(config.configurable?.checkpoint_ns) ?? '';
}

function optionalNamespace(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error('Invalid configurable value for "checkpoint_ns": expected a string');
  }
  return value;
}

function optionalKey(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Invalid configurable value for "${field}": expected a string`);
  }
  return value;
}

function requiredKey(value: unknown, field: string, action: string): string {
  const key = optionalKey(value, field);
  if (!key) {
    throw new Error(`Failed to ${action}: "${field}" is required and must be a non-empty string`);
  }
  return key;
}

/**
 * Prisma's `Bytes` input is a `Uint8Array` over a plain `ArrayBuffer`. The
 * serializer may hand back a view over a shared or larger buffer, so copy it
 * only when that is not already the case.
 */
function toBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  if (data.buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
    return data as Uint8Array<ArrayBuffer>;
  }
  return new Uint8Array(data);
}
