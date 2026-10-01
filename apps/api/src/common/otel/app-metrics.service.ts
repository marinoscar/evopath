// =============================================================================
// Application metrics (issue #125, epic A)
// =============================================================================
//
// THE ONE PLACE `apps/api/src` CREATES OPENTELEMETRY INSTRUMENTS. Every
// business-level number the API exports — queue throughput, backup outcomes,
// sign-ins, AI usage, notification deliveries — goes through a typed method
// here, so the metric names, units and attribute keys live in exactly one file
// and a call site cannot invent a label.
//
// ONE SANCTIONED SIBLING: `nodes/node-fleet-metrics.service.ts` (#131) creates
// the `app.nodes.*` gauges, because its callback needs `NodeOffloadService` and
// the fleet policy, which this global module cannot import without a cycle. It
// takes its meter, clock and gate from `gaugeContext()` and its names from
// `APP_METRIC_NAMES` below, so the conventions still have one owner.
//
// -----------------------------------------------------------------------------
// OFF MEANS NO-OP, FOR FREE
// -----------------------------------------------------------------------------
//
// The meter is `metrics.getMeter('app')` from `@opentelemetry/api`. When
// `OTEL_ENABLED` is not `true`, `instrumentation.ts` installs no SDK, the
// global MeterProvider is the API's no-op one, and every instrument below is a
// no-op: a counter `add()` costs a function call. When the SDK IS installed
// but the `telemetry.enabled` setting is off, instruments still aggregate in
// memory and the gated exporter drops each batch (`telemetry-gate.ts`).
//
// The OBSERVABLE GAUGES are different, because their callbacks query the
// database. They are registered only when `otel.enabled` (the same
// `OTEL_ENABLED` switch) is true, and each callback also returns early while
// the runtime gate is closed — so a deployment with telemetry off never pays
// for a single `SELECT` on this account.
//
// -----------------------------------------------------------------------------
// NAMES, UNITS, TABLES
// -----------------------------------------------------------------------------
//
// GreptimeDB stores OTLP metrics Prometheus-style, one table per metric, with
// the name's dots turned into underscores and the unit appended as a suffix
// (`v8js.memory.heap.used` + `By` → `v8js_memory_heap_used_bytes`; see
// docs/specs/telemetry.md §11.3). So:
//
//   - every name carries the `app.` prefix, so application tables sort
//     together and can never collide with a runtime or library metric;
//   - durations are SECONDS (`s` → `_seconds`), sizes BYTES (`By` → `_bytes`),
//     instants UNIX SECONDS (`s`);
//   - counts use a curly-brace annotation (`{job}`), which carries no suffix;
//     monotonic counters additionally get `_total` under Prometheus naming.
//
// Attribute keys are snake_case without dots (`job_type`, not `job.type`):
// they become columns, and a dotted column must be double-quoted in every SQL
// statement that reads it.
//
// -----------------------------------------------------------------------------
// LOW CARDINALITY, ENFORCED HERE
// -----------------------------------------------------------------------------
//
// Attributes are job type, status/outcome, executor, provider, model,
// operation, channel and notification event key — NEVER a user id, an email,
// a URL or an error message. Every free-form string passes `boundLabel`: it
// must look like an identifier (≤ 64 chars of `[A-Za-z0-9_.:/@+-]`, never
// address-shaped), and each
// attribute key admits at most `MAX_DISTINCT_VALUES` distinct values per
// process; anything else becomes `other`. Enumerated attributes (outcomes) are
// checked against their allowed set and fall back to `other` too.
//
// -----------------------------------------------------------------------------
// NEVER THROWS
// -----------------------------------------------------------------------------
//
// Every public method is wrapped: a metrics fault must never reach the job
// runner, the auth flow or a delivery. Gauge callbacks log at `debug` and skip
// the observation on any failure.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  metrics,
  type Attributes,
  type BatchObservableResult,
  type Counter,
  type Histogram,
  type Meter,
  type ObservableGauge,
} from '@opentelemetry/api';

import { PrismaService } from '../../prisma/prisma.service';
import { telemetryGate } from './telemetry-gate';

/** The instrumentation scope every application metric is created under. */
export const APP_METER_NAME = 'app';

/** Optional test seam: an explicit meter, clock and gate. Unprovided in production. */
export const APP_METRICS_OPTIONS = Symbol('APP_METRICS_OPTIONS');

export interface AppMetricsOptions {
  meter?: Meter;
  now?: () => number;
  /** Whether the runtime export gate is open. Defaults to `telemetryGate.isEnabled()`. */
  gateOpen?: () => boolean;
  /** Forces gauge registration on or off. Defaults to the `otel.enabled` config value. */
  gauges?: boolean;
}

/** Every metric name, in one place (the docs quote this table). */
export const APP_METRIC_NAMES = {
  jobsEnqueued: 'app.jobs.enqueued',
  jobsClaimed: 'app.jobs.claimed',
  jobsSettled: 'app.jobs.settled',
  jobsDuration: 'app.jobs.duration',
  jobsReaped: 'app.jobs.reaped',
  jobsQueueDepth: 'app.jobs.queue.depth',
  jobsOldestPendingAge: 'app.jobs.oldest_pending.age',
  backupRuns: 'app.backup.runs',
  backupDuration: 'app.backup.duration',
  backupSize: 'app.backup.size',
  backupLastSuccessTimestamp: 'app.backup.last_success.timestamp',
  backupLastSuccessSize: 'app.backup.last_success.size',
  authLogins: 'app.auth.logins',
  authRefreshes: 'app.auth.refreshes',
  aiRequests: 'app.ai.requests',
  aiTokens: 'app.ai.tokens',
  aiDuration: 'app.ai.request.duration',
  notificationDeliveries: 'app.notifications.deliveries',
  healthDocumentPurges: 'app.health.documents.purges',
  // AI health summary (H8, #192): the `ai.health.summary` job.
  healthSummaryGenerations: 'app.health.summary.generations',
  healthSummaryDuration: 'app.health.summary.duration',
  healthSummaryRegenerations: 'app.health.summary.regenerations',
  healthSummaryPostCheckRejections: 'app.health.summary.post_check_rejections',
  healthSummaryTokens: 'app.health.summary.tokens',
  // Worker-node fleet gauges (#131). Created by `nodes/node-fleet-metrics.service.ts`
  // through `gaugeContext()`, because they read the nodes module's services.
  nodesCount: 'app.nodes.count',
  nodesCpuUtilization: 'app.nodes.cpu.utilization',
  nodesMemoryRss: 'app.nodes.memory.rss',
  nodesHeapUsed: 'app.nodes.heap.used',
  nodesHeapLimit: 'app.nodes.heap.limit',
  nodesEventLoopDelayP99: 'app.nodes.event_loop.delay.p99',
  nodesStateDirFree: 'app.nodes.state_dir.free',
  nodesStateDirTotal: 'app.nodes.state_dir.total',
  nodesSlotsUsed: 'app.nodes.slots.used',
  nodesSlotsTotal: 'app.nodes.slots.total',
  nodesUptime: 'app.nodes.uptime',
  nodesCounter: 'app.nodes.counter',
  nodesTypesNoEligibleNode: 'app.nodes.types.no_eligible_node',
} as const;

/** How long one gauge snapshot is reused across collections and callbacks. */
export const GAUGE_CACHE_TTL_MS = 30_000;

/** Per attribute key, how many distinct free-form values are admitted before `other`. */
export const MAX_DISTINCT_VALUES = 100;

const MAX_LABEL_LENGTH = 64;
const LABEL_PATTERN = /^[A-Za-z0-9_.:/@+-]+$/;
/** `@` is allowed for versioned model ids (`model@20240620`), never for an address. */
const EMAIL_LIKE = /@[^@]*\./;

export const OTHER_LABEL = 'other';
export const UNKNOWN_LABEL = 'unknown';

// Histogram buckets, in the instrument's unit (seconds).
const JOB_DURATION_BUCKETS_S = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];
const BACKUP_DURATION_BUCKETS_S = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 14400];
const BACKUP_SIZE_BUCKETS_BY = [
  1e6, 1e7, 5e7, 1e8, 5e8, 1e9, 5e9, 1e10, 5e10, 1e11,
];
const AI_DURATION_BUCKETS_S = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300];

// ---- Enumerated attribute values -------------------------------------------

export type JobExecutorLabel = 'server' | 'node';
const JOB_EXECUTORS = new Set<string>(['server', 'node']);

/** `JobSettleOutcome` values, mirrored so this file does not import the queue. */
const JOB_SETTLE_OUTCOMES = new Set<string>([
  'succeeded',
  'failed',
  'retry-scheduled',
  'rate-limit-deferred',
  'claim-lost',
  'write-failed',
]);

export type JobReapOutcome = 'requeued' | 'failed';

/** The queue statuses the depth gauge reports (terminal rows are history, not depth). */
const DEPTH_STATUSES = ['pending', 'running'] as const;

export type BackupOutcome = 'completed' | 'failed';

export type AuthLoginOutcome = 'success' | 'allowlist_rejected' | 'disabled';
const AUTH_LOGIN_OUTCOMES = new Set<string>(['success', 'allowlist_rejected', 'disabled']);

export type AuthRefreshOutcome =
  | 'success'
  | 'invalid'
  | 'reuse_detected'
  | 'expired'
  | 'user_inactive'
  | 'device_revoked';
const AUTH_REFRESH_OUTCOMES = new Set<string>([
  'success',
  'invalid',
  'reuse_detected',
  'expired',
  'user_inactive',
  'device_revoked',
]);

const AI_STATUSES = new Set<string>(['succeeded', 'failed', 'cancelled']);

export type NotificationDeliveryOutcome = 'sent' | 'failed' | 'rate_limited' | 'error';

/** How one `health.document.purge` attempt ended (H1, #185). */
export type HealthDocumentPurgeOutcome = 'purged' | 'failed';
const HEALTH_DOCUMENT_PURGE_OUTCOMES = new Set<string>(['purged', 'failed']);

/**
 * How one `ai.health.summary` job ended (H8, #192): a summary stored
 * (`ready`), rejected twice by the post-check (`rejected`), failed
 * (`failed`), nothing to do (`skipped`: consent off, no data, unchanged) or
 * deferred by a provider throttle (`deferred`).
 */
export type HealthSummaryOutcome = 'ready' | 'rejected' | 'failed' | 'skipped' | 'deferred';
const HEALTH_SUMMARY_OUTCOMES = new Set<string>(['ready', 'rejected', 'failed', 'skipped', 'deferred']);
const HEALTH_SUMMARY_DURATION_BUCKETS_S = [0.05, 0.25, 1, 2.5, 5, 10, 20, 30, 60, 120, 240];

/** The counts one summary job reports besides its outcome. */
export interface HealthSummaryCounts {
  regenerations: number;
  rejections: number;
  inputTokens: number;
  outputTokens: number;
}
const NOTIFICATION_OUTCOMES = new Set<string>(['sent', 'failed', 'rate_limited', 'error']);

export interface AiUsageMetric {
  provider: string;
  model: string;
  operation: string;
  status: string;
  keySource?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs: number;
}

/** One cached read of the database-backed gauges. */
export interface GaugeSnapshot {
  depth: Array<{ type: string; status: string; count: number }>;
  oldestPendingAgeSeconds: Array<{ type: string; ageSeconds: number }>;
  backupLastSuccess: { finishedAtSeconds: number; sizeBytes: number } | null;
}

/**
 * The SHAPE half of {@link AppMetricsService.boundLabel}, with no distinct-value
 * budget: `unknown` when empty, `other` when the value is not identifier-shaped
 * (≤ 64 chars of `[A-Za-z0-9_.:/@+-]`, never address-shaped), else the trimmed
 * value. For a label that is functionally dependent on another, already-bounded
 * one (a node's name beside its capped `node_id`), where a per-process budget
 * would only fold real values into `other` without bounding anything.
 */
export function shapeLabel(value: unknown): string {
  if (typeof value !== 'string') return UNKNOWN_LABEL;
  const trimmed = value.trim();
  if (trimmed.length === 0) return UNKNOWN_LABEL;
  if (trimmed.length > MAX_LABEL_LENGTH || !LABEL_PATTERN.test(trimmed) || EMAIL_LIKE.test(trimmed)) {
    return OTHER_LABEL;
  }
  return trimmed;
}

/** What a sibling gauge provider needs to follow this service's conventions. */
export interface AppGaugeContext {
  /** The `app` meter. */
  meter: Meter;
  now: () => number;
  /** Whether the runtime export gate is open; a callback queries nothing while it is closed. */
  gateOpen: () => boolean;
}

/** An enumerated value, or `other`. */
function enumLabel(value: unknown, allowed: Set<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : OTHER_LABEL;
}

/** Non-negative finite number, or `null`. */
function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

@Injectable()
export class AppMetricsService implements OnModuleInit {
  private readonly logger = new Logger(AppMetricsService.name);

  private readonly meter: Meter;
  private readonly now: () => number;
  private readonly gateOpen: () => boolean;
  private readonly gaugesForced: boolean | undefined;

  private readonly jobsEnqueued: Counter;
  private readonly jobsClaimed: Counter;
  private readonly jobsSettled: Counter;
  private readonly jobsDuration: Histogram;
  private readonly jobsReaped: Counter;
  private readonly backupRuns: Counter;
  private readonly backupDuration: Histogram;
  private readonly backupSize: Histogram;
  private readonly authLogins: Counter;
  private readonly authRefreshes: Counter;
  private readonly aiRequests: Counter;
  private readonly aiTokens: Counter;
  private readonly aiDuration: Histogram;
  private readonly notificationDeliveries: Counter;
  private readonly healthDocumentPurges: Counter;
  private readonly healthSummaryGenerations: Counter;
  private readonly healthSummaryDuration: Histogram;
  private readonly healthSummaryRegenerations: Counter;
  private readonly healthSummaryPostCheckRejections: Counter;
  private readonly healthSummaryTokens: Counter;

  /** Distinct free-form values admitted so far, per attribute key. */
  private readonly seen = new Map<string, Set<string>>();

  private gaugesRegistered = false;
  private snapshotCache: { at: number; value: GaugeSnapshot } | null = null;
  private snapshotInFlight: Promise<GaugeSnapshot | null> | null = null;

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly config?: ConfigService,
    @Optional() @Inject(APP_METRICS_OPTIONS) options?: AppMetricsOptions,
  ) {
    // Resolved at construction, which is after `instrumentation.ts` has run
    // (`main.ts` imports it first), so this is the SDK's meter when there is
    // one and the API's no-op meter otherwise.
    this.meter = options?.meter ?? metrics.getMeter(APP_METER_NAME);
    this.now = options?.now ?? Date.now;
    this.gateOpen = options?.gateOpen ?? (() => telemetryGate.isEnabled());
    this.gaugesForced = options?.gauges;

    const m = this.meter;
    const N = APP_METRIC_NAMES;

    this.jobsEnqueued = m.createCounter(N.jobsEnqueued, {
      description: 'Jobs inserted into the queue (dedup hits excluded).',
      unit: '{job}',
    });
    this.jobsClaimed = m.createCounter(N.jobsClaimed, {
      description: 'Jobs claimed by an executor.',
      unit: '{job}',
    });
    this.jobsSettled = m.createCounter(N.jobsSettled, {
      description: 'Executor reports settled by the terminal state machine, by outcome.',
      unit: '{job}',
    });
    this.jobsDuration = m.createHistogram(N.jobsDuration, {
      description: 'Run time of one job attempt, from claim to settlement.',
      unit: 's',
      advice: { explicitBucketBoundaries: JOB_DURATION_BUCKETS_S },
    });
    this.jobsReaped = m.createCounter(N.jobsReaped, {
      description: 'Abandoned running jobs recovered by the lease reaper.',
      unit: '{job}',
    });
    this.backupRuns = m.createCounter(N.backupRuns, {
      description: 'Database backup runs settled, by outcome.',
      unit: '{run}',
    });
    this.backupDuration = m.createHistogram(N.backupDuration, {
      description: 'Wall time of a settled database backup run.',
      unit: 's',
      advice: { explicitBucketBoundaries: BACKUP_DURATION_BUCKETS_S },
    });
    this.backupSize = m.createHistogram(N.backupSize, {
      description: 'Size of a completed, verified database backup archive.',
      unit: 'By',
      advice: { explicitBucketBoundaries: BACKUP_SIZE_BUCKETS_BY },
    });
    this.authLogins = m.createCounter(N.authLogins, {
      description: 'Interactive sign-in attempts, by provider and outcome.',
      unit: '{login}',
    });
    this.authRefreshes = m.createCounter(N.authRefreshes, {
      description: 'Refresh-token rotations, by outcome.',
      unit: '{refresh}',
    });
    this.aiRequests = m.createCounter(N.aiRequests, {
      description: 'AI provider round-trips, by provider, model, operation and status.',
      unit: '{request}',
    });
    this.aiTokens = m.createCounter(N.aiTokens, {
      description: 'AI tokens reported by the provider, by token_type (input|output).',
      unit: '{token}',
    });
    this.aiDuration = m.createHistogram(N.aiDuration, {
      description: 'Latency of one AI provider round-trip.',
      unit: 's',
      advice: { explicitBucketBoundaries: AI_DURATION_BUCKETS_S },
    });
    this.notificationDeliveries = m.createCounter(N.notificationDeliveries, {
      description: 'Notification delivery attempts, by channel, event and outcome.',
      unit: '{delivery}',
    });
    this.healthDocumentPurges = m.createCounter(N.healthDocumentPurges, {
      description: 'Health document file purges (delete after processing), by outcome.',
      unit: '{document}',
    });
    this.healthSummaryGenerations = m.createCounter(N.healthSummaryGenerations, {
      description: 'AI health summary jobs, by outcome.',
      unit: '{summary}',
    });
    this.healthSummaryDuration = m.createHistogram(N.healthSummaryDuration, {
      description: 'Wall time of one AI health summary job, by outcome.',
      unit: 's',
      advice: { explicitBucketBoundaries: HEALTH_SUMMARY_DURATION_BUCKETS_S },
    });
    this.healthSummaryRegenerations = m.createCounter(N.healthSummaryRegenerations, {
      description: 'AI health summary answers asked for again after a post-check rejection.',
      unit: '{regeneration}',
    });
    this.healthSummaryPostCheckRejections = m.createCounter(N.healthSummaryPostCheckRejections, {
      description: 'AI health summary answers rejected by the post-check.',
      unit: '{answer}',
    });
    this.healthSummaryTokens = m.createCounter(N.healthSummaryTokens, {
      description: 'Tokens the AI health summary used, by token_type (input|output).',
      unit: '{token}',
    });
  }

  onModuleInit(): void {
    this.registerGauges();
  }

  // ===========================================================================
  // Jobs
  // ===========================================================================

  /** A job row was inserted (not a dedup collapse onto an existing row). */
  jobEnqueued(type: string): void {
    this.safely(() => this.jobsEnqueued.add(1, { job_type: this.boundLabel('job_type', type) }));
  }

  /** `count` jobs of `type` were claimed by `executor`. */
  jobsClaimedBy(executor: string, types: readonly string[]): void {
    this.safely(() => {
      const byType = new Map<string, number>();
      for (const type of types) {
        const label = this.boundLabel('job_type', type);
        byType.set(label, (byType.get(label) ?? 0) + 1);
      }
      const exec = enumLabel(executor, JOB_EXECUTORS);
      for (const [jobType, count] of byType) {
        this.jobsClaimed.add(count, { job_type: jobType, executor: exec });
      }
    });
  }

  /**
   * One executor report was settled with `outcome` (a `JobSettleOutcome`).
   * `durationMs` is claim → settlement; omitted (null) when unknown.
   */
  jobSettled(
    type: string,
    outcome: string,
    durationMs: number | null,
    executor?: string | null,
  ): void {
    this.safely(() => {
      const attrs: Attributes = {
        job_type: this.boundLabel('job_type', type),
        outcome: enumLabel(outcome, JOB_SETTLE_OUTCOMES),
        executor: executor ? enumLabel(executor, JOB_EXECUTORS) : UNKNOWN_LABEL,
      };
      this.jobsSettled.add(1, attrs);
      const ms = nonNegative(durationMs);
      if (ms !== null) this.jobsDuration.record(ms / 1000, attrs);
    });
  }

  /**
   * The lease reaper recovered `count` jobs. `type` is known for the rows it
   * failed permanently (read one by one) and not for the requeued ones (one
   * `updateMany` per attempt budget), which are reported without `job_type`.
   */
  leaseReaped(outcome: JobReapOutcome, count: number, type?: string): void {
    this.safely(() => {
      if (!(count > 0)) return;
      const attrs: Attributes = { outcome: enumLabel(outcome, new Set(['requeued', 'failed'])) };
      if (type !== undefined) attrs.job_type = this.boundLabel('job_type', type);
      this.jobsReaped.add(count, attrs);
    });
  }

  // ===========================================================================
  // Database backup
  // ===========================================================================

  /** A backup run settled. `sizeBytes` is recorded only for a completed run. */
  backupSettled(outcome: BackupOutcome, durationMs: number | null, sizeBytes?: number | bigint | null): void {
    this.safely(() => {
      const attrs: Attributes = { outcome: enumLabel(outcome, new Set(['completed', 'failed'])) };
      this.backupRuns.add(1, attrs);
      const ms = nonNegative(durationMs);
      if (ms !== null) this.backupDuration.record(ms / 1000, attrs);
      if (outcome === 'completed') {
        const size = nonNegative(typeof sizeBytes === 'bigint' ? Number(sizeBytes) : sizeBytes);
        if (size !== null) this.backupSize.record(size, attrs);
      }
    });
  }

  // ===========================================================================
  // Auth
  // ===========================================================================

  authLogin(outcome: AuthLoginOutcome, provider = 'google'): void {
    this.safely(() =>
      this.authLogins.add(1, {
        provider: this.boundLabel('auth_provider', provider),
        outcome: enumLabel(outcome, AUTH_LOGIN_OUTCOMES),
      }),
    );
  }

  authRefresh(outcome: AuthRefreshOutcome): void {
    this.safely(() =>
      this.authRefreshes.add(1, { outcome: enumLabel(outcome, AUTH_REFRESH_OUTCOMES) }),
    );
  }

  // ===========================================================================
  // AI
  // ===========================================================================

  aiUsage(event: AiUsageMetric): void {
    this.safely(() => {
      const base: Attributes = {
        provider: this.boundLabel('ai_provider', event.provider),
        model: this.boundLabel('ai_model', event.model),
        operation: this.boundLabel('ai_operation', event.operation),
      };
      const withStatus: Attributes = {
        ...base,
        status: enumLabel(event.status, AI_STATUSES),
        key_source: event.keySource
          ? this.boundLabel('ai_key_source', event.keySource)
          : UNKNOWN_LABEL,
      };

      this.aiRequests.add(1, withStatus);

      const ms = nonNegative(event.latencyMs);
      if (ms !== null) this.aiDuration.record(ms / 1000, withStatus);

      const input = nonNegative(event.inputTokens);
      if (input !== null && input > 0) this.aiTokens.add(Math.round(input), { ...base, token_type: 'input' });
      const output = nonNegative(event.outputTokens);
      if (output !== null && output > 0) this.aiTokens.add(Math.round(output), { ...base, token_type: 'output' });
    });
  }

  // ===========================================================================
  // Notifications
  // ===========================================================================

  notificationDelivery(channel: string, outcome: NotificationDeliveryOutcome, eventKey?: string): void {
    this.safely(() =>
      this.notificationDeliveries.add(1, {
        channel: this.boundLabel('notification_channel', channel),
        event: eventKey ? this.boundLabel('notification_event', eventKey) : UNKNOWN_LABEL,
        outcome: enumLabel(outcome, NOTIFICATION_OUTCOMES),
      }),
    );
  }

  // ===========================================================================
  // Health documents
  // ===========================================================================

  /** One `health.document.purge` attempt ended: the file was erased, or the attempt failed (and is retried). */
  healthDocumentPurge(outcome: HealthDocumentPurgeOutcome): void {
    this.safely(() =>
      this.healthDocumentPurges.add(1, { outcome: enumLabel(outcome, HEALTH_DOCUMENT_PURGE_OUTCOMES) }),
    );
  }

  // ===========================================================================
  // AI health summary
  // ===========================================================================

  /** One `ai.health.summary` job ended; `counts` when a model was called. */
  healthSummaryGenerated(outcome: HealthSummaryOutcome, durationMs: number | null, counts?: HealthSummaryCounts): void {
    this.safely(() => {
      const attrs: Attributes = { outcome: enumLabel(outcome, HEALTH_SUMMARY_OUTCOMES) };
      this.healthSummaryGenerations.add(1, attrs);
      const ms = nonNegative(durationMs);
      if (ms !== null) this.healthSummaryDuration.record(ms / 1000, attrs);
      if (!counts) return;
      const regenerations = nonNegative(counts.regenerations);
      if (regenerations) this.healthSummaryRegenerations.add(Math.round(regenerations));
      const rejections = nonNegative(counts.rejections);
      if (rejections) this.healthSummaryPostCheckRejections.add(Math.round(rejections));
      const input = nonNegative(counts.inputTokens);
      if (input) this.healthSummaryTokens.add(Math.round(input), { token_type: 'input' });
      const output = nonNegative(counts.outputTokens);
      if (output) this.healthSummaryTokens.add(Math.round(output), { token_type: 'output' });
    });
  }

  // ===========================================================================
  // Label bounding
  // ===========================================================================

  /**
   * A free-form string as a low-cardinality label: `unknown` when empty,
   * `other` when it does not look like an identifier, is too long, or would be
   * the `MAX_DISTINCT_VALUES + 1`-th distinct value for `key`.
   */
  boundLabel(key: string, value: unknown): string {
    const trimmed = shapeLabel(value);
    if (trimmed === UNKNOWN_LABEL || trimmed === OTHER_LABEL) return trimmed;

    let seen = this.seen.get(key);
    if (!seen) {
      seen = new Set();
      this.seen.set(key, seen);
    }
    if (seen.has(trimmed)) return trimmed;
    if (seen.size >= MAX_DISTINCT_VALUES) return OTHER_LABEL;
    seen.add(trimmed);
    return trimmed;
  }

  // ===========================================================================
  // Observable gauges
  // ===========================================================================

  /** Whether DB-backed gauges may be registered in this process (`otel.enabled`). */
  private gaugesEnabled(): boolean {
    return this.gaugesForced ?? this.config?.get<boolean>('otel.enabled') === true;
  }

  /**
   * The meter, clock and export gate for a SIBLING gauge provider that lives in
   * a feature module (it needs that module's services, so it cannot live here
   * without a module cycle) — `null` when gauges are off in this process, in
   * which case the caller registers nothing. `NodeFleetMetrics` is the reader.
   */
  gaugeContext(): AppGaugeContext | null {
    if (!this.gaugesEnabled()) return null;
    return { meter: this.meter, now: this.now, gateOpen: this.gateOpen };
  }

  /** Registers the DB-backed gauges once, only when OTel is enabled for this process. */
  registerGauges(): void {
    if (this.gaugesRegistered || !this.prisma) return;

    if (!this.gaugesEnabled()) return;

    try {
      const N = APP_METRIC_NAMES;
      const depth = this.meter.createObservableGauge(N.jobsQueueDepth, {
        description: 'Jobs currently pending or running, by type and status.',
        unit: '{job}',
      });
      const oldest = this.meter.createObservableGauge(N.jobsOldestPendingAge, {
        description: 'Age of the oldest runnable pending job, by type.',
        unit: 's',
      });
      const lastSuccessAt = this.meter.createObservableGauge(N.backupLastSuccessTimestamp, {
        description: 'When the most recent completed database backup finished (unix seconds).',
        unit: 's',
      });
      const lastSuccessSize = this.meter.createObservableGauge(N.backupLastSuccessSize, {
        description: 'Size of the most recent completed database backup archive.',
        unit: 'By',
      });

      this.meter.addBatchObservableCallback(
        (result) => this.observeGauges(result, { depth, oldest, lastSuccessAt, lastSuccessSize }),
        [depth, oldest, lastSuccessAt, lastSuccessSize],
      );
      this.gaugesRegistered = true;
    } catch (error) {
      this.logger.debug(`Could not register application gauges: ${describe(error)}`);
    }
  }

  /** The batch callback. Never throws; observes nothing when the snapshot is unavailable. */
  async observeGauges(
    result: BatchObservableResult,
    gauges: {
      depth: ObservableGauge;
      oldest: ObservableGauge;
      lastSuccessAt: ObservableGauge;
      lastSuccessSize: ObservableGauge;
    },
  ): Promise<void> {
    try {
      const snap = await this.gaugeSnapshot();
      if (!snap) return;

      for (const row of snap.depth) {
        result.observe(gauges.depth, row.count, { job_type: row.type, status: row.status });
      }
      for (const row of snap.oldestPendingAgeSeconds) {
        result.observe(gauges.oldest, row.ageSeconds, { job_type: row.type });
      }
      if (snap.backupLastSuccess) {
        result.observe(gauges.lastSuccessAt, snap.backupLastSuccess.finishedAtSeconds);
        result.observe(gauges.lastSuccessSize, snap.backupLastSuccess.sizeBytes);
      }
    } catch (error) {
      this.logger.debug(`Application gauge callback skipped: ${describe(error)}`);
    }
  }

  /**
   * The cached snapshot: reused for `GAUGE_CACHE_TTL_MS`, with at most one
   * query round in flight. `null` while the export gate is closed (nothing
   * would leave the process, so nothing is queried) or when the read failed.
   */
  async gaugeSnapshot(): Promise<GaugeSnapshot | null> {
    if (!this.gateOpen()) return null;

    const cached = this.snapshotCache;
    if (cached && this.now() - cached.at < GAUGE_CACHE_TTL_MS) return cached.value;

    if (!this.snapshotInFlight) {
      this.snapshotInFlight = this.readSnapshot()
        .then((value) => {
          this.snapshotCache = { at: this.now(), value };
          return value;
        })
        .catch((error: unknown) => {
          this.logger.debug(`Application gauge read failed: ${describe(error)}`);
          return null;
        })
        .finally(() => {
          this.snapshotInFlight = null;
        });
    }

    return this.snapshotInFlight;
  }

  /**
   * THREE CHEAP AGGREGATES:
   *
   *   1. depth — `groupBy(type, status)` restricted to the two live statuses,
   *      served by the `jobs(status, type, id)` covering index (the same one
   *      `JobAdminService.stats()` leans on);
   *   2. oldest runnable pending — `min(created_at)` per type over `pending`
   *      rows that are due (`scheduled_for` null or past), so a job waiting
   *      out a retry backoff does not read as a stalled queue;
   *   3. the newest `completed` backup run (a small table).
   */
  private async readSnapshot(): Promise<GaugeSnapshot> {
    const prisma = this.prisma as PrismaService;
    const takenAt = new Date(this.now());

    const [depthRows, oldestRows, lastBackup] = await Promise.all([
      prisma.job.groupBy({
        by: ['type', 'status'],
        where: { status: { in: [...DEPTH_STATUSES] } },
        _count: { _all: true },
      }),
      prisma.job.groupBy({
        by: ['type'],
        where: {
          status: 'pending',
          OR: [{ scheduledFor: null }, { scheduledFor: { lte: takenAt } }],
        },
        _min: { createdAt: true },
      }),
      prisma.databaseBackupRun.findFirst({
        where: { status: 'completed', finishedAt: { not: null } },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true, sizeBytes: true },
      }),
    ]);

    const depth = depthRows.map((row) => ({
      type: this.boundLabel('job_type', row.type),
      status: String(row.status),
      count: countOf(row._count),
    }));

    const oldestPendingAgeSeconds: GaugeSnapshot['oldestPendingAgeSeconds'] = [];
    for (const row of oldestRows) {
      const createdAt = row._min?.createdAt;
      if (!(createdAt instanceof Date)) continue;
      oldestPendingAgeSeconds.push({
        type: this.boundLabel('job_type', row.type),
        ageSeconds: Math.max(0, (takenAt.getTime() - createdAt.getTime()) / 1000),
      });
    }

    const backupLastSuccess =
      lastBackup?.finishedAt instanceof Date
        ? {
            finishedAtSeconds: Math.floor(lastBackup.finishedAt.getTime() / 1000),
            sizeBytes: Number(lastBackup.sizeBytes ?? 0),
          }
        : null;

    return { depth, oldestPendingAgeSeconds, backupLastSuccess };
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.logger.debug(`Metric recording skipped: ${describe(error)}`);
    }
  }
}

function countOf(count: unknown): number {
  if (typeof count === 'number') return count;
  if (count && typeof count === 'object' && '_all' in count) {
    const all = (count as { _all: unknown })._all;
    return typeof all === 'number' ? all : 0;
  }
  return 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// -----------------------------------------------------------------------------
// The fallback instance
// -----------------------------------------------------------------------------
//
// Services that record metrics inject `AppMetricsService` as `@Optional()` and
// fall back to this shared instance: no database, no gauges, the global meter.
// That keeps the dozens of hand-built service instances in the test suites
// (`new JobsService(prisma)`, testing modules that list only the providers
// they exercise) valid without a stub each, while production — where
// `AppMetricsModule` is global — always injects the real one.
let fallback: AppMetricsService | null = null;

export function fallbackAppMetrics(): AppMetricsService {
  if (!fallback) fallback = new AppMetricsService();
  return fallback;
}
