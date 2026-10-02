// =============================================================================
// Real-Postgres test: user memory (#325)
// =============================================================================
//
// What only real rows and the real `pg_trgm` extension can prove:
//   - near-duplicate detection: a reworded fact in the same category
//     (similarity > 0.8) updates the existing row; a different fact, or the
//     same words in another category, adds a row; an exact duplicate
//     (ignoring case and punctuation) returns the existing row;
//   - `forget({ query })` finds the best active match by trigram similarity;
//   - cross-user isolation: another user's id is a 404 on edit, delete and
//     restore; list, the memory block and the near-duplicate search never see
//     another user's rows;
//   - supersession links the old row to its replacement (self FK);
//   - `memory.purge` erases expired deleted/superseded rows and nothing else;
//   - deleting the user cascades every memory and the extraction state.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Run with
// `npm run test:db` against a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { MemoryContextService } from '../../src/memory/memory-context.service';
import { MemoryService } from '../../src/memory/memory.service';
import { MemoryPurgeHandler } from '../../src/memory/purge/memory-purge.handler';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('memory.db.spec');
const DAY = 24 * 60 * 60 * 1000;

describeWithDb('user memory (real Postgres)', () => {
  let client: PrismaClient;
  let service: MemoryService;
  let context: MemoryContextService;
  let purge: MemoryPurgeHandler;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];
  let alice: string;
  let bob: string;

  const systemSettings = { getMemoryPolicy: async () => ({ ...DEFAULT_SYSTEM_SETTINGS.memory }) };

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `memory-${label}-${run}@example.com` }, select: { id: true } });
    createdUserIds.push(user.id);
    return user.id;
  }

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    service = new MemoryService(prisma, systemSettings as never);
    context = new MemoryContextService(prisma, service);
    purge = new MemoryPurgeHandler({ register: () => undefined } as never, prisma, systemSettings as never);
    alice = await makeUser('alice');
    bob = await makeUser('bob');
  });

  afterAll(async () => {
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
  });

  beforeEach(async () => {
    await client.userMemory.deleteMany({ where: { userId: { in: createdUserIds } } });
  });

  it('pg_trgm is installed and the trigram index exists', async () => {
    const ext = await client.$queryRaw<Array<{ extname: string }>>`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`;
    expect(ext).toHaveLength(1);
    const idx = await client.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'user_memories' AND indexname = 'user_memories_content_trgm_idx'`;
    expect(idx).toHaveLength(1);
  });

  it('a reworded fact in the same category updates the existing row; another category or fact adds one', async () => {
    const first = await service.write(alice, { content: 'User trains at the gym on Monday mornings.', category: 'schedule', source: 'extracted' }, 'agent');
    expect(first.op).toBe('added');

    const near = await service.write(alice, { content: 'User trains at the gym on Monday mornings!!', category: 'schedule', source: 'extracted' }, 'agent');
    expect(near).toMatchObject({ op: 'unchanged', memory: { id: first.memory.id } });

    const reworded = await service.write(alice, { content: 'User trains at the gym on Monday mornings early.', category: 'schedule', source: 'explicit' }, 'agent');
    expect(reworded).toMatchObject({ op: 'updated', memory: { id: first.memory.id, source: 'explicit' } });

    const otherCategory = await service.write(alice, { content: 'User trains at the gym on Monday mornings early too.', category: 'preference', source: 'explicit' }, 'agent');
    expect(otherCategory.op).toBe('added');

    const different = await service.write(alice, { content: 'User owns a rowing machine at home.', category: 'schedule', source: 'explicit' }, 'agent');
    expect(different.op).toBe('added');

    expect(await client.userMemory.count({ where: { userId: alice, status: 'active' } })).toBe(3);
  });

  it("the extraction never rewrites the user's own near-duplicate", async () => {
    const mine = await service.create(alice, { content: 'User prefers workouts under forty five minutes.', category: 'preference' });
    const extracted = await service.write(alice, { content: 'User prefers workouts under forty minutes.', category: 'preference', source: 'extracted' }, 'agent');

    expect(extracted.op).toBe('unchanged');
    const row = await client.userMemory.findUniqueOrThrow({ where: { id: mine.id } });
    expect(row).toMatchObject({ content: 'User prefers workouts under forty five minutes.', source: 'user_edited' });
  });

  it('forget by query finds the best active match by similarity, only among the caller\'s rows', async () => {
    await service.write(alice, { content: 'User prefers to be called Bobby.', category: 'preference', source: 'explicit' }, 'agent');
    await service.write(alice, { content: 'User owns adjustable dumbbells.', category: 'equipment', source: 'explicit' }, 'agent');
    await service.write(bob, { content: 'User prefers to be called Bobby too.', category: 'preference', source: 'explicit' }, 'agent');

    const match = await service.findBestMatch(alice, 'prefers to be called Bobby');
    expect(match).toMatchObject({ userId: alice, content: 'User prefers to be called Bobby.' });
    expect(await service.findBestMatch(alice, 'kettlebell swings tempo')).toBeNull();
  });

  it('cross-user isolation: 404 on every id route, and list, block and dedup never see another user', async () => {
    const bobs = await service.write(bob, { content: 'User trains judo on Tuesdays.', category: 'schedule', source: 'explicit' }, 'agent');

    await expect(service.update(alice, bobs.memory.id, { pinned: true }, 'user')).rejects.toMatchObject({ status: 404 });
    await expect(service.softDelete(alice, bobs.memory.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.restore(alice, bobs.memory.id)).rejects.toMatchObject({ status: 404 });

    // Alice writes the same words: a new row of hers, Bob's untouched.
    const hers = await service.write(alice, { content: 'User trains judo on Tuesdays.', category: 'schedule', source: 'explicit' }, 'agent');
    expect(hers.op).toBe('added');
    expect(hers.memory.id).not.toBe(bobs.memory.id);

    const list = await service.list(alice);
    expect(list.items.map((i) => i.id)).toEqual([hers.memory.id]);
    const block = await context.buildBlock(alice, { audience: 'coach' });
    expect(block).toContain('judo');
    expect(await context.buildBlock(randomUUID(), { audience: 'coach' })).toBe('');

    const bobRow = await client.userMemory.findUniqueOrThrow({ where: { id: bobs.memory.id } });
    expect(bobRow).toMatchObject({ status: 'active', pinned: false, userId: bob });
  });

  it('the memory block bumps lastUsedAt of the rows it used', async () => {
    const m = await service.write(alice, { content: 'User wants to deadlift twice bodyweight.', category: 'goal', source: 'explicit' }, 'agent');
    expect(m.memory.lastUsedAt).toBeNull();
    await context.buildBlock(alice, { audience: 'training' });
    const row = await client.userMemory.findUniqueOrThrow({ where: { id: m.memory.id } });
    expect(row.lastUsedAt).toBeInstanceOf(Date);
  });

  it('supersede links the old row to its replacement; purge erases only expired deleted/superseded rows', async () => {
    const old = await service.write(alice, { content: 'User trains three days a week.', category: 'schedule', source: 'extracted' }, 'agent');
    const replaced = await service.supersede(alice, old.memory.id, { content: 'User trains four days a week.', source: 'extracted' });
    const oldRow = await client.userMemory.findUniqueOrThrow({ where: { id: old.memory.id } });
    expect(oldRow).toMatchObject({ status: 'superseded', supersededById: replaced!.memory.id });

    const recentDelete = await service.write(alice, { content: 'User likes rowing intervals.', category: 'preference', source: 'explicit' }, 'agent');
    await service.softDelete(alice, recentDelete.memory.id);
    const oldDelete = await service.write(alice, { content: 'User likes hill sprints.', category: 'preference', source: 'explicit' }, 'agent');
    await client.userMemory.update({ where: { id: oldDelete.memory.id }, data: { status: 'deleted', deletedAt: new Date(Date.now() - 40 * DAY) } });
    await client.$executeRaw`UPDATE user_memories SET updated_at = now() - interval '40 days' WHERE id = ${old.memory.id}::uuid`;

    const erased = await purge.purge(new Date());
    expect(erased).toBeGreaterThanOrEqual(2);
    const left = await client.userMemory.findMany({ where: { userId: alice }, select: { id: true, status: true } });
    expect(left.map((r) => r.id).sort()).toEqual([replaced!.memory.id, recentDelete.memory.id].sort());
  });

  it('deleting the user cascades every memory and the extraction state', async () => {
    const carol = await makeUser('carol');
    await service.write(carol, { content: 'User likes swimming.', category: 'preference', source: 'explicit' }, 'agent');
    await client.userMemoryState.create({ data: { userId: carol, lastExtractedAt: new Date(), extractionsToday: 1 } });

    await client.user.delete({ where: { id: carol } });
    expect(await client.userMemory.count({ where: { userId: carol } })).toBe(0);
    expect(await client.userMemoryState.count({ where: { userId: carol } })).toBe(0);
  });
});
