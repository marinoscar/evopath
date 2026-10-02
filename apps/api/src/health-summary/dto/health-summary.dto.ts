import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { FEATURE_RESOLUTION_STATES } from '../../ai/assignments/dto/ai-feature-resolution.dto';
import { HEALTH_SUMMARY_STATUSES } from '../health-summary.constants';
import { HEALTH_CONSIDERATION_SEVERITIES } from '../health-summary.prompt';

// =============================================================================
// /api/ai/training/health-summary (H8, #192)
// =============================================================================

export const healthConsiderationSchema = z.object({
  text: z.string(),
  severity: z.enum(HEALTH_CONSIDERATION_SEVERITIES),
  /** This consideration switches a training run to conservative mode. */
  conservative: z.boolean(),
});

export const healthSummaryViewSchema = z.object({
  /**
   * "Use my health data in training plans and coach chat" (off by default): training plans use the AI health
   * summary; the coach chat may read the summary and look up biomarker values.
   */
  enabled: z.boolean(),
  /** When the consent was last turned on (ISO), null when never. */
  consentedAt: z.string().nullable(),
  /** What turning it on shares, and the model provider that will process it. */
  sharing: z.object({
    shared: z.array(z.string()),
    neverShared: z.array(z.string()),
    /** The `health_summary` feature's resolution for the caller. */
    modelState: z.enum(FEATURE_RESOLUTION_STATES),
    /** The model that will write the summary, null when none can. */
    processor: z
      .object({ provider: z.string(), modelId: z.string(), displayName: z.string() })
      .nullable(),
  }),
  /** The newest ready summary, verbatim as the training agents and the coach chat receive it (only while `enabled`). */
  summary: z
    .object({
      version: z.number().int(),
      narrative: z.string(),
      trainingConsiderations: z.array(healthConsiderationSchema),
      /** `YYYY-MM-DD`: the newest health input the summary covered. */
      dataAsOf: z.string().nullable(),
      createdAt: z.string(),
      provider: z.string().nullable(),
      model: z.string().nullable(),
    })
    .nullable(),
  /** The newest generation attempt, ready or failed. */
  lastAttempt: z
    .object({
      version: z.number().int(),
      status: z.enum(HEALTH_SUMMARY_STATUSES),
      /** An AI error code, `HEALTH_SUMMARY_POST_CHECK_REJECTED` or `HEALTH_SUMMARY_GENERATION_FAILED`. */
      errorCode: z.string().nullable(),
      createdAt: z.string(),
    })
    .nullable(),
  /** There is health data to summarise. */
  hasData: z.boolean(),
  /** The health data changed since the newest ready summary (or there is none yet). */
  stale: z.boolean(),
  /** A summary job is queued or running. */
  pending: z.boolean(),
});

export type HealthSummaryViewData = z.infer<typeof healthSummaryViewSchema>;
export class HealthSummaryView extends createZodDto(healthSummaryViewSchema) {}

export const setHealthSummaryConsentSchema = z
  .object({
    /** Turn "Use my health data in training plans and coach chat" on or off. */
    enabled: z.boolean(),
  })
  .strict();

export class SetHealthSummaryConsentDto extends createZodDto(setHealthSummaryConsentSchema) {}
