import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { onboardingGoalSchema } from '../../common/schemas/user-settings-namespaces.schema';

// =============================================================================
// GET /api/onboarding — query and response (#203)
// =============================================================================

/**
 * `refresh` is `z.enum(['true','false']).transform(...)` and NOT
 * `z.coerce.boolean()`: every query parameter is a string and
 * `Boolean('false')` is `true` (same rule as the Doctor's query DTO in `@marinoscar/platform-api/doctor`).
 */
export const onboardingQuerySchema = z.object({
  /** `true` forwards `refresh` to the Doctor, bypassing its report cache. */
  refresh: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export class OnboardingQueryDto extends createZodDto(onboardingQuerySchema) {}

export const onboardingStepSchema = z.object({
  /** Stable step id: `health_profile`, `gym`, `storage`, ... */
  id: z.string(),
  /** Admin steps only: `required` or `features`. `null` on user steps. */
  group: z.enum(['required', 'features']).nullable(),
  status: z.enum(['done', 'todo']),
  label: z.string(),
  /** Admin steps: the first non-passing check's remedy (or detail). Otherwise null. */
  detail: z.string().nullable(),
  /** The web route where the step is completed. */
  href: z.string(),
});

export const onboardingUserBlockSchema = z.object({
  steps: z.array(onboardingStepSchema),
  completed: z.number().int(),
  total: z.number().int(),
});

export const onboardingAdminBlockSchema = z.object({
  steps: z.array(onboardingStepSchema),
  completed: z.number().int(),
  total: z.number().int(),
  /** Every `required` step is done. */
  requiredDone: z.boolean(),
});

export const onboardingResponseSchema = z.object({
  welcomeSeenAt: z.string().nullable(),
  checklistDismissedAt: z.string().nullable(),
  goal: onboardingGoalSchema.nullable(),
  user: onboardingUserBlockSchema,
  /** Present (non-null) only when the caller holds `system_settings:read`. */
  admin: onboardingAdminBlockSchema.nullable(),
});

export class OnboardingResponseDto extends createZodDto(onboardingResponseSchema) {}

export type OnboardingStep = z.infer<typeof onboardingStepSchema>;
export type OnboardingUserBlock = z.infer<typeof onboardingUserBlockSchema>;
export type OnboardingAdminBlock = z.infer<typeof onboardingAdminBlockSchema>;
export type OnboardingResponse = z.infer<typeof onboardingResponseSchema>;
