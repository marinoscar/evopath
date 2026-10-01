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
//   2. Audio (E7.6): normally settled before this job is enqueued
//      (`coach.audio.settle`). A message somehow still `pending` is NOT
//      waited on: its audio is recorded `failed` (`reason = 'timeout'`) and
//      it goes out as text. `hasAudio` is true only for `ready` audio with
//      its object, so the push carries the "Hear Coach" action exactly then.
//      The message ALWAYS carries its text.
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
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Job } from '@prisma/client';
import { z } from 'zod';

import { AppMetricsService, fallbackAppMetrics } from '../../../common/otel/app-metrics.service';
import { resolveServiceName } from '../../../common/otel/service-name';
import type { JobExecutionProfile } from '../../../jobs/job-execution-profile';
import type { JobHandler } from '../../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import type { CoachNotificationData } from '../../../notifications/channels/browser-notification.channel';
import { NotificationsService } from '../../../notifications/notifications.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { CoachAudioService } from '../../audio/coach-audio.service';
import { COACH_MESSAGE_DELIVER_JOB_TYPE } from '../../coach-job-types';
import { CoachStateService } from '../../planning/coach-state.service';
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
    private readonly audio: CoachAudioService,
    @Optional() private readonly metrics: AppMetricsService = fallbackAppMetrics(),
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
        audioStorageObjectId: true,
        deliveredAt: true,
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

    let audioReady = message.audioStatus === 'ready' && Boolean(message.audioStorageObjectId);
    if (message.audioStatus === 'pending') {
      // Never wait here and never send audio-only: the text goes now.
      await this.audio.markFailed(message.id, 'timeout', null, now);
      audioReady = false;
    }

    const eventKey = eventForKind(message.kind);
    const data: CoachNotificationData = {
      messageId: message.id,
      pushTitle: message.pushTitle ?? message.title,
      pushBody: message.pushBody ?? '',
      // Ready audio adds the "Hear Coach" action (`/coach?m=<id>&autoplay=1`).
      hasAudio: audioReady,
    };

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
}
