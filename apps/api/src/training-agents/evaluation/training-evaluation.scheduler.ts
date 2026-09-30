import { ConflictException, HttpException, Injectable, Logger } from '@nestjs/common';

import { AiConfigService } from '../../ai/config/ai-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { isGraphReady } from '../graph/training-graphs';
import { TrainingModelResolver } from '../models/training-model-resolver.service';
import { runnable } from '../models/training-models.service';
import { TRAINING_KIND_ROLES } from '../models/training-role-defaults';
import { ACTIVE_RUN_STATUSES, TRAINING_REASONS } from '../runtime/training-runs.constants';
import { TrainingRunsService } from '../runtime/training-runs.service';
import {
  AUTOMATIC_EVALUATION_TRIGGERS,
  type AutomaticEvaluationTrigger,
  type EvaluationSkipReason,
  MANUAL_EVALUATION_TRIGGER,
} from './evaluation.constants';
import { type EvaluationFacts, evaluationGate, startOfUtcDay } from './evaluation-gates';

// =============================================================================
// TrainingEvaluationScheduler: whether to start an evaluation run, and start it
// =============================================================================
//
// `requestEvaluation(userId, trigger)` is the one door for AUTOMATIC
// evaluations (`workout_finished` from the finish event, `weekly` and
// `missed_sessions` from the hourly sweep). It reads a bounded set of small
// facts (one row each, a count, the evaluator's resolution), applies the
// gates in `evaluation-gates.ts`, and either creates ONE run through
// `TrainingRunsService.create` (the run row and its job in one transaction)
// or answers why not. It does no long-running work and calls no provider, so
// an `@OnEvent` listener may await it.
//
// RACES are decided by the database: two triggers at the same instant both
// pass the gates and both call `create`; the unique active-run index lets one
// insert win and the other's `409 TRAINING_RUN_ACTIVE` is read as "already
// running", never an error.
//
// THE COALESCING FLAG. A deferred `workout_finished` request stamps
// `programs.evaluation_requested_at` (the oldest request is kept). When any
// run of the user settles, `onRunSettled` asks again as a FOLLOW-UP (exempt
// from the 30-minute spacing), so a burst of finished workouts costs at most
// one extra run. The sweep also honours a flag it finds. Creating a run
// clears the flag: that run reads everything the request was about.
// =============================================================================

export type EvaluationRequestOutcome =
  | { status: 'created'; runId: string; programId: string }
  /** Not now; the coalescing flag is set (for a `workout_finished` request). */
  | { status: 'deferred'; reason: EvaluationSkipReason }
  | { status: 'skipped'; reason: EvaluationSkipReason };

export interface EvaluationRequestOptions {
  /** A weekly review in the last week of a block: a block-transition hint. */
  deep?: boolean;
  /** The follow-up rule after a settled run (exempt from the spacing). */
  followUp?: boolean;
  now?: Date;
}

const AUTOMATIC = [...AUTOMATIC_EVALUATION_TRIGGERS];

@Injectable()
export class TrainingEvaluationScheduler {
  private readonly logger = new Logger(TrainingEvaluationScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfigService,
    private readonly resolver: TrainingModelResolver,
    private readonly runs: TrainingRunsService,
  ) {}

  async requestEvaluation(
    userId: string,
    trigger: AutomaticEvaluationTrigger,
    options: EvaluationRequestOptions = {},
  ): Promise<EvaluationRequestOutcome> {
    const now = options.now ?? new Date();
    const facts = await this.loadFacts(userId, now);

    // The evaluator's resolution is the one fact that is not a single row:
    // read it only when every cheaper gate already passes.
    let decision = evaluationGate({ ...facts, evaluatorUsable: true }, now, options);
    if (decision.allow) {
      facts.evaluatorUsable = await this.evaluatorUsable(userId);
      decision = evaluationGate(facts, now, options);
    }

    if (!decision.allow) {
      if (decision.defer && trigger === 'workout_finished' && facts.program) {
        await this.flag(facts.program.id, now);
        return { status: 'deferred', reason: decision.reason };
      }
      return { status: 'skipped', reason: decision.reason };
    }

    const programId = facts.program!.id;

    try {
      const started = await this.runs.create(
        userId,
        { kind: 'evaluate', programId, input: { trigger, ...(options.deep ? { deep: true } : {}) } },
        trigger,
      );

      if (started.status !== 'queued') return { status: 'skipped', reason: 'active_run' };

      await this.prisma.program.updateMany({
        where: { id: programId, userId },
        data: {
          lastEvaluatedAt: now,
          evaluationRequestedAt: null,
          ...(trigger === 'weekly' ? { lastWeeklyEvaluationAt: now } : {}),
        },
      });

      this.logger.log(`Queued ${trigger} evaluation run ${started.runId} for program ${programId}`);
      return { status: 'created', runId: started.runId, programId };
    } catch (error) {
      const reason = refusalReason(error);
      if (reason === TRAINING_REASONS.RUN_ACTIVE) {
        // Another trigger (or a user) won the race. A follow-up never re-arms
        // the flag it is serving, or two settles could chain runs forever.
        if (trigger === 'workout_finished' && !options.followUp) {
          await this.flag(programId, now);
          return { status: 'deferred', reason: 'active_run' };
        }
        return { status: 'skipped', reason: 'active_run' };
      }
      if (reason === TRAINING_REASONS.ROLE_UNAVAILABLE) return { status: 'skipped', reason: 'evaluator_unavailable' };
      if (reason === TRAINING_REASONS.NOT_IMPLEMENTED) return { status: 'skipped', reason: 'graph_not_ready' };
      throw error;
    }
  }

  /**
   * The follow-up rule: a run of this user settled; if their active plan
   * carries a deferred request, ask once more. Returns `null` when there is
   * nothing to follow up.
   */
  async onRunSettled(runId: string, now: Date = new Date()): Promise<EvaluationRequestOutcome | null> {
    const run = await this.prisma.trainingPlanRun.findUnique({ where: { id: runId }, select: { userId: true } });
    if (!run) return null;

    const flagged = await this.prisma.program.findFirst({
      where: { userId: run.userId, status: 'active', evaluationRequestedAt: { not: null } },
      select: { id: true },
    });
    if (!flagged) return null;

    return this.requestEvaluation(run.userId, 'workout_finished', { followUp: true, now });
  }

  private async loadFacts(userId: string, now: Date): Promise<EvaluationFacts> {
    const since = startOfUtcDay(now);
    const [aiEnabled, program, activeRun, automaticRunsToday, lastAutomatic, lastManual] = await Promise.all([
      this.aiConfig.isEnabled(),
      this.prisma.program.findFirst({
        where: { userId, status: 'active' },
        select: { id: true, autonomyPausedAt: true },
      }),
      this.prisma.trainingPlanRun.findFirst({
        where: { userId, status: { in: [...ACTIVE_RUN_STATUSES] } },
        select: { kind: true, status: true },
      }),
      this.prisma.trainingPlanRun.count({
        where: { userId, kind: 'evaluate', trigger: { in: AUTOMATIC }, createdAt: { gte: since } },
      }),
      this.lastEvaluationRun(userId, AUTOMATIC),
      this.lastEvaluationRun(userId, [MANUAL_EVALUATION_TRIGGER]),
    ]);

    const proposalPending = program
      ? (await this.prisma.programChangeLog.count({ where: { programId: program.id, status: 'proposed' } })) > 0
      : false;

    return {
      aiEnabled,
      graphReady: isGraphReady('evaluate'),
      program,
      evaluatorUsable: false,
      proposalPending,
      activeRun,
      automaticRunsToday,
      lastAutomaticRunAt: lastAutomatic,
      lastManualRunAt: lastManual,
    };
  }

  private async lastEvaluationRun(userId: string, triggers: string[]): Promise<Date | null> {
    const run = await this.prisma.trainingPlanRun.findFirst({
      where: { userId, kind: 'evaluate', trigger: { in: triggers } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return run?.createdAt ?? null;
  }

  private async evaluatorUsable(userId: string): Promise<boolean> {
    const { roles } = await this.resolver.resolveForRun(userId);
    return TRAINING_KIND_ROLES.evaluate.every((role) => runnable(roles[role]));
  }

  /** Stamps the coalescing flag, keeping the oldest pending request. */
  private async flag(programId: string, now: Date): Promise<void> {
    await this.prisma.program.updateMany({
      where: { id: programId, evaluationRequestedAt: null },
      data: { evaluationRequestedAt: now },
    });
  }
}

/** The `details.reason` of a refusal from `TrainingRunsService.create`, if it is one. */
function refusalReason(error: unknown): string | null {
  if (!(error instanceof HttpException) || !(error instanceof ConflictException || error.getStatus() === 501)) {
    return null;
  }
  const response = error.getResponse() as { details?: { reason?: unknown } };
  return typeof response?.details?.reason === 'string' ? response.details.reason : null;
}
