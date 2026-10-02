import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { NotificationChannel } from '../notification-events';
import { PushNotificationChannel } from './push-notification.channel';

// =============================================================================
// AndroidAppNotificationChannel (issue #312)
// =============================================================================
//
// The `android_app` channel: Web Push to the subscriptions a user registered
// from inside the Android app (its Trusted Web Activity subscribes with
// `platform: 'android_app'`), and to no other. Everything else — the inbox row
// it writes, the payload, the VAPID configuration, the 404/410 prune and the
// failure counter — is `PushNotificationChannel`'s, inherited unchanged, so the
// two channels cannot drift apart in how they send.
//
// A SUBCLASS, NOT A FLAG ON THE PUSH CHANNEL: the dispatcher keys senders by
// `channel`, and the delivery log records which key sent. Two registered
// senders give `notification_deliveries.channel` the honest answer for free.
//
// Overlap with `push` is resolved before either is reached:
// `collapseOverlappingChannels` (notification-events.ts) drops `android_app`
// from a dispatch that also resolved `push`, so no subscription is pushed
// twice and no second inbox row is written.
// =============================================================================

@Injectable()
export class AndroidAppNotificationChannel extends PushNotificationChannel {
  override readonly channel: NotificationChannel = 'android_app';

  protected override subscriptionScope(): Prisma.PushSubscriptionWhereInput {
    return { platform: 'android_app' };
  }

  protected override noSubscriptionsError(): string {
    return 'No Android app push subscriptions for this user';
  }
}
