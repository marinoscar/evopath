import { Injectable } from '@nestjs/common';

import { AiConfigService } from '../../ai/config/ai-config.service';
import {
  TRAINING_AGENT_ROLES,
  TRAINING_MAX_RUN_TOKENS,
  TRAINING_MIN_RUN_TOKENS,
  type TrainingAgentRole,
} from '../../common/schemas/settings.schema';
import { RUNNABLE_ROLE_STATES, type RoleResolution } from './dto/role-resolution.dto';
import type {
  TrainingModelsViewData,
  TrainingRunEstimateData,
} from './dto/training-models.dto';
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

  async estimate(
    userId: string,
    input: { kind: TrainingRunKind; criticRounds?: number; contextChars?: number },
  ): Promise<TrainingRunEstimateData> {
    const [settings, roles] = await Promise.all([
      this.resolver.userAiSettings(userId),
      this.resolver.resolveAll(userId),
    ]);

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

    return { tokens, cap, capBinding: tokens.high > cap };
  }
}
