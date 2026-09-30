import { randomUUID } from 'node:crypto';

import { HttpException, HttpStatus } from '@nestjs/common';
import { type Job, Prisma } from '@prisma/client';

import type { AiConfigService } from '../../ai/config/ai-config.service';
import type { AiService } from '../../ai/runtime/ai.service';
import { HARNESS_MODEL } from '../../ai/testing/ai-runtime-harness';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { PlanTree } from '../../programs/contracts/plan-tree.contract';
import { PROGRAM_REASONS } from '../../programs/programs.constants';
import type { TrainingAgentRole } from '../../common/schemas/settings.schema';
import type { RoleResolution } from '../../training-agents/models/dto/role-resolution.dto';
import type { TrainingModelResolver } from '../../training-agents/models/training-model-resolver.service';
import { TrainingRunsService } from '../../training-agents/runtime/training-runs.service';
import { inMemoryAdaptCheckpointer } from '../../training-agents/testing/adapt-graph-support';
import { LIBRARY } from '../../training-agents/testing/context-fixtures';
import { InMemoryRunEventLog } from '../../training-agents/testing/in-memory-run-event-log';
import { ADAPTATION_RUN_JOB_TYPE, ADAPTATION_SUBJECT_TYPE } from '../adaptation.constants';
import { AdaptationService } from '../adaptation.service';
import type { AdaptationContextPort } from '../context/adaptation-context.builder';
import { AdaptationRunHandler, type AdaptationRunHandlerOptions } from '../handlers/adaptation-run.handler';
import {
  ADAPT_GYM_ID,
  ADAPT_PLAN_VERSION_ID,
  ADAPT_PROGRAM_ID,
  ADAPT_PROGRAM_WORKOUT_ID,
  UPPER_A,
  adaptationContextFixture,
} from './adaptation-fixtures';
import { createInMemoryAdaptationPrisma } from './in-memory-adaptation-prisma';

// =============================================================================
// createAdaptationRig: the real adaptation service and run handler, no database
// =============================================================================
//
// The REAL `AdaptationService`, `AdaptationRunHandler` and `TrainingRunsService`
// over `createInMemoryAdaptationPrisma()`, an in-memory run event log and
// checkpointer, and the context builder replaced by the fixture (the same pure
// builder production calls, over `rig.source`). The AI runtime is whatever the
// caller passes (`createAiRuntimeHarness` or the HTTP app's harness), so the
// provider call log is the source of truth for "what was sent".
//
// Jobs are not run by a queue: `create` records the enqueued job and
// `rig.runJob(adaptationId)` executes the handler for it, exactly as the
// worker would (`handler.process(job)`).
//
// The programs and workouts services are small stubs: the real-Postgres suite
// (`test/training-adaptation/adaptation-apply.db.spec.ts`) proves the apply
// writes; here they let the routes' answers, idempotence and refusals run.
// =============================================================================

export const READY_ROLE = (role: TrainingAgentRole): RoleResolution =>
  ({
    role,
    state: 'ready',
    model: { provider: 'openai', modelId: HARNESS_MODEL, displayName: 'Fake', keySource: 'user' },
    needs: [],
    requestedEffort: 'medium',
    effectiveEffort: 'medium',
    fix: null,
  }) as unknown as RoleResolution;

/** A minimal plan holding today's planned workout (id `ADAPT_PROGRAM_WORKOUT_ID`), for `replaceWorkout`. */
export function planTreeFixture(): PlanTree {
  return {
    blocks: [
      {
        position: 0,
        name: 'Block',
        focus: null,
        rationale: null,
        weeks: [
          {
            weekNumber: 2,
            isDeload: false,
            workouts: [
              {
                id: ADAPT_PROGRAM_WORKOUT_ID,
                position: 0,
                weekday: 3,
                name: 'Upper A',
                estimatedMinutes: 60,
                rationale: null,
                exercises: UPPER_A.map((e, position) => ({
                  exerciseId: e.exerciseId,
                  position,
                  isPriority: e.isPriority,
                  targetSets: e.sets,
                  repMin: e.repMin,
                  repMax: e.repMax,
                  targetLoadKg: e.targetLoadKg,
                  targetRpe: e.targetRpe,
                  restSeconds: e.restSeconds,
                  loadGuidance: e.loadGuidance,
                  rationale: null,
                  evidenceRefs: [],
                  notes: null,
                  equipmentTypeId: null,
                })),
              },
            ],
          },
        ],
      },
    ],
  } as unknown as PlanTree;
}

export interface AdaptationRigOptions {
  ai: { ai: AiService; aiConfig: AiConfigService };
  /** The model resolver (default: a stub over `rig.roles`). */
  resolver?: TrainingModelResolver;
  handler?: AdaptationRunHandlerOptions;
  /** A context builder to use instead of the fixture (the canary suites pass the REAL builder over a Prisma stand-in). */
  context?: AdaptationContextPort;
  /** The user whose plan `program.findFirst` finds (owner of the stubbed active plan). */
  planOwner?: string;
}

export function createAdaptationRig(opts: AdaptationRigOptions) {
  const db = createInMemoryAdaptationPrisma();
  const events = new InMemoryRunEventLog();
  const saver = inMemoryAdaptCheckpointer();
  const enqueued: Array<{ id: string; type: string; subjectType?: string; subjectId?: string; payload: Record<string, unknown> }> = [];

  const rig = {
    /** Overrides for the fixture context source (a gym, a check-in, no plan, ...). Mutable between calls. */
    source: {} as NonNullable<Parameters<typeof adaptationContextFixture>[0]>,
    roles: { planner: READY_ROLE('planner'), critic: READY_ROLE('critic') } as Record<TrainingAgentRole, RoleResolution>,
    plan: {
      currentVersion: 3,
      tree: planTreeFixture(),
      changeLogId: randomUUID(),
      versionIds: new Map<number, string>(),
      /** Whether the planned workout still exists in the active plan (the one-off's link target). */
      linkable: true,
    },
    /** The user's AI settings the resolver reports (`training.maxRunTokens` bounds the run's token cap). */
    settings: { training: { maxRunTokens: 120_000 } } as { training?: { maxRunTokens?: number } } | undefined,
    /** A workout in progress for the caller (the E4 partial unique index), or `null`. */
    inProgressWorkoutId: null as string | null,
  };

  const contextPort: AdaptationContextPort = {
    build: jest.fn(async (userId, request, now) =>
      opts.context ? opts.context.build(userId, request, now) : adaptationContextFixture({ ...rig.source, request }),
    ),
  };

  const resolver =
    opts.resolver ??
    ({
      resolveForRun: async () => ({
        roles: rig.roles,
        settings: rig.settings,
        limits: () => ({ contextWindow: 128_000, maxOutputTokens: 16_384 }),
      }),
    } as unknown as TrainingModelResolver);

  const jobs = {
    enqueueWithin: jest.fn(async (_tx: unknown, input: { type: string; subjectType?: string; subjectId?: string; payload: Record<string, unknown> }) => {
      const job = { id: randomUUID(), ...input };
      enqueued.push(job);
      return job;
    }),
  };

  const runs = new TrainingRunsService(db.prisma as never, jobs as never, resolver, events as never, { screen: async () => ({ stop: false as const }) } as never);

  // ---- the stubbed plan and workout writes ------------------------------------------------
  const planRow = db.addProgram(opts.planOwner ?? randomUUID(), rig.plan.currentVersion, ADAPT_PROGRAM_ID);
  rig.plan.versionIds.set(3, ADAPT_PLAN_VERSION_ID);
  const created = { workouts: [] as Array<{ id: string; input: Record<string, unknown> }>, sessions: 0, notes: new Map<string, string>() };

  const versionId = (versionNumber: number) => {
    if (!rig.plan.versionIds.has(versionNumber)) rig.plan.versionIds.set(versionNumber, randomUUID());
    return rig.plan.versionIds.get(versionNumber)!;
  };

  const workouts = {
    startPrefilled: jest.fn(async (_tx: unknown, _userId: string, input: Record<string, unknown>) => {
      if (rig.inProgressWorkoutId) {
        // The E4 partial unique index: one in-progress workout per user.
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: 'workouts_user_in_progress_uniq_idx' },
        });
      }
      const workout = { id: randomUUID(), input };
      created.workouts.push(workout);
      return { id: workout.id };
    }),
  };

  const programs = {
    applyChange: jest.fn(async (args: { expectedVersion: number; mutate: (tree: PlanTree) => PlanTree; [key: string]: unknown }) => {
      if (args.expectedVersion !== rig.plan.currentVersion) {
        throw new HttpException(
          { message: 'Stale plan', details: { reason: PROGRAM_REASONS.STALE_PLAN } },
          HttpStatus.CONFLICT,
        );
      }
      rig.plan.tree = args.mutate(structuredClone(rig.plan.tree));
      rig.plan.currentVersion += 1;
      planRow.currentVersion = rig.plan.currentVersion;
      return { versionNumber: rig.plan.currentVersion, changeLogId: rig.plan.changeLogId };
    }),
  };

  Object.assign(db.prisma, {
    programVersion: {
      findUniqueOrThrow: jest.fn(async (args: { where: { programId_versionNumber: { versionNumber: number } } }) => ({
        id: versionId(args.where.programId_versionNumber.versionNumber),
      })),
      findFirst: jest.fn(async (args: { where: { id: string } }) => {
        const entry = [...rig.plan.versionIds.entries()].find(([, id]) => id === args.where.id);
        return entry ? { id: entry[1], programId: ADAPT_PROGRAM_ID, versionNumber: entry[0] } : null;
      }),
      findUnique: jest.fn(async () => ({ id: ADAPT_PLAN_VERSION_ID })),
    },
    programChangeLog: { findFirst: jest.fn(async () => ({ id: rig.plan.changeLogId })) },
    programWorkout: {
      findFirst: jest.fn(async () =>
        rig.plan.linkable
          ? { id: ADAPT_PROGRAM_WORKOUT_ID, week: { programId: ADAPT_PROGRAM_ID, program: { currentVersion: rig.plan.currentVersion } } }
          : null,
      ),
    },
    programSession: {
      create: jest.fn(async () => {
        created.sessions += 1;
        return {};
      }),
      count: jest.fn(async () => created.sessions),
    },
    workout: {
      findFirst: jest.fn(async (args: { where: { status?: string } }) => {
        if (args.where.status === 'in_progress') return rig.inProgressWorkoutId ? { id: rig.inProgressWorkoutId } : null;
        return null;
      }),
      update: jest.fn(async (args: { where: { id: string }; data: { notes?: string } }) => {
        if (args.data.notes) created.notes.set(args.where.id, args.data.notes);
        return {};
      }),
    },
  });

  const library = { loadLibrary: jest.fn(async () => LIBRARY) };

  const service = new AdaptationService(
    db.prisma as never,
    jobs as never,
    resolver,
    events as never,
    runs,
    { build: (...args: Parameters<AdaptationContextPort['build']>) => contextPort.build(...args) } as never,
    library as never,
    workouts as never,
    programs as never,
  );

  const handler = new AdaptationRunHandler(
    new JobHandlerRegistry(),
    db.prisma as never,
    opts.ai.ai,
    opts.ai.aiConfig,
    events as never,
    {} as never,
    { cancelPollMs: 25, heartbeatMs: 60_000, checkpointer: () => saver, contextPort, ...opts.handler },
  );

  /** A `Job` row for the job `create` enqueued for `adaptationId`. */
  const jobFor = (adaptationId: string): Job => {
    const job = enqueued.find((j) => j.subjectId === adaptationId);
    if (!job) throw new Error(`No job was enqueued for adaptation ${adaptationId}`);
    return { ...job, status: 'running', subjectType: ADAPTATION_SUBJECT_TYPE } as unknown as Job;
  };

  // The SAME object the closures above read, so a test assigning `rig.source = ...` or `rig.settings = ...` is seen by them.
  return Object.assign(rig, {
    db,
    events,
    saver,
    jobs,
    enqueued,
    runs,
    service,
    handler,
    workouts,
    programs,
    library,
    contextPort,
    created,
    planRow,
    /** Runs the handler for the job that `create` enqueued for `adaptationId`. */
    runJob: (adaptationId: string) => handler.process(jobFor(adaptationId)),
    jobFor,
    /** The kit run's event types, in order. */
    eventTypes: (runId: string) => events.types(runId),
    type: ADAPTATION_RUN_JOB_TYPE,
    gymId: ADAPT_GYM_ID,
  });
}

export type AdaptationRig = ReturnType<typeof createAdaptationRig>;
