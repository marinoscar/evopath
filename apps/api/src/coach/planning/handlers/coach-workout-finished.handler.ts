import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';
import { z } from 'zod';

import { AiConfigService } from '../../../ai/config/ai-config.service';
import type { JobExecutionProfile } from '../../../jobs/job-execution-profile';
import type { JobHandler } from '../../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import { DEFAULT_NOTIFICATION_POLICY, type NotificationPolicy } from '../../../notifications/notification-policy';
import { PrismaService } from '../../../prisma/prisma.service';
import { SystemSettingsService } from '../../../settings/system-settings/system-settings.service';
import { COACH_WORKOUT_FINISHED_JOB_TYPE } from '../../coach-job-types';
import { type CoachPlanOutcome, CoachPlannerService } from '../coach-planner.service';

// =============================================================================
// `coach.workout_finished`: plan right after a finished workout (E7.4)
// =============================================================================
//
// Enqueued by `CoachEventsListener` on `workout.finished` (subject = the user,
// so a burst of finished workouts collapses onto one pending job). Plans only
// the event moments (`comeback`, `pr`, `weekly_target_hit`) through the same
// gates as the sweep; logging the workout also clears `silencedAt` and the
// ignored run (the planner's re-engagement rule). Server-only, profile 1
// minute, 2 attempts. A coach that is off for the user does nothing.
// =============================================================================

const payloadSchema = z.object({ userId: z.uuid(), workoutId: z.uuid() });

export type CoachWorkoutFinishedPayload = z.infer<typeof payloadSchema>;

@Injectable()
export class CoachWorkoutFinishedHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(CoachWorkoutFinishedHandler.name);

  readonly type = COACH_WORKOUT_FINISHED_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: 60_000, maxAttempts: 2 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfigService,
    private readonly systemSettings: SystemSettingsService,
    private readonly planner: CoachPlannerService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      this.logger.warn(`Coach workout job ${job.id} carries no valid payload; nothing to plan`);
      return;
    }
    await this.plan(parsed.data, new Date());
  }

  /** Plans the event moments for one finished workout; null when the coach is off. */
  async plan(payload: CoachWorkoutFinishedPayload, now: Date): Promise<CoachPlanOutcome | null> {
    const [aiEnabled, system] = await Promise.all([this.aiConfig.isEnabled(), this.systemSettings.getCoachPolicy()]);
    if (!aiEnabled || !system.enabled) return null;

    const row = await this.prisma.userSettings.findUnique({
      where: { userId: payload.userId },
      select: { value: true, user: { select: { isActive: true, healthProfile: { select: { timeZone: true } } } } },
    });
    if (!row || !row.user.isActive || !coachEnabledIn(row.value)) return null;

    return this.planner.planUser(payload.userId, {
      now,
      trigger: 'workout_finished',
      workoutId: payload.workoutId,
      timeZone: row.user.healthProfile?.timeZone ?? null,
      settingsValue: row.value,
      aiEnabled,
      system,
      notificationPolicy: await this.notificationPolicy(),
    });
  }

  private async notificationPolicy(): Promise<NotificationPolicy> {
    try {
      return await this.systemSettings.getNotificationsPolicy();
    } catch {
      return DEFAULT_NOTIFICATION_POLICY;
    }
  }
}

function coachEnabledIn(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const coach = (value as Record<string, unknown>).coach;
  return typeof coach === 'object' && coach !== null && (coach as Record<string, unknown>).enabled === true;
}
