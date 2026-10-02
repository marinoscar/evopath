import { randomUUID } from 'node:crypto';

import { APP_NAME } from '@app/shared';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { describeThrown } from './describe-thrown';
import { PushConfigService } from './push-config.service';
import { endpointHost, PushTestService } from './push-test.service';
import type { PushTestSendResult } from './dto/push-test.dto';

// =============================================================================
// AndroidAppPushService (issue #312)
// =============================================================================
//
// The admin "Send test notification" for the Android app: one Web Push to the
// `android_app`-platform subscriptions of one user (the caller by default),
// reported per subscription. Served by `POST /api/admin/android-app/
// test-notification` in `AndroidAppController`; it lives here, and is
// exported, because the push sender and VAPID configuration belong to this
// module and the Android app module only needs this one door into them.
//
// REUSES `PushTestService.sendToSubscriptions`: the same send, the same 404/410
// prune and the same success bookkeeping as the Web Push diagnostic, rather
// than a third copy of that logic. Like that diagnostic it does NOT go through
// `notify()`: a test is not a notification, writes no inbox row, and must
// reach the device whatever the user's preferences say.
// =============================================================================

/** `audit_events.action` for a test send. */
export const ANDROID_APP_TEST_NOTIFICATION_ACTION = 'android_app.test_notification.sent';

/** Sent as the payload's `eventKey`; not a registry event, and never persisted. */
export const ANDROID_APP_TEST_EVENT_KEY = 'android_app.test';

/** Where a tap on the test notification lands. */
export const ANDROID_APP_TEST_LINK = '/settings/connected-devices';

export const ANDROID_APP_TEST_BODY =
  'If you can read this on your phone, Android app notifications work.';

/** Why nothing was sent. */
export type AndroidAppTestReason = 'NO_ANDROID_SUBSCRIPTION' | 'PUSH_NOT_CONFIGURED';

export interface AndroidAppTestResultRow {
  subscriptionId: string;
  endpointHost: string;
  status: 'sent' | 'failed' | 'gone';
  error?: string;
}

export interface AndroidAppTestNotificationResult {
  userId: string;
  androidSubscriptions: number;
  results: AndroidAppTestResultRow[];
  reason?: AndroidAppTestReason;
}

@Injectable()
export class AndroidAppPushService {
  private readonly logger = new Logger(AndroidAppPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushConfig: PushConfigService,
    private readonly pushTest: PushTestService,
  ) {}

  /**
   * Send the test notification to `targetUserId`'s Android app subscriptions
   * (the actor's own when absent). Answers 200 with a `reason` when nothing
   * could be sent; throws only for an unknown user (404) or a real database
   * error (500).
   */
  async sendTest(
    actorUserId: string,
    targetUserId?: string,
  ): Promise<AndroidAppTestNotificationResult> {
    const userId = targetUserId ?? actorUserId;

    if (targetUserId && targetUserId !== actorUserId) {
      const exists = await this.prisma.user.findUnique({
        where: { id: targetUserId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('User not found');
    }

    const [active, subscriptions] = await Promise.all([
      this.pushConfig.resolveActiveVapidConfig(),
      this.prisma.pushSubscription.findMany({
        where: { userId, platform: 'android_app' },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    let result: AndroidAppTestNotificationResult;

    if (!active) {
      result = {
        userId,
        androidSubscriptions: subscriptions.length,
        results: [],
        reason: 'PUSH_NOT_CONFIGURED',
      };
    } else if (subscriptions.length === 0) {
      result = { userId, androidSubscriptions: 0, results: [], reason: 'NO_ANDROID_SUBSCRIPTION' };
    } else {
      const payload = JSON.stringify({
        // `test: true` with a non-row id: the service worker shows it without
        // touching the notification centre (see `handleTestPush` in sw.ts).
        id: `android-app-test-${randomUUID()}`,
        eventKey: ANDROID_APP_TEST_EVENT_KEY,
        title: `${APP_NAME} test notification`,
        body: ANDROID_APP_TEST_BODY,
        link: ANDROID_APP_TEST_LINK,
        test: true,
      });

      const sent = await this.pushTest.sendToSubscriptions(active, subscriptions, payload);

      result = {
        userId,
        androidSubscriptions: subscriptions.length,
        results: subscriptions.map((subscription, index) =>
          toResultRow(subscription.id, subscription.endpoint, sent[index]),
        ),
      };
    }

    const counts = { sent: 0, failed: 0, gone: 0 };
    for (const row of result.results) counts[row.status]++;

    this.logger.log(
      `Android app test notification by ${actorUserId} to ${userId}: ` +
        `${result.reason ?? `${counts.sent} sent, ${counts.failed} failed, ${counts.gone} gone`}`,
    );

    await this.audit(actorUserId, userId, result, counts);

    return result;
  }

  /** Counts and hosts only; best effort, like the Web Push test's audit. */
  private async audit(
    actorUserId: string,
    userId: string,
    result: AndroidAppTestNotificationResult,
    counts: Record<AndroidAppTestResultRow['status'], number>,
  ): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId,
          action: ANDROID_APP_TEST_NOTIFICATION_ACTION,
          targetType: 'user',
          targetId: userId,
          meta: {
            androidSubscriptions: result.androidSubscriptions,
            counts,
            hosts: [...new Set(result.results.map((row) => row.endpointHost))],
            ...(result.reason ? { reason: result.reason } : {}),
          } as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Android app test notification: could not record the audit event: ${describeThrown(err)}`,
      );
    }
  }
}

/** Map the shared sender's outcome onto the contract's three statuses. */
export function toResultRow(
  subscriptionId: string,
  endpoint: string,
  sent: PushTestSendResult | undefined,
): AndroidAppTestResultRow {
  const host = endpointHost(endpoint);

  if (sent?.status === 'sent') return { subscriptionId, endpointHost: host, status: 'sent' };
  if (sent?.status === 'pruned') {
    return {
      subscriptionId,
      endpointHost: host,
      status: 'gone',
      error: 'The push service no longer knows this subscription; it was removed.',
    };
  }

  return {
    subscriptionId,
    endpointHost: host,
    status: 'failed',
    error: sent?.message ?? 'Not sent.',
  };
}
