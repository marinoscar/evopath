/**
 * The activity goals API (`/api/goals`) and the activity entries API
 * (`/api/activity-entries`), as the web app sees them. Epic #260, #266/#267/#268.
 *
 * Every route is owner-scoped on the server (`goals:read` for reads,
 * `goals:write` otherwise). `services/api.ts` stays the transport (bearer
 * token, refresh, the `{ data }` envelope); this module holds the calls next
 * to their types.
 *
 * CONCURRENCY: `PATCH /api/goals/:id` requires `If-Match: <version>`. A stale
 * version answers `412` (see `isGoalStale`); reload and re-apply.
 *
 * UNITS: the API speaks meters and seconds only. Display converts.
 *
 * The bounds below mirror the API's Zod schemas so a form can explain a
 * problem before the round trip; the API decides (progress, matching, on
 * track, streaks are all computed server-side and shown as sent).
 */
import { api, ApiError } from './api';

// -----------------------------------------------------------------------------
// Vocabulary and bounds
// -----------------------------------------------------------------------------

/** Kinds a goal may track. `steps` is entry-only and refused on goals. */
export const GOAL_ACTIVITY_KINDS = ['walk', 'run', 'cardio_any', 'workout_any', 'custom'] as const;
export type GoalActivityKind = (typeof GOAL_ACTIVITY_KINDS)[number];

/** Mirrors the Prisma `ActivityKind` enum. */
export type ActivityKind = GoalActivityKind | 'steps';

export const GOAL_METRICS = ['sessions', 'minutes', 'steps', 'distance_m'] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];

export const GOAL_PERIODS = ['week', 'day'] as const;
export type GoalPeriod = (typeof GOAL_PERIODS)[number];

export const GOAL_STATUSES = ['active', 'paused', 'archived'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export type ActivitySource = 'manual' | 'workout' | 'integration';

export const GOAL_TITLE_MAX = 80;
export const GOAL_CUSTOM_LABEL_MAX = 80;
export const GOAL_TARGET_MIN = 1;
export const GOAL_TARGET_MAX = 1_000_000;
/** More active goals than this answers `409 GOAL_LIMIT_REACHED`. */
export const MAX_ACTIVE_GOALS = 10;

/** An entry's day may be today or up to this many days back (local). */
export const ENTRY_MAX_DAYS_BACK = 7;
export const ENTRY_STEPS_MAX = 200_000;
export const ENTRY_DURATION_MAX_SECONDS = 86_400;
export const ENTRY_NOTE_MAX = 280;

export const GOALS_UNAVAILABLE = 'Goals are not available for your account.';

// -----------------------------------------------------------------------------
// Shapes
// -----------------------------------------------------------------------------

export interface Goal {
  id: string;
  title: string;
  activityKind: GoalActivityKind;
  customLabel: string | null;
  metric: GoalMetric;
  target: number;
  period: GoalPeriod;
  status: GoalStatus;
  /** `YYYY-MM-DD`. */
  startsOn: string;
  /** Send back as `If-Match` on `PATCH`. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface GoalTemplate {
  key: string;
  title: string;
  activityKind: GoalActivityKind;
  metric: GoalMetric;
  target: number;
  period: GoalPeriod;
}

export interface CreateGoalInput {
  title: string;
  activityKind: GoalActivityKind;
  customLabel?: string;
  metric: GoalMetric;
  target: number;
  period: GoalPeriod;
  startsOn?: string;
}

export type UpdateGoalInput = Partial<Omit<CreateGoalInput, 'customLabel'>> & { customLabel?: string | null };

export interface ActivityEntry {
  id: string;
  occurredOn: string;
  occurredAt: string | null;
  activityKind: ActivityKind;
  completed: boolean;
  durationSeconds: number | null;
  steps: number | null;
  distanceMeters: number | null;
  source: ActivitySource;
  workoutId: string | null;
  provider: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateActivityEntryInput {
  /** `YYYY-MM-DD`, within [today-7, today] local. Omitted: today (server's local day). */
  occurredOn?: string;
  activityKind: ActivityKind;
  completed?: boolean;
  durationSeconds?: number;
  steps?: number;
  distanceMeters?: number;
  note?: string;
}

export interface GoalProgress {
  goalId: string;
  goal: Goal;
  periodStart: string;
  periodEnd: string;
  done: number;
  target: number;
  remaining: number;
  /** Includes today. */
  daysLeft: number;
  onTrack: boolean;
  hit: boolean;
  streakPeriods: number;
  entries: Array<ActivityEntry & { superseded: boolean }>;
}

export interface GoalHistoryPeriod {
  periodStart: string;
  periodEnd: string;
  done: number;
  target: number;
  hit: boolean;
}

// -----------------------------------------------------------------------------
// Calls
// -----------------------------------------------------------------------------

const goalPath = (id: string) => `/goals/${encodeURIComponent(id)}`;

/** `GET /api/goals?status=` */
export function listGoals(status: GoalStatus, options: { signal?: AbortSignal } = {}) {
  return api.get<Goal[]>(`/goals?status=${encodeURIComponent(status)}`, { signal: options.signal });
}

/** `GET /api/goals/templates` */
export function listGoalTemplates(options: { signal?: AbortSignal } = {}) {
  return api.get<GoalTemplate[]>('/goals/templates', { signal: options.signal });
}

/** `GET /api/goals/:id` */
export function getGoal(id: string) {
  return api.get<Goal>(goalPath(id));
}

/** `POST /api/goals` */
export function createGoal(input: CreateGoalInput) {
  return api.post<Goal>('/goals', input);
}

/** `PATCH /api/goals/:id` with `If-Match: <version>`. */
export function updateGoal(id: string, expectedVersion: number, patch: UpdateGoalInput) {
  return api.patch<Goal>(goalPath(id), patch, { headers: { 'If-Match': String(expectedVersion) } });
}

export type GoalTransition = 'pause' | 'resume' | 'archive';

/** `POST /api/goals/:id/pause|resume|archive` */
export function transitionGoal(id: string, action: GoalTransition) {
  return api.post<Goal>(`${goalPath(id)}/${action}`);
}

/** `GET /api/goals/progress?date=` (active goals only). */
export function getGoalProgress(date?: string, options: { signal?: AbortSignal } = {}) {
  const query = date ? `?date=${encodeURIComponent(date)}` : '';
  return api.get<GoalProgress[]>(`/goals/progress${query}`, { signal: options.signal });
}

/** `GET /api/goals/:id/history?limit=` (newest first). */
export function getGoalHistory(id: string, limit = 12, options: { signal?: AbortSignal } = {}) {
  return api.get<GoalHistoryPeriod[]>(`${goalPath(id)}/history?limit=${limit}`, { signal: options.signal });
}

/** `POST /api/activity-entries` */
export function createActivityEntry(input: CreateActivityEntryInput) {
  return api.post<ActivityEntry>('/activity-entries', input);
}

/** `GET /api/activity-entries?from=&to=&kind=` */
export function listActivityEntries(params: { from: string; to: string; kind?: ActivityKind }) {
  const search = new URLSearchParams({ from: params.from, to: params.to });
  if (params.kind) search.set('kind', params.kind);
  return api.get<ActivityEntry[]>(`/activity-entries?${search.toString()}`);
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** `details.reason`, else the envelope `code`. */
export function goalErrorReason(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const details = err.details;
  if (details && typeof details === 'object' && 'reason' in details) {
    const reason = (details as { reason: unknown }).reason;
    if (typeof reason === 'string') return reason;
  }
  return err.code ?? null;
}

export function isGoalLimitReached(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && goalErrorReason(err) === 'GOAL_LIMIT_REACHED';
}

/** The goal changed since it was loaded (`412`), or `If-Match` was missing (`428`). */
export function isGoalStale(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 412 || err.status === 428);
}

export const GOAL_LIMIT_MESSAGE = `You can have up to ${MAX_ACTIVE_GOALS} active goals. Pause or archive one first.`;
export const GOAL_STALE_MESSAGE =
  'This goal was changed somewhere else, so your edit was not saved. The latest version is loaded; review it and save again.';

/** A sentence for an error from any goals or entries route. */
export function goalErrorMessage(err: unknown, fallback: string): string {
  if (isGoalLimitReached(err)) return GOAL_LIMIT_MESSAGE;
  if (isGoalStale(err)) return GOAL_STALE_MESSAGE;
  if (err instanceof ApiError && err.status === 403) return GOALS_UNAVAILABLE;
  if (err instanceof ApiError || err instanceof Error) return err.message || fallback;
  return fallback;
}
