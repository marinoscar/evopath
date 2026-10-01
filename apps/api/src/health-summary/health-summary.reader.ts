import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { CHECK_IN_METRIC_KEYS } from '../check-ins/dto/check-in.dto';
import { fromDbDate } from '../check-ins/local-date';
import { ACTIVE } from '../measurements/measurement-active';
import { LAB_METRIC_KEYS } from '../measurements/metric-registry';
import { PrismaService } from '../prisma/prisma.service';
import { BODY_KEYS, BP_KEYS, RESTING_HR_KEY, type DigestMeasurement, type HealthDigestSource } from './health-digest';
import { HEALTH_CONSIDERATION_SEVERITIES } from './health-summary.prompt';

// =============================================================================
// HealthSummaryReader: the reads behind the health summary (H8, #192)
// =============================================================================
//
// Every query is scoped by `userId` and SELECTS ONLY the columns the digest
// or the training agents use: never `notes`, `sourceRef`, `referenceText`, a
// document, a storage key or a file name. Bounded: each read takes at most a
// fixed number of rows, newest first.
//
// `forTraining` is the ONLY door through which health data reaches a
// training agent: the stored summary's narrative and considerations, and
// only while the user's consent is on and a `ready` summary exists. It never
// reads a measurement.
// =============================================================================

/** Row caps per read (newest first). */
export const DIGEST_READ_LIMITS = {
  labs: 2000,
  vitals: 600,
  body: 600,
  wellness: 600,
} as const;

/** What a training agent may receive: the stored summary text, nothing else. */
export interface TrainingHealthSummary {
  narrative: string;
  trainingConsiderations: Array<{ text: string; severity: 'info' | 'caution'; conservative: boolean }>;
  /** `YYYY-MM-DD`, the newest input the summary covered. */
  dataAsOf: string | null;
}

export const storedConsiderationsSchema = z.array(
  z.object({
    text: z.string().min(1).max(300),
    severity: z.enum(HEALTH_CONSIDERATION_SEVERITIES),
    conservative: z.boolean().default(false),
  }),
);

/** The stored considerations, or an empty list when the column does not parse. */
export function considerationsOf(value: unknown): TrainingHealthSummary['trainingConsiderations'] {
  const parsed = storedConsiderationsSchema.safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

type ReaderPrisma = Pick<PrismaService, 'healthSummarySetting' | 'healthSummary' | 'healthProfile' | 'measurement'>;

@Injectable()
export class HealthSummaryReader {
  constructor(private readonly prisma: PrismaService) {}

  private get db(): ReaderPrisma {
    return this.prisma;
  }

  /** Whether the user's "Use my health data in training plans" consent is on (no row = off). */
  async consentOn(userId: string): Promise<boolean> {
    const row = await this.db.healthSummarySetting.findUnique({ where: { userId }, select: { enabled: true } });
    return row?.enabled === true;
  }

  /** The newest `ready` summary, whatever the consent (for the owner's own view). */
  async latestReady(userId: string) {
    return this.db.healthSummary.findFirst({
      where: { userId, status: 'ready' },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        narrative: true,
        trainingConsiderations: true,
        dataAsOf: true,
        inputsHash: true,
        provider: true,
        model: true,
        createdAt: true,
      },
    });
  }

  /**
   * The summary a training agent may receive: present only when the consent
   * is on AND a `ready` summary with a narrative exists. Otherwise `null`, and
   * the run's context is exactly what it was before H8.
   */
  async forTraining(userId: string): Promise<TrainingHealthSummary | null> {
    if (!(await this.consentOn(userId))) return null;
    const row = await this.latestReady(userId);
    if (!row || !row.narrative) return null;
    return {
      narrative: row.narrative,
      trainingConsiderations: considerationsOf(row.trainingConsiderations),
      dataAsOf: row.dataAsOf ? fromDbDate(row.dataAsOf) : null,
    };
  }

  /** The digest's inputs: the profile's age and sex fields and the active rows of the digest's metrics. */
  async digestSource(userId: string): Promise<HealthDigestSource> {
    const select = {
      metricKey: true,
      value: true,
      measuredAt: true,
      localDate: true,
      flag: true,
      referenceLow: true,
      referenceHigh: true,
    } as const;
    const read = (metricKeys: readonly string[], take: number) =>
      this.db.measurement.findMany({
        where: { userId, ...ACTIVE, metricKey: { in: [...metricKeys] } },
        orderBy: [{ measuredAt: 'desc' }, { id: 'desc' }],
        take,
        select,
      });

    const [profile, labs, vitals, body, wellness] = await Promise.all([
      this.db.healthProfile.findUnique({ where: { userId }, select: { dateOfBirth: true, sexAtBirth: true } }),
      read(LAB_METRIC_KEYS, DIGEST_READ_LIMITS.labs),
      read([BP_KEYS.systolic, BP_KEYS.diastolic, RESTING_HR_KEY], DIGEST_READ_LIMITS.vitals),
      read([BODY_KEYS.weight, BODY_KEYS.bodyFat, BODY_KEYS.waist], DIGEST_READ_LIMITS.body),
      read(CHECK_IN_METRIC_KEYS, DIGEST_READ_LIMITS.wellness),
    ]);

    const measurements: DigestMeasurement[] = [...labs, ...vitals, ...body, ...wellness].map((row) => ({
      metricKey: row.metricKey,
      value: row.value,
      measuredAt: row.measuredAt,
      localDate: row.localDate ? fromDbDate(row.localDate) : null,
      flag: row.flag ?? null,
      referenceLow: row.referenceLow ?? null,
      referenceHigh: row.referenceHigh ?? null,
    }));

    return {
      profile: profile
        ? { dateOfBirth: profile.dateOfBirth ? fromDbDate(profile.dateOfBirth) : null, sexAtBirth: profile.sexAtBirth }
        : null,
      measurements,
    };
  }
}
