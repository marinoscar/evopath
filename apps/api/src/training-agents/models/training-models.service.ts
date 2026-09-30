import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';

import { AiConfigService } from '../../ai/config/ai-config.service';
import {
  TRAINING_AGENT_ROLES,
  TRAINING_MAX_RUN_TOKENS,
  TRAINING_MIN_RUN_TOKENS,
  type TrainingAgentRole,
} from '../../common/schemas/settings.schema';
import { RUNNABLE_ROLE_STATES, type RoleResolution } from './dto/role-resolution.dto';
import type {
  SentDataEntry,
  TrainingModelsViewData,
  TrainingRunEstimateData,
} from './dto/training-models.dto';
import { fitPlannerContext } from '../agents/planner/planner.agent';
import { buildTrainingRunContext } from '../context/build-planner-context';
import { PlannerContextLoader, TRAINING_CONTEXT_REASONS } from '../context/planner-context.loader';
import type { TrainingRunContext } from '../context/planner-context.contract';
import {
  type SentDataSummary,
  summarizeCriticContext,
  summarizePlannerContext,
  summarizeResearcherContext,
} from '../context/summarize-context';
import type { TrainingIntake } from '../contracts/training-intake.contract';
import type { FrozenRoleModel } from '../graph/node-context';
import { ContextBudget } from '../runtime/context-budget';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import {
  effectiveTokenCap,
  estimateRunTokens,
  TRAINING_DEFAULT_CRITIC_ROUNDS,
  TRAINING_DEFAULT_RUN_TOKENS,
  TRAINING_TYPICAL_CONTEXT_CHARS,
  type TrainingRunKind,
} from './token-estimate';
import { TRAINING_KIND_ROLES } from './training-role-defaults';
import { TrainingModelResolver } from './training-model-resolver.service';

/** Whether a resolved role has a model it can run on. */
export function runnable(resolution: RoleResolution): boolean {
  return RUNNABLE_ROLE_STATES.includes(resolution.state) && resolution.model !== undefined;
}

/** Read-only answers for the agent model settings page. Makes no provider call. */
@Injectable()
export class TrainingModelsService {
  constructor(
    private readonly resolver: TrainingModelResolver,
    private readonly aiConfig: AiConfigService,
    @Optional() private readonly plannerContext?: PlannerContextLoader,
  ) {}

  async overview(userId: string): Promise<TrainingModelsViewData> {
    const [roles, policy] = await Promise.all([this.resolver.resolveAll(userId), this.aiConfig.resolve()]);
    const can = (kind: TrainingRunKind) => TRAINING_KIND_ROLES[kind].every((role) => runnable(roles[role]));

    return {
      roles,
      webSearch: { adminEnabled: policy.hostedTools.web_search },
      limits: {
        defaultRunTokens: { ...TRAINING_DEFAULT_RUN_TOKENS },
        minRunTokens: TRAINING_MIN_RUN_TOKENS,
        hardMaxRunTokens: TRAINING_MAX_RUN_TOKENS,
      },
      canRun: {
        create: can('create'),
        revise: can('revise'),
        evaluate: can('evaluate'),
        blockers: TRAINING_AGENT_ROLES.filter((role) => !runnable(roles[role])).map((role) => ({
          role,
          state: roles[role].state,
        })),
      },
    };
  }

  async estimate(userId: string, input: EstimateInput): Promise<TrainingRunEstimateData> {
    const { roles, settings, limits } = await this.resolver.resolveForRun(userId);

    const tokens = estimateRunTokens({
      kind: input.kind,
      criticRounds: input.criticRounds ?? settings?.training?.maxCriticRounds ?? TRAINING_DEFAULT_CRITIC_ROUNDS,
      contextChars: input.contextChars ?? TRAINING_TYPICAL_CONTEXT_CHARS,
      // A role with a model sends its effective effort; a blocked role is
      // estimated at what it asked for, since fixing it is the next step.
      roles: Object.fromEntries(
        TRAINING_AGENT_ROLES.map((role) => [
          role,
          roles[role].model ? roles[role].effectiveEffort : roles[role].requestedEffort,
        ]),
      ),
    });
    const cap = effectiveTokenCap(input.kind, settings);
    const request = runRequestOf(input);
    const sentData = request ? await this.sentData(userId, input.kind, request, roles, limits) : [];

    return { tokens, cap, capBinding: tokens.high > cap, sentData };
  }

  /**
   * "What will be sent": the run's own context builder over the caller's
   * data, summarised per role that will run. No provider call, no run row.
   */
  private async sentData(
    userId: string,
    kind: TrainingRunKind,
    request: Record<string, unknown>,
    roles: Record<TrainingAgentRole, RoleResolution>,
    limits: (provider: string, modelId: string) => { contextWindow?: number; maxOutputTokens?: number },
  ): Promise<SentDataEntry[]> {
    if (!this.plannerContext) return [];

    let context: TrainingRunContext;
    try {
      context = buildTrainingRunContext(await this.plannerContext.load(userId, request, new Date()));
    } catch (error) {
      if (error instanceof TrainingRunFailedError) {
        if (error.code === TRAINING_CONTEXT_REASONS.REQUEST_INVALID) throw new BadRequestException(error.message);
        if (error.code === TRAINING_CONTEXT_REASONS.GYM_NOT_FOUND) throw new NotFoundException('Gym not found');
        if (error.code === TRAINING_CONTEXT_REASONS.PROGRAM_NOT_FOUND) throw new NotFoundException('Program not found');
      }
      throw error;
    }

    const entry = (role: TrainingAgentRole, summary: SentDataSummary): SentDataEntry => {
      const model = roles[role].model;
      return {
        role,
        provider: model?.provider ?? null,
        model: model?.modelId ?? null,
        keySource: model?.keySource ?? null,
        sections: summary.sections.map((section) => ({
          key: section.key,
          title: section.title,
          items: section.items,
          ...(section.count !== undefined ? { count: section.count } : {}),
        })),
        dropped: summary.dropped,
        excluded: summary.excluded,
      };
    };

    const out: SentDataEntry[] = [];
    for (const role of TRAINING_KIND_ROLES[kind]) {
      if (role === 'researcher') out.push(entry(role, summarizeResearcherContext(context.researcher)));
      if (role === 'planner') {
        const model = roles.planner.model;
        const frozen: FrozenRoleModel | undefined = model
          ? { provider: model.provider, modelId: model.modelId, effort: null, keySource: model.keySource, ...limits(model.provider, model.modelId) }
          : undefined;
        const { fit } = fitPlannerContext(
          { contextBudget: new ContextBudget(), roleModels: frozen ? { planner: frozen } : {} },
          context.planner,
          null,
        );
        out.push(entry(role, summarizePlannerContext(context.planner, fit.dropped)));
      }
      if (role === 'critic') {
        const painFlags = [...new Set([...context.history.filter((h) => h.painFlagged).map((h) => h.key), ...(context.planner.history?.painFlagExerciseKeys ?? [])])].sort();
        out.push(entry(role, summarizeCriticContext(context.planner, painFlags)));
      }
    }
    return out;
  }
}

/** What `estimate` reads from the body. */
export interface EstimateInput {
  kind: TrainingRunKind;
  criticRounds?: number;
  contextChars?: number;
  intake?: TrainingIntake;
  programId?: string;
  basedOnVersion?: number;
  instruction?: string;
}

/** The run request the estimate's optional fields describe, or `null` when they describe none. */
export function runRequestOf(input: EstimateInput): Record<string, unknown> | null {
  if (input.kind === 'create' && input.intake) return { kind: 'create', intake: input.intake };
  if (input.kind === 'revise' && input.programId && input.basedOnVersion !== undefined && input.instruction) {
    return { kind: 'revise', programId: input.programId, basedOnVersion: input.basedOnVersion, instruction: input.instruction };
  }
  return null;
}
