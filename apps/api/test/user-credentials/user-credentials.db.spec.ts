// =============================================================================
// Real-Postgres test: the `user_credentials` table (issue #387)
// =============================================================================
//
// What only a real server can prove: that `@@unique([userId, purpose, name])`
// is an actual constraint (all three columns NOT NULL), that rows cascade with
// their owner, and that the owner-bound cipher rejects a ciphertext moved
// between users by a raw SQL write — the attack the sub-key exists to stop.
//
// Every user is created by this suite with a run-unique email and deleted in
// `afterAll`, so it neither sees nor disturbs other data.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Run with
// `npm run test:db` against a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { InternalServerErrorException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';

import type { PrismaService } from '../../src/prisma/prisma.service';
import { UserCredentialsService } from '../../src/user-credentials/user-credentials.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('user-credentials.db.spec');

const ORIGINAL_KEY = process.env.SECRETS_ENCRYPTION_KEY;

describeWithDb('user_credentials (real Postgres)', () => {
  let client: PrismaClient;
  let service: UserCredentialsService;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `${label}-${run}@example.com` },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  beforeAll(() => {
    process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 21).toString('base64');
    client = createDbClient();
    service = new UserCredentialsService(client as unknown as PrismaService);
  });

  afterAll(async () => {
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
    if (ORIGINAL_KEY === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  it('round-trips through the real table, storing ciphertext only', async () => {
    const alice = await makeUser('alice');
    await service.setSecret(alice, 'webhook', 'default', 'alice-db-secret-1234', {
      label: 'Mine',
    });

    const raw = await client.userCredential.findUniqueOrThrow({
      where: { userId_purpose_name: { userId: alice, purpose: 'webhook', name: 'default' } },
    });
    expect(raw.secret).not.toContain('alice-db-secret-1234');
    expect(raw.hint).toBe('••••1234');

    await expect(service.getSecret(alice, 'webhook', 'default')).resolves.toBe(
      'alice-db-secret-1234',
    );
    await expect(service.list(alice)).resolves.toEqual([
      expect.objectContaining({ purpose: 'webhook', name: 'default', label: 'Mine' }),
    ]);
  });

  it("rejects A's ciphertext copied into B's row by a raw SQL write", async () => {
    const alice = await makeUser('copy-a');
    const bob = await makeUser('copy-b');
    await service.setSecret(alice, 'webhook', 'default', 'alice-only-secret');
    await service.setSecret(bob, 'webhook', 'default', 'bob-only-secret');

    await client.$executeRaw`
      UPDATE user_credentials
         SET secret = (SELECT secret FROM user_credentials
                        WHERE user_id = ${alice}::uuid AND purpose = 'webhook' AND name = 'default')
       WHERE user_id = ${bob}::uuid AND purpose = 'webhook' AND name = 'default'`;

    await expect(service.getSecret(bob, 'webhook', 'default')).rejects.toThrow(
      InternalServerErrorException,
    );
    // Alice's own row is unaffected.
    await expect(service.getSecret(alice, 'webhook', 'default')).resolves.toBe(
      'alice-only-secret',
    );
  });

  it('enforces (user_id, purpose, name) uniqueness at the database', async () => {
    const carol = await makeUser('unique');
    const row = { userId: carol, purpose: 'webhook', name: 'default', secret: 'x' };

    await client.userCredential.create({ data: row });
    const error = await client.userCredential.create({ data: row }).catch((e) => e);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('allows the same (purpose, name) for two different users', async () => {
    const dave = await makeUser('same-a');
    const erin = await makeUser('same-b');

    await service.setSecret(dave, 'webhook', 'default', 'dave-secret-1234');
    await service.setSecret(erin, 'webhook', 'default', 'erin-secret-1234');

    await expect(service.getSecret(dave, 'webhook', 'default')).resolves.toBe('dave-secret-1234');
    await expect(service.getSecret(erin, 'webhook', 'default')).resolves.toBe('erin-secret-1234');
  });

  it('upserts in place: a second write updates the one row', async () => {
    const frank = await makeUser('upsert');
    await service.setSecret(frank, 'webhook', 'default', 'first-secret-1111');
    await service.setSecret(frank, 'webhook', 'default', 'second-secret-2222');

    await expect(
      client.userCredential.count({ where: { userId: frank } }),
    ).resolves.toBe(1);
    await expect(service.getSecret(frank, 'webhook', 'default')).resolves.toBe(
      'second-secret-2222',
    );
  });

  it("cascades: deleting the user deletes their credentials, and only theirs", async () => {
    const gone = await makeUser('cascade-gone');
    const kept = await makeUser('cascade-kept');
    await service.setSecret(gone, 'webhook', 'default', 'gone-secret-1234');
    await service.setSecret(gone, 'other', 'default', 'gone-other-1234');
    await service.setSecret(kept, 'webhook', 'default', 'kept-secret-1234');

    await client.user.delete({ where: { id: gone } });

    await expect(client.userCredential.count({ where: { userId: gone } })).resolves.toBe(0);
    await expect(service.getSecret(kept, 'webhook', 'default')).resolves.toBe(
      'kept-secret-1234',
    );
  });

  it('refuses a row for a user that does not exist (FK)', async () => {
    await expect(
      client.userCredential.create({
        data: { userId: randomUUID(), purpose: 'webhook', name: 'default', secret: 'x' },
      }),
    ).rejects.toThrow();
  });
});
