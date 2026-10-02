import { NotFoundException } from '@nestjs/common';
import { WebPushError } from 'web-push';

import {
  ANDROID_APP_TEST_LINK,
  ANDROID_APP_TEST_NOTIFICATION_ACTION,
  AndroidAppPushService,
  toResultRow,
} from './android-app-push.service';
import { PushTestService } from './push-test.service';

// =============================================================================
// AndroidAppPushService — tests (issue #312)
// =============================================================================
//
// `web-push` is mocked like `push-test.service.spec.ts` does it, and the REAL
// `PushTestService.sendToSubscriptions` runs underneath, so the 404/410 prune
// is the shared sender's, not a reimplementation.
// =============================================================================

jest.mock('web-push', () => {
  const actual = jest.requireActual('web-push');
  return { ...actual, sendNotification: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const webpush = jest.requireMock('web-push') as { sendNotification: jest.Mock };

const ACTOR = '00000000-0000-4000-8000-000000000001';
const TARGET = '00000000-0000-4000-8000-000000000002';
const ACTIVE = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.org' };

function sub(id: string, endpoint: string) {
  return {
    id,
    userId: ACTOR,
    endpoint,
    p256dh: 'p',
    auth: 'a',
    platform: 'android_app',
    failureCount: 0,
    lastSuccessAt: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
  };
}

function setup(opts: { active?: typeof ACTIVE | null; subs?: unknown[]; userExists?: boolean } = {}) {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(opts.userExists === false ? null : { id: TARGET }) },
    pushSubscription: {
      findMany: jest.fn().mockResolvedValue(opts.subs ?? []),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const pushConfig = {
    resolveActiveVapidConfig: jest.fn().mockResolvedValue(opts.active === undefined ? ACTIVE : opts.active),
  };
  const pushTest = new PushTestService(prisma as never, pushConfig as never, {} as never);
  const service = new AndroidAppPushService(prisma as never, pushConfig as never, pushTest);

  return { prisma, service };
}

describe('AndroidAppPushService.sendTest', () => {
  beforeEach(() => webpush.sendNotification.mockReset());

  it('queries only android_app subscriptions of the caller by default', async () => {
    const { prisma, service } = setup();

    await service.sendTest(ACTOR);

    expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: ACTOR, platform: 'android_app' } }),
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('answers NO_ANDROID_SUBSCRIPTION with no send when the user has none', async () => {
    const { prisma, service } = setup({ subs: [] });

    await expect(service.sendTest(ACTOR)).resolves.toEqual({
      userId: ACTOR,
      androidSubscriptions: 0,
      results: [],
      reason: 'NO_ANDROID_SUBSCRIPTION',
    });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: ANDROID_APP_TEST_NOTIFICATION_ACTION,
        targetId: ACTOR,
        meta: expect.objectContaining({ reason: 'NO_ANDROID_SUBSCRIPTION' }),
      }),
    });
  });

  it('answers PUSH_NOT_CONFIGURED when no VAPID pair is active, even with subscriptions', async () => {
    const { service } = setup({ active: null, subs: [sub('s1', 'https://fcm.googleapis.com/fcm/send/a')] });

    await expect(service.sendTest(ACTOR)).resolves.toEqual({
      userId: ACTOR,
      androidSubscriptions: 1,
      results: [],
      reason: 'PUSH_NOT_CONFIGURED',
    });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('reports sent and gone per subscription, pruning the gone one, with the test payload', async () => {
    const subs = [
      sub('s1', 'https://fcm.googleapis.com/fcm/send/a'),
      sub('s2', 'https://fcm.googleapis.com/fcm/send/b'),
    ];
    const { prisma, service } = setup({ subs });
    webpush.sendNotification
      .mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} })
      .mockRejectedValueOnce(new WebPushError('gone', 410, {}, 'expired', subs[1].endpoint));

    const result = await service.sendTest(ACTOR);

    expect(result.reason).toBeUndefined();
    expect(result.results).toEqual([
      { subscriptionId: 's1', endpointHost: 'fcm.googleapis.com', status: 'sent' },
      expect.objectContaining({ subscriptionId: 's2', endpointHost: 'fcm.googleapis.com', status: 'gone' }),
    ]);
    expect(prisma.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: 's2' } });

    const payload = JSON.parse(webpush.sendNotification.mock.calls[0][1] as string);
    expect(payload).toMatchObject({
      title: expect.stringMatching(/ test notification$/),
      body: 'If you can read this on your phone, Android app notifications work.',
      link: ANDROID_APP_TEST_LINK,
      test: true,
    });
  });

  it('checks that a named target user exists, 404 otherwise', async () => {
    const { service } = setup({ userExists: false });

    await expect(service.sendTest(ACTOR, TARGET)).rejects.toThrow(NotFoundException);
  });

  it('a failed audit write does not fail the test', async () => {
    const { prisma, service } = setup();
    prisma.auditEvent.create.mockRejectedValue(new Error('db down'));

    await expect(service.sendTest(ACTOR)).resolves.toMatchObject({ reason: 'NO_ANDROID_SUBSCRIPTION' });
  });
});

describe('toResultRow', () => {
  it('maps a failed or skipped send to failed with its message, never exposing the endpoint', () => {
    const row = toResultRow('s1', 'https://push.example.org/secret-path', {
      status: 'failed',
      statusCode: 503,
      message: 'boom',
      responseBody: null,
      durationMs: 1,
    });

    expect(row).toEqual({ subscriptionId: 's1', endpointHost: 'push.example.org', status: 'failed', error: 'boom' });
  });
});
