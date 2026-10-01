import { randomUUID } from 'node:crypto';

import { activityRefusal } from '../activity/activity-mapper';
import { daysBetween } from '../activity/goal-progress';
import { addDays, localDateInZone } from '../check-ins/local-date';
import { roundCanonical } from '../measurements/metric-registry';
import type { SyncEntryInput, SyncInput, SyncMeasurementInput, SyncSleepInput } from './dto/health-sync.dto';
import {
  HEALTH_SYNC_REASONS,
  MEASUREMENT_WINDOW_SLACK_DAYS,
  SYNC_MAX_DAYS_AHEAD,
  SYNC_MAX_DAYS_BACK,
  SYNC_WINDOW_MAX_DAYS,
  SYNCED_TYPE_SCOPES,
  type SyncedTypeName,
  type SyncedTypeScope,
} from './health-sync.constants';

// =============================================================================
// Health sync — the pure half of a sync (epic #276, #278)
// =============================================================================
//
// Everything `HealthSyncService.sync` decides before it touches the database:
// the allowed days, the window checks, de-duplication (last occurrence of an
// external id wins), the entry grouping of measurements and the
// reconciliation scope. No Nest, no Prisma: unit-tested directly.
// =============================================================================

export interface DayRange {
  from: string;
  to: string;
}

/** The local days a sync may write: [today - 30, today + 1]. */
export function allowedDays(today: string): DayRange {
  return { from: addDays(today, -SYNC_MAX_DAYS_BACK), to: addDays(today, SYNC_MAX_DAYS_AHEAD) };
}

function inRange(day: string, range: DayRange): boolean {
  return day >= range.from && day <= range.to;
}

function outOfRange(path: string, day: string, allowed: DayRange, window?: DayRange) {
  return activityRefusal(
    400,
    HEALTH_SYNC_REASONS.ENTRY_DATE_OUT_OF_RANGE,
    window
      ? `${day} is outside the sync window ${window.from}..${window.to} or the allowed days ${allowed.from}..${allowed.to}`
      : `${day} is outside the allowed days ${allowed.from}..${allowed.to}`,
    { path, allowedFrom: allowed.from, allowedTo: allowed.to, ...(window ? { windowFrom: window.from, windowTo: window.to } : {}) },
  );
}

/** A measurement row ready to upsert: its local day and entry id are decided here. */
export interface PlannedMeasurement extends SyncMeasurementInput {
  localDate: string;
  entryId: string;
}

export interface SyncPlan {
  entries: SyncEntryInput[];
  measurements: PlannedMeasurement[];
  sleepSessions: SyncSleepInput[];
  /** Null when this sync reconciles nothing. */
  reconcile: ReconcileScope | null;
}

/**
 * Validates the days of a sync against the user's `today` (their Health
 * Profile zone) and returns the de-duplicated rows to write.
 *
 * Throws 400 `WINDOW_TOO_LARGE` for a window over 31 days and 400
 * `ENTRY_DATE_OUT_OF_RANGE` (with `details.path`) for a window, entry,
 * reading or sleep session outside the allowed days, or outside the window
 * when one is given (a reading, whose local day is computed here in the
 * user's zone, gets one day of slack on each side of the window).
 */
export function planSync(
  input: SyncInput,
  today: string,
  userTimeZone: string | null,
  newId: () => string = randomUUID,
): SyncPlan {
  const allowed = allowedDays(today);
  const window = input.window;

  if (window) {
    if (daysBetween(window.from, window.to) + 1 > SYNC_WINDOW_MAX_DAYS) {
      throw activityRefusal(
        400,
        HEALTH_SYNC_REASONS.WINDOW_TOO_LARGE,
        `The window may span at most ${SYNC_WINDOW_MAX_DAYS} days`,
        { path: 'window', max: SYNC_WINDOW_MAX_DAYS },
      );
    }
    if (!inRange(window.from, allowed)) throw outOfRange('window.from', window.from, allowed);
    if (!inRange(window.to, allowed)) throw outOfRange('window.to', window.to, allowed);
  }

  const strict = (day: string) => inRange(day, allowed) && (!window || inRange(day, window));
  const slack: DayRange | undefined = window
    ? { from: addDays(window.from, -MEASUREMENT_WINDOW_SLACK_DAYS), to: addDays(window.to, MEASUREMENT_WINDOW_SLACK_DAYS) }
    : undefined;

  input.entries.forEach((entry, index) => {
    if (!strict(entry.occurredOn)) throw outOfRange(`entries.${index}.occurredOn`, entry.occurredOn, allowed, window);
  });

  const readings = (input.measurements ?? []).map((reading, index) => {
    const day = localDateInZone(new Date(reading.measuredAt), userTimeZone);
    if (!inRange(day, allowed) || (slack && !inRange(day, slack))) {
      throw outOfRange(`measurements.${index}.measuredAt`, day, allowed, window);
    }
    return { ...reading, value: roundCanonical(reading.value), localDate: day };
  });

  (input.sleepSessions ?? []).forEach((session, index) => {
    if (!strict(session.localDate)) throw outOfRange(`sleepSessions.${index}.localDate`, session.localDate, allowed, window);
  });

  return {
    entries: lastWins(input.entries),
    measurements: assignEntryIds(lastWins(readings), newId),
    sleepSessions: lastWins(input.sleepSessions ?? []),
    reconcile: window && input.run.status === 'ok' ? reconcileScope(window, syncedTypesOf(input.run.details)) : null,
  };
}

/** One row per `externalId`, the LAST occurrence winning, in first-seen order. */
export function lastWins<T extends { externalId: string }>(rows: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of rows) {
    byId.delete(row.externalId);
    byId.set(row.externalId, row);
  }
  return [...byId.values()];
}

/**
 * Readings sharing an `entryKey` share one new entry id (a blood-pressure
 * pair); a reading without one gets an entry of its own. Only an INSERT uses
 * it: an existing row keeps its entry.
 */
export function assignEntryIds<T extends { entryKey?: string }>(
  readings: readonly T[],
  newId: () => string = randomUUID,
): Array<T & { entryId: string }> {
  const byKey = new Map<string, string>();
  return readings.map((reading) => {
    if (reading.entryKey === undefined) return { ...reading, entryId: newId() };
    let entryId = byKey.get(reading.entryKey);
    if (!entryId) {
      entryId = newId();
      byKey.set(reading.entryKey, entryId);
    }
    return { ...reading, entryId };
  });
}

// -----------------------------------------------------------------------------
// Reconciliation scope
// -----------------------------------------------------------------------------

export interface ReconcileScope {
  window: DayRange;
  /** Activity kinds whose absent rows are deleted; empty = none. */
  activityKinds: string[];
  /** Metric keys whose absent readings are soft-deleted; empty = none. */
  metricKeys: string[];
  sleep: boolean;
}

/** `run.details.syncedTypes`, the strings only; anything else is no list. */
export function syncedTypesOf(details: Record<string, unknown> | undefined): string[] {
  const value = details?.syncedTypes;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** What a reconciling sync may delete: the union of its synced types' scopes ({@link SYNCED_TYPE_SCOPES}). */
export function reconcileScope(window: DayRange, syncedTypes: readonly string[]): ReconcileScope {
  const activityKinds = new Set<string>();
  const metricKeys = new Set<string>();
  let sleep = false;

  for (const name of syncedTypes) {
    if (!Object.prototype.hasOwnProperty.call(SYNCED_TYPE_SCOPES, name)) continue;
    const scope: SyncedTypeScope = SYNCED_TYPE_SCOPES[name as SyncedTypeName];
    if (scope.table === 'activity_entries') scope.activityKinds.forEach((kind) => activityKinds.add(kind));
    else if (scope.table === 'measurements') scope.metricKeys.forEach((key) => metricKeys.add(key));
    else sleep = true;
  }

  return { window, activityKinds: [...activityKinds], metricKeys: [...metricKeys], sleep };
}
