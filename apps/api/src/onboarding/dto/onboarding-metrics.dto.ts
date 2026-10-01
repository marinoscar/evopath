import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/admin/onboarding/metrics — query and response (#212)
// =============================================================================

export const ONBOARDING_METRICS_DAYS_DEFAULT = 30;
export const ONBOARDING_METRICS_DAYS_MAX = 365;
/** A new user counts as activated with a completed workout this many days after sign-up. */
export const ACTIVATION_WINDOW_DAYS = 7;

export const onboardingMetricsQuerySchema = z.object({
  /** The cohort: users created in the last `days` days. */
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(ONBOARDING_METRICS_DAYS_MAX)
    .default(ONBOARDING_METRICS_DAYS_DEFAULT),
});

export class OnboardingMetricsQueryDto extends createZodDto(onboardingMetricsQuerySchema) {}

export const ONBOARDING_METRIC_STEP_IDS = [
  'health_profile',
  'gym',
  'first_workout',
  'ai_plan',
] as const;

export const onboardingMetricStepSchema = z.object({
  id: z.enum(ONBOARDING_METRIC_STEP_IDS),
  /** Cohort users with this step done now. */
  completed: z.number().int(),
  /** `completed / cohortSize`; `null` when the cohort is empty. */
  rate: z.number().nullable(),
});

export const onboardingMetricsResponseSchema = z.object({
  /** Echo of `days`. */
  windowDays: z.number().int(),
  /** Always 7. */
  activationWindowDays: z.number().int(),
  /** Users created in the last `windowDays` days. */
  cohortSize: z.number().int(),
  /** Cohort users created at least `activationWindowDays` days ago (their window has closed). */
  eligible: z.number().int(),
  /** Eligible users with a completed workout within `activationWindowDays` of sign-up. */
  activated: z.number().int(),
  /** `activated / eligible`; `null` when `eligible` is 0. */
  activationRate: z.number().nullable(),
  /** Median hours from sign-up to first completed workout, over cohort users with one; 1 decimal. */
  medianHoursToFirstWorkout: z.number().nullable(),
  steps: z.array(onboardingMetricStepSchema),
});

export class OnboardingMetricsResponseDto extends createZodDto(onboardingMetricsResponseSchema) {}

export type OnboardingMetricStep = z.infer<typeof onboardingMetricStepSchema>;
export type OnboardingMetricsResponse = z.infer<typeof onboardingMetricsResponseSchema>;
