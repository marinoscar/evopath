import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AiModel, Prisma } from '@prisma/client';

import { CredentialsService } from '../../credentials/credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AiCatalogService } from '../catalog/ai-catalog.service';
import { aiModelCapabilitiesSchema } from '../core/capabilities';
import { AiConfigAdminService } from './ai-config-admin.service';
import { AI_CREDENTIAL_PURPOSE, aiCredentialName } from './ai-credential.constants';
import {
  AI_CAPABILITY_SOURCES,
  type AiCapabilitySource,
  type AiModelListQuery,
  type AiModelView,
  type RefreshAiCatalogResult,
  type UpdateAiModelInput,
} from './dto/ai-model.dto';

// =============================================================================
// AiModelsAdminService — the model catalog, administered (#428, epic #419)
// =============================================================================
//
// Reads and edits `ai_models` rows directly. Discovery itself — inserting rows,
// classifying, deprecating — is the catalog sync's job (#427, the
// `ai.catalog.refresh` handler); this service only lets an administrator act on
// what discovery found, and ask for another discovery run — which it queues
// through `AiCatalogService.enqueueRefresh`, the one place that knows the job's
// type, subject and payload.
//
// The rules it enforces are docs/specs/ai-platform.md §2.17's:
//   - enabling is exclusively an administrator's act, and
//   - a deprecated model cannot be enabled (409), and
//   - an unclassified model must be classified (capabilities supplied) before
//     it can be enabled (400), and
//   - supplying capabilities marks the row `admin_override`, which a refresh
//     never overwrites.
// =============================================================================

@Injectable()
export class AiModelsAdminService {
  private readonly logger = new Logger(AiModelsAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly catalog: AiCatalogService,
    private readonly admin: AiConfigAdminService,
  ) {}

  /** `GET /api/admin/ai/models` — flat pagination, the `GET /api/admin/jobs` shape. */
  async list(query: AiModelListQuery): Promise<{
    items: AiModelView[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const { page, pageSize } = query;
    const where = buildModelWhere(query);

    const [rows, total] = await Promise.all([
      this.prisma.aiModel.findMany({
        where,
        orderBy: [{ provider: 'asc' }, { modelId: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.aiModel.count({ where }),
    ]);

    return {
      items: rows.map(toModelView),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /** `PATCH /api/admin/ai/models/:id`. */
  async update(id: string, input: UpdateAiModelInput, userId: string): Promise<AiModelView> {
    const row = await this.prisma.aiModel.findUnique({ where: { id } });

    if (!row) {
      throw new NotFoundException(`AI model ${id} not found.`);
    }

    if (input.enabled === true) {
      if (row.deprecatedAt) {
        throw new ConflictException({
          message:
            `"${row.modelId}" is no longer listed by ${row.provider} and cannot be enabled. ` +
            'It is re-offered for enablement if a catalog refresh sees it again.',
          details: { reason: 'AI_MODEL_DEPRECATED', modelId: row.modelId },
        });
      }

      if (row.capabilitySource === 'unclassified' && !input.capabilities) {
        throw new BadRequestException({
          message:
            `"${row.modelId}" has not been classified, so what it can do is unknown. Supply ` +
            '`capabilities` in the same request (or classify it first) before enabling it.',
          details: { reason: 'AI_MODEL_UNCLASSIFIED', modelId: row.modelId },
        });
      }
    }

    const data: Prisma.AiModelUpdateInput = {
      updatedByUser: { connect: { id: userId } },
    };
    const fields: string[] = [];

    if (input.enabled !== undefined) {
      data.enabled = input.enabled;
      fields.push('enabled');
    }

    if (input.displayName !== undefined) {
      data.displayName = input.displayName;
      fields.push('displayName');
    }

    if (input.capabilities !== undefined) {
      data.capabilities = input.capabilities as Prisma.InputJsonValue;
      data.capabilitySource = 'admin_override' satisfies AiCapabilitySource;
      // Keep the denormalised columns in step with an override that states them.
      if (input.capabilities.contextWindow !== undefined) {
        data.contextWindow = input.capabilities.contextWindow;
      }
      if (input.capabilities.maxOutputTokens !== undefined) {
        data.maxOutputTokens = input.capabilities.maxOutputTokens;
      }
      fields.push('capabilities');
    }

    const updated = await this.prisma.aiModel.update({ where: { id }, data });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'ai_model:update',
        targetType: 'ai_model',
        targetId: id,
        meta: { provider: row.provider, modelId: row.modelId, fields } as Prisma.InputJsonValue,
      },
    });

    this.logger.log(`AI model ${row.provider}/${row.modelId} updated by ${userId}: ${fields.join(',')}`);

    return toModelView(updated);
  }

  /**
   * `POST /api/admin/ai/models/refresh` — enqueue `ai.catalog.refresh` for one
   * provider. 409 when no admin key is stored: discovery runs under that key
   * (§2.17), so the job could only fail — unless the provider is keyless
   * (#448), which discovers with no key at all.
   *
   * Enqueued with the provider as the job's subject, so a second click while a
   * refresh is still pending or running returns that job instead of queueing a
   * duplicate (the queue's own dedup).
   */
  async refresh(provider: string, userId: string): Promise<RefreshAiCatalogResult> {
    this.admin.requireRegistered(provider);

    const key = await this.credentials.describe(AI_CREDENTIAL_PURPOSE, aiCredentialName(provider));

    // A keyless provider (#448: `requiresKey: false`) discovers with no key.
    if (!key && (await this.admin.providerRequiresKey(provider))) {
      throw new ConflictException({
        message: `No admin key is stored for "${provider}". Save one before refreshing its model catalog.`,
        details: { reason: 'AI_KEY_REQUIRED', provider },
      });
    }

    const job = await this.catalog.enqueueRefresh(provider, userId);

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'ai_catalog:refresh_requested',
        targetType: 'ai_config',
        targetId: provider,
        meta: { provider, jobId: job.id } as Prisma.InputJsonValue,
      },
    });

    return { jobId: job.id, status: job.status };
  }
}

/** The list filter, extracted so it can be asserted directly. */
export function buildModelWhere(query: AiModelListQuery): Prisma.AiModelWhereInput {
  const where: Prisma.AiModelWhereInput = {};

  if (query.provider) where.provider = query.provider;
  if (query.enabled !== undefined) where.enabled = query.enabled;
  if (!query.includeDeprecated) where.deprecatedAt = null;

  if (query.capability) {
    where.capabilities = { path: ['capabilities'], array_contains: [query.capability] };
  }

  if (query.q) {
    where.OR = [
      { modelId: { contains: query.q, mode: 'insensitive' } },
      { displayName: { contains: query.q, mode: 'insensitive' } },
    ];
  }

  return where;
}

/** A row as the API publishes it. Capabilities are re-validated on the way out. */
export function toModelView(row: AiModel): AiModelView {
  const capabilities = aiModelCapabilitiesSchema.safeParse(row.capabilities);
  const source = (AI_CAPABILITY_SOURCES as readonly string[]).includes(row.capabilitySource)
    ? (row.capabilitySource as AiCapabilitySource)
    : 'unclassified';

  return {
    id: row.id,
    provider: row.provider,
    modelId: row.modelId,
    displayName: row.displayName,
    capabilities: capabilities.success ? capabilities.data : null,
    capabilitySource: source,
    enabled: row.enabled,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    discoveredAt: row.discoveredAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    deprecatedAt: row.deprecatedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    updatedByUserId: row.updatedByUserId,
  };
}
