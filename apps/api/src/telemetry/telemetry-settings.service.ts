import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { resolveTelemetryInstanceId } from '../common/otel/telemetry-identity';
import { telemetryGate } from '@marinoscar/platform-api/otel-core';
import type { SystemTelemetryValue } from '../common/schemas/settings.schema';
import { APP_SLUG } from '@app/shared';

import { enqueueHousekeepingJob } from '../jobs/housekeeping.enqueue';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import type {
  TelemetryConfigResponse,
  TelemetryPublicConfig,
  UpdateTelemetryConfigInput,
} from './dto/telemetry-config.dto';
import { GreptimeClient } from './greptime/greptime.client';
import { TELEMETRY_RETENTION_TYPE } from './handlers/telemetry-retention.handler';

// =============================================================================
// TelemetrySettingsService — the `telemetry` namespace, and the runtime gate
// (issue #534, epic #528)
// =============================================================================
//
// Three jobs, one owner:
//
//   1. THE ONE CACHED READ of `telemetry.*` (`getPolicy`, 5s TTL — the same
//      bound `AiConfigService` uses). The explorer (#535) and the assistant
//      (#536) read their bounds (`query.maxRows`, `query.timeoutSeconds`,
//      `assistant.*`) through this, not through `SystemSettingsService`.
//
//   2. THE ADMIN WRITE (`replace`), modelled on `AiConfigAdminService.replace`:
//      If-Match checked before anything is written, `patchSettings` (which
//      re-checks it), cache dropped synchronously, audit row with changed
//      field NAMES, then the two side effects — the gate, and the retention
//      job.
//
//   3. THE EXPORT GATE. `telemetryGate` (common/otel/telemetry-gate.ts) starts
//      CLOSED; this service opens it when `telemetry.enabled` is true AND a
//      telemetry store is configured (the connection saved at
//      /admin/settings/telemetry, else the `GREPTIME_*` deployment default —
//      `TelemetryConnectionService`, #558), on boot and every
//      `TELEMETRY_GATE_REFRESH_MS` after. The interval is what makes a
//      multi-instance deployment converge: the instance that served the PUT
//      flips its gate immediately, every other one within one interval.
//      The same refresh pushes the resolved instance identifier
//      (`telemetry.instanceId`, else `APP_SLUG` — #565) with
//      `telemetryGate.setInstanceId()`, so a relabel converges the same way.
//
// WHY BOTH CONDITIONS FOR THE GATE: with no GreptimeDB there is nowhere for
// the collector to write. Exporting anyway would only fill the collector's
// retry queue and its logs.
//
// A FAILED SETTINGS READ LEAVES THE GATE AS IT IS. Flipping it closed on a
// database blip would drop telemetry exactly when an operator most needs it;
// flipping it open would ignore an administrator's "off". The last known
// answer stands until a read succeeds.
// =============================================================================

/** How long a `getPolicy()` answer may be reused. */
export const TELEMETRY_POLICY_CACHE_MS = 5_000;

/** How often every instance re-reads the policy and re-applies the gate. */
export const TELEMETRY_GATE_REFRESH_MS = 5_000;

/** Audit `action` for a successful admin save. */
export const TELEMETRY_CONFIG_AUDIT_ACTION = 'telemetry:config_update';

type SettingsRow = {
  version: number;
  updatedAt: Date;
  updatedByUser: { id: string; email: string } | null;
} | null;

@Injectable()
export class TelemetrySettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelemetrySettingsService.name);

  private cache: { value: SystemTelemetryValue; readAt: number } | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  /** Whether the previous background refresh failed — so a long outage logs once, not every 5s. */
  private refreshFailing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly greptime: GreptimeClient,
    private readonly jobs: JobsService,
  ) {}

  /**
   * Applies the gate once, then keeps it fresh. Detached and swallowed: boot
   * must never wait on, or fail because of, a settings read.
   */
  onModuleInit(): void {
    void this.refreshGate();

    this.refreshTimer = setInterval(() => {
      void this.refreshGate();
    }, TELEMETRY_GATE_REFRESH_MS);
    // Never the reason a process (or a test run) stays alive.
    this.refreshTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * The current `telemetry` policy. `fresh: true` bypasses the cache — for a
   * caller SHOWING the configuration, never for a hot path.
   */
  async getPolicy(opts: { fresh?: boolean } = {}): Promise<SystemTelemetryValue> {
    const now = Date.now();

    if (!opts.fresh && this.cache && now - this.cache.readAt < TELEMETRY_POLICY_CACHE_MS) {
      return this.cache.value;
    }

    const value = await this.systemSettings.getTelemetryPolicy();
    this.cache = { value, readAt: Date.now() };

    return value;
  }

  /** Drop the cached policy so the next read consults the row. */
  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Re-reads the policy and sets the export gate to
   * `telemetry.enabled && GreptimeDB configured`, and the gate's instance id
   * to `telemetry.instanceId ?? APP_SLUG`. Never throws: on a failed read the
   * gate keeps its last values (see the header).
   *
   * @returns the gate's state after the call.
   */
  async refreshGate(): Promise<boolean> {
    try {
      const policy = await this.getPolicy({ fresh: true });
      const next = policy.enabled && this.greptime.isConfigured();
      const previous = telemetryGate.isEnabled();
      const nextInstanceId = resolveTelemetryInstanceId(policy.instanceId);
      const previousInstanceId = telemetryGate.instanceId();

      telemetryGate.setEnabled(next);
      telemetryGate.setInstanceId(nextInstanceId);

      if (next !== previous) {
        this.logger.log(`Telemetry export ${next ? 'enabled' : 'disabled'}`);
      }

      if (nextInstanceId !== previousInstanceId) {
        this.logger.log(`Telemetry instance id is now "${nextInstanceId}"`);
      }

      if (this.refreshFailing) {
        this.refreshFailing = false;
        this.logger.log('Telemetry settings readable again; export gate is current');
      }
    } catch (error) {
      if (!this.refreshFailing) {
        this.refreshFailing = true;
        this.logger.warn(
          'Could not read the telemetry settings; the export gate keeps its last value ' +
            `(${telemetryGate.isEnabled() ? 'open' : 'closed'}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return telemetryGate.isEnabled();
  }

  /** `GET /api/admin/telemetry/config`. Read fresh, and never creates the settings row. */
  async describeForAdmin(): Promise<TelemetryConfigResponse> {
    const [policy, row] = await Promise.all([this.getPolicy({ fresh: true }), this.readRow()]);

    return {
      ...structuredClone(policy),
      available: this.greptime.isConfigured(),
      retentionApplicable: this.greptime.isAdminConfigured(),
      instanceIdDefault: APP_SLUG,
      instanceIdEffective: resolveTelemetryInstanceId(policy.instanceId),
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedByUser ?? null,
    };
  }

  /** `GET /api/telemetry/config` — the web feature flag. Cached; no provenance, no bounds. */
  async describePublic(): Promise<TelemetryPublicConfig> {
    const policy = await this.getPolicy();

    return {
      available: this.greptime.isConfigured(),
      enabled: policy.enabled,
      assistantEnabled: policy.assistant.enabled,
    };
  }

  /**
   * `PUT /api/admin/telemetry/config` — full replace of the namespace.
   *
   * Order, each step load-bearing:
   *   1. `If-Match` refused BEFORE anything is written (409);
   *   2. `patchSettings`, passing `expectedVersion` again so the write
   *      re-checks it (that also writes the generic `system_settings:patch`
   *      audit row);
   *   3. the cache dropped SYNCHRONOUSLY, before anything else awaits;
   *   4. the `telemetry:config_update` audit row — changed field NAMES only;
   *   5. the gate re-applied on this instance (others follow within
   *      `TELEMETRY_GATE_REFRESH_MS`);
   *   6. a `telemetry.retention.apply` job enqueued, so a changed retention
   *      reaches GreptimeDB now rather than at the next 4am run. Never fails
   *      the save: the helper swallows its own errors, and the nightly cron
   *      re-asserts the TTL regardless.
   */
  async replace(
    input: UpdateTelemetryConfigInput,
    userId: string,
    expectedVersion?: number,
  ): Promise<TelemetryConfigResponse> {
    const row = await this.readRow();
    const currentVersion = row?.version ?? 0;

    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw new ConflictException(
        `Telemetry settings version mismatch. Expected ${expectedVersion}, found ${currentVersion}`,
      );
    }

    const current = await this.systemSettings.getTelemetryPolicy();
    // `instanceId` is the one optional field of the PUT body (see the DTO):
    // absent keeps the stored value, so a client that predates it cannot
    // reset it.
    const next: SystemTelemetryValue = structuredClone({
      ...input,
      instanceId: input.instanceId !== undefined ? input.instanceId : current.instanceId,
    });

    await this.systemSettings.patchSettings({ telemetry: next }, userId, expectedVersion);

    // Step 3 — nothing awaits between the write and this.
    this.invalidateCache();

    const changedFields = diffTelemetryFieldNames(current, next);

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: TELEMETRY_CONFIG_AUDIT_ACTION,
        targetType: 'telemetry_config',
        targetId: 'telemetry',
        meta: { changedFields } as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `Telemetry configuration replaced by user ${userId} ` +
        `(enabled=${next.enabled} retentionDays=${next.retentionDays} ` +
        `changed=${changedFields.join(',') || '(none)'})`,
    );

    await this.refreshGate();

    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: TELEMETRY_RETENTION_TYPE,
      what: 'telemetry retention',
    });

    return this.describeForAdmin();
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

/**
 * The dotted NAMES of the fields that differ between two policies — never the
 * values (the audit row's contract, the same as `ai_config:replace`).
 */
export function diffTelemetryFieldNames(before: SystemTelemetryValue, after: SystemTelemetryValue): string[] {
  const flat = (value: SystemTelemetryValue): Record<string, unknown> => ({
    enabled: value.enabled,
    retentionDays: value.retentionDays,
    instanceId: value.instanceId,
    'query.maxRows': value.query.maxRows,
    'query.timeoutSeconds': value.query.timeoutSeconds,
    'assistant.enabled': value.assistant.enabled,
    'assistant.provider': value.assistant.provider,
    'assistant.modelId': value.assistant.modelId,
    'assistant.shareResults': value.assistant.shareResults,
    'assistant.maxResultRowsToModel': value.assistant.maxResultRowsToModel,
    'assistant.maxSteps': value.assistant.maxSteps,
  });

  const a = flat(before);
  const b = flat(after);

  return Object.keys(a).filter((key) => a[key] !== b[key]);
}
