/**
 * Sleep sessions (`/api/sleep`), as the web app sees them. Issue #283 scope
 * update, epic #276.
 *
 * Sessions arrive from the Android app's Health Connect sync (origin
 * `device`) or, later, by hand (origin `manual`). Reads need
 * `health_data:read`, delete `health_data:write`; the API enforces both and
 * computes every number (asleep minutes exclude awake time when the phone
 * reported stages). Display only here.
 */
import { api } from './api';

export type SleepOrigin = 'manual' | 'device';

export interface SleepSession {
  id: string;
  startAt: string;
  endAt: string;
  /** `YYYY-MM-DD`: the local date of waking up. */
  localDate: string;
  /** Asleep time (total minus awake when stages exist, else end - start). */
  durationMinutes: number;
  awakeMinutes: number | null;
  lightMinutes: number | null;
  deepMinutes: number | null;
  remMinutes: number | null;
  unknownMinutes: number | null;
  origin: SleepOrigin;
  /** `health_connect:<deviceId>` for synced sessions. */
  provider: string | null;
  externalId: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The API refuses a wider range. */
export const SLEEP_MAX_RANGE_DAYS = 400;
/** The Health page shows this many nights. */
export const SLEEP_NIGHTS_SHOWN = 14;

export const SLEEP_STAGES = ['awake', 'light', 'deep', 'rem', 'unknown'] as const;
export type SleepStage = (typeof SLEEP_STAGES)[number];

export const SLEEP_STAGE_LABELS: Record<SleepStage, string> = {
  awake: 'Awake',
  light: 'Light',
  deep: 'Deep',
  rem: 'REM',
  unknown: 'Asleep',
};

/** `GET /api/sleep?from=&to=` — ordered by `localDate` descending. */
export function listSleep(params: { from: string; to: string }, options: { signal?: AbortSignal } = {}) {
  const search = new URLSearchParams({ from: params.from, to: params.to });
  return api.get<SleepSession[]>(`/sleep?${search.toString()}`, { signal: options.signal });
}

/** `DELETE /api/sleep/:id` */
export function deleteSleep(id: string) {
  return api.delete<void>(`/sleep/${encodeURIComponent(id)}`);
}

/** Stage minutes as `[stage, minutes]`, only the stages the session reported. */
export function sleepStages(session: SleepSession): Array<[SleepStage, number]> {
  const minutes: Record<SleepStage, number | null> = {
    awake: session.awakeMinutes,
    light: session.lightMinutes,
    deep: session.deepMinutes,
    rem: session.remMinutes,
    unknown: session.unknownMinutes,
  };
  return SLEEP_STAGES.filter((stage) => (minutes[stage] ?? 0) > 0).map((stage) => [stage, minutes[stage] as number]);
}

/** `452` → `7h 32m`. */
export function formatSleepDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** True for a session the Android app synced from Health Connect. */
export function isHealthConnectSleep(session: Pick<SleepSession, 'origin' | 'provider'>): boolean {
  return session.origin === 'device' && (session.provider ?? '').startsWith('health_connect:');
}
