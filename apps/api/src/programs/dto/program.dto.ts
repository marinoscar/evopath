import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { isRealDate } from '../../check-ins/local-date';
import { optionalText, requiredName } from '../../gyms/dto/fields';
import { LOAD_GUIDANCE, PLAN_LIMITS, planTreeSchema } from '../contracts/plan-tree.contract';
import {
  AUTONOMY_PAUSE_REASONS,
  CHANGE_ACTORS,
  CHANGE_KINDS,
  CHANGE_LOG_PAGE_SIZE_DEFAULT,
  CHANGE_LOG_PAGE_SIZE_MAX,
  CHANGE_STATUSES,
  PROGRAM_AUTONOMY,
  PROGRAM_GOALS,
  PROGRAM_NOTES_MAX,
  PROGRAM_SOURCES,
  PROGRAM_STATUSES,
  VERSION_ORIGINS,
} from '../programs.constants';

// =============================================================================
// /api/programs: request and response schemas (E5.1)
// =============================================================================
//
// Weights are kilograms (`targetLoadKg`), always; clients convert for display.
// Decimals leave the API as JSON numbers.
// =============================================================================

const localDate = z.iso
  .date()
  .refine(isRealDate, { message: 'Must be a real calendar date in YYYY-MM-DD format' })
  .meta({ description: 'A calendar day, `YYYY-MM-DD`.' });

const jsonObject = z.record(z.string(), z.unknown());

// -----------------------------------------------------------------------------
// Requests
// -----------------------------------------------------------------------------

export const listProgramsQuerySchema = z.object({
  status: z.enum(PROGRAM_STATUSES).optional().meta({ description: 'Only programs in this status.' }),
});
export class ListProgramsQueryDto extends createZodDto(listProgramsQuerySchema) {}

export const createProgramSchema = z
  .object({
    name: requiredName(PLAN_LIMITS.nameMax),
    goal: z.enum(PROGRAM_GOALS),
    notes: optionalText(PROGRAM_NOTES_MAX),
  })
  .strict();
export class CreateProgramDto extends createZodDto(createProgramSchema) {}
export type CreateProgramInput = z.output<typeof createProgramSchema>;

export const updateProgramSchema = z
  .object({
    name: requiredName(PLAN_LIMITS.nameMax).optional(),
    goal: z.enum(PROGRAM_GOALS).optional(),
    notes: optionalText(PROGRAM_NOTES_MAX),
    autonomy: z.enum(PROGRAM_AUTONOMY).optional(),
    gymId: z.uuid().nullable().optional().meta({ description: 'One of the caller\'s gyms, or null to clear.' }),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), { message: 'Nothing to update' });
export class UpdateProgramDto extends createZodDto(updateProgramSchema) {}
export type UpdateProgramInput = z.output<typeof updateProgramSchema>;

/** `PUT /api/programs/:id/structure`: the whole plan tree. */
export class ReplaceStructureDto extends createZodDto(planTreeSchema) {}

export const activateProgramSchema = z
  .object({
    startDate: localDate.meta({
      description: 'The client\'s calendar day the plan starts: at most 7 days in the past and 365 in the future.',
    }),
  })
  .strict();
export class ActivateProgramDto extends createZodDto(activateProgramSchema) {}

export const revertProgramSchema = z
  .object({
    toVersion: z.number().int().min(1).optional().meta({ description: 'Restore this version as a new version.' }),
    changeLogId: z.uuid().optional().meta({ description: 'Undo this change; it must be the latest applied change.' }),
  })
  .strict()
  .refine((body) => (body.toVersion === undefined) !== (body.changeLogId === undefined), {
    message: 'Send exactly one of toVersion or changeLogId',
  });
export class RevertProgramDto extends createZodDto(revertProgramSchema) {}
export type RevertProgramInput = z.output<typeof revertProgramSchema>;

export const changeLogQuerySchema = z.object({
  status: z.enum(CHANGE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(CHANGE_LOG_PAGE_SIZE_MAX).default(CHANGE_LOG_PAGE_SIZE_DEFAULT),
  cursor: z
    .string()
    .max(200)
    .optional()
    .meta({ description: 'The `nextCursor` of the previous page. Opaque.' }),
});
export class ChangeLogQueryDto extends createZodDto(changeLogQuerySchema) {}
export type ChangeLogQuery = z.output<typeof changeLogQuerySchema>;

export const markSeenSchema = z
  .object({
    upToId: z.uuid().meta({ description: 'Marks this entry and every older one as seen.' }),
  })
  .strict();
export class MarkSeenDto extends createZodDto(markSeenSchema) {}

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

const programHeaderSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  goal: z.enum(PROGRAM_GOALS),
  status: z.enum(PROGRAM_STATUSES),
  source: z.enum(PROGRAM_SOURCES),
  autonomy: z.enum(PROGRAM_AUTONOMY),
  startDate: z.iso.date().nullable(),
  gymId: z.uuid().nullable(),
  currentVersion: z.number().int(),
  autonomyPausedAt: z.iso
    .datetime()
    .nullable()
    .meta({ description: 'When automatic adjustments were paused (a safety stop, or the owner); null while they run.' }),
  autonomyPausedReason: z
    .enum(AUTONOMY_PAUSE_REASONS)
    .nullable()
    .meta({ description: 'Why automatic adjustments are paused; null while they run.' }),
  lastEvaluatedAt: z.iso.datetime().nullable().meta({ description: 'When the last evaluation run started; null when never.' }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const programListItemSchema = programHeaderSchema.extend({
  unseenChangeCount: z.number().int().meta({ description: 'AI changes the owner has not yet seen.' }),
});
export class ProgramListItemView extends createZodDto(programListItemSchema) {}
export type ProgramListItemData = z.infer<typeof programListItemSchema>;

const exerciseRefSchema = z
  .object({ id: z.uuid(), name: z.string(), slug: z.string(), trackingMode: z.string() })
  .nullable()
  .meta({ description: 'The library or custom exercise; null when it is no longer available.' });

const planExerciseViewSchema = z.object({
  id: z.uuid(),
  exerciseId: z.uuid(),
  exercise: exerciseRefSchema,
  exerciseUnavailable: z.boolean().meta({ description: 'True when the exercise is not (or no longer) available.' }),
  position: z.number().int(),
  isPriority: z.boolean(),
  targetSets: z.number().int(),
  repMin: z.number().int(),
  repMax: z.number().int(),
  targetLoadKg: z.number().nullable(),
  targetRpe: z.number().nullable(),
  restSeconds: z.number().int(),
  loadGuidance: z.enum(LOAD_GUIDANCE),
  rationale: z.string().nullable(),
  evidenceRefs: z.array(z.string()),
  notes: z.string().nullable(),
  equipmentTypeId: z.uuid().nullable(),
});

const planWorkoutViewSchema = z.object({
  id: z.uuid(),
  position: z.number().int(),
  weekday: z.number().int().nullable(),
  name: z.string(),
  estimatedMinutes: z.number().int().nullable(),
  rationale: z.string().nullable(),
  exercises: z.array(planExerciseViewSchema),
});

const planWeekViewSchema = z.object({
  id: z.uuid(),
  weekNumber: z.number().int(),
  isDeload: z.boolean(),
  workouts: z.array(planWorkoutViewSchema),
});

const planBlockViewSchema = z.object({
  id: z.uuid(),
  position: z.number().int(),
  name: z.string(),
  focus: z.string().nullable(),
  rationale: z.string().nullable(),
  weeks: z.array(planWeekViewSchema),
});

export const planTreeViewSchema = z.object({ blocks: z.array(planBlockViewSchema) });
export type PlanTreeViewData = z.infer<typeof planTreeViewSchema>;

export const programViewSchema = programHeaderSchema.extend({
  notes: z.string().nullable(),
  rationale: z.string().nullable().meta({ description: 'The plan\'s overall rationale.' }),
  intake: z.unknown().nullable().meta({ description: 'The intake snapshot an AI plan was made from.' }),
  gym: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  version: z.object({
    versionNumber: z.number().int(),
    origin: z.enum(VERSION_ORIGINS),
    rationale: z.string().nullable(),
    evidence: z.array(jsonObject),
    meta: jsonObject,
    createdAt: z.iso.datetime(),
  }),
  tree: planTreeViewSchema,
  warnings: z
    .array(z.string())
    .optional()
    .meta({ description: 'Present after a write: non-blocking notes about the saved plan.' }),
});
export class ProgramView extends createZodDto(programViewSchema) {}
export type ProgramViewData = z.infer<typeof programViewSchema>;

export const versionSummarySchema = z.object({
  versionNumber: z.number().int(),
  origin: z.enum(VERSION_ORIGINS),
  createdAt: z.iso.datetime(),
  runId: z.uuid().nullable(),
  changeLogId: z.uuid().nullable(),
  summary: z.string().nullable(),
});
export class ProgramVersionSummaryView extends createZodDto(versionSummarySchema) {}
export type VersionSummaryData = z.infer<typeof versionSummarySchema>;

export const versionViewSchema = versionSummarySchema.extend({
  rationale: z.string().nullable(),
  evidence: z.array(jsonObject),
  meta: jsonObject,
  snapshot: jsonObject.meta({ description: '`{ schemaVersion, program, tree }` with row ids preserved.' }),
});
export class ProgramVersionView extends createZodDto(versionViewSchema) {}
export type VersionViewData = z.infer<typeof versionViewSchema>;

export const changeLogEntrySchema = z.object({
  id: z.uuid(),
  kind: z.enum(CHANGE_KINDS),
  actor: z.enum(CHANGE_ACTORS),
  status: z.enum(CHANGE_STATUSES),
  fromVersion: z.number().int().nullable(),
  toVersion: z.number().int().nullable(),
  runId: z.uuid().nullable(),
  summary: z.string(),
  rationale: z.string().nullable(),
  operations: z.array(jsonObject),
  citations: z.array(jsonObject),
  revertsLogId: z.uuid().nullable(),
  seenAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
});
export class ChangeLogEntryView extends createZodDto(changeLogEntrySchema) {}
export type ChangeLogEntryData = z.infer<typeof changeLogEntrySchema>;

export const changeLogPageSchema = z.object({
  items: z.array(changeLogEntrySchema),
  nextCursor: z.string().nullable().meta({ description: 'Pass as `cursor` for the next page; null on the last page.' }),
});
export class ChangeLogPageView extends createZodDto(changeLogPageSchema) {}

export const markSeenResultSchema = z.object({ updated: z.number().int() });
export class MarkSeenResultView extends createZodDto(markSeenResultSchema) {}
