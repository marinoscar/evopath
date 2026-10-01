import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { isRealDate } from '../../check-ins/local-date';
import {
  ACTIVITY_KINDS,
  ACTIVITY_SOURCES,
  GOAL_ACTIVITY_KINDS,
  GOAL_CUSTOM_LABEL_MAX,
  GOAL_HISTORY_LIMIT_DEFAULT,
  GOAL_HISTORY_LIMIT_MAX,
  GOAL_METRICS,
  GOAL_PERIODS,
  GOAL_STATUSES,
  GOAL_TARGET_MAX,
  GOAL_TARGET_MIN,
  GOAL_TITLE_MAX,
} from '../activity.constants';

// =============================================================================
// /api/goals — schemas (#266, #268)
// =============================================================================
//
// The cross-field rules (`sessions` needs `period: week`, a `custom` goal
// needs a `customLabel`) are checked on the MERGED goal in the service, so a
// PATCH that changes one side alone is judged against the stored other side.
// =============================================================================

export const localDate = z.iso
  .date()
  .refine(isRealDate, { message: 'Must be a real calendar date in YYYY-MM-DD format' })
  .meta({ description: 'A local calendar day, `YYYY-MM-DD`.' });

const title = z
  .string()
  .trim()
  .min(1, 'Title is required')
  .max(GOAL_TITLE_MAX, `At most ${GOAL_TITLE_MAX} characters`);

/** Blank means "none". */
const customLabel = z
  .string()
  .trim()
  .max(GOAL_CUSTOM_LABEL_MAX, `At most ${GOAL_CUSTOM_LABEL_MAX} characters`)
  .transform((value) => (value === '' ? null : value));

const goalKind = z.enum(GOAL_ACTIVITY_KINDS, {
  error: '`steps` is tracked through a metric, not a kind: use metric `steps` with kind `walk`',
});
const target = z.number().int().min(GOAL_TARGET_MIN).max(GOAL_TARGET_MAX);

export const createGoalSchema = z
  .object({
    title,
    activityKind: goalKind,
    customLabel: customLabel.nullable().optional().meta({ description: 'Required when `activityKind` is `custom`.' }),
    metric: z.enum(GOAL_METRICS),
    target: target.meta({ description: 'Sessions, minutes, steps or meters per period, 1..1,000,000.' }),
    period: z.enum(GOAL_PERIODS),
    startsOn: localDate.optional().meta({ description: 'Defaults to today (local). At most a year either side of today.' }),
  })
  .strict();
export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export class CreateGoalDto extends createZodDto(createGoalSchema) {}

export const updateGoalSchema = z
  .object({
    title: title.optional(),
    activityKind: goalKind.optional(),
    customLabel: customLabel.nullable().optional(),
    metric: z.enum(GOAL_METRICS).optional(),
    target: target.optional(),
    period: z.enum(GOAL_PERIODS).optional(),
    startsOn: localDate.optional(),
  })
  .strict();
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;
export class UpdateGoalDto extends createZodDto(updateGoalSchema) {}

export const listGoalsQuerySchema = z.object({
  status: z.enum(GOAL_STATUSES).optional().meta({ description: 'Defaults to `active`.' }),
});
export class ListGoalsQueryDto extends createZodDto(listGoalsQuerySchema) {}

export const goalProgressQuerySchema = z.object({
  date: localDate.optional().meta({ description: 'The local day to evaluate; defaults to today (local).' }),
});
export class GoalProgressQueryDto extends createZodDto(goalProgressQuerySchema) {}

export const goalHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(GOAL_HISTORY_LIMIT_MAX).default(GOAL_HISTORY_LIMIT_DEFAULT),
  date: localDate.optional().meta({ description: 'The newest period holds this day; defaults to today (local).' }),
});
export class GoalHistoryQueryDto extends createZodDto(goalHistoryQuerySchema) {}

// -----------------------------------------------------------------------------
// Views
// -----------------------------------------------------------------------------

export const goalViewSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  activityKind: z.enum(GOAL_ACTIVITY_KINDS),
  customLabel: z.string().nullable(),
  metric: z.enum(GOAL_METRICS),
  target: z.number().int(),
  period: z.enum(GOAL_PERIODS),
  status: z.enum(GOAL_STATUSES),
  startsOn: z.string().meta({ description: '`YYYY-MM-DD`.' }),
  version: z.number().int().meta({ description: 'Send back as `If-Match` on PATCH.' }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GoalViewData = z.infer<typeof goalViewSchema>;
export class GoalView extends createZodDto(goalViewSchema) {}

export const goalTemplateViewSchema = z.object({
  key: z.string(),
  title: z.string(),
  activityKind: z.enum(GOAL_ACTIVITY_KINDS),
  metric: z.enum(GOAL_METRICS),
  target: z.number().int(),
  period: z.enum(GOAL_PERIODS),
});
export class GoalTemplateView extends createZodDto(goalTemplateViewSchema) {}

export const activityEntryViewSchema = z.object({
  id: z.uuid(),
  occurredOn: z.string().meta({ description: 'Local day, `YYYY-MM-DD`.' }),
  occurredAt: z.string().nullable(),
  activityKind: z.enum(ACTIVITY_KINDS),
  completed: z.boolean(),
  durationSeconds: z.number().int().nullable(),
  steps: z.number().int().nullable(),
  distanceMeters: z.number().nullable(),
  source: z.enum(ACTIVITY_SOURCES),
  workoutId: z.uuid().nullable(),
  provider: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ActivityEntryViewData = z.infer<typeof activityEntryViewSchema>;
export class ActivityEntryView extends createZodDto(activityEntryViewSchema) {}

export const goalProgressViewSchema = z.object({
  goalId: z.uuid(),
  goal: goalViewSchema,
  periodStart: z.string(),
  periodEnd: z.string(),
  done: z.number().meta({ description: 'Sessions, whole minutes, steps or whole meters.' }),
  target: z.number().int(),
  remaining: z.number(),
  daysLeft: z.number().int().meta({ description: 'Days left in the period, today included.' }),
  onTrack: z.boolean(),
  hit: z.boolean(),
  streakPeriods: z.number().int().meta({ description: 'Consecutive hit periods right before this one.' }),
  entries: z.array(
    activityEntryViewSchema.extend({
      superseded: z.boolean().meta({ description: 'A higher-precedence source counted that day instead.' }),
    }),
  ),
});
export type GoalProgressViewData = z.infer<typeof goalProgressViewSchema>;
export class GoalProgressView extends createZodDto(goalProgressViewSchema) {}

export const goalHistoryPeriodViewSchema = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  done: z.number(),
  target: z.number().int(),
  hit: z.boolean(),
});
export type GoalHistoryPeriodData = z.infer<typeof goalHistoryPeriodViewSchema>;
export class GoalHistoryPeriodView extends createZodDto(goalHistoryPeriodViewSchema) {}
