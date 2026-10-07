import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Job } from '@prisma/client';
import { z } from 'zod';

import { AiConfigService } from '../../../ai/config/ai-config.service';
import { resolveServiceName } from '../../../common/otel/telemetry-identity';
import type { JobExecutionProfile } from '../../../jobs/job-execution-profile';
import type { JobHandler } from '../../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import { HOUSEKEEPING_PRIORITY } from '../../../jobs/housekeeping.enqueue';
import { JobsService } from '../../../jobs/jobs.service';
import { DEFAULT_NOTIFICATION_POLICY, type NotificationPolicy } from '../../../notifications/notification-policy';
import { PrismaService } from '../../../prisma/prisma.service';
import { SystemSettingsService } from '../../../settings/system-settings/system-settings.service';
import { COACH_SWEEP_JOB_TYPE } from '../../coach-job-types';
import { CoachPlannerService } from '../coach-planner.service';
import { CoachPlanningMetrics } from '../coach-planning.metrics';

// =============================================================================
// `coach.sweep`: the hourly coach planning pass (E7.4; spec §2.5, §3.4)
// =============================================================================
//
// Enqueued by `CoachSweepTask` (minute 17, only while AI and the coach are on)
// through `enqueueHousekeepingJob`: global, so the active-dedup index keeps
// one per hour at most. Server-only: it reads many tables mid-computation for
// every user (no `nodeResultSchema` / `persistNodeResult`). Profile 5 minutes,
// 2 attempts.
//
// One pass pages users whose `user_settings.value.coach.enabled` is true
// (active accounts only), keyset on user id, and runs
// `CoachPlannerService.planUser` for each. ONE USER'S FAILURE NEVER STOPS THE
// PASS: it is counted (`coach.sweep.user_error`) and logged with the user id
// only. A database error reading a page propagates, so the queue's retry
// applies.
//
// CHUNKED BY CURSOR. Input `{ cursor?: string }`. A pass that runs out of its
// time budget queues a continuation from the last user it finished, with
// `skipDedup` (the continuation is the same global type, and with dedup on it
// would collapse onto this running job).
// =============================================================================

export const COACH_SWEEP = {
  /** Users read per page. */
  pageSize: 200,
  /** Stop starting new users after this long and continue in a new job. */
  timeBudgetMs: 4 * 60_000,
} as const;

const payloadSchema = z.object({ cursor: z.uuid().optional() }).passthrough();

export interface CoachSweepSummary {
  enabled: boolean;
  users: number;
  queued: number;
  failed: number;
  continuedFrom: string | null;
}

interface SweepUserRow {
  userId: string;
  value: unknown;
  user: { healthProfile: { timeZone: string | null } | null };
}

@Injectable()
export class CoachSweepHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(CoachSweepHandler.name);

  readonly type = COACH_SWEEP_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: 5 * 60_000, maxAttempts: 2 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly aiConfig: AiConfigService,
    private readonly systemSettings: SystemSettingsService,
    private readonly planner: CoachPlannerService,
    private readonly metrics: CoachPlanningMetrics,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const parsed = payloadSchema.safeParse(job.payload ?? {});
    const cursor = parsed.success ? (parsed.data.cursor ?? null) : null;
    await this.sweep(job.id, cursor, new Date());
  }

  /** One pass from `cursor` (exclusive), as of `now`. `clock` is the elapsed-time source (tests). */
  async sweep(jobId: string, cursor: string | null, now: Date, clock: () => number = Date.now): Promise<CoachSweepSummary> {
    const tracer = trace.getTracer(resolveServiceName());
    return tracer.startActiveSpan('coach.sweep', async (span) => {
      try {
        const summary = await this.run(jobId, cursor, now, clock);
        span.setAttributes({ 'coach.sweep.users': summary.users, 'coach.sweep.queued': summary.queued, 'coach.sweep.failed': summary.failed });
        return summary;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async run(jobId: string, startCursor: string | null, now: Date, clock: () => number): Promise<CoachSweepSummary> {
    const summary: CoachSweepSummary = { enabled: false, users: 0, queued: 0, failed: 0, continuedFrom: null };

    const [aiEnabled, system] = await Promise.all([this.aiConfig.isEnabled(), this.systemSettings.getCoachPolicy()]);
    if (!aiEnabled || !system.enabled) {
      this.logger.log(`AI or the coach is disabled; coach sweep ${jobId} did nothing`);
      return summary;
    }
    summary.enabled = true;
    const notificationPolicy = await this.notificationPolicy();

    const started = clock();
    let cursor = startCursor;

    for (;;) {
      const rows: SweepUserRow[] = await this.prisma.userSettings.findMany({
        where: {
          value: { path: ['coach', 'enabled'], equals: true },
          user: { isActive: true },
          ...(cursor ? { userId: { gt: cursor } } : {}),
        },
        orderBy: { userId: 'asc' },
        take: COACH_SWEEP.pageSize,
        select: { userId: true, value: true, user: { select: { healthProfile: { select: { timeZone: true } } } } },
      });

      for (const row of rows) {
        if (clock() - started >= COACH_SWEEP.timeBudgetMs) {
          await this.continueFrom(cursor, jobId);
          summary.continuedFrom = cursor;
          this.finish(jobId, summary);
          return summary;
        }
        summary.users += 1;
        try {
          const outcome = await this.planner.planUser(row.userId, {
            now,
            trigger: 'sweep',
            timeZone: row.user.healthProfile?.timeZone ?? null,
            settingsValue: row.value,
            aiEnabled,
            system,
            notificationPolicy,
          });
          if (outcome.queued) summary.queued += 1;
        } catch (error) {
          summary.failed += 1;
          this.metrics.userError();
          this.logger.warn(
            `Coach sweep ${jobId} skipped user ${row.userId}: ${error instanceof Error ? error.name : 'error'}`,
          );
        }
        cursor = row.userId;
      }

      if (rows.length < COACH_SWEEP.pageSize) break;
    }

    this.finish(jobId, summary);
    return summary;
  }

  private finish(jobId: string, summary: CoachSweepSummary): void {
    this.metrics.usersPlanned(summary.users);
    this.logger.log(
      `Coach sweep ${jobId}: ${summary.users} user(s), ${summary.queued} moment(s) queued, ${summary.failed} failed` +
        (summary.continuedFrom !== null ? `; continues after cursor ${summary.continuedFrom}` : ''),
    );
  }

  /** Queues the next chunk (global, `skipDedup`: see the header). */
  private async continueFrom(cursor: string | null, jobId: string): Promise<void> {
    await this.jobs.enqueue({
      type: COACH_SWEEP_JOB_TYPE,
      reason: 'backfill',
      priority: HOUSEKEEPING_PRIORITY,
      payload: cursor ? { cursor } : {},
      skipDedup: true,
    });
    this.logger.log(`Coach sweep ${jobId} ran out of time; queued a continuation`);
  }

  /** The admin notification policy; the permissive default when it cannot be read. */
  private async notificationPolicy(): Promise<NotificationPolicy> {
    try {
      return await this.systemSettings.getNotificationsPolicy();
    } catch {
      return DEFAULT_NOTIFICATION_POLICY;
    }
  }
}
