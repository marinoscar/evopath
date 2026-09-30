import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TRAINING_AGENT_ROLES, type TrainingAgentRole } from '../common/schemas/settings.schema';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import type { FrozenRoleModel } from '../training-agents/graph/node-context';
import { countedTokens, parseRunUsage, runCapState, type UsageTotals } from '../training-agents/runtime/run-budget';
import {
  TRAINING_USAGE_MAX_MONTHS_BACK,
  TRAINING_USAGE_MONTH_INVALID,
  TRAINING_USAGE_RUN_KINDS,
  TRAINING_USAGE_TYPICAL_MIN_RUNS,
  TRAINING_USAGE_TYPICAL_WINDOW,
  UNATTRIBUTED_ROLE,
  type TrainingMonthlyUsage,
  type TrainingRunUsage,
  type TrainingRunUsageNode,
  type TrainingUsageBucket,
} from './dto/training-usage.dto';
import {
  NODE_ROLES,
  addBuckets,
  attributeRun,
  bucketOfGroup,
  emptyBucket,
  median,
  type AttributionUnit,
  type UsageRowGroup,
} from './training-usage.attribution';

// =============================================================================
// TrainingUsageService: agent usage per run and per month (E6.3)
// =============================================================================
//
// OWNER SCOPING IS IN THE SQL: every statement is keyed by the caller's id
// (`training_plan_runs.user_id` AND `ai_usage_events.user_id`); the routes
// hand in the JWT user and have no way to name anyone else. Another user's
// run is a 404, never an empty report.
//
// Every count and sum is cast at the database (`::int`, `::float8`) so Prisma
// never returns a `bigint`. Usage rows that belong to no agent run are
// excluded by the join through the run's job ids (`job_ids` plus the current
// `job_id`), so `/settings/ai`'s all-features report stays the place for them.
//
// Tokens, model and key source only; no currency (there is no price catalog).
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

/** The raw row shape of both usage statements (numbers cast in SQL). */
interface GroupRow {
  run_id: string;
  kind: string;
  provider: string;
  model_id: string;
  key_source: string;
  requests: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
  latency_ms: number;
}

interface RunForAttribution {
  id: string;
  kind: string;
  roleModels: unknown;
  usage: unknown;
}

export interface MonthRange {
  month: string;
  from: string;
  to: string;
  start: Date;
  end: Date;
}

const toInt = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

function toGroup(row: GroupRow): UsageRowGroup {
  return {
    runId: row.run_id,
    provider: row.provider,
    modelId: row.model_id,
    keySource: row.key_source,
    requests: toInt(row.requests),
    failed: toInt(row.failed),
    inputTokens: toInt(row.input_tokens),
    outputTokens: toInt(row.output_tokens),
    reasoningTokens: toInt(row.reasoning_tokens),
    cachedInputTokens: toInt(row.cached_input_tokens),
    latencyMs: toInt(row.latency_ms),
  };
}

/** The same aggregate columns for both statements. */
const AGGREGATES = Prisma.sql`
  count(*)::int AS requests,
  (count(*) FILTER (WHERE e.status = 'failed'))::int AS failed,
  coalesce(sum(e.input_tokens), 0)::float8 AS input_tokens,
  coalesce(sum(e.output_tokens), 0)::float8 AS output_tokens,
  coalesce(sum(e.reasoning_tokens), 0)::float8 AS reasoning_tokens,
  coalesce(sum(e.cached_input_tokens), 0)::float8 AS cached_input_tokens,
  coalesce(sum(e.latency_ms), 0)::float8 AS latency_ms`;

/**
 * Every (run, job) pair of the caller's runs: the jobs recorded in `job_ids`
 * plus the current `job_id` (`UNION` removes the overlap). `job_ids` is a
 * JSON array written by the kit; anything else reads as empty.
 */
function runJobsCte(userId: string, runId?: string): Prisma.Sql {
  return Prisma.sql`
    run_jobs AS (
      SELECT r.id AS run_id, r.kind AS kind, j.job_id AS job_id
      FROM training_plan_runs r
      CROSS JOIN LATERAL (
        SELECT (jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(r.job_ids) = 'array' THEN r.job_ids ELSE '[]'::jsonb END
        ))::uuid AS job_id
        UNION
        SELECT r.job_id
      ) j
      WHERE r.user_id = ${userId}::uuid
        AND j.job_id IS NOT NULL
        ${runId ? Prisma.sql`AND r.id = ${runId}::uuid` : Prisma.empty}
    )`;
}

@Injectable()
export class TrainingUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  // ---- per run ------------------------------------------------------------

  async runUsage(userId: string, runId: string): Promise<TrainingRunUsage> {
    const run = await this.prisma.trainingPlanRun.findFirst({
      where: { id: runId, userId },
      select: { id: true, kind: true, status: true, jobId: true, roleModels: true, usage: true, tokenCap: true, errorCode: true },
    });
    if (!run) throw new NotFoundException('Training run not found');

    const [rows, events, retentionDays] = await Promise.all([
      this.prisma.$queryRaw<GroupRow[]>(Prisma.sql`
        WITH ${runJobsCte(userId, run.id)}
        SELECT rj.run_id::text AS run_id, rj.kind AS kind, e.provider, e.model_id, e.key_source, ${AGGREGATES}
        FROM ai_usage_events e
        JOIN run_jobs rj ON rj.job_id = e.job_id
        WHERE e.user_id = ${userId}::uuid
        GROUP BY rj.run_id, rj.kind, e.provider, e.model_id, e.key_source
      `),
      this.prisma.trainingRunEvent.findMany({
        where: { runId: run.id, type: 'agent.usage' },
        select: { data: true },
        orderBy: { seq: 'asc' },
      }),
      this.retentionDays(),
    ]);

    const groups = (rows ?? []).map(toGroup);
    const tally = parseRunUsage(run.usage);
    const roleModels = frozenModels(run.roleModels);
    const fromEvents = nodeFactsFromEvents(events.map((e) => e.data));

    // The tally's nodes; the events' when the tally has none (an older write failed).
    const nodeTallies: Record<string, UsageTotals> =
      Object.keys(tally.byNode).length > 0 ? tally.byNode : Object.fromEntries([...fromEvents].map(([node, f]) => [node, f.tally]));

    const units: AttributionUnit[] = Object.entries(nodeTallies).map(([node, nodeTally]) => {
      const role = fromEvents.get(node)?.role ?? NODE_ROLES[node] ?? null;
      const model = role ? roleModels[role] : undefined;
      return {
        key: node,
        role,
        provider: model?.provider ?? fromEvents.get(node)?.provider ?? null,
        modelId: model?.modelId ?? fromEvents.get(node)?.modelId ?? null,
        keySource: model?.keySource ?? null,
        tally: nodeTally,
        latencyMs: fromEvents.get(node)?.latencyMs ?? 0,
      };
    });

    const attribution = attributeRun(units, groups);
    const byNode: TrainingRunUsageNode[] = attribution.units
      .map((unit) => ({
        node: unit.key,
        role: unit.role,
        provider: unit.provider,
        modelId: unit.modelId,
        keySource: unit.keySource,
        ...unit.bucket,
      }))
      .sort((a, b) => b.requests - a.requests || (a.node ?? '').localeCompare(b.node ?? ''));

    for (const rest of attribution.unattributed) {
      byNode.push({ node: null, role: null, provider: rest.provider, modelId: rest.modelId, keySource: rest.keySource, ...rest.bucket });
    }

    const purged = groups.length === 0 && tally.total.calls > 0;
    const totals = purged
      ? byNode.reduce<TrainingUsageBucket>((sum, row) => addBuckets(sum, bucketOnly(row)), emptyBucket())
      : groups.reduce<TrainingUsageBucket>((sum, group) => addBuckets(sum, bucketOfGroup(group)), emptyBucket());

    return {
      runId: run.id,
      jobId: run.jobId,
      kind: run.kind,
      status: run.status,
      totals,
      byNode,
      cap: runCapState(run.tokenCap, run.usage, run.errorCode),
      retention: { purged, retentionDays },
    };
  }

  // ---- per month ----------------------------------------------------------

  async monthlyUsage(userId: string, month: string | undefined, now: Date = new Date()): Promise<TrainingMonthlyUsage> {
    const range = resolveUsageMonth(month, now);

    const [rows, retentionDays, typical] = await Promise.all([
      this.prisma.$queryRaw<GroupRow[]>(Prisma.sql`
        WITH ${runJobsCte(userId)}
        SELECT rj.run_id::text AS run_id, rj.kind AS kind, e.provider, e.model_id, e.key_source, ${AGGREGATES}
        FROM ai_usage_events e
        JOIN run_jobs rj ON rj.job_id = e.job_id
        WHERE e.user_id = ${userId}::uuid
          AND e.created_at >= ${range.start}::timestamptz
          AND e.created_at < ${range.end}::timestamptz
        GROUP BY rj.run_id, rj.kind, e.provider, e.model_id, e.key_source
      `),
      this.retentionDays(),
      this.typical(userId),
    ]);

    const groups = (rows ?? []).map(toGroup);
    const kindOf = new Map((rows ?? []).map((row) => [row.run_id, row.kind]));
    const runIds = [...new Set(groups.map((g) => g.runId))];

    const runs: RunForAttribution[] =
      runIds.length === 0
        ? []
        : await this.prisma.trainingPlanRun.findMany({
            where: { id: { in: runIds }, userId },
            select: { id: true, kind: true, roleModels: true, usage: true },
          });

    let totals = emptyBucket();
    const byModel = new Map<string, TrainingUsageBucket & { provider: string; modelId: string }>();
    const byKeySource = new Map<string, TrainingUsageBucket>();
    const byKind = new Map<string, { bucket: TrainingUsageBucket; runs: Set<string> }>();

    for (const group of groups) {
      const bucket = bucketOfGroup(group);
      totals = addBuckets(totals, bucket);

      const modelKey = `${group.provider}\u0000${group.modelId}`;
      const model = byModel.get(modelKey);
      byModel.set(modelKey, { provider: group.provider, modelId: group.modelId, ...addBuckets(model ?? emptyBucket(), bucket) });

      byKeySource.set(group.keySource, addBuckets(byKeySource.get(group.keySource) ?? emptyBucket(), bucket));

      const kind = kindOf.get(group.runId) ?? 'unknown';
      const entry = byKind.get(kind) ?? { bucket: emptyBucket(), runs: new Set<string>() };
      entry.bucket = addBuckets(entry.bucket, bucket);
      entry.runs.add(group.runId);
      byKind.set(kind, entry);
    }

    const byRole = new Map<string, TrainingUsageBucket>();
    for (const run of runs) {
      const tally = parseRunUsage(run.usage);
      const roleModels = frozenModels(run.roleModels);
      const roles = new Set<TrainingAgentRole>([
        ...(Object.keys(roleModels) as TrainingAgentRole[]),
        ...(Object.keys(tally.byRole) as TrainingAgentRole[]),
      ]);
      const units: AttributionUnit[] = [...roles]
        .filter((role) => (TRAINING_AGENT_ROLES as readonly string[]).includes(role))
        .map((role) => ({
          key: role,
          role,
          provider: roleModels[role]?.provider ?? null,
          modelId: roleModels[role]?.modelId ?? null,
          keySource: roleModels[role]?.keySource ?? null,
          tally: tally.byRole[role] ?? { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
          latencyMs: 0,
        }));

      const attribution = attributeRun(
        units,
        groups.filter((g) => g.runId === run.id),
      );
      for (const unit of attribution.units) {
        byRole.set(unit.key, addBuckets(byRole.get(unit.key) ?? emptyBucket(), unit.bucket));
      }
      for (const rest of attribution.unattributed) {
        byRole.set(UNATTRIBUTED_ROLE, addBuckets(byRole.get(UNATTRIBUTED_ROLE) ?? emptyBucket(), rest.bucket));
      }
    }

    const roleOrder = [...TRAINING_AGENT_ROLES, UNATTRIBUTED_ROLE] as string[];
    const byRequests = <T extends { requests: number }>(a: T, b: T, ka: string, kb: string) =>
      b.requests - a.requests || ka.localeCompare(kb);

    return {
      month: range.month,
      range: { from: range.from, to: range.to },
      totals,
      byRole: [...byRole]
        .filter(([, bucket]) => bucket.requests > 0 || bucket.inputTokens > 0 || bucket.outputTokens > 0)
        .sort(([a], [b]) => roleOrder.indexOf(a) - roleOrder.indexOf(b))
        .map(([role, bucket]) => ({ role: role as TrainingAgentRole | typeof UNATTRIBUTED_ROLE, ...bucket })),
      byModel: [...byModel.values()].sort((a, b) =>
        byRequests(a, b, `${a.provider}:${a.modelId}`, `${b.provider}:${b.modelId}`),
      ),
      byKeySource: [...byKeySource]
        .map(([keySource, bucket]) => ({ keySource, ...bucket }))
        .sort((a, b) => byRequests(a, b, a.keySource, b.keySource)),
      byKind: [...byKind]
        .map(([kind, entry]) => ({ kind, runs: entry.runs.size, ...entry.bucket }))
        .sort((a, b) => byRequests(a, b, a.kind, b.kind)),
      typical,
      retention: { partial: range.start.getTime() < now.getTime() - retentionDays * DAY_MS, retentionDays },
    };
  }

  /**
   * The median counted tokens (the cap's count) of the caller's last 10
   * SUCCEEDED runs of each kind; `null` below 3 runs. From the run's own
   * tally, so it survives both retention windows of the usage rows and events.
   */
  async typical(userId: string): Promise<TrainingMonthlyUsage['typical']> {
    const rows = await this.prisma.$queryRaw<Array<{ kind: string; usage: unknown }>>(Prisma.sql`
      SELECT kind, usage
      FROM (
        SELECT kind, usage,
          row_number() OVER (PARTITION BY kind ORDER BY completed_at DESC NULLS LAST, created_at DESC) AS rn
        FROM training_plan_runs
        WHERE user_id = ${userId}::uuid AND status = 'succeeded'
      ) ranked
      WHERE rn <= ${TRAINING_USAGE_TYPICAL_WINDOW}
    `);

    const tokensByKind = new Map<string, number[]>();
    for (const row of rows ?? []) {
      tokensByKind.set(row.kind, [...(tokensByKind.get(row.kind) ?? []), countedTokens(parseRunUsage(row.usage).total)]);
    }

    const typicalOf = (kind: string) => {
      const tokens = tokensByKind.get(kind) ?? [];
      return tokens.length >= TRAINING_USAGE_TYPICAL_MIN_RUNS ? { runs: tokens.length, medianTokens: median(tokens) } : null;
    };

    return Object.fromEntries(TRAINING_USAGE_RUN_KINDS.map((kind) => [kind, typicalOf(kind)])) as TrainingMonthlyUsage['typical'];
  }

  private async retentionDays(): Promise<number> {
    const policy = await this.systemSettings.getAiPolicy();
    return policy.usageRetentionDays;
  }
}

/** The role models frozen on a run, read loosely (a missing or junk value is `{}`). */
function frozenModels(value: unknown): Partial<Record<TrainingAgentRole, FrozenRoleModel>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Partial<Record<TrainingAgentRole, FrozenRoleModel>>;
}

interface NodeFacts {
  role: TrainingAgentRole | null;
  provider: string | null;
  modelId: string | null;
  latencyMs: number;
  tally: UsageTotals;
}

/** Per node, from the run's `agent.usage` events: its role, model, latency and tally. */
export function nodeFactsFromEvents(events: readonly unknown[]): Map<string, NodeFacts> {
  const facts = new Map<string, NodeFacts>();

  for (const raw of events) {
    const data = (raw ?? {}) as Record<string, unknown>;
    if (typeof data.node !== 'string') continue;
    const role = (TRAINING_AGENT_ROLES as readonly string[]).includes(data.role as string) ? (data.role as TrainingAgentRole) : null;
    const prev = facts.get(data.node);
    facts.set(data.node, {
      role: prev?.role ?? role,
      provider: prev?.provider ?? (typeof data.provider === 'string' ? data.provider : null),
      modelId: prev?.modelId ?? (typeof data.model === 'string' ? data.model : null),
      latencyMs: (prev?.latencyMs ?? 0) + toInt(data.latencyMs),
      tally: {
        calls: (prev?.tally.calls ?? 0) + 1,
        inputTokens: (prev?.tally.inputTokens ?? 0) + toInt(data.inputTokens),
        outputTokens: (prev?.tally.outputTokens ?? 0) + toInt(data.outputTokens),
        reasoningTokens: (prev?.tally.reasoningTokens ?? 0) + toInt(data.reasoningTokens),
      },
    });
  }

  return facts;
}

function bucketOnly(row: TrainingRunUsageNode): TrainingUsageBucket {
  const { node: _node, role: _role, provider: _provider, modelId: _modelId, keySource: _keySource, ...bucket } = row;
  return bucket;
}

/**
 * The UTC month a monthly report covers. Default: the current UTC month.
 * Refused (400 `TRAINING_USAGE_MONTH_INVALID`) in the future or more than
 * `TRAINING_USAGE_MAX_MONTHS_BACK` months back. Pure, for unit tests.
 */
export function resolveUsageMonth(month: string | undefined, now: Date): MonthRange {
  const current = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  let start: Date;

  if (month === undefined) {
    start = new Date(current);
  } else {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
    if (!match) throw monthError(`"${month}" is not a month (YYYY-MM).`);
    start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  }

  const monthsBack =
    (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth());

  if (monthsBack < 0) throw monthError('The month is in the future.');
  if (monthsBack > TRAINING_USAGE_MAX_MONTHS_BACK) {
    throw monthError(`At most ${TRAINING_USAGE_MAX_MONTHS_BACK} months back are available.`);
  }

  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  return {
    month: iso(start).slice(0, 7),
    from: iso(start),
    to: iso(new Date(end.getTime() - DAY_MS)),
    start,
    end,
  };
}

function monthError(message: string): BadRequestException {
  return new BadRequestException({ message, details: { reason: TRAINING_USAGE_MONTH_INVALID } });
}
