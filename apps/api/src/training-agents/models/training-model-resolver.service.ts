import { Injectable } from '@nestjs/common';

import { AiFeatureModelResolver } from '../../ai/assignments/ai-feature-model-resolver.service';
import {
  TRAINING_AGENT_ROLES,
  type TrainingAgentRole,
  userAiSettingsSchema,
  type UserAiSettingsValue,
} from '../../common/schemas/settings.schema';
import { PrismaService } from '../../prisma/prisma.service';
import type { RoleResolution } from './dto/role-resolution.dto';
import { type RoleResolutionFacts, resolveRole } from './training-role-resolution';

// =============================================================================
// TrainingModelResolver: which model each training agent role will use
// =============================================================================
//
// A thin binding over the platform's `AiFeatureModelResolver` (#173): the
// facts (usable models, key sources, catalog, the administrator's
// assignments) are gathered there, once per call, and each role is the pure
// `resolveRole` over them. Also reads the caller's own training limits
// (`ai.training`), the one AI preference a user still sets. Reads, never
// writes, and never touches key material.
// =============================================================================

@Injectable()
export class TrainingModelResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly features: AiFeatureModelResolver,
  ) {}

  /** Every role's resolution for `userId`, from one gathering of the facts. */
  async resolveAll(userId: string): Promise<Record<TrainingAgentRole, RoleResolution>> {
    const facts = await this.facts(userId);

    return Object.fromEntries(TRAINING_AGENT_ROLES.map((role) => [role, resolveRole(role, facts)])) as Record<
      TrainingAgentRole,
      RoleResolution
    >;
  }

  /**
   * Every role's resolution plus what a run freezes beside it: the caller's
   * stored settings and each resolved model's catalog limits (context window,
   * max output). One gathering of the facts; still no key material.
   */
  async resolveForRun(userId: string): Promise<{
    roles: Record<TrainingAgentRole, RoleResolution>;
    settings: UserAiSettingsValue | undefined;
    limits: (provider: string, modelId: string) => { contextWindow?: number; maxOutputTokens?: number };
  }> {
    const [facts, settings] = await Promise.all([this.facts(userId), this.userAiSettings(userId)]);
    const roles = Object.fromEntries(TRAINING_AGENT_ROLES.map((role) => [role, resolveRole(role, facts)])) as Record<
      TrainingAgentRole,
      RoleResolution
    >;

    return {
      roles,
      settings,
      limits: (provider, modelId) => {
        const model = facts.usable.find((m) => m.provider === provider && m.modelId === modelId);
        const caps = model?.capabilities;

        return {
          ...(caps?.contextWindow ? { contextWindow: caps.contextWindow } : {}),
          ...(caps?.maxOutputTokens ? { maxOutputTokens: caps.maxOutputTokens } : {}),
        };
      },
    };
  }

  async resolve(userId: string, role: TrainingAgentRole): Promise<RoleResolution> {
    return resolveRole(role, await this.facts(userId));
  }

  /**
   * The caller's stored `ai` namespace, read raw (never creates a settings
   * row): the user's training limits.
   */
  async userAiSettings(userId: string): Promise<UserAiSettingsValue | undefined> {
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    const parsed = userAiSettingsSchema.safeParse((row?.value as { ai?: unknown } | null | undefined)?.ai);

    return parsed.success ? parsed.data : undefined;
  }

  private facts(userId: string): Promise<RoleResolutionFacts> {
    return this.features.facts(userId);
  }
}
