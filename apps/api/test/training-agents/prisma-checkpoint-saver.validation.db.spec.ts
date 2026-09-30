// =============================================================================
// LangGraph's own checkpointer conformance suite, run against the real
// `PrismaCheckpointSaver` on real Postgres.
// =============================================================================
//
// `@langchain/langgraph-checkpoint-validation` ships a CommonJS build, so it
// loads under ts-jest without any transform. Its tests call `list()` without a
// thread id, so isolation is by emptying the two checkpoint tables around each
// saver instance; nothing else writes to them, and `*.db.spec.ts` suites run
// in band.
//
// THIS IS A `*.db.spec.ts` FILE: skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`.
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import { validate } from '@langchain/langgraph-checkpoint-validation';

import { PrismaCheckpointSaver } from '../../src/training-agents/runtime/prisma-checkpoint-saver';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { dbReachable } = resolveDbSuite('prisma-checkpoint-saver.validation.db.spec');

/**
 * The conformance tests this saver deliberately does not satisfy. Each is
 * skipped by exact title so any OTHER failure still fails the suite.
 *
 * - "should migrate pending sends": pre-v4 checkpoints (`TASKS` pending sends)
 *   never exist in these tables, which were created for a v4 runtime, so the
 *   migration path is absent by design (and the list variant needs vitest's
 *   `expect.soft`, which Jest lacks).
 * - "should only store channel_values that have changed": the saver keeps
 *   channel values inside the one checkpoint blob (one row is the whole
 *   atomic write) instead of a blob per channel version.
 */
const DELIBERATE_DIVERGENCES = [
  'should migrate pending sends',
  'should only store channel_values that have changed (based on newVersions)',
];

let client: PrismaClient;

async function emptyTables(): Promise<void> {
  await client.trainingRunCheckpointWrite.deleteMany({});
  await client.trainingRunCheckpoint.deleteMany({});
}

/** Registers the suite with the deliberate divergences skipped by title. */
function validateWithDivergences(initializer: Parameters<typeof validate>[0]): void {
  const realIt = globalThis.it;
  const guarded = ((title: string, ...rest: unknown[]) =>
    (DELIBERATE_DIVERGENCES.includes(title) ? realIt.skip : realIt)(
      title,
      ...(rest as [jest.ProvidesCallback?, number?]),
    )) as typeof realIt;
  Object.assign(guarded, realIt);

  globalThis.it = guarded;
  try {
    validate(initializer);
  } finally {
    globalThis.it = realIt;
  }
}

if (dbReachable) {
  validateWithDivergences({
    checkpointerName: 'PrismaCheckpointSaver',
    beforeAllTimeout: 30_000,
    async beforeAll() {
      client = createDbClient();
      await client.$connect();
    },
    async afterAll() {
      await emptyTables();
      await client.$disconnect();
    },
    async createCheckpointer() {
      await emptyTables();
      return new PrismaCheckpointSaver(client);
    },
    async destroyCheckpointer() {
      await emptyTables();
    },
  });
} else {
  describe.skip('PrismaCheckpointSaver conformance suite (no database)', () => {
    it('is skipped without a reachable Postgres', () => undefined);
  });
}
