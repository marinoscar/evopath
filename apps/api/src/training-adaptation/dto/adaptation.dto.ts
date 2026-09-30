import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { TASK_REASONING_EFFORTS } from '../../common/schemas/settings.schema';
import { ROLE_RESOLUTION_STATES, roleResolutionSchema } from '../../training-agents/models/dto/role-resolution.dto';
import { ADAPTATION_STATUSES, APPLIED_AS } from '../adaptation.constants';
import {
  adaptationGuardrailReportSchema,
  adaptedWorkoutSchema,
} from '../contracts/adapted-workout.contract';

// =============================================================================
// /api/ai/training/adaptations: response shapes
// =============================================================================

const sentDataSectionSchema = z.object({
  key: z.string(),
  title: z.string(),
  items: z.array(z.string()),
  count: z.number().int().optional(),
});

/** The "what will be sent" summary: the sections rendered from the exact object sent, and what is never sent. */
export const sentDataSummarySchema = z.object({
  sections: z.array(sentDataSectionSchema),
  dropped: z.array(z.string()),
  excluded: z.array(z.string()),
});

const roleSchema = z.object({
  role: z.enum(['planner', 'critic']),
  state: z.enum(ROLE_RESOLUTION_STATES),
  model: z.object({ provider: z.string(), modelId: z.string(), displayName: z.string() }).nullable(),
  effectiveEffort: z.enum(TASK_REASONING_EFFORTS).nullable(),
  /** Who can fix a blocking state: the caller (`keys`: add a key) or an administrator (model assignments are admin-only). */
  fix: roleResolutionSchema.shape.fix,
  runnable: z.boolean(),
});

const safetySchema = z.object({
  level: z.enum(['ok', 'conservative', 'blocked']),
  /** Rule codes (`urgent:chest_pain`, `stem:pain`, `readiness:low_energy`); never your words. */
  reasons: z.array(z.string()),
});

const baseRefSchema = z.object({
  planId: z.uuid(),
  planVersionId: z.uuid().nullable(),
  planVersion: z.number().int(),
  planWorkoutId: z.uuid(),
  date: z.iso.date(),
});

export const adaptationPreviewSchema = z.object({
  /** `planned` when today's planned workout is the base; `none` for an ad-hoc session. */
  baseWorkout: z.enum(['planned', 'none']),
  base: z
    .object({ programWorkoutId: z.uuid(), name: z.string(), date: z.iso.date(), planVersion: z.number().int() })
    .nullable(),
  sentData: sentDataSummarySchema,
  models: z.object({ planner: roleSchema, critic: roleSchema }),
  /** False when the safety screen blocks the request or a role has no usable model. */
  willCallProvider: z.boolean(),
  safety: safetySchema,
  /** Set when the safety screen stops the request: what to do instead. */
  blocked: z.object({ reason: z.string(), guidance: z.string() }).nullable(),
});

export class AdaptationPreview extends createZodDto(adaptationPreviewSchema) {}
export type AdaptationPreviewData = z.infer<typeof adaptationPreviewSchema>;

export const adaptationStartedSchema = z.object({
  adaptationId: z.uuid(),
  /** The queue job; `null` when the safety screen stopped the request. */
  jobId: z.uuid().nullable(),
  /** The kit run to follow with `GET /api/ai/training/stream/{runId}`; `null` when stopped. */
  runId: z.uuid().nullable(),
  status: z.enum(['queued', 'blocked_safety']),
  /** Set on `blocked_safety`: what to do instead. */
  guidance: z.string().optional(),
});

export class AdaptationStarted extends createZodDto(adaptationStartedSchema) {}
export type AdaptationStartedData = z.infer<typeof adaptationStartedSchema>;

const modelRefSchema = z.object({ provider: z.string(), modelId: z.string() });

export const criticReportSchema = z.object({
  verdict: z.enum(['accept', 'revise']).nullable(),
  checks: z
    .object({
      honoursRequest: z.boolean(),
      preservesIntent: z.boolean(),
      avoidsSoreAreas: z.boolean(),
      sensibleOrder: z.boolean(),
    })
    .nullable(),
  issues: z.array(z.object({ code: z.string(), severity: z.enum(['minor', 'major']), note: z.string() })),
  rounds: z.number().int(),
  /** Set when the critic did not review ("Not reviewed by the critic"). */
  skipped: z.enum(['token_cap', 'error']).optional(),
});

export const adaptationViewSchema = z.object({
  id: z.uuid(),
  status: z.enum(ADAPTATION_STATUSES),
  /** What you asked for, as validated. */
  request: z.record(z.string(), z.unknown()),
  gymId: z.uuid().nullable(),
  /** The planned workout it adapts; `null` for an ad-hoc session. */
  baseRef: baseRefSchema.nullable(),
  /** The checked proposal (no loads: `apply` fills them). `null` until `ready`. */
  proposal: adaptedWorkoutSchema.nullable(),
  guardrailReport: adaptationGuardrailReportSchema.nullable(),
  criticReport: criticReportSchema.nullable(),
  safety: safetySchema.nullable(),
  /** What was (or will be) sent to the models. */
  sentData: sentDataSummarySchema.nullable(),
  models: z.object({ planner: modelRefSchema.nullable(), critic: modelRefSchema.nullable() }),
  runId: z.uuid().nullable(),
  jobId: z.uuid().nullable(),
  /** The run's current node while it works (`context`, `adapt`, `guardrails`, `critic`, `finalize`). */
  stage: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  appliedAs: z.enum(APPLIED_AS).nullable(),
  appliedWorkoutId: z.uuid().nullable(),
  appliedPlanVersionId: z.uuid().nullable(),
  appliedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Set on `blocked_safety`: what to do instead. */
  guidance: z.string().nullable(),
});

export class AdaptationView extends createZodDto(adaptationViewSchema) {}
export type AdaptationViewData = z.infer<typeof adaptationViewSchema>;

export const applyWorkoutResultSchema = z.object({
  /** The in-progress E4 workout; open it in the logger. */
  workoutId: z.uuid(),
  /** Linked to today's planned workout (adherence counts the day). */
  linkedToPlan: z.boolean(),
  /** The plan changed since the adaptation was made (the workout was still created). */
  planChanged: z.boolean(),
});

export class ApplyWorkoutResult extends createZodDto(applyWorkoutResultSchema) {}
export type ApplyWorkoutResultData = z.infer<typeof applyWorkoutResultSchema>;

export const applyPlanResultSchema = z.object({
  programId: z.uuid(),
  /** `program_versions.id` of the new version. */
  planVersionId: z.uuid(),
  versionNumber: z.number().int(),
  /** The change-log entry; E5.1's one-tap revert undoes it. */
  changeLogId: z.uuid(),
});

export class ApplyPlanResult extends createZodDto(applyPlanResultSchema) {}
export type ApplyPlanResultData = z.infer<typeof applyPlanResultSchema>;
