/**
 * The training programs API (`/api/programs`), as the web app sees it. E5.1.
 *
 * Every route is owner-scoped on the server (`programs:read` /
 * `programs:write`); another user's program answers `404`. Manual plans need
 * no AI. `services/api.ts` stays the transport (bearer token, refresh, the
 * `{ data }` envelope); this module holds the calls next to their types.
 *
 * CONCURRENCY: content writes (`replaceProgramStructure`, `revertProgram`)
 * send the loaded `currentVersion` as `If-Match`. A stale version answers
 * `409` with `details.reason: 'TRAINING_STALE_PLAN'` and
 * `details.currentVersion`; reload and re-apply.
 *
 * UNITS: the API speaks kilograms only (`targetLoadKg`). Display converts with
 * `formatTargetLoad` (`utils/units.ts`), from the Health Profile `unitSystem`.
 *
 * The bounds below mirror the API's plan contract
 * (`apps/api/src/programs/contracts/plan-tree.contract.ts`) so a form can
 * explain a problem before the round trip; the API decides.
 */

import { formatWeight, type WeightUnit } from '../utils/units';
import { api, ApiError } from './api';

// -----------------------------------------------------------------------------
// Vocabulary and bounds
// -----------------------------------------------------------------------------

export const PROGRAM_STATUSES = ['draft', 'active', 'paused', 'archived', 'completed'] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

export const PROGRAM_GOALS = ['strength', 'hypertrophy', 'fat_loss', 'general', 'endurance', 'custom'] as const;
export type ProgramGoal = (typeof PROGRAM_GOALS)[number];

export const PROGRAM_AUTONOMY = ['autonomous', 'ask_first'] as const;
export type ProgramAutonomy = (typeof PROGRAM_AUTONOMY)[number];

export type ProgramSource = 'ai' | 'manual';

export const VERSION_ORIGINS = ['initial', 'ai_create', 'ai_adapt', 'manual_edit', 'revert', 'duplicate'] as const;
export type VersionOrigin = (typeof VERSION_ORIGINS)[number];

export type ChangeKind = 'created' | 'adapted' | 'edited' | 'reverted';
export type ChangeActor = 'ai' | 'user';
export const CHANGE_STATUSES = ['applied', 'proposed', 'rejected', 'reverted', 'superseded', 'expired'] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export type LoadGuidance = 'choose_start' | 'from_history' | 'fixed';

export const PLAN_LIMITS = {
  weeksMax: 52,
  workoutsPerWeekMax: 7,
  exercisesPerWorkoutMax: 20,
  nameMax: 100,
  nodeRationaleMax: 300,
  targetSets: { min: 1, max: 20 },
  reps: { min: 1, max: 100 },
  targetLoadKg: { min: 0, max: 1000, decimals: 3 },
  targetRpe: { min: 1, max: 10, step: 0.5 },
  restSeconds: { min: 0, max: 900 },
} as const;

/** `details.reason` values the programs API answers with. */
export const PROGRAM_REFUSALS = {
  STALE_PLAN: 'TRAINING_STALE_PLAN',
  NOT_LATEST: 'NOT_LATEST',
  NOT_REVERTIBLE: 'NOT_REVERTIBLE',
  SNAPSHOT_UNSUPPORTED: 'SNAPSHOT_UNSUPPORTED',
  IF_MATCH_REQUIRED: 'IF_MATCH_REQUIRED',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  NOT_SCHEDULABLE: 'PLAN_NOT_SCHEDULABLE',
  ACTIVE_PROGRAM_CONFLICT: 'ACTIVE_PROGRAM_CONFLICT',
  START_DATE_OUT_OF_RANGE: 'START_DATE_OUT_OF_RANGE',
  PROGRAM_ARCHIVED: 'PROGRAM_ARCHIVED',
  HAS_HISTORY: 'PROGRAM_HAS_HISTORY',
  UNKNOWN_EXERCISES: 'UNKNOWN_EXERCISES',
  ROW_ID_CONFLICT: 'ROW_ID_CONFLICT',
  INVALID_PLAN: 'INVALID_PLAN',
} as const;
export type ProgramRefusal = (typeof PROGRAM_REFUSALS)[keyof typeof PROGRAM_REFUSALS];

// -----------------------------------------------------------------------------
// The plan tree (what PUT /structure takes; ids optional for new rows)
// -----------------------------------------------------------------------------

export interface PlanExercise {
  /** Omit for a new row. */
  id?: string;
  exerciseId: string;
  position: number;
  isPriority?: boolean;
  targetSets: number;
  repMin: number;
  repMax: number;
  /** Kilograms; null lets the lifter choose or use history. */
  targetLoadKg?: number | null;
  /** 1..10 in steps of 0.5. */
  targetRpe?: number | null;
  restSeconds: number;
  loadGuidance?: LoadGuidance;
  rationale?: string | null;
  evidenceRefs?: string[];
  notes?: string | null;
  equipmentTypeId?: string | null;
}

export interface PlanWorkout {
  id?: string;
  position: number;
  /** ISO weekday 1 (Monday) .. 7 (Sunday); null when unscheduled. */
  weekday?: number | null;
  name: string;
  estimatedMinutes?: number | null;
  rationale?: string | null;
  exercises: PlanExercise[];
}

export interface PlanWeek {
  id?: string;
  /** 1-based, program-wide, contiguous. */
  weekNumber: number;
  isDeload?: boolean;
  workouts: PlanWorkout[];
}

export interface PlanBlock {
  id?: string;
  position: number;
  name: string;
  focus?: string | null;
  rationale?: string | null;
  weeks: PlanWeek[];
}

export interface PlanTree {
  blocks: PlanBlock[];
}

// -----------------------------------------------------------------------------
// Views
// -----------------------------------------------------------------------------

export interface ProgramHeader {
  id: string;
  name: string;
  goal: ProgramGoal;
  status: ProgramStatus;
  source: ProgramSource;
  autonomy: ProgramAutonomy;
  /** `YYYY-MM-DD`, set on activation. */
  startDate: string | null;
  gymId: string | null;
  /** Send back as `If-Match` on content writes. */
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProgramListItem extends ProgramHeader {
  /** AI changes the owner has not yet marked seen. */
  unseenChangeCount: number;
}

export interface PlanExerciseView extends Required<Omit<PlanExercise, 'id'>> {
  id: string;
  /** Null when the exercise is no longer available; see `exerciseUnavailable`. */
  exercise: { id: string; name: string; slug: string; trackingMode: string } | null;
  exerciseUnavailable: boolean;
}

export interface PlanWorkoutView extends Required<Omit<PlanWorkout, 'id' | 'exercises'>> {
  id: string;
  exercises: PlanExerciseView[];
}

export interface PlanWeekView extends Required<Omit<PlanWeek, 'id' | 'workouts'>> {
  id: string;
  workouts: PlanWorkoutView[];
}

export interface PlanBlockView extends Required<Omit<PlanBlock, 'id' | 'weeks'>> {
  id: string;
  weeks: PlanWeekView[];
}

export interface PlanTreeView {
  blocks: PlanBlockView[];
}

export interface Program extends ProgramHeader {
  notes: string | null;
  /** The plan's overall rationale. */
  rationale: string | null;
  intake: unknown;
  gym: { id: string; name: string } | null;
  version: {
    versionNumber: number;
    origin: VersionOrigin;
    rationale: string | null;
    evidence: Record<string, unknown>[];
    meta: Record<string, unknown>;
    createdAt: string;
  };
  tree: PlanTreeView;
  /** Present after a write: non-blocking notes about the saved plan. */
  warnings?: string[];
}

export interface ProgramVersionSummary {
  versionNumber: number;
  origin: VersionOrigin;
  createdAt: string;
  runId: string | null;
  changeLogId: string | null;
  summary: string | null;
}

export interface ProgramVersion extends ProgramVersionSummary {
  rationale: string | null;
  evidence: Record<string, unknown>[];
  meta: Record<string, unknown>;
  /** `{ schemaVersion, program, tree }`, row ids preserved. */
  snapshot: Record<string, unknown>;
}

export interface ChangeLogEntry {
  id: string;
  kind: ChangeKind;
  actor: ChangeActor;
  status: ChangeStatus;
  fromVersion: number | null;
  toVersion: number | null;
  runId: string | null;
  summary: string;
  rationale: string | null;
  operations: Record<string, unknown>[];
  citations: Record<string, unknown>[];
  revertsLogId: string | null;
  seenAt: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ChangeLogPage {
  items: ChangeLogEntry[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

export interface CreateProgramInput {
  name: string;
  goal: ProgramGoal;
  notes?: string | null;
}

export interface UpdateProgramInput {
  name?: string;
  goal?: ProgramGoal;
  notes?: string | null;
  autonomy?: ProgramAutonomy;
  gymId?: string | null;
}

export type RevertProgramInput = { toVersion: number } | { changeLogId: string };

// -----------------------------------------------------------------------------
// Calls
// -----------------------------------------------------------------------------

const programPath = (id: string) => `/programs/${encodeURIComponent(id)}`;
const ifMatch = (version: number) => ({ headers: { 'If-Match': String(version) } });

export function listPrograms(params: { status?: ProgramStatus } = {}, options: { signal?: AbortSignal } = {}) {
  const query = params.status ? `?status=${encodeURIComponent(params.status)}` : '';
  return api.get<ProgramListItem[]>(`/programs${query}`, { signal: options.signal });
}

export function createProgram(input: CreateProgramInput) {
  return api.post<Program>('/programs', input);
}

export function getProgram(id: string, options: { signal?: AbortSignal } = {}) {
  return api.get<Program>(programPath(id), { signal: options.signal });
}

/** Header fields only; does not create a version. */
export function updateProgram(id: string, input: UpdateProgramInput) {
  return api.patch<Program>(programPath(id), input);
}

/** Replace the whole tree. `currentVersion` is the version the edit is based on. */
export function replaceProgramStructure(id: string, currentVersion: number, tree: PlanTree) {
  return api.put<Program>(`${programPath(id)}/structure`, tree, ifMatch(currentVersion));
}

/** `startDate` is the client's calendar day, `YYYY-MM-DD`. */
export function activateProgram(id: string, startDate: string) {
  return api.post<Program>(`${programPath(id)}/activate`, { startDate });
}

export function pauseProgram(id: string) {
  return api.post<Program>(`${programPath(id)}/pause`);
}

export function archiveProgram(id: string) {
  return api.post<Program>(`${programPath(id)}/archive`);
}

export function duplicateProgram(id: string) {
  return api.post<Program>(`${programPath(id)}/duplicate`);
}

/** 409 `PROGRAM_HAS_HISTORY` when workouts were logged from it: archive instead. */
export async function deleteProgram(id: string): Promise<void> {
  await api.delete<void>(programPath(id));
}

export function listProgramVersions(id: string, options: { signal?: AbortSignal } = {}) {
  return api.get<ProgramVersionSummary[]>(`${programPath(id)}/versions`, { signal: options.signal });
}

export function getProgramVersion(id: string, versionNumber: number, options: { signal?: AbortSignal } = {}) {
  return api.get<ProgramVersion>(`${programPath(id)}/versions/${versionNumber}`, { signal: options.signal });
}

/**
 * `{ toVersion }` restores that version as a new one; `{ changeLogId }` undoes
 * the latest change (409 `NOT_LATEST` otherwise: offer "Restore version N").
 */
export function revertProgram(id: string, currentVersion: number, input: RevertProgramInput) {
  return api.post<Program>(`${programPath(id)}/revert`, input, ifMatch(currentVersion));
}

export function listProgramChangeLog(
  id: string,
  params: { status?: ChangeStatus; limit?: number; cursor?: string } = {},
  options: { signal?: AbortSignal } = {},
) {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  const query = search.toString();
  return api.get<ChangeLogPage>(`${programPath(id)}/change-log${query ? `?${query}` : ''}`, { signal: options.signal });
}

/** Marks `upToId` and every older entry as seen. */
export function markProgramChangesSeen(id: string, upToId: string) {
  return api.post<{ updated: number }>(`${programPath(id)}/change-log/seen`, { upToId });
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** The refusal reason of an API error, when it is one of this API's. */
export function programRefusalOf(error: unknown): ProgramRefusal | null {
  if (!(error instanceof ApiError)) return null;
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' && (Object.values(PROGRAM_REFUSALS) as string[]).includes(reason)
    ? (reason as ProgramRefusal)
    : null;
}

/** A target load for display in the user's unit, or null when the plan leaves it open. */
export function formatTargetLoad(kg: number | null | undefined, unit: WeightUnit): string | null {
  return kg === null || kg === undefined ? null : formatWeight(kg, unit);
}
