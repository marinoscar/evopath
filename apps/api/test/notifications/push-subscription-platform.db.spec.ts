// =============================================================================
// push_subscriptions.platform against real Postgres (issue #312)
// =============================================================================
//
// The column default, the CHECK constraint that lives only in migration SQL
// (Prisma cannot express it), and the subscribe upsert moving an existing
// endpoint between platforms. A mocked Prisma can prove none of these.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const PREFIX = 'push-platform-db-';

const { describeWithDb } = resolveDbSuite('push-subscription-platform.db.spec');

describeWithDb('push_subscriptions.platform (real Postgres)', () => {
  let prisma: ReturnType<typeof createDbClient>;
  let userId: string;

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();
  });

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: { email: `${PREFIX}${randomUUID()}@example.test` },
    });
    userId = user.id;
  });

  afterEach(async () => {
    // Cascade removes the subscriptions.
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const endpoint = () => `https://push.example.test/${randomUUID()}`;

  it('defaults to browser for a row created without a platform', async () => {
    const row = await prisma.pushSubscription.create({
      data: { userId, endpoint: endpoint(), p256dh: 'p', auth: 'a' },
    });

    expect(row.platform).toBe('browser');
  });

  it('accepts android_app', async () => {
    const row = await prisma.pushSubscription.create({
      data: { userId, endpoint: endpoint(), p256dh: 'p', auth: 'a', platform: 'android_app' },
    });

    expect(row.platform).toBe('android_app');
  });

  it('rejects any other value through the CHECK constraint', async () => {
    await expect(
      prisma.pushSubscription.create({
        data: { userId, endpoint: endpoint(), p256dh: 'p', auth: 'a', platform: 'ios_app' },
      }),
    ).rejects.toThrow(/push_subscriptions_platform_check|check constraint/i);
  });

  it('the subscribe upsert moves an existing endpoint to the new platform without a duplicate', async () => {
    const url = endpoint();
    const upsert = (platform: string) =>
      prisma.pushSubscription.upsert({
        where: { endpoint: url },
        update: { userId, p256dh: 'p2', auth: 'a2', failureCount: 0, platform },
        create: { userId, endpoint: url, p256dh: 'p', auth: 'a', platform },
      });

    const first = await upsert('browser');
    const second = await upsert('android_app');

    expect(second.id).toBe(first.id);
    expect(second.platform).toBe('android_app');
    expect(await prisma.pushSubscription.count({ where: { endpoint: url } })).toBe(1);
  });
});
