// =============================================================================
// push_subscriptions.platform against real Postgres (issue #312)
// =============================================================================
//
// The column default, the CHECK constraint that lives only in migration SQL
// (Prisma cannot express it), and the real subscribe upsert moving an existing
// endpoint up to android_app but never back down to browser (#318). A mocked
// Prisma can prove none of these.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../src/prisma/prisma.service';
import { PushConfigService } from '../../src/notifications/push-config.service';
import { PushSubscriptionService } from '../../src/notifications/push-subscription.service';
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

  describe('PushSubscriptionService.subscribe (#318: sticky upward)', () => {
    const service = () =>
      new PushSubscriptionService(
        prisma as unknown as PrismaService,
        {
          resolveActiveVapidConfig: jest
            .fn()
            .mockResolvedValue({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:x@example.test' }),
        } as unknown as PushConfigService,
      );
    const post = (url: string, platform: 'browser' | 'android_app') =>
      service().subscribe(userId, { endpoint: url, keys: { p256dh: 'p', auth: 'a' }, platform }, 'ua');

    it('a browser re-post does not downgrade an android_app row', async () => {
      const url = endpoint();
      const first = await post(url, 'android_app');
      const second = await post(url, 'browser');

      expect(second.id).toBe(first.id);
      expect(second.platform).toBe('android_app');
      const row = await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: url } });
      expect(row.platform).toBe('android_app');
      expect(await prisma.pushSubscription.count({ where: { endpoint: url } })).toBe(1);
    });

    it('an android_app post upgrades a browser row; a new endpoint takes the posted value', async () => {
      const url = endpoint();
      const created = await post(url, 'browser');
      expect(created.platform).toBe('browser');

      const upgraded = await post(url, 'android_app');
      expect(upgraded.id).toBe(created.id);
      expect(upgraded.platform).toBe('android_app');
    });
  });
});
