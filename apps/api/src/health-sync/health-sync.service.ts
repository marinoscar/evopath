import { randomUUID } from 'node:crypto';

import { ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Prisma,
  type ActivityKind,
  type HealthSyncDevice,
  type HealthSyncDiagnosticReport,
  type HealthSyncRun,
} from '@prisma/client';

import { ACTIVITY_ENTRY_RECORDED_EVENT, type ActivityEntryRecordedEvent } from '../activity/activity-events';
import { activityRefusal } from '../activity/activity-mapper';
import type { AuthCredentialInfo } from '../auth/decorators/auth-credential.decorator';
import { fromDbDate, localDateInZone, toDbDate } from '../check-ins/local-date';
import { staticLogger } from '../common/logger/logger.service';
import { HealthProfileService } from '../health-profile/health-profile.service';
import { emitHealthDataChanged } from '../measurements/health-data-events';
import { ACTIVE } from '../measurements/measurement-active';
import { PrismaService } from '../prisma/prisma.service';
import type {
  DeviceView,
  RegisterDeviceInput,
  ReportSummaryView,
  ReportView,
  RunView,
  SyncEntryInput,
  SyncInput,
  SyncResultView,
  SyncSleepInput,
  UploadDiagnosticsInput,
} from './dto/health-sync.dto';
import { type PlannedMeasurement, planSync, type ReconcileScope } from './health-sync-plan';
import {
  HEALTH_SYNC_REASONS,
  providerForDevice,
  REPORTS_KEPT_PER_DEVICE,
  RUNS_KEPT_PER_DEVICE,
  SYNC_METRIC_DEFAULT_METHOD,
  SYNC_TX_TIMEOUT_MS,
} from './health-sync.constants';

// =============================================================================
// HealthSyncService — Android Health Connect sync (epic #276, #278)
// =============================================================================
//
// Owner-scoped: another user's device is a 404.
//
// PAIRING. A phone pairs through the device flow and gets a PAT; it then
// registers (`POST /devices`, upsert on (user, installationId)) with that
// PAT, and the device row links the PAT's id (`@AuthCredential()`), so
// unpairing revokes exactly that token, and `tokenExpiresAt` comes from it.
//
// A SYNC is one transaction (timeout {@link SYNC_TX_TIMEOUT_MS}):
//   1. upsert each activity entry, measurement and sleep session through its
//      raw-SQL partial unique index (`*_provider_external_uniq_idx`; Prisma's
//      upsert cannot target a partial index), provider
//      `health_connect:<deviceId>` so two phones never touch each other's rows;
//   2. reconcile (only with a `window` and `run.status === 'ok'`, only for
//      the types in `run.details.syncedTypes`, see `SYNCED_TYPE_SCOPES`);
//   3. insert the run (always, even for a failed or empty one), trim the
//      device's runs to the newest {@link RUNS_KEPT_PER_DEVICE};
//   4. stamp the device's last-seen/last-sync fields.
// After commit: `activity.entry.recorded` when activity entries changed,
// `health.data.changed` when measurements changed, and one structured Pino
// line (ids and counts only, never values).
//
// OWNERSHIP OF A KEY. An upsert only overwrites a row this sync owns: an
// activity entry with `source: integration` (a manual batch row that reused
// the key is left alone), a sleep session with `origin: device`, and an
// ACTIVE measurement — a reading the user deleted or edited (superseded) is
// never resurrected or overwritten. Unchanged rows are not touched, so a
// re-sent day emits no event and bumps no `updated_at`.
//
// ⚠ NEVER LOG VALUES. Health readings are health data.
// =============================================================================

type Tx = Prisma.TransactionClient;

interface Counts {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  skipped: number;
}

const zero = (): Counts => ({ created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0 });

type UpsertOutcome = 'created' | 'updated' | 'unchanged' | 'skipped';

type DeviceWithPat = HealthSyncDevice & { pat: { expiresAt: Date; revokedAt: Date | null } | null };

const WITH_PAT = { pat: { select: { expiresAt: true, revokedAt: true } } } as const;

@Injectable()
export class HealthSyncService {
  private readonly logger = new Logger(HealthSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly healthProfile: HealthProfileService,
    // Optional so a hand-built service (tests) needs none; Nest always injects it.
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  // ---------------------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------------------

  /**
   * Registers (or re-registers) the caller's phone. A revoked device comes
   * back active. Authenticated with a PAT, the device links it; a JWT caller
   * leaves the link as it was.
   */
  async register(
    userId: string,
    input: RegisterDeviceInput,
    credential: AuthCredentialInfo | null,
    now: Date = new Date(),
  ): Promise<DeviceView> {
    const fields = {
      name: input.name,
      manufacturer: input.manufacturer ?? null,
      model: input.model ?? null,
      androidVersion: input.androidVersion ?? null,
      sdkInt: input.sdkInt ?? null,
      appVersion: input.appVersion ?? null,
      healthConnectVersion: input.healthConnectVersion ?? null,
      packageName: input.packageName ?? null,
      signingSha256: input.signingSha256 ?? null,
      ...(input.timezone ? { timezone: input.timezone } : {}),
      status: 'active' as const,
      lastSeenAt: now,
      ...(credential?.kind === 'pat' ? { patId: credential.tokenId } : {}),
    };

    const device = await this.prisma.healthSyncDevice.upsert({
      where: { userId_installationId: { userId, installationId: input.installationId } },
      create: { userId, installationId: input.installationId, ...fields },
      update: fields,
      include: WITH_PAT,
    });
    return this.toDeviceView(device, await this.healthProfile.getTimeZone(userId));
  }

  async list(userId: string): Promise<DeviceView[]> {
    const [devices, timeZone] = await Promise.all([
      this.prisma.healthSyncDevice.findMany({
        where: { userId },
        include: WITH_PAT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.healthProfile.getTimeZone(userId),
    ]);
    return devices.map((device) => this.toDeviceView(device, timeZone));
  }

  async get(userId: string, deviceId: string): Promise<DeviceView> {
    const device = await this.findOwned(userId, deviceId);
    return this.toDeviceView(device, await this.healthProfile.getTimeZone(userId));
  }

  /**
   * Unpairs: the device becomes `revoked` and its linked PAT is revoked in
   * the same transaction (a revoked device must not keep a live token).
   * `deleteEntries` also removes what it imported. Idempotent.
   */
  async unpair(userId: string, deviceId: string, deleteEntries: boolean, now: Date = new Date()): Promise<void> {
    const device = await this.findOwned(userId, deviceId);
    const provider = providerForDevice(device.id);

    const measurementsDeleted = await this.prisma.$transaction(async (tx) => {
      await tx.healthSyncDevice.update({ where: { id: device.id }, data: { status: 'revoked' } });
      if (device.patId) {
        await tx.personalAccessToken.updateMany({
          where: { id: device.patId, userId, revokedAt: null },
          data: { revokedAt: now },
        });
      }
      if (!deleteEntries) return 0;

      await tx.activityEntry.deleteMany({ where: { userId, provider, source: 'integration' } });
      await tx.sleepSession.deleteMany({ where: { userId, provider } });
      const { count } = await tx.measurement.updateMany({
        where: { userId, externalProvider: provider, ...ACTIVE },
        data: { deletedAt: now },
      });
      return count;
    });

    this.logger.log(`Unpaired health sync device ${device.id} (user ${userId}, deleteEntries=${deleteEntries})`);
    if (measurementsDeleted > 0) this.healthDataChanged(userId);
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  /**
   * Ingests one sync from the phone. `canWriteHealthData` is the caller's
   * `health_data:write`: required (403) for a payload carrying measurements
   * or sleep, and without it reconciliation never touches those tables.
   */
  async sync(
    userId: string,
    deviceId: string,
    input: SyncInput,
    canWriteHealthData: boolean,
    now: Date = new Date(),
  ): Promise<SyncResultView> {
    const carriesHealthData = (input.measurements?.length ?? 0) > 0 || (input.sleepSessions?.length ?? 0) > 0;
    if (carriesHealthData && !canWriteHealthData) {
      throw new ForbiddenException({
        message: 'Syncing measurements or sleep needs the health_data:write permission',
        details: { reason: HEALTH_SYNC_REASONS.HEALTH_DATA_SCOPE_REQUIRED, permission: 'health_data:write' },
      });
    }

    const device = await this.findOwned(userId, deviceId);
    if (device.status === 'revoked') {
      throw activityRefusal(409, HEALTH_SYNC_REASONS.DEVICE_REVOKED, 'This device was unpaired: pair it again', {
        deviceId: device.id,
      });
    }

    const userTimeZone = await this.healthProfile.getTimeZone(userId);
    const today = localDateInZone(now, userTimeZone);
    const plan = planSync(input, today, userTimeZone);
    const reconcile = plan.reconcile && !canWriteHealthData ? { ...plan.reconcile, metricKeys: [], sleep: false } : plan.reconcile;
    const provider = providerForDevice(device.id);

    const recordedSince = new Date();
    const result = await this.prisma.$transaction(
      async (tx) => {
        const entries = zero();
        for (const entry of plan.entries) {
          entries[await upsertEntry(tx, userId, provider, entry)] += 1;
        }
        const measurements = zero();
        for (const reading of plan.measurements) {
          measurements[await upsertMeasurement(tx, userId, provider, device.id, reading)] += 1;
        }
        const sleep = zero();
        for (const session of plan.sleepSessions) {
          sleep[await upsertSleep(tx, userId, provider, device.id, session)] += 1;
        }

        if (reconcile) {
          const deleted = await reconcileDeletes(tx, userId, provider, reconcile, plan, now);
          entries.deleted = deleted.entries;
          measurements.deleted = deleted.measurements;
          sleep.deleted = deleted.sleep;
        }

        const total = (key: 'created' | 'updated' | 'deleted') => entries[key] + measurements[key] + sleep[key];
        const sent = input.entries.length + (input.measurements?.length ?? 0) + (input.sleepSessions?.length ?? 0);
        const run = await tx.healthSyncRun.create({
          data: {
            deviceId: device.id,
            userId,
            trigger: input.run.trigger,
            status: input.run.status,
            startedAt: new Date(input.run.startedAt),
            finishedAt: new Date(input.run.finishedAt),
            windowFrom: input.window ? toDbDate(input.window.from) : null,
            windowTo: input.window ? toDbDate(input.window.to) : null,
            recordsRead: input.run.recordsRead ?? sent,
            created: total('created'),
            updated: total('updated'),
            deleted: total('deleted'),
            errorCode: input.run.errorCode ?? null,
            errorMessage: input.run.errorMessage ?? null,
            details: {
              ...(input.run.details ?? {}),
              // What the server did with what was sent, per table (the phone's
              // `sync.delivery` check compares it with what it read and sent).
              server: { entries, measurements, sleep },
            } as unknown as Prisma.InputJsonObject,
          },
        });
        await trimRuns(tx, device.id);

        await tx.healthSyncDevice.update({
          where: { id: device.id },
          data: {
            lastSeenAt: now,
            lastSyncAt: now,
            lastSyncStatus: input.run.status,
            lastError: input.run.errorMessage ?? null,
            ...(input.run.timezone ? { timezone: input.run.timezone } : {}),
          },
        });

        return { runId: run.id, entries, measurements, sleep };
      },
      { timeout: SYNC_TX_TIMEOUT_MS },
    );

    const { entries, measurements, sleep } = result;
    if (entries.created + entries.updated + entries.deleted > 0) {
      this.emitRecorded({ userId, recordedSince: recordedSince.toISOString() });
    }
    if (measurements.created + measurements.updated + measurements.deleted > 0) this.healthDataChanged(userId);

    staticLogger.info(
      {
        event: 'health_sync.run',
        userId,
        deviceId: device.id,
        runId: result.runId,
        trigger: input.run.trigger,
        status: input.run.status,
        reconciled: reconcile !== null,
        entries,
        measurements,
        sleep,
      },
      'Health sync run recorded',
    );

    return {
      runId: result.runId,
      created: entries.created,
      updated: entries.updated,
      deleted: entries.deleted,
      unchanged: entries.unchanged,
      skipped: entries.skipped,
      measurements,
      sleep,
    };
  }

  // ---------------------------------------------------------------------------
  // Runs and diagnostics
  // ---------------------------------------------------------------------------

  async listRuns(userId: string, deviceId: string, limit: number): Promise<RunView[]> {
    const device = await this.findOwned(userId, deviceId);
    const runs = await this.prisma.healthSyncRun.findMany({
      where: { deviceId: device.id, userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return runs.map(toRunView);
  }

  /** Stores a diagnostics report; works for a revoked device too (that is when one is needed). */
  async uploadDiagnostics(
    userId: string,
    deviceId: string,
    input: UploadDiagnosticsInput,
  ): Promise<{ id: string; createdAt: string }> {
    const device = await this.findOwned(userId, deviceId);
    const report = await this.prisma.$transaction(async (tx) => {
      const created = await tx.healthSyncDiagnosticReport.create({
        data: {
          deviceId: device.id,
          userId,
          summary: input.summary ? input.summary : null,
          report: input.report as Prisma.InputJsonObject,
        },
        select: { id: true, createdAt: true },
      });
      await trimReports(tx, device.id);
      return created;
    });
    return { id: report.id, createdAt: report.createdAt.toISOString() };
  }

  async listDiagnostics(userId: string, deviceId: string, limit: number): Promise<ReportSummaryView[]> {
    const device = await this.findOwned(userId, deviceId);
    const reports = await this.prisma.healthSyncDiagnosticReport.findMany({
      where: { deviceId: device.id, userId },
      select: { id: true, deviceId: true, summary: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return reports.map((report) => ({ ...report, createdAt: report.createdAt.toISOString() }));
  }

  async getDiagnostics(userId: string, deviceId: string, reportId: string): Promise<ReportView> {
    const device = await this.findOwned(userId, deviceId);
    const report = await this.prisma.healthSyncDiagnosticReport.findFirst({
      where: { id: reportId, deviceId: device.id, userId },
    });
    if (!report) throw new NotFoundException('Diagnostics report not found');
    return toReportView(report);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async findOwned(userId: string, deviceId: string): Promise<DeviceWithPat> {
    const device = await this.prisma.healthSyncDevice.findFirst({ where: { id: deviceId, userId }, include: WITH_PAT });
    if (!device) throw new NotFoundException('Health sync device not found');
    return device;
  }

  private toDeviceView(device: DeviceWithPat, userTimezone: string | null): DeviceView {
    return {
      id: device.id,
      name: device.name,
      manufacturer: device.manufacturer,
      model: device.model,
      androidVersion: device.androidVersion,
      sdkInt: device.sdkInt,
      appVersion: device.appVersion,
      healthConnectVersion: device.healthConnectVersion,
      packageName: device.packageName,
      signingSha256: device.signingSha256,
      timezone: device.timezone,
      userTimezone,
      status: device.status,
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      lastSyncAt: device.lastSyncAt?.toISOString() ?? null,
      lastSyncStatus: device.lastSyncStatus,
      lastError: device.lastError,
      // A revoked token no longer expires: it is gone.
      tokenExpiresAt: device.pat && !device.pat.revokedAt ? device.pat.expiresAt.toISOString() : null,
      createdAt: device.createdAt.toISOString(),
      updatedAt: device.updatedAt.toISOString(),
    };
  }

  /** `activity.entry.recorded`, after the write committed. A listener's failure never fails the sync. */
  private emitRecorded(event: ActivityEntryRecordedEvent): void {
    try {
      this.events?.emit(ACTIVITY_ENTRY_RECORDED_EVENT, event);
    } catch (error) {
      this.logger.warn(`A ${ACTIVITY_ENTRY_RECORDED_EVENT} listener threw: ${error instanceof Error ? error.name : 'error'}`);
    }
  }

  private healthDataChanged(userId: string): void {
    emitHealthDataChanged(this.events, this.logger, { userId, source: 'measurements' });
  }
}

// =============================================================================
// SQL (each through its raw-SQL partial unique index)
// =============================================================================
//
// Every upsert is one statement: `prev` reads the row the key names BEFORE
// the write (a CTE sees the statement's snapshot), `up` inserts or, when the
// row is owned by this sync AND differs, updates it. `inserted` true is a new
// row, false an updated one; null (nothing written) is `unchanged` when the
// previous row was ours, `skipped` otherwise.
// =============================================================================

function outcome(row: { inserted: boolean | null; owned: boolean | null } | undefined): UpsertOutcome {
  if (row?.inserted === true) return 'created';
  if (row?.inserted === false) return 'updated';
  return row?.owned ? 'unchanged' : 'skipped';
}

async function upsertEntry(tx: Tx, userId: string, provider: string, entry: SyncEntryInput): Promise<UpsertOutcome> {
  const rows = await tx.$queryRaw<Array<{ inserted: boolean | null; owned: boolean | null }>>(Prisma.sql`
    WITH prev AS (
      SELECT ("source" = 'integration') AS owned FROM "activity_entries"
      WHERE "user_id" = ${userId}::uuid AND "provider" = ${provider} AND "external_id" = ${entry.externalId}
    ), up AS (
      INSERT INTO "activity_entries" (
        "id", "user_id", "occurred_on", "occurred_at", "activity_kind", "completed", "duration_seconds", "steps",
        "distance_meters", "source", "provider", "external_id", "note", "created_at", "updated_at"
      ) VALUES (
        ${randomUUID()}::uuid, ${userId}::uuid, ${entry.occurredOn}::date, ${entry.occurredAt ?? null}::timestamptz,
        ${entry.activityKind}::"ActivityKind", true, ${entry.durationSeconds ?? null}::int, ${entry.steps ?? null}::int,
        ${entry.distanceMeters ?? null}::numeric, 'integration'::"ActivitySource", ${provider}, ${entry.externalId},
        ${entry.note ? entry.note : null}, now(), now()
      )
      ON CONFLICT ("user_id", "provider", "external_id") WHERE "provider" IS NOT NULL
      DO UPDATE SET
        "occurred_on" = EXCLUDED."occurred_on",
        "occurred_at" = EXCLUDED."occurred_at",
        "activity_kind" = EXCLUDED."activity_kind",
        "completed" = EXCLUDED."completed",
        "duration_seconds" = EXCLUDED."duration_seconds",
        "steps" = EXCLUDED."steps",
        "distance_meters" = EXCLUDED."distance_meters",
        "note" = EXCLUDED."note",
        "updated_at" = now()
      WHERE "activity_entries"."source" = 'integration'
        AND (
          "activity_entries"."occurred_on", "activity_entries"."occurred_at", "activity_entries"."activity_kind",
          "activity_entries"."completed", "activity_entries"."duration_seconds", "activity_entries"."steps",
          "activity_entries"."distance_meters", "activity_entries"."note"
        ) IS DISTINCT FROM (
          EXCLUDED."occurred_on", EXCLUDED."occurred_at", EXCLUDED."activity_kind", EXCLUDED."completed",
          EXCLUDED."duration_seconds", EXCLUDED."steps", EXCLUDED."distance_meters", EXCLUDED."note"
        )
      RETURNING ("xmax" = 0) AS inserted
    )
    SELECT (SELECT inserted FROM up) AS inserted, (SELECT owned FROM prev) AS owned
  `);
  return outcome(rows[0]);
}

async function upsertMeasurement(
  tx: Tx,
  userId: string,
  provider: string,
  deviceId: string,
  reading: PlannedMeasurement,
): Promise<UpsertOutcome> {
  const method = reading.method ?? SYNC_METRIC_DEFAULT_METHOD[reading.metricKey];
  const rows = await tx.$queryRaw<Array<{ inserted: boolean | null; owned: boolean | null }>>(Prisma.sql`
    WITH prev AS (
      SELECT ("deleted_at" IS NULL AND "superseded_at" IS NULL) AS owned FROM "measurements"
      WHERE "user_id" = ${userId}::uuid AND "external_provider" = ${provider} AND "external_id" = ${reading.externalId}
    ), up AS (
      INSERT INTO "measurements" (
        "id", "user_id", "entry_id", "metric_key", "value", "unit", "measured_at", "local_date", "method", "origin",
        "revision", "external_provider", "external_id", "health_sync_device_id", "created_at", "updated_at"
      ) VALUES (
        ${randomUUID()}::uuid, ${userId}::uuid, ${reading.entryId}::uuid, ${reading.metricKey},
        ${reading.value}::double precision, ${reading.unit}, ${reading.measuredAt}::timestamptz,
        ${reading.localDate}::date, ${method}, 'device', 1, ${provider}, ${reading.externalId}, ${deviceId}::uuid,
        now(), now()
      )
      ON CONFLICT ("user_id", "external_provider", "external_id") WHERE "external_provider" IS NOT NULL
      DO UPDATE SET
        "metric_key" = EXCLUDED."metric_key",
        "value" = EXCLUDED."value",
        "unit" = EXCLUDED."unit",
        "measured_at" = EXCLUDED."measured_at",
        "local_date" = EXCLUDED."local_date",
        "method" = EXCLUDED."method",
        "health_sync_device_id" = EXCLUDED."health_sync_device_id",
        "updated_at" = now()
      WHERE "measurements"."deleted_at" IS NULL AND "measurements"."superseded_at" IS NULL
        AND (
          "measurements"."metric_key", "measurements"."value", "measurements"."unit", "measurements"."measured_at",
          "measurements"."local_date", "measurements"."method"
        ) IS DISTINCT FROM (
          EXCLUDED."metric_key", EXCLUDED."value", EXCLUDED."unit", EXCLUDED."measured_at", EXCLUDED."local_date",
          EXCLUDED."method"
        )
      RETURNING ("xmax" = 0) AS inserted
    )
    SELECT (SELECT inserted FROM up) AS inserted, (SELECT owned FROM prev) AS owned
  `);
  return outcome(rows[0]);
}

async function upsertSleep(
  tx: Tx,
  userId: string,
  provider: string,
  deviceId: string,
  session: SyncSleepInput,
): Promise<UpsertOutcome> {
  const rows = await tx.$queryRaw<Array<{ inserted: boolean | null; owned: boolean | null }>>(Prisma.sql`
    WITH prev AS (
      SELECT ("origin" = 'device') AS owned FROM "sleep_sessions"
      WHERE "user_id" = ${userId}::uuid AND "provider" = ${provider} AND "external_id" = ${session.externalId}
    ), up AS (
      INSERT INTO "sleep_sessions" (
        "id", "user_id", "start_at", "end_at", "local_date", "duration_minutes", "awake_minutes", "light_minutes",
        "deep_minutes", "rem_minutes", "unknown_minutes", "origin", "provider", "external_id",
        "health_sync_device_id", "note", "created_at", "updated_at"
      ) VALUES (
        ${randomUUID()}::uuid, ${userId}::uuid, ${session.startAt}::timestamptz, ${session.endAt}::timestamptz,
        ${session.localDate}::date, ${session.durationMinutes}::int, ${session.awakeMinutes ?? null}::int,
        ${session.lightMinutes ?? null}::int, ${session.deepMinutes ?? null}::int, ${session.remMinutes ?? null}::int,
        ${session.unknownMinutes ?? null}::int, 'device', ${provider}, ${session.externalId}, ${deviceId}::uuid,
        ${session.note ? session.note : null}, now(), now()
      )
      ON CONFLICT ("user_id", "provider", "external_id") WHERE "provider" IS NOT NULL
      DO UPDATE SET
        "start_at" = EXCLUDED."start_at",
        "end_at" = EXCLUDED."end_at",
        "local_date" = EXCLUDED."local_date",
        "duration_minutes" = EXCLUDED."duration_minutes",
        "awake_minutes" = EXCLUDED."awake_minutes",
        "light_minutes" = EXCLUDED."light_minutes",
        "deep_minutes" = EXCLUDED."deep_minutes",
        "rem_minutes" = EXCLUDED."rem_minutes",
        "unknown_minutes" = EXCLUDED."unknown_minutes",
        "note" = EXCLUDED."note",
        "health_sync_device_id" = EXCLUDED."health_sync_device_id",
        "updated_at" = now()
      WHERE "sleep_sessions"."origin" = 'device'
        AND (
          "sleep_sessions"."start_at", "sleep_sessions"."end_at", "sleep_sessions"."local_date",
          "sleep_sessions"."duration_minutes", "sleep_sessions"."awake_minutes", "sleep_sessions"."light_minutes",
          "sleep_sessions"."deep_minutes", "sleep_sessions"."rem_minutes", "sleep_sessions"."unknown_minutes",
          "sleep_sessions"."note"
        ) IS DISTINCT FROM (
          EXCLUDED."start_at", EXCLUDED."end_at", EXCLUDED."local_date", EXCLUDED."duration_minutes",
          EXCLUDED."awake_minutes", EXCLUDED."light_minutes", EXCLUDED."deep_minutes", EXCLUDED."rem_minutes",
          EXCLUDED."unknown_minutes", EXCLUDED."note"
        )
      RETURNING ("xmax" = 0) AS inserted
    )
    SELECT (SELECT inserted FROM up) AS inserted, (SELECT owned FROM prev) AS owned
  `);
  return outcome(rows[0]);
}

/**
 * Deletes this device's rows inside the window that the payload no longer
 * carries, per the scope `run.details.syncedTypes` allowed. Measurements are
 * soft-deleted (active rows only); entries and sleep are hard-deleted.
 */
async function reconcileDeletes(
  tx: Tx,
  userId: string,
  provider: string,
  scope: ReconcileScope,
  plan: { entries: SyncEntryInput[]; measurements: PlannedMeasurement[]; sleepSessions: SyncSleepInput[] },
  now: Date,
): Promise<{ entries: number; measurements: number; sleep: number }> {
  const days = { gte: toDbDate(scope.window.from), lte: toDbDate(scope.window.to) };
  let entries = 0;
  let measurements = 0;
  let sleep = 0;

  if (scope.activityKinds.length > 0) {
    ({ count: entries } = await tx.activityEntry.deleteMany({
      where: {
        userId,
        provider,
        source: 'integration',
        occurredOn: days,
        activityKind: { in: scope.activityKinds as ActivityKind[] },
        externalId: { notIn: plan.entries.map((entry) => entry.externalId) },
      },
    }));
  }
  if (scope.metricKeys.length > 0) {
    ({ count: measurements } = await tx.measurement.updateMany({
      where: {
        userId,
        ...ACTIVE,
        externalProvider: provider,
        metricKey: { in: scope.metricKeys },
        localDate: days,
        externalId: { notIn: plan.measurements.map((reading) => reading.externalId) },
      },
      data: { deletedAt: now },
    }));
  }
  if (scope.sleep) {
    ({ count: sleep } = await tx.sleepSession.deleteMany({
      where: {
        userId,
        provider,
        origin: 'device',
        localDate: days,
        externalId: { notIn: plan.sleepSessions.map((session) => session.externalId) },
      },
    }));
  }
  return { entries, measurements, sleep };
}

/** Keeps the newest {@link RUNS_KEPT_PER_DEVICE} runs of the device. */
async function trimRuns(tx: Tx, deviceId: string): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM "health_sync_runs"
    WHERE "device_id" = ${deviceId}::uuid
      AND "id" NOT IN (
        SELECT "id" FROM "health_sync_runs" WHERE "device_id" = ${deviceId}::uuid
        ORDER BY "created_at" DESC, "id" DESC LIMIT ${RUNS_KEPT_PER_DEVICE}
      )
  `;
}

/** Keeps the newest {@link REPORTS_KEPT_PER_DEVICE} diagnostics reports of the device. */
async function trimReports(tx: Tx, deviceId: string): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM "health_sync_diagnostic_reports"
    WHERE "device_id" = ${deviceId}::uuid
      AND "id" NOT IN (
        SELECT "id" FROM "health_sync_diagnostic_reports" WHERE "device_id" = ${deviceId}::uuid
        ORDER BY "created_at" DESC, "id" DESC LIMIT ${REPORTS_KEPT_PER_DEVICE}
      )
  `;
}

export function toRunView(run: HealthSyncRun): RunView {
  return {
    id: run.id,
    deviceId: run.deviceId,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt.toISOString(),
    windowFrom: run.windowFrom ? fromDbDate(run.windowFrom) : null,
    windowTo: run.windowTo ? fromDbDate(run.windowTo) : null,
    recordsRead: run.recordsRead,
    created: run.created,
    updated: run.updated,
    deleted: run.deleted,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    details: (run.details ?? null) as Record<string, unknown> | null,
    createdAt: run.createdAt.toISOString(),
  };
}

export function toReportView(report: HealthSyncDiagnosticReport): ReportView {
  return {
    id: report.id,
    deviceId: report.deviceId,
    summary: report.summary,
    report: report.report as Record<string, unknown>,
    createdAt: report.createdAt.toISOString(),
  };
}
