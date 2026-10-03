// =============================================================================
// `coach.message.deliver`: send one persisted coach message (E7.5, #245)
// =============================================================================
//
// docs/specs/ai-coach.md §2.7. Enqueued by `ai.coach.nudge` right after the
// `CoachMessage` row is written (and by `coach.audio.settle` only for a
// message left `pending` by the pre-#259 automatic audio path). Payload `{ messageId }`, subject (`coach_message`, messageId), so
// two enqueues for one message collapse onto one pending job.
//
// SERVER-ONLY: it sends a notification and writes rows as it goes (spec
// §3.4). PROFILE `{ maxRuntimeMs: 3 min, maxAttempts: 3 }`: a weekly review
// also sends an email, and a slow SMTP server must not let the lease lapse
// mid-send (the claim below makes a lapse safe, the budget makes it rare).
//
// STEPS
//   1. Load the message. Gone, not a coach message, ALREADY DELIVERED or
//      already SUPPRESSED (`data.suppressed`) -> nothing.
//   2. RE-CHECK the state that may have changed since `ai.coach.nudge` (or
//      `ai.coach.weekly_review`) wrote the row: AI on, the system coach on, the account active, the
//      user's `coach.enabled`, and not paused (`pausedUntil` in the future).
//      Any of the first four -> `coach_off`; a pause -> `paused`. Then NO
//      notification: `data.suppressed = { reason, at }` is written (guarded on
//      `deliveredAt: null`), `deliveredAt` stays null, step 1 skips the row
//      for good, and `app.coach.nudge.suppressed{reason, moment}` counts it.
//      The row stays on the `/coach` timeline. A weekly review obeys the
//      pause too (spec §2.10). A `kickoff` does NOT re-check the pause: the
//      nudge job's `kickoffGate` already deferred it past any pause it saw,
//      and a kickoff is never dropped (spec §2.5, E7.12).
//   3. Audio is ON DEMAND (#259): delivery never waits for it and never
//      touches `audioStatus` (a `pending` one belongs to a Listen request in
//      flight). `hasAudio` means "audio can be heard": the user's
//      `audio.enabled` AND the system `allowAudio`. It adds the "Hear Coach"
//      action (`/coach?m=<id>&autoplay=1`), whose click opens the message and
//      requests its audio. The message ALWAYS carries its text.
//   4. CLAIM, then send. `deliveredAt` is stamped FIRST with a guarded update
//      (`deliveredAt: null`); a count of 0 means another run claimed it ->
//      skip. Only the claimant calls `notifyNow('coach.<kind>')`, awaited,
//      OUTSIDE any `$transaction` (the row committed in an earlier job). So a
//      retry, a concurrent run or a run after a lapsed lease never sends a
//      second push or email. `notifyNow` never rejects by contract; should it
//      throw anyway (nothing confirmed sent), the claim is released (guarded
//      on the same timestamp) and the error rethrown, so the queue retries.
//      A process killed between the claim and the send loses that one
//      message: at most once, never twice.
//   5. Store the inbox `notificationId`, then count the nudge against the
//      daily cap and the spacing gate (`CoachStateService.recordNudgeSent`).
//
// ⚠ PRIVACY: logs carry ids and the event key only, never the text.
// =============================================================================

import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Job, Prisma } from '@prisma/client';
import { z } from 'zod';

import { AiConfigService } from '../../../ai/config/ai-config.service';
import {
  AppMetricsService,
  fallbackAppMetrics,
  type CoachNudgeSuppressionReason,
} from '../../../common/otel/app-metrics.service';
import type { CoachWeeklyReviewEmailData } from '../../../email/templates/coach-weekly-review.email';
import { resolveServiceName } from '../../../common/otel/service-name';
import type { JobExecutionProfile } from '../../../jobs/job-execution-profile';
import type { JobHandler } from '../../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import type { CoachNotificationData } from '../../../notifications/channels/browser-notification.channel';
import { NotificationsService } from '../../../notifications/notifications.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { SystemSettingsService } from '../../../settings/system-settings/system-settings.service';
import { COACH_MESSAGE_DELIVER_JOB_TYPE } from '../../coach-job-types';
import { findCoachPersona } from '../../personas';
import { coachUserSettingsOf } from '../../planning/coach-planner.service';
import { CoachStateService } from '../../planning/coach-state.service';
import { weeklyReviewMessageDataSchema } from '../../review/weekly-review-data';
import { stripMarkdown } from '../../text/strip-markdown';
import { eventForKind } from '../coach-message-kinds';

const payloadSchema = z.object({ messageId: z.uuid() }).passthrough();

/** Why a message was not sent at delivery time (a subset of the nudge suppression reasons). */
export type CoachDeliverSuppressionReason = Extract<CoachNudgeSuppressionReason, 'coach_off' | 'paused'>;

export type CoachDeliverOutcome =
  | { status: 'delivered'; eventKey: string; notificationId: string | null }
  | { status: 'suppressed'; reason: CoachDeliverSuppressionReason }
  | { status: 'skipped'; reason: 'not_found' | 'already_delivered' | 'suppressed' };

/** The delivery job's budget: room for a slow SMTP send of a weekly review. */
export const COACH_DELIVER_MAX_RUNTIME_MS = 180_000;

@Injectable()
export class CoachMessageDeliverHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(CoachMessageDeliverHandler.name);

  readonly type = COACH_MESSAGE_DELIVER_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: COACH_DELIVER_MAX_RUNTIME_MS, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly coachState: CoachStateService,
    private readonly aiConfig: AiConfigService,
    private readonly systemSettings: SystemSettingsService,
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
        span.setAttribute('coach.deliver.outcome', outcome.status === 'delivered' ? outcome.status : `${outcome.status}:${outcome.reason}`);
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
    if (isRecord(message.data) && message.data.suppressed) {
      this.logger.debug(`Coach message ${messageId} was suppressed at delivery; skipping`);
      return { status: 'skipped', reason: 'suppressed' };
    }

    const gate = await this.deliveryGate(message.userId, message.kind, now);
    if ('suppress' in gate) return this.suppress(message, gate.suppress, now);

    const eventKey = eventForKind(message.kind);
    const push: CoachNotificationData = {
      messageId: message.id,
      // A notification is plain text: no markdown reaches the OS or the inbox row (#343).
      pushTitle: stripMarkdown(message.pushTitle ?? message.title),
      pushBody: stripMarkdown(message.pushBody ?? ''),
      // Audio available on demand adds the "Hear Coach" action (`/coach?m=<id>&autoplay=1`).
      hasAudio: gate.audioAvailable,
    };
    // A weekly review also carries what its email renders (E7.10): the stats
    // block and the CLEAN-register prose. The browser and push templates read
    // only the lock-screen-safe fields above, so none of it reaches a lock screen.
    const data: CoachNotificationData & Partial<CoachWeeklyReviewEmailData> =
      message.kind === 'weekly_review' ? { ...push, ...this.weeklyReviewEmailData(message) } : push;

    // Claim BEFORE sending: only the run whose guarded stamp lands sends.
    const claimed = await this.prisma.coachMessage.updateMany({
      where: { id: message.id, deliveredAt: null },
      data: { deliveredAt: now },
    });
    if (claimed.count === 0) {
      // A concurrent (or earlier, lease-lapsed) delivery claimed it; it sends and counts.
      this.logger.debug(`Coach message ${message.id} claimed by another delivery; skipping`);
      return { status: 'skipped', reason: 'already_delivered' };
    }

    // Awaited, never rejects by contract, and NOT inside a transaction: the
    // message row was committed by the job that enqueued this one.
    let result: Awaited<ReturnType<NotificationsService['notifyNow']>>;
    try {
      result = await this.notifications.notifyNow(eventKey, message.userId, data);
    } catch (error) {
      // Nothing confirmed sent: release the claim (only our own) so the queue's retry can send.
      await this.prisma.coachMessage.updateMany({
        where: { id: message.id, deliveredAt: now },
        data: { deliveredAt: null },
      });
      this.logger.warn(`Coach message ${message.id}: notifyNow threw; claim released for a retry`);
      throw error;
    }
    const notificationId = result.notificationId ?? null;
    if (notificationId) {
      await this.prisma.coachMessage.updateMany({ where: { id: message.id }, data: { notificationId } });
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
   * The state re-checked at send time (step 2): why the message may not go
   * out, or whether its audio can be heard on demand (step 3). Reads only
   * flags and ids.
   */
  private async deliveryGate(
    userId: string,
    kind: string,
    now: Date,
  ): Promise<{ suppress: CoachDeliverSuppressionReason } | { audioAvailable: boolean }> {
    const [aiEnabled, system] = await Promise.all([this.aiConfig.isEnabled(), this.systemSettings.getCoachPolicy()]);
    if (!aiEnabled || !system.enabled) return { suppress: 'coach_off' };

    const [row, state] = await Promise.all([
      this.prisma.userSettings.findUnique({
        where: { userId },
        select: { value: true, user: { select: { isActive: true } } },
      }),
      this.prisma.coachState.findUnique({ where: { userId }, select: { pausedUntil: true } }),
    ]);
    const settings = row ? coachUserSettingsOf(row.value) : null;
    if (!row || !settings || !row.user.isActive || !settings.enabled) return { suppress: 'coach_off' };

    // A kickoff was already deferred past any pause by the nudge job's `kickoffGate`; it is never dropped.
    if (kind !== 'kickoff' && state?.pausedUntil && state.pausedUntil.getTime() > now.getTime()) return { suppress: 'paused' };
    return { audioAvailable: Boolean(system.allowAudio) && settings.audio.enabled };
  }

  /**
   * Records a delivery-time suppression on the row (`data.suppressed`), so no
   * later run sends it, and counts it. Guarded on `deliveredAt: null`: a
   * message another run already sent is left alone.
   */
  private async suppress(
    message: { id: string; userId: string; moment: string | null; data: unknown },
    reason: CoachDeliverSuppressionReason,
    now: Date,
  ): Promise<CoachDeliverOutcome> {
    const data = { ...(isRecord(message.data) ? message.data : {}), suppressed: { reason, at: now.toISOString() } };
    const marked = await this.prisma.coachMessage.updateMany({
      where: { id: message.id, deliveredAt: null },
      data: { data: data as Prisma.InputJsonValue },
    });
    if (marked.count === 0) return { status: 'skipped', reason: 'already_delivered' };
    this.metrics.coachNudgeSuppression(reason, message.moment);
    this.logger.log(`Coach message ${message.id} for user ${message.userId} not sent: suppressed (${reason})`);
    return { status: 'suppressed', reason };
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
      // The email renders plain prose (its subject is the headline): markdown stripped (#343).
      prose: {
        headline: stripMarkdown(emailProse.headline),
        intro: stripMarkdown(emailProse.intro),
        wins: emailProse.wins.map((win) => stripMarkdown(win)),
        focus: stripMarkdown(emailProse.focus),
      },
      ...(appUrl ? { appUrl: appUrl.replace(/\/+$/, '') } : {}),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
