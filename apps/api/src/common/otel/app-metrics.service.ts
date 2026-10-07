// =============================================================================
// Application metrics (issue #125, epic A)
// =============================================================================
//
// THE APP'S TYPED RECORDERS, ON THE PLATFORM'S METRICS HOST. Every
// business-level number the API exports — queue throughput, backup outcomes,
// sign-ins, AI usage, notification deliveries — goes through a typed method
// here, so a call site cannot invent a label. The instruments themselves are
// created by `MetricsHostService` (`@marinoscar/platform-api/otel-core`,
// marinoscar/EnterpriseAppBase#700) from the app-metric registry; this
// service keeps the domain half (the
// recorders below and the Prisma-backed gauges), which moves to its slices
// later (jobs, db-backup, identity, ai, notifications).
//
// ONE SANCTIONED SIBLING: `nodes/node-fleet-metrics.service.ts` (#131) creates
// the `app.nodes.*` gauges, because its callback needs `NodeOffloadService` and
// the fleet policy, which this global module cannot import without a cycle. It
// takes its meter, clock and gate from `gaugeContext()` (the host's) and its names, units
// and descriptions from the app-metric registry (`createRegisteredGauge`), so
// the conventions still have one owner.
//
// -----------------------------------------------------------------------------
// DECLARED IN A REGISTRY (marinoscar/EnterpriseAppBase#680)
// -----------------------------------------------------------------------------
//
// Every metric is declared in the app-metric registry (`appMetricRegistry`,
// `@marinoscar/platform-api/otel-core`): the platform's in
// `platform-app-metrics.ts`, registered by `app-metric.manifest.ts` (imported
// below); this app's own health and coach metrics in
// `app-metrics/domain-metric-names.ts`, registered by
// `app-metrics/domain-metrics.module.ts` and recorded by
// `EvoPathMetricsService` (marinoscar/EnterpriseAppBase#718). The host creates
// EVERY
// registered counter and histogram from its declaration. The typed methods
// below (`jobEnqueued`, `aiUsage`, …) are the platform's call sites; `add` and
// `record` are the generic ones, and the documented way an app emits its own
// metrics: they admit only the attribute keys the declaration lists and bound
// each one (`enum`: the value or `other`; `free`: `boundLabel`).
//
// -----------------------------------------------------------------------------
// OFF MEANS NO-OP, FOR FREE
// -----------------------------------------------------------------------------
//
// The meter is `metrics.getMeter('app')` from `@opentelemetry/api`. When
// `OTEL_ENABLED` is not `true`, `instrumentation.ts` (`initializeOtel()`) installs no SDK, the
// global MeterProvider is the API's no-op one, and every instrument below is a
// no-op: a counter `add()` costs a function call. When the SDK IS installed
// but the `telemetry.enabled` setting is off, instruments still aggregate in
// memory and the gated exporter drops each batch (the package's `telemetryGate`).
//
// The OBSERVABLE GAUGES are different, because their callbacks query the
// database. They are registered through the host's `registerGaugeProvider`,
// only when `otel.enabled` (the same `OTEL_ENABLED` switch) is true, and each
// callback also returns early while
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
// a URL or an error message. Every free-form string passes the host's
// `boundLabel`: it
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
import type {
  Attributes,
  BatchObservableResult,
  Counter,
  Histogram,
  Meter,
  ObservableGauge,
} from '@opentelemetry/api';
import {
  appMetricRegistry,
  createRegisteredGauge as createPlatformRegisteredGauge,
  enumLabel,
  METRICS_HOST_OPTIONS,
  MetricsHostService,
  nonNegative,
  UNKNOWN_LABEL,
  type AppGaugeContext,
  type AppMetricKeys,
  type MetricsHostOptions,
} from '@marinoscar/platform-api/otel-core';

import { PrismaService } from '../../prisma/prisma.service';
import './app-metric.manifest';
import {
  AI_STATUS_VALUES,
  AUTH_LOGIN_OUTCOME_VALUES,
  AUTH_REFRESH_OUTCOME_VALUES,
  BACKUP_OUTCOME_VALUES,
  JOB_DEPTH_STATUS_VALUES,
  JOB_EXECUTOR_VALUES,
  JOB_REAP_OUTCOME_VALUES,
  JOB_SETTLE_OUTCOME_VALUES,
  NOTIFICATION_OUTCOME_VALUES,
  PLATFORM_APP_METRICS,
  type PlatformAppMetricKey,
} from './platform-app-metrics';

// The generic half, re-exported so the importers keep one path
// (marinoscar/EnterpriseAppBase#700).
export {
  APP_METER_NAME,
  APP_METRIC_ATTRIBUTE_KEY_PATTERN,
  APP_METRIC_NAME_PATTERN,
  MAX_DISTINCT_VALUES,
  OTHER_LABEL,
  UNKNOWN_LABEL,
  appMetricRegistry,
  registerAppMetrics,
  shapeLabel,
  type AppGaugeContext,
  type AppMetricAttribute,
  type AppMetricDef,
  type AppMetricKeys,
  type AppMetricKind,
} from '@marinoscar/platform-api/otel-core';

/**
 * Optional test seam: an explicit meter, clock and gate. Unprovided in
 * production. The same token as the package's `METRICS_HOST_OPTIONS`.
 */
export const APP_METRICS_OPTIONS = METRICS_HOST_OPTIONS;

export type AppMetricsOptions = MetricsHostOptions;

/** A registered metric's code key: the platform's, or one an app declared (and typed by augmentation). */
export type AppMetricKey = PlatformAppMetricKey | (keyof AppMetricKeys & string);

/**
 * Every PLATFORM metric name by code key (the docs quote this table). Derived
 * from the platform declarations rather than from the registry, so it does not
 * depend on whether `EvoPathMetricsModule` was imported before this module was
 * evaluated: this app's own names are `EVOPATH_METRIC_NAMES`
 * (`app-metrics/domain-metric-names.ts`).
 */
export const APP_METRIC_NAMES: Readonly<Record<PlatformAppMetricKey, string>> = Object.freeze(
  Object.fromEntries(PLATFORM_APP_METRICS.map((def) => [def.key, def.name])) as Record<PlatformAppMetricKey, string>,
);

/** How long one gauge snapshot is reused across collections and callbacks. */
export const GAUGE_CACHE_TTL_MS = 30_000;

// ---- Enumerated attribute values (declared in `platform-app-metrics.ts`) ----

export type JobExecutorLabel = 'server' | 'node';
const JOB_EXECUTORS = new Set<string>(JOB_EXECUTOR_VALUES);
const JOB_SETTLE_OUTCOMES = new Set<string>(JOB_SETTLE_OUTCOME_VALUES);
const JOB_REAP_OUTCOMES = new Set<string>(JOB_REAP_OUTCOME_VALUES);

export type JobReapOutcome = 'requeued' | 'failed';

/** The queue statuses the depth gauge reports (terminal rows are history, not depth). */
const DEPTH_STATUSES = JOB_DEPTH_STATUS_VALUES;

export type BackupOutcome = 'completed' | 'failed';
const BACKUP_OUTCOMES = new Set<string>(BACKUP_OUTCOME_VALUES);

export type AuthLoginOutcome = 'success' | 'allowlist_rejected' | 'disabled';
const AUTH_LOGIN_OUTCOMES = new Set<string>(AUTH_LOGIN_OUTCOME_VALUES);

export type AuthRefreshOutcome =
  | 'success'
  | 'invalid'
  | 'reuse_detected'
  | 'expired'
  | 'user_inactive'
  | 'device_revoked';
const AUTH_REFRESH_OUTCOMES = new Set<string>(AUTH_REFRESH_OUTCOME_VALUES);

const AI_STATUSES = new Set<string>(AI_STATUS_VALUES);

export type NotificationDeliveryOutcome = 'sent' | 'failed' | 'rate_limited' | 'error';
const NOTIFICATION_OUTCOMES = new Set<string>(NOTIFICATION_OUTCOME_VALUES);

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
 * Creates the observable gauge DECLARED under `key` in the app-metric registry,
 * with its registered name, unit and description (the package's
 * `createRegisteredGauge`, typed with this app's keys). For gauge providers
 * (`registerGauges()` below, `NodeFleetMetrics`, an app's own provider): the
 * callback is theirs, the descriptor is the registry's.
 *
 * @throws RegistryError `UNKNOWN_ID` when no metric is declared under `key`;
 *   `Error` when the declared metric is not a gauge.
 */
export function createRegisteredGauge(meter: Meter, key: AppMetricKey): ObservableGauge {
  return createPlatformRegisteredGauge(meter, key);
}

@Injectable()
export class AppMetricsService implements OnModuleInit {
  private readonly logger = new Logger(AppMetricsService.name);

  /** The platform's metrics host: the meter, the instruments, label bounding, the gauge seam. */
  private readonly host: MetricsHostService;

  private gaugesRegistered = false;
  private snapshotCache: { at: number; value: GaugeSnapshot } | null = null;
  private snapshotInFlight: Promise<GaugeSnapshot | null> | null = null;

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() config?: ConfigService,
    @Optional() @Inject(APP_METRICS_OPTIONS) options?: AppMetricsOptions,
    @Optional() host?: MetricsHostService,
  ) {
    // In the application the global `OtelMetricsModule` (imported by
    // `AppMetricsModule`) injects the one host. A hand-built instance (the
    // specs, `fallbackAppMetrics()`) gets a host of its own with the same
    // defaults as before: gauges follow `otel.enabled` unless forced.
    this.host =
      host ??
      new MetricsHostService({
        ...options,
        gauges: options?.gauges ?? config?.get<boolean>('otel.enabled') === true,
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
    this.safely(() => this.counter('jobsEnqueued').add(1, { job_type: this.boundLabel('job_type', type) }));
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
        this.counter('jobsClaimed').add(count, { job_type: jobType, executor: exec });
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
      this.counter('jobsSettled').add(1, attrs);
      const ms = nonNegative(durationMs);
      if (ms !== null) this.histogram('jobsDuration').record(ms / 1000, attrs);
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
      const attrs: Attributes = { outcome: enumLabel(outcome, JOB_REAP_OUTCOMES) };
      if (type !== undefined) attrs.job_type = this.boundLabel('job_type', type);
      this.counter('jobsReaped').add(count, attrs);
    });
  }

  // ===========================================================================
  // Database backup
  // ===========================================================================

  /** A backup run settled. `sizeBytes` is recorded only for a completed run. */
  backupSettled(outcome: BackupOutcome, durationMs: number | null, sizeBytes?: number | bigint | null): void {
    this.safely(() => {
      const attrs: Attributes = { outcome: enumLabel(outcome, BACKUP_OUTCOMES) };
      this.counter('backupRuns').add(1, attrs);
      const ms = nonNegative(durationMs);
      if (ms !== null) this.histogram('backupDuration').record(ms / 1000, attrs);
      if (outcome === 'completed') {
        const size = nonNegative(typeof sizeBytes === 'bigint' ? Number(sizeBytes) : sizeBytes);
        if (size !== null) this.histogram('backupSize').record(size, attrs);
      }
    });
  }

  // ===========================================================================
  // Auth
  // ===========================================================================

  authLogin(outcome: AuthLoginOutcome, provider = 'google'): void {
    this.safely(() =>
      this.counter('authLogins').add(1, {
        provider: this.boundLabel('auth_provider', provider),
        outcome: enumLabel(outcome, AUTH_LOGIN_OUTCOMES),
      }),
    );
  }

  authRefresh(outcome: AuthRefreshOutcome): void {
    this.safely(() =>
      this.counter('authRefreshes').add(1, { outcome: enumLabel(outcome, AUTH_REFRESH_OUTCOMES) }),
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

      this.counter('aiRequests').add(1, withStatus);

      const ms = nonNegative(event.latencyMs);
      if (ms !== null) this.histogram('aiDuration').record(ms / 1000, withStatus);

      const input = nonNegative(event.inputTokens);
      if (input !== null && input > 0) this.counter('aiTokens').add(Math.round(input), { ...base, token_type: 'input' });
      const output = nonNegative(event.outputTokens);
      if (output !== null && output > 0) this.counter('aiTokens').add(Math.round(output), { ...base, token_type: 'output' });
    });
  }

  // ===========================================================================
  // Notifications
  // ===========================================================================

  notificationDelivery(channel: string, outcome: NotificationDeliveryOutcome, eventKey?: string): void {
    this.safely(() =>
      this.counter('notificationDeliveries').add(1, {
        channel: this.boundLabel('notification_channel', channel),
        event: eventKey ? this.boundLabel('notification_event', eventKey) : UNKNOWN_LABEL,
        outcome: enumLabel(outcome, NOTIFICATION_OUTCOMES),
      }),
    );
  }

  // ===========================================================================
  // Generic: any registered counter or histogram (marinoscar/EnterpriseAppBase#680)
  // ===========================================================================

  /**
   * Adds `value` (default 1) to the counter registered under `key`, with its
   * declared attributes only, each bounded (`enum` → the value or `other`;
   * `free` → {@link boundLabel}). An undeclared attribute key is dropped. An
   * unknown key, or a key that names a histogram or gauge, is a no-op logged
   * once at `debug`. A negative or non-finite value is ignored (counters are
   * monotonic). Never throws.
   */
  add(key: AppMetricKey | (string & {}), value = 1, attributes?: Record<string, unknown>): void {
    this.host.add(key, value, attributes);
  }

  /**
   * Records `value` on the histogram registered under `key`, with the same
   * attribute rules as {@link add}. A negative or non-finite value is ignored.
   * Never throws.
   */
  record(key: AppMetricKey | (string & {}), value: number, attributes?: Record<string, unknown>): void {
    this.host.record(key, value, attributes);
  }

  /** A platform counter, by key. */
  private counter(key: PlatformAppMetricKey): Counter {
    return this.host.counter(key);
  }

  /** A platform histogram, by key. */
  private histogram(key: PlatformAppMetricKey): Histogram {
    return this.host.histogram(key);
  }

  // ===========================================================================
  // Label bounding
  // ===========================================================================

  /**
   * A free-form string as a low-cardinality label: `unknown` when empty,
   * `other` when it does not look like an identifier, is too long, or would be
   * the `MAX_DISTINCT_VALUES + 1`-th distinct value for `key` (the host's
   * budget, shared with `add`/`record`).
   */
  boundLabel(key: string, value: unknown): string {
    return this.host.boundLabel(key, value);
  }

  // ===========================================================================
  // Observable gauges
  // ===========================================================================

  /**
   * The meter, clock and export gate for a SIBLING gauge provider that lives in
   * a feature module (it needs that module's services, so it cannot live here
   * without a module cycle) — `null` when gauges are off in this process, in
   * which case the caller registers nothing. `NodeFleetMetrics` is the reader.
   */
  gaugeContext(): AppGaugeContext | null {
    return this.host.gaugeContext();
  }

  /** Registers the DB-backed gauges once, only when OTel is enabled for this process. */
  registerGauges(): void {
    if (this.gaugesRegistered || !this.prisma) return;

    this.gaugesRegistered = this.host.registerGaugeProvider(({ meter }) => {
      const depth = createRegisteredGauge(meter, 'jobsQueueDepth');
      const oldest = createRegisteredGauge(meter, 'jobsOldestPendingAge');
      const lastSuccessAt = createRegisteredGauge(meter, 'backupLastSuccessTimestamp');
      const lastSuccessSize = createRegisteredGauge(meter, 'backupLastSuccessSize');

      meter.addBatchObservableCallback(
        (result) => this.observeGauges(result, { depth, oldest, lastSuccessAt, lastSuccessSize }),
        [depth, oldest, lastSuccessAt, lastSuccessSize],
      );
    });
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
    if (!this.host.gateOpen()) return null;

    const cached = this.snapshotCache;
    if (cached && this.host.now() - cached.at < GAUGE_CACHE_TTL_MS) return cached.value;

    if (!this.snapshotInFlight) {
      this.snapshotInFlight = this.readSnapshot()
        .then((value) => {
          this.snapshotCache = { at: this.host.now(), value };
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
    const takenAt = new Date(this.host.now());

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
