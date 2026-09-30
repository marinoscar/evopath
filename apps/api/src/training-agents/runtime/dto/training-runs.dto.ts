import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AI_KEY_SOURCES } from '../../../ai/keys/dto/usable-ai-model.dto';
import { TASK_REASONING_EFFORTS, TRAINING_AGENT_ROLES } from '../../../common/schemas/settings.schema';
import { createRunRequestSchema, reviseRunRequestSchema, trainingIntakeSchema } from '../../contracts/training-intake.contract';
import { TRAINING_RUN_KINDS } from '../../models/token-estimate';
import { TRAINING_RUN_STATUSES, TRAINING_RUN_TRIGGERS } from '../training-runs.constants';

// =============================================================================
// /api/ai/training/runs and /api/ai/training/stream
// =============================================================================

/** The largest request a run stores, as JSON characters. */
export const TRAINING_RUN_INPUT_MAX_CHARS = 32_000;

const FORBIDDEN_BY_KIND = {
  create: ['programId', 'basedOnVersion', 'instruction', 'input'],
  revise: ['intake', 'input'],
  evaluate: ['intake', 'basedOnVersion', 'instruction'],
} as const;

const REQUIRED_BY_KIND = {
  create: ['intake'],
  revise: ['programId', 'basedOnVersion', 'instruction'],
  evaluate: [],
} as const;

/**
 * The body of `POST /api/ai/training/runs`, one object for the three kinds:
 * `create` carries `intake`; `revise` carries `programId`, `basedOnVersion`
 * and `instruction`; `evaluate` carries an optional `programId` and the
 * evaluator's own `input`. A field another kind owns is refused.
 */
export const startTrainingRunSchema = z
  .object({
    kind: z.enum(TRAINING_RUN_KINDS),
    /** `create`: what the user asks for (`contracts/training-intake.contract.ts`). */
    intake: trainingIntakeSchema.optional(),
    /** `revise` (required) and `evaluate`: the program the run works on. */
    programId: z.string().uuid().optional(),
    /** `revise`: the version the instruction is based on; must be the program's current version. */
    basedOnVersion: reviseRunRequestSchema.shape.basedOnVersion.optional(),
    /** `revise`: what to change, at most 500 characters. */
    instruction: reviseRunRequestSchema.shape.instruction.optional(),
    /** `evaluate`: the evaluator's request; at most 32,000 characters as JSON. */
    input: z
      .record(z.string().max(64), z.unknown())
      .refine((value) => JSON.stringify(value).length <= TRAINING_RUN_INPUT_MAX_CHARS, {
        message: `input must be at most ${TRAINING_RUN_INPUT_MAX_CHARS} characters as JSON`,
      })
      .optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    for (const field of FORBIDDEN_BY_KIND[body.kind]) {
      if (body[field] !== undefined) {
        ctx.addIssue({ code: 'custom', path: [field], message: `Not allowed for a ${body.kind} run` });
      }
    }
    for (const field of REQUIRED_BY_KIND[body.kind]) {
      if (body[field] === undefined) {
        ctx.addIssue({ code: 'custom', path: [field], message: `Required for a ${body.kind} run` });
      }
    }
  });

export type StartTrainingRunBody = z.output<typeof startTrainingRunSchema>;

/** A validated body as the run stores it: the request the graph reads as `state.input`, and its program. */
export function toRunRequest(body: StartTrainingRunBody): { request: Record<string, unknown>; programId: string | null } {
  if (body.kind === 'create') {
    return { request: createRunRequestSchema.parse({ kind: 'create', intake: body.intake }), programId: null };
  }
  if (body.kind === 'revise') {
    const request = reviseRunRequestSchema.parse({
      kind: 'revise',
      programId: body.programId,
      basedOnVersion: body.basedOnVersion,
      instruction: body.instruction,
    });
    return { request, programId: request.programId };
  }
  return { request: body.input ?? {}, programId: body.programId ?? null };
}

export class StartTrainingRunDto extends createZodDto(startTrainingRunSchema) {}
export type StartTrainingRunInput = z.input<typeof startTrainingRunSchema>;

export const trainingRunIdParamSchema = z.object({
  runId: z.string().uuid(),
});

export class TrainingRunIdParamDto extends createZodDto(trainingRunIdParamSchema) {}

export const listTrainingRunsQuerySchema = z.object({
  programId: z.string().uuid().optional(),
  status: z.enum(TRAINING_RUN_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export class ListTrainingRunsQueryDto extends createZodDto(listTrainingRunsQuerySchema) {}
export type ListTrainingRunsQuery = z.infer<typeof listTrainingRunsQuerySchema>;

export const trainingRunDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  /** An optional note for the agents. Never shown in events or logs. */
  note: z.string().trim().min(1).max(1_000).optional(),
});

export class TrainingRunDecisionDto extends createZodDto(trainingRunDecisionSchema) {}
export type TrainingRunDecisionInput = z.infer<typeof trainingRunDecisionSchema>;

export const trainingRunStreamQuerySchema = z.object({
  /** Replay events with `seq` greater than this; `Last-Event-ID` is honoured when absent. */
  after: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
});

export class TrainingRunStreamQueryDto extends createZodDto(trainingRunStreamQuerySchema) {}

// ---- responses ----------------------------------------------------------------

export const trainingRunStartedSchema = z.object({
  runId: z.string().uuid(),
  /** The queue job executing it; `null` when the safety screen stopped the run. */
  jobId: z.string().uuid().nullable(),
  status: z.enum(['queued', 'blocked_safety']),
  /** Set on `blocked_safety`: what to do instead. */
  guidance: z.string().optional(),
});

export class TrainingRunStarted extends createZodDto(trainingRunStartedSchema) {}
export type TrainingRunStartedData = z.infer<typeof trainingRunStartedSchema>;

const usageTotalsSchema = z.object({
  calls: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  reasoningTokens: z.number().int(),
});

export const trainingRunViewSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(TRAINING_RUN_KINDS),
  trigger: z.enum(TRAINING_RUN_TRIGGERS),
  status: z.enum(TRAINING_RUN_STATUSES),
  /** The node running now. */
  stage: z.string().nullable(),
  programId: z.string().uuid().nullable(),
  /** The models frozen at start, by role. Identifiers only. */
  roleModels: z.record(
    z.enum(TRAINING_AGENT_ROLES),
    z.object({
      provider: z.string(),
      modelId: z.string(),
      effort: z.enum(TASK_REASONING_EFFORTS).nullable(),
      keySource: z.enum(AI_KEY_SOURCES),
    }),
  ),
  tokenCap: z.number().int(),
  usage: z.object({
    byRole: z.record(z.string(), usageTotalsSchema),
    byNode: z.record(z.string(), usageTotalsSchema),
    total: usageTotalsSchema,
  }),
  /** A small summary once finished. */
  result: z.record(z.string(), z.unknown()).nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** A decision recorded and waiting for the resume job. */
  pendingDecision: z.enum(['approve', 'reject']).nullable(),
  cancelRequested: z.boolean(),
  resumeCount: z.number().int(),
  /** The last event `seq`; stream with `after` to catch up. */
  lastEventSeq: z.number().int(),
  heartbeatAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export class TrainingRunView extends createZodDto(trainingRunViewSchema) {}
export type TrainingRunViewData = z.infer<typeof trainingRunViewSchema>;

export interface TrainingRunListData {
  items: TrainingRunViewData[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
