import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type JobReason } from '@prisma/client';

import { AiFeatureModelResolver } from '../ai/assignments/ai-feature-model-resolver.service';
import { RUNNABLE_FEATURE_STATES } from '../ai/assignments/dto/ai-feature-resolution.dto';
import { fromDbDate } from '../check-ins/local-date';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildHealthDigest, digestHasData, digestHash } from './health-digest';
import {
  HEALTH_SUMMARY_CONSENT_AUDIT_ACTION,
  HEALTH_SUMMARY_CONSENT_AUDIT_TARGET,
  HEALTH_SUMMARY_DEBOUNCE_MS,
  HEALTH_SUMMARY_FEATURE_ID,
  HEALTH_SUMMARY_JOB_TYPE,
  HEALTH_SUMMARY_NEVER_SHARED,
  HEALTH_SUMMARY_REASONS,
  HEALTH_SUMMARY_SHARED,
  HEALTH_SUMMARY_SUBJECT_TYPE,
  type HealthSummaryStatus,
} from './health-summary.constants';
import { considerationsOf, HealthSummaryReader } from './health-summary.reader';
import type { HealthSummaryViewData } from './dto/health-summary.dto';

// =============================================================================
// HealthSummaryService: consent, regeneration and the owner's view (H8, #192)
// =============================================================================
//
// CONSENT. `setConsent` upserts the caller's `health_summary_settings` row
// and writes an audit row (`health_summary:consent`, `meta: { enabled }`).
// Turning it ON enqueues a summary at once. Turning it OFF deletes the
// caller's pending summary job; a job already running sees the consent off
// and stores nothing, and every later training run omits the summary
// (`HealthSummaryReader.forTraining`).
//
// REGENERATION IS ALWAYS A JOB (`ai.health.summary`), never inline.
// `requestRegeneration` (after a health write) enqueues one job scheduled
// `HEALTH_SUMMARY_DEBOUNCE_MS` ahead; every further write while it waits
// collapses onto it through the queue's active dedup key (subject =
// the user). `refresh` asks for one now (`force`), pulling a waiting
// debounced job forward. Nothing is enqueued while the consent is off.
//
// STALENESS. `view` rebuilds the digest and compares its hash with the
// newest ready summary's: different (or no summary while data exists) is
// `stale`, whether generation is off, AI is off or a job is still waiting.
// =============================================================================

@Injectable()
export class HealthSummaryService {
  private readonly logger = new Logger(HealthSummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly reader: HealthSummaryReader,
    private readonly features: AiFeatureModelResolver,
  ) {}

  /** The owner's view: consent, what is shared, the newest summary, the last attempt and staleness. */
  async view(userId: string): Promise<HealthSummaryViewData> {
    const [setting, latest, lastAttempt, source, pending, resolution] = await Promise.all([
      this.prisma.healthSummarySetting.findUnique({ where: { userId }, select: { enabled: true, consentedAt: true } }),
      this.reader.latestReady(userId),
      this.prisma.healthSummary.findFirst({
        where: { userId },
        orderBy: { version: 'desc' },
        select: { version: true, status: true, errorCode: true, createdAt: true },
      }),
      this.reader.digestSource(userId),
      this.prisma.job.count({
        where: { type: HEALTH_SUMMARY_JOB_TYPE, subjectType: HEALTH_SUMMARY_SUBJECT_TYPE, subjectId: userId, status: { in: ['pending', 'running'] } },
      }),
      this.features.resolve(userId, HEALTH_SUMMARY_FEATURE_ID),
    ]);

    const digest = buildHealthDigest(source);
    const hasData = digestHasData(digest);
    const runnable = RUNNABLE_FEATURE_STATES.includes(resolution.state) && resolution.model;

    return {
      enabled: setting?.enabled === true,
      consentedAt: setting?.consentedAt?.toISOString() ?? null,
      sharing: {
        shared: [...HEALTH_SUMMARY_SHARED],
        neverShared: [...HEALTH_SUMMARY_NEVER_SHARED],
        modelState: resolution.state,
        processor: runnable
          ? { provider: resolution.model!.provider, modelId: resolution.model!.modelId, displayName: resolution.model!.displayName }
          : null,
      },
      summary: latest?.narrative
        ? {
            version: latest.version,
            narrative: latest.narrative,
            trainingConsiderations: considerationsOf(latest.trainingConsiderations),
            dataAsOf: latest.dataAsOf ? fromDbDate(latest.dataAsOf) : null,
            createdAt: latest.createdAt.toISOString(),
            provider: latest.provider,
            model: latest.model,
          }
        : null,
      lastAttempt: lastAttempt
        ? {
            version: lastAttempt.version,
            status: lastAttempt.status as HealthSummaryStatus,
            errorCode: lastAttempt.errorCode,
            createdAt: lastAttempt.createdAt.toISOString(),
          }
        : null,
      hasData,
      stale: hasData && (!latest || latest.inputsHash !== digestHash(digest)),
      pending: pending > 0,
    };
  }

  /** Turns the consent on or off (audited); on enqueues a summary, off cancels the pending one. */
  async setConsent(userId: string, enabled: boolean): Promise<HealthSummaryViewData> {
    const previous = await this.prisma.healthSummarySetting.findUnique({ where: { userId }, select: { enabled: true } });
    const now = new Date();

    await this.prisma.healthSummarySetting.upsert({
      where: { userId },
      create: { userId, enabled, consentedAt: enabled ? now : null },
      update: enabled ? { enabled, ...(previous?.enabled ? {} : { consentedAt: now }) } : { enabled },
    });

    if ((previous?.enabled === true) !== enabled) await this.audit(userId, enabled);

    if (enabled) {
      await this.enqueue(userId, { reason: 'upload', scheduledFor: null, force: false });
    } else {
      await this.prisma.job.deleteMany({
        where: { type: HEALTH_SUMMARY_JOB_TYPE, subjectType: HEALTH_SUMMARY_SUBJECT_TYPE, subjectId: userId, status: 'pending' },
      });
    }

    return this.view(userId);
  }

  /** "Refresh summary": a forced regeneration now. 409 while the consent is off or without data. */
  async refresh(userId: string): Promise<HealthSummaryViewData> {
    if (!(await this.reader.consentOn(userId))) {
      throw new ConflictException({
        message: 'Turn on "Use my health data in training plans" first.',
        details: { reason: HEALTH_SUMMARY_REASONS.CONSENT_OFF },
      });
    }
    if (!digestHasData(buildHealthDigest(await this.reader.digestSource(userId)))) {
      throw new ConflictException({
        message: 'There is no health data to summarise yet.',
        details: { reason: HEALTH_SUMMARY_REASONS.NO_DATA },
      });
    }

    await this.enqueue(userId, { reason: 'rerun', scheduledFor: null, force: true });
    return this.view(userId);
  }

  /**
   * After a health write: one debounced regeneration, only while the consent
   * is on. Returns whether a job is queued for it (new or collapsed).
   */
  async requestRegeneration(userId: string): Promise<boolean> {
    if (!(await this.reader.consentOn(userId))) return false;
    await this.enqueue(userId, {
      reason: 'upload',
      scheduledFor: new Date(Date.now() + HEALTH_SUMMARY_DEBOUNCE_MS),
      force: false,
    });
    return true;
  }

  private async enqueue(
    userId: string,
    opts: { reason: JobReason; scheduledFor: Date | null; force: boolean },
  ): Promise<void> {
    const job = await this.jobs.enqueue({
      type: HEALTH_SUMMARY_JOB_TYPE,
      reason: opts.reason,
      subjectType: HEALTH_SUMMARY_SUBJECT_TYPE,
      subjectId: userId,
      payload: opts.force ? { force: true } : {},
      scheduledFor: opts.scheduledFor,
    });

    // A request for "now" that collapsed onto a waiting debounced job pulls
    // that job forward (and carries `force`), instead of waiting it out.
    if (opts.scheduledFor === null && job.status === 'pending' && job.scheduledFor && job.scheduledFor.getTime() > Date.now()) {
      await this.prisma.job.updateMany({
        where: { id: job.id, status: 'pending' },
        data: { scheduledFor: null, ...(opts.force ? { payload: { force: true } as Prisma.InputJsonValue } : {}) },
      });
    }
  }

  /** Best-effort: the change has committed, so an audit failure must not fail the request. */
  private async audit(userId: string, enabled: boolean): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: userId,
          action: HEALTH_SUMMARY_CONSENT_AUDIT_ACTION,
          targetType: HEALTH_SUMMARY_CONSENT_AUDIT_TARGET,
          targetId: userId,
          meta: { enabled } as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      this.logger.error(
        `Could not audit ${HEALTH_SUMMARY_CONSENT_AUDIT_ACTION} for user ${userId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
