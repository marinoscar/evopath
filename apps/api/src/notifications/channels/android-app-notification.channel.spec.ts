import { NOTIFICATION_EVENTS } from '../notification-events';
import type { NotificationDispatchContext } from '../notification.types';
import { AndroidAppNotificationChannel } from './android-app-notification.channel';
import { PushNotificationChannel } from './push-notification.channel';

// =============================================================================
// AndroidAppNotificationChannel — tests (issue #312)
// =============================================================================
//
// The send path is `PushNotificationChannel`'s and is covered by its spec; what
// is new here is the subscription scope: `android_app` reads only Android app
// subscriptions, `push` keeps reading every one.
// =============================================================================

jest.mock('web-push', () => {
  const actual = jest.requireActual('web-push');
  return { ...actual, sendNotification: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const webpush = jest.requireMock('web-push') as { sendNotification: jest.Mock };

const event = NOTIFICATION_EVENTS.find((e) => e.key === 'admin.broadcast')!;
const context: NotificationDispatchContext = {
  event,
  recipient: { userId: 'user-1', email: null, preferences: {} },
  data: { title: 'Hello', body: 'World', critical: false },
  channels: ['android_app'],
};

function setup(Channel: typeof PushNotificationChannel, subs: unknown[]) {
  const prisma = {
    pushSubscription: {
      findMany: jest.fn().mockResolvedValue(subs),
      update: jest.fn().mockResolvedValue({ failureCount: 0 }),
      delete: jest.fn().mockResolvedValue({}),
    },
    notification: { create: jest.fn().mockResolvedValue({ id: 'n-1' }) },
  };
  const pushConfig = {
    resolveActiveVapidConfig: jest
      .fn()
      .mockResolvedValue({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.org' }),
  };
  return { prisma, channel: new Channel(prisma as never, pushConfig as never) };
}

const androidSub = { id: 's1', userId: 'user-1', endpoint: 'https://fcm.googleapis.com/a', p256dh: 'p', auth: 'a', platform: 'android_app', failureCount: 0 };

describe('AndroidAppNotificationChannel', () => {
  beforeEach(() => webpush.sendNotification.mockReset());

  it('is registered under the android_app key', () => {
    expect(setup(AndroidAppNotificationChannel, []).channel.channel).toBe('android_app');
  });

  it('reads only the recipient’s android_app subscriptions', async () => {
    const { prisma, channel } = setup(AndroidAppNotificationChannel, [androidSub]);
    webpush.sendNotification.mockResolvedValue({ statusCode: 201 });

    await expect(channel.deliver(context, 'user-1')).resolves.toEqual({ success: true, messageId: 'n-1' });
    expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith({
      where: { platform: 'android_app', userId: 'user-1' },
    });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('reports a failure worded for the app when the user has no Android app subscription', async () => {
    const { prisma, channel } = setup(AndroidAppNotificationChannel, []);

    await expect(channel.deliver(context, 'user-1')).resolves.toEqual({
      success: false,
      error: 'No Android app push subscriptions for this user',
    });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('leaves the push channel reading every subscription, whatever its platform', async () => {
    const { prisma, channel } = setup(PushNotificationChannel, []);

    await channel.deliver({ ...context, channels: ['push'] }, 'user-1');

    expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });
});
