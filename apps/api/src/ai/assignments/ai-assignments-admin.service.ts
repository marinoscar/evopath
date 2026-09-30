import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import {
  AI_FEATURE_IDS,
  type AiFeatureAssignment,
  type AiFeatureId,
  type AiModelRef,
  type SystemAiAssignmentsValue,
} from '../../common/schemas/settings.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { EMPTY_AI_MODEL_CAPABILITIES } from '../catalog/ai-catalog.service';
import { AiConfigService, type AiPolicy, providerPolicy } from '../config/ai-config.service';
import { type AiCapability, type AiModelCapabilities, aiModelCapabilitiesSchema } from '../core/capabilities';
import { AiProviderRegistry } from '../core/provider-registry';
import { assignmentsOf } from './ai-feature-model-resolver.service';
import { type AiFeatureDefinition, featureShortfall, listAiFeatures } from './ai-features';
import {
  AI_ASSIGNMENT_INVALID,
  AI_ASSIGNMENT_ISSUES,
  type AiAssignmentsResponse,
  type AiAssignmentWarning,
  type AiEligibleModel,
  type UpdateAiAssignmentsInput,
} from './dto/ai-assignments.dto';

// =============================================================================
// AiAssignmentsAdminService (#173) — read and write `ai.assignments`
// =============================================================================
//
// A route of its own rather than a field of `PUT /api/admin/ai/config`: that
// body is a full replace of provider configuration, and a round-trip from a
// client that predates assignments must never wipe them (the config PUT
// carries the stored value through; see `AiConfigAdminService.buildNext`).
//
// Validation is DEPLOYMENT-wide, not per user: an assignment must name a
// catalog model that is enabled, not deprecated, of an enabled provider with
// an adapter, and capable for its feature (model capabilities, provider port,
// input modality, provider restriction). Whether a given user's key reaches it
// is the resolver's question, at call time — an assignment a user cannot use
// falls through for that user instead of blocking them.
//
// Audit rows name changed fields only (`default`, `features.<id>`), never
// model ids, matching the other `ai_config` audit rows.
// =============================================================================

export const AI_ASSIGNMENTS_AUDIT_ACTION = 'ai_config:assignments';

interface CatalogRow {
  provider: string;
  modelId: string;
  displayName: string | null;
  capabilities: AiModelCapabilities;
  enabled: boolean;
  deprecated: boolean;
}

interface AssignmentError extends AiAssignmentWarning {
  field: string;
  provider: string;
  modelId: string;
}

type SettingsRow = {
  version: number;
  updatedAt: Date;
  updatedByUser: { id: string; email: string } | null;
} | null;

@Injectable()
export class AiAssignmentsAdminService {
  private readonly logger = new Logger(AiAssignmentsAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly aiConfig: AiConfigService,
    private readonly registry: AiProviderRegistry,
  ) {}

  /** `GET /api/admin/ai/assignments`. Read fresh; never creates the settings row. */
  async describe(): Promise<AiAssignmentsResponse> {
    const [policy, row, catalog] = await Promise.all([
      this.aiConfig.resolve({ fresh: true }),
      this.readRow(),
      this.readCatalog(),
    ]);
    const stored = assignmentsOf(policy);
    const usableProvider = (provider: string) => this.providerLive(policy, provider);
    const eligibleFor = (feature: AiFeatureDefinition | null) =>
      catalog
        .filter((m) => m.enabled && !m.deprecated && usableProvider(m.provider))
        .filter((m) => !feature || featureShortfall(feature, fit(m), this.supports).length === 0)
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId))
        .map(toEligible);

    return {
      assignments: {
        default: stored.default ? { ...stored.default } : null,
        features: Object.fromEntries(
          AI_FEATURE_IDS.map((id) => [id, stored.features[id] ? { ...stored.features[id] } : null]),
        ) as AiAssignmentsResponse['assignments']['features'],
      },
      default: {
        eligibleModels: eligibleFor(null),
        warning: stored.default ? this.check(stored.default, null, catalog, policy) : null,
      },
      features: listAiFeatures().map((feature) => {
        const assignment = stored.features[feature.id] ?? null;

        return {
          featureId: feature.id,
          label: feature.label,
          group: feature.group,
          needs: [...feature.needs],
          inputModalities: [...feature.inputModalities],
          providers: feature.providers ? [...feature.providers] : null,
          requiresWebSearch: feature.requiresWebSearch,
          defaultReasoningEffort: feature.defaultEffort,
          assignment: assignment ? { ...assignment } : null,
          eligibleModels: eligibleFor(feature),
          warning: assignment ? this.check(assignment, feature, catalog, policy) : null,
        };
      }),
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedByUser ?? null,
    };
  }

  /**
   * `PUT /api/admin/ai/assignments` — full replace of `ai.assignments`.
   *
   * Order, as `AiConfigAdminService.replace`: `If-Match` refused before
   * anything is written; every assignment validated (all problems reported in
   * one 400, nothing written); `patchSettings` re-checking the version; the
   * policy cache dropped synchronously; the audit row.
   */
  async replace(
    input: UpdateAiAssignmentsInput,
    userId: string,
    expectedVersion?: number,
  ): Promise<AiAssignmentsResponse> {
    const row = await this.readRow();
    const currentVersion = row?.version ?? 0;

    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw new ConflictException(
        `AI settings version mismatch. Expected ${expectedVersion}, found ${currentVersion}`,
      );
    }

    const [policy, catalog] = await Promise.all([this.aiConfig.resolve({ fresh: true }), this.readCatalog()]);
    const next = normalize(input);
    const errors: AssignmentError[] = [];

    if (next.default) {
      const issue = this.check(next.default, null, catalog, policy);
      if (issue) errors.push({ field: 'default', ...next.default, ...issue });
    }

    for (const feature of listAiFeatures()) {
      const assignment = next.features[feature.id];
      if (!assignment) continue;

      const field = `features.${feature.id}`;

      if (feature.defaultEffort === null && assignment.reasoningEffort != null) {
        errors.push({
          field,
          provider: assignment.provider,
          modelId: assignment.modelId,
          code: AI_ASSIGNMENT_ISSUES.EFFORT_UNSUPPORTED,
          message: `${feature.label} does not take a reasoning effort.`,
        });
        continue;
      }

      const issue = this.check(assignment, feature, catalog, policy);
      if (issue) errors.push({ field, provider: assignment.provider, modelId: assignment.modelId, ...issue });
    }

    if (errors.length > 0) {
      throw new BadRequestException({
        message: `The model assignments were not saved: ${errors.map((e) => `${e.field}: ${e.message}`).join(' ')}`,
        details: { reason: AI_ASSIGNMENT_INVALID, errors },
      });
    }

    const current = assignmentsOf(policy);

    await this.systemSettings.patchSettings({ ai: { assignments: next } }, userId, expectedVersion);

    // Nothing awaits between the write and this (see `AiConfigService.invalidateCache`).
    this.aiConfig.invalidateCache();

    const changedFields = diffAssignmentFields(current, next);

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: AI_ASSIGNMENTS_AUDIT_ACTION,
        targetType: 'ai_config',
        targetId: 'assignments',
        meta: { changedFields } as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `AI model assignments replaced by user ${userId} (changed=${changedFields.join(',') || '(none)'})`,
    );

    return this.describe();
  }

  // ---------------------------------------------------------------------------

  private readonly supports = (provider: string, capability: AiCapability) =>
    this.registry.supports(provider, capability);

  private providerLive(policy: AiPolicy, provider: string): boolean {
    return providerPolicy(policy, provider)?.enabled === true && this.registry.get(provider) !== undefined;
  }

  /** What is wrong with `ref` for `feature` (`null` = the default, which needs only to be enabled), or `null`. */
  private check(
    ref: AiModelRef,
    feature: AiFeatureDefinition | null,
    catalog: readonly CatalogRow[],
    policy: AiPolicy,
  ): AiAssignmentWarning | null {
    const name = `${ref.provider}/${ref.modelId}`;

    if (!this.providerLive(policy, ref.provider)) {
      return {
        code: AI_ASSIGNMENT_ISSUES.PROVIDER_DISABLED,
        message: `Provider "${ref.provider}" is not enabled in this deployment.`,
      };
    }

    const row = catalog.find((m) => m.provider === ref.provider && m.modelId === ref.modelId);

    if (!row) {
      return { code: AI_ASSIGNMENT_ISSUES.MODEL_NOT_FOUND, message: `Model ${name} is not in the catalog.` };
    }

    if (row.deprecated) {
      return { code: AI_ASSIGNMENT_ISSUES.MODEL_DEPRECATED, message: `Model ${name} is deprecated.` };
    }

    if (!row.enabled) {
      return { code: AI_ASSIGNMENT_ISSUES.MODEL_DISABLED, message: `Model ${name} is not enabled.` };
    }

    if (feature) {
      const missing = featureShortfall(feature, fit(row), this.supports);

      if (missing.length > 0) {
        return {
          code: AI_ASSIGNMENT_ISSUES.MODEL_INCAPABLE,
          message: `Model ${name} cannot serve ${feature.label} (missing ${missing.join(', ')}).`,
          missing,
        };
      }
    }

    return null;
  }

  private async readCatalog(): Promise<CatalogRow[]> {
    const rows = await this.prisma.aiModel.findMany({
      select: {
        provider: true,
        modelId: true,
        displayName: true,
        capabilities: true,
        enabled: true,
        deprecatedAt: true,
      },
    });

    return rows.map((row) => {
      const parsed = aiModelCapabilitiesSchema.safeParse(row.capabilities);

      return {
        provider: row.provider,
        modelId: row.modelId,
        displayName: row.displayName,
        capabilities: parsed.success ? parsed.data : EMPTY_AI_MODEL_CAPABILITIES,
        enabled: row.enabled,
        deprecated: row.deprecatedAt !== null,
      };
    });
  }

  /** The `global` settings row's provenance, WITHOUT creating it. */
  private async readRow(): Promise<SettingsRow> {
    return this.prisma.systemSettings.findUnique({
      where: { key: 'global' },
      select: {
        version: true,
        updatedAt: true,
        updatedByUser: { select: { id: true, email: true } },
      },
    });
  }
}

function fit(row: CatalogRow) {
  return {
    provider: row.provider,
    capabilities: row.capabilities.capabilities,
    inputModalities: row.capabilities.inputModalities,
  };
}

function toEligible(row: CatalogRow): AiEligibleModel {
  return {
    provider: row.provider,
    modelId: row.modelId,
    displayName: row.displayName ?? row.modelId,
    reasoningEfforts: row.capabilities.capabilities.includes('reasoning')
      ? [...(row.capabilities.reasoningEfforts ?? [])]
      : [],
  };
}

/** The body as it is stored: unassigned features dropped, efforts only where set. */
export function normalize(input: UpdateAiAssignmentsInput): SystemAiAssignmentsValue {
  const features: Record<string, AiFeatureAssignment> = {};

  for (const id of AI_FEATURE_IDS) {
    const assignment = input.features[id];
    if (!assignment) continue;

    features[id] = {
      provider: assignment.provider,
      modelId: assignment.modelId,
      ...(assignment.reasoningEffort != null ? { reasoningEffort: assignment.reasoningEffort } : {}),
    };
  }

  return {
    default: input.default ? { provider: input.default.provider, modelId: input.default.modelId } : null,
    features,
  };
}

/** Dotted NAMES of what changed (`default`, `features.<id>`) — never the model ids. */
export function diffAssignmentFields(before: SystemAiAssignmentsValue, after: SystemAiAssignmentsValue): string[] {
  const key = (value: AiFeatureAssignment | AiModelRef | null | undefined) =>
    value
      ? `${value.provider}\u0000${value.modelId}\u0000${'reasoningEffort' in value ? (value.reasoningEffort ?? '') : ''}`
      : '';
  const changed: string[] = [];

  if (key(before.default) !== key(after.default)) changed.push('default');

  for (const id of AI_FEATURE_IDS as readonly AiFeatureId[]) {
    if (key(before.features[id]) !== key(after.features[id])) changed.push(`features.${id}`);
  }

  return changed;
}
