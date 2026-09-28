// =============================================================================
// `telemetry.retention.apply` job handler (issue #534, epic #528)
// =============================================================================
//
// Makes GreptimeDB's database-level TTL match `telemetry.retentionDays`:
//
//     ALTER DATABASE <database> SET 'ttl'='<N>d'
//
// The database name is deliberately UNQUOTED: GreptimeDB v1.2.1 resolves a
// double-quoted name in ALTER DATABASE literally (`"public"` fails with
// "Failed to find schema"), so the name is instead restricted to a plain
// identifier and refused otherwise.
//
// One database TTL covers every telemetry table, including the per-metric and
// per-attribute tables GreptimeDB creates later (spike #529: tables inherit
// it). GreptimeDB enforces the TTL itself during compaction — this job only
// states the policy, it deletes nothing directly.
//
// IDEMPOTENT: setting the TTL to the value it already has is a no-op on the
// server, so a retry, a duplicate run, or the daily re-assertion
// (`TelemetryRetentionTask`) are all harmless. Enqueued by that cron and by
// every successful `PUT /api/admin/telemetry/config`.
//
// NOT GATED ON `telemetry.enabled`. Retention is a data-hygiene policy: a
// deployment that switched collection off still wants what it already
// collected to age out.
//
// A DEPLOYMENT WITHOUT GREPTIMEDB (or without its admin credential) completes
// as a NO-OP with a log line rather than failing: that is a supported
// configuration, and failing would put a red row in the jobs dashboard every
// night for a feature the operator never deployed.
//
// SERVER-ONLY, PERMANENTLY: no `nodeResultSchema`/`persistNodeResult`. The
// statement needs the GreptimeDB ADMIN credential — one able to change
// retention and drop telemetry — and a worker node must never hold it
// (CLAUDE.md, queue rule 3).
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { GreptimeClient } from '../greptime/greptime.client';

/** The job type. PERMANENT once rows of it exist. */
export const TELEMETRY_RETENTION_TYPE = 'telemetry.retention.apply';

/** Client-side ceiling on the ALTER. It is a metadata change; seconds, not minutes. */
export const TELEMETRY_RETENTION_STATEMENT_TIMEOUT_MS = 30_000;

/** A bare SQL identifier; the only database names the statement accepts. */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The one statement this job runs. Exported so its text is pinned by a test. */
export function retentionStatement(database: string, retentionDays: number): string {
  // Defence in depth: the value came through `systemTelemetrySchema`
  // (an integer in 1..3650), and it is interpolated into SQL — GreptimeDB
  // has no bind parameters — so it is checked again right here.
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error(`Refusing to apply an invalid telemetry retention of ${String(retentionDays)} day(s).`);
  }

  if (!PLAIN_IDENTIFIER.test(database)) {
    throw new Error(`Refusing to apply retention to a non-plain database name: ${JSON.stringify(database)}.`);
  }

  return `ALTER DATABASE ${database} SET 'ttl'='${retentionDays}d'`;
}

@Injectable()
export class TelemetryRetentionHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(TelemetryRetentionHandler.name);

  readonly type = TELEMETRY_RETENTION_TYPE;

  /** One metadata statement; a minute is generous. Retried like any housekeeping job. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 60_000, maxAttempts: 3 };

  // Deliberately NO `nodeResultSchema` / `persistNodeResult` — see the header.

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly systemSettings: SystemSettingsService,
    private readonly greptime: GreptimeClient,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Throws to fail (GreptimeDB unreachable or refusing), so the queue's retry applies. */
  async process(job: Job): Promise<void> {
    if (!this.greptime.isConfigured()) {
      this.logger.log(
        `Telemetry retention skipped: GreptimeDB is not configured (see /admin/settings/telemetry) (job ${job.id})`,
      );
      return;
    }

    if (!this.greptime.isAdminConfigured()) {
      this.logger.warn(
        'Telemetry retention skipped: the GreptimeDB admin login is not configured ' +
          '(set it at /admin/settings/telemetry), so the database TTL cannot be changed ' +
          `(job ${job.id})`,
      );
      return;
    }

    const { retentionDays } = await this.systemSettings.getTelemetryPolicy();
    const sql = retentionStatement(this.greptime.database, retentionDays);

    await this.greptime.queryAdmin(sql, { timeoutMs: TELEMETRY_RETENTION_STATEMENT_TIMEOUT_MS });

    this.logger.log(
      `Telemetry retention applied: database "${this.greptime.database}" TTL is ${retentionDays} day(s) (job ${job.id})`,
    );
  }
}
