// =============================================================================
// `coach.message.deliver`: send one persisted coach message (E7.5, #245)
// =============================================================================
//
// docs/specs/ai-coach.md §2.7. Enqueued by `ai.coach.nudge` right after the
// `CoachMessage` row is written (and, from E7.6, when a message's speech job
// settles). Payload `{ messageId }`, subject (`coach_message`, messageId), so
// two enqueues for one message collapse onto one pending job.
//
// SERVER-ONLY: it sends a notification and writes rows as it goes (spec
// §3.4). PROFILE `{ maxRuntimeMs: 1 min, maxAttempts: 3 }`.
//
// STEPS
//   1. Load the message. Gone, not a coach message, or ALREADY DELIVERED ->
//      nothing (a retry after a successful send never sends twice).
//   2. Audio (E7.6 seam): a message still `pending` audio is not this
//      story's to wait on; it is delivered as text. E7.6 adds the wait cap and
//      the `ready`/`failed` branches, and sets `hasAudio` on the payload so
//      the push carries the "Hear Coach" action.
//   3. `notifyNow('coach.<kind>')`, awaited, OUTSIDE any `$transaction` (the
//      message row committed in an earlier job). It never rejects; a channel
//      failure is recorded by the dispatcher's own containment.
//   4. Stamp `deliveredAt` (and the inbox `notificationId`) with a guarded
//      update (`deliveredAt: null`), then count the nudge against the daily
//      cap and the spacing gate (`CoachStateService.recordNudgeSent`).
//
// ⚠ PRIVACY: logs carry ids and the event key only, never the text.
// =============================================================================

import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Job } from '@prisma/client';
import { z } from 'zod';

import { AppMetricsService, fallbackAppMetrics } from '../../../common/otel/app-metrics.service';
import type { CoachWeeklyReviewEmailData } from '../../../email/templates/coach-weekly-review.email';
import { resolveServiceName } from '../../../common/otel/service-name';
import type { JobExecutionProfile } from '../../../jobs/job-execution-profile';
import type { JobHandler } from '../../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import type { CoachNotificationData } from '../../../notifications/channels/browser-notification.channel';
import { NotificationsService } from '../../../notifications/notifications.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { COACH_MESSAGE_DELIVER_JOB_TYPE } from '../../coach-job-types';
import { findCoachPersona } from '../../personas';
import { CoachStateService } from '../../planning/coach-state.service';
import { weeklyReviewMessageDataSchema } from '../../review/weekly-review-data';
import { eventForKind } from '../coach-message-kinds';

const payloadSchema = z.object({ messageId: z.uuid() }).passthrough();

export type CoachDeliverOutcome =
  | { status: 'delivered'; eventKey: string; notificationId: string | null }
  | { status: 'skipped'; reason: 'not_found' | 'already_delivered' };

@Injectable()
export class CoachMessageDeliverHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(CoachMessageDeliverHandler.name);

  readonly type = COACH_MESSAGE_DELIVER_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: 60_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly coachState: CoachStateService,
    @Optional() private readonly metrics: AppMetricsService = fallbackAppMetrics(),
    @Optional() private readonly config?: ConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const parsed = payloadSchema.safeParse(job.payload ?? {});
    if (!parsed.success) {
      this.logger.warn(`Coach delivery job ${job.id} carries no valid payload; nothing to deliver`);
      return;
    }
    await this.deliver(parsed.data.messageId, new Date());
  }

  async deliver(messageId: string, now: Date): Promise<CoachDeliverOutcome> {
    const tracer = trace.getTracer(resolveServiceName());
    return tracer.startActiveSpan('coach.message.deliver', async (span) => {
      try {
        const outcome = await this.deliverInner(messageId, now);
        span.setAttribute('coach.deliver.outcome', outcome.status === 'skipped' ? `skipped:${outcome.reason}` : outcome.status);
        if (outcome.status === 'delivered') span.setAttribute('coach.event', outcome.eventKey);
        return outcome;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async deliverInner(messageId: string, now: Date): Promise<CoachDeliverOutcome> {
    const message = await this.prisma.coachMessage.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        userId: true,
        role: true,
        kind: true,
        moment: true,
        title: true,
        pushTitle: true,
        pushBody: true,
        audioStatus: true,
        deliveredAt: true,
        personaId: true,
        data: true,
        user: { select: { healthProfile: { select: { timeZone: true } } } },
      },
    });

    if (!message || message.role !== 'coach') {
      this.logger.warn(`Coach message ${messageId} not found; nothing to deliver`);
      return { status: 'skipped', reason: 'not_found' };
    }
    if (message.deliveredAt) {
      this.logger.debug(`Coach message ${messageId} already delivered; skipping`);
      return { status: 'skipped', reason: 'already_delivered' };
    }

    const eventKey = eventForKind(message.kind);
    const push: CoachNotificationData = {
      messageId: message.id,
      pushTitle: message.pushTitle ?? message.title,
      pushBody: message.pushBody ?? '',
      // E7.6 sets this once the message's audio is `ready` (adds "Hear Coach").
      hasAudio: message.audioStatus === 'ready',
    };
    // A weekly review also carries what its email renders (E7.10): the stats
    // block and the CLEAN-register prose. The browser and push templates read
    // only the lock-screen-safe fields above, so none of it reaches a lock screen.
    const data: CoachNotificationData & Partial<CoachWeeklyReviewEmailData> =
      message.kind === 'weekly_review' ? { ...push, ...this.weeklyReviewEmailData(message) } : push;

    // Awaited, never rejects, and NOT inside a transaction: the message row
    // was committed by the job that enqueued this one.
    const result = await this.notifications.notifyNow(eventKey, message.userId, data);
    const notificationId = result.notificationId ?? null;

    const stamped = await this.prisma.coachMessage.updateMany({
      where: { id: message.id, deliveredAt: null },
      data: { deliveredAt: now, ...(notificationId ? { notificationId } : {}) },
    });
    if (stamped.count === 0) {
      // A concurrent delivery stamped it first; it also counted the nudge.
      return { status: 'skipped', reason: 'already_delivered' };
    }

    // Weekly reviews sit outside the daily cap (spec §2.5).
    if (message.kind !== 'weekly_review') {
      await this.coachState.recordNudgeSent(message.userId, now, message.user?.healthProfile?.timeZone ?? null);
    }

    this.metrics.coachNudgeDelivered(message.moment);
    this.logger.log(`Coach message ${message.id} delivered as ${eventKey} (inbox ${notificationId ?? 'none'})`);
    return { status: 'delivered', eventKey, notificationId };
  }

  /**
   * The email half of a weekly review's notification data. A stored `data`
   * that does not parse yields no review fields: the email template then
   * refuses to render and the email channel records the failed delivery,
   * while the in-app card and the push still go out.
   */
  private weeklyReviewEmailData(message: {
    id: string;
    personaId: string | null;
    data: unknown;
  }): Partial<CoachWeeklyReviewEmailData> {
    const parsed = weeklyReviewMessageDataSchema.safeParse(message.data);
    if (!parsed.success) {
      this.logger.warn(`Coach message ${message.id}: weekly review data does not parse; the email cannot render`);
      return {};
    }
    const { stats, emailProse } = parsed.data;
    const appUrl = this.config?.get<string>('appUrl');
    return {
      messageId: message.id,
      personaName: findCoachPersona(message.personaId ?? '')?.name ?? 'Coach',
      stats,
      prose: { headline: emailProse.headline, intro: emailProse.intro, wins: emailProse.wins, focus: emailProse.focus },
      ...(appUrl ? { appUrl: appUrl.replace(/\/+$/, '') } : {}),
    };
  }
}
