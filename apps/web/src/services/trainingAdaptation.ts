/**
 * Quick workout adaptation (E6.1): "I have 30 minutes", "I'm sore", "only
 * dumbbells". `/api/ai/training/adaptations`, as the web app sees it.
 *
 * `services/api.ts` stays the transport; this module holds the calls next to
 * the types they produce (mirrors `apps/api/src/training-adaptation/dto/`).
 * Every route sits behind `ai:use` and the AI kill switch (`403 AI_DISABLED`
 * while AI is off); `apply/workout` adds `workouts:write` and `apply/plan`
 * `programs:write`. The API decides everything: the browser renders the
 * preview it builds, the proposal it checked and the refusals it answers.
 *
 * The live progress of a run is the E5.6 run view (`runId`, kind `adapt`):
 * `hooks/useTrainingRun.ts`.
 */
import { api, ApiError } from './api';
import type { SentDataSection, RoleResolutionState } from './trainingAgents';
import type { TaskReasoningEffort } from '../types';

// -----------------------------------------------------------------------------
// The request
// -----------------------------------------------------------------------------

/** Mirrors `ADAPTATION_REQUEST_LIMITS` in `adaptation.constants.ts`. */
export const ADAPTATION_LIMITS = {
  minutes: { min: 10, max: 240 },
  soreMuscles: { min: 1, max: 8 },
  onlyEquipment: { min: 1, max: 12 },
  freeTextChars: 500,
} as const;

/** The minute chips; "Custom" takes any value inside `ADAPTATION_LIMITS.minutes`. */
export const MINUTE_CHOICES = [15, 20, 30, 45, 60] as const;

export const SORENESS_LEVELS = ['mild', 'moderate'] as const;
export type SorenessLevel = (typeof SORENESS_LEVELS)[number];

export type AdaptationEquipment =
  | { mode: 'gym' }
  | { mode: 'only'; equipmentTypeIds: string[] }
  | { mode: 'bodyweight' };

/** `POST /api/ai/training/adaptations` and its `/context-preview`. */
export interface AdaptationRequest {
  minutes?: number;
  soreness?: { muscles: string[]; level: SorenessLevel };
  lowEnergy?: boolean;
  equipment?: AdaptationEquipment;
  gymId?: string;
  freeText?: string;
  useReadiness?: boolean;
  baseWorkout?: 'planned' | 'none';
}

/** What the API answers when nothing would change (400). */
export const NOTHING_TO_CHANGE_MESSAGE = 'Tell us what to change';

/**
 * The schema's at-least-one rule, so the sheet can say so before the round
 * trip (the API decides; mirrors `requestsAChange` in the request DTO).
 */
export function requestsAChange(body: AdaptationRequest): boolean {
  return (
    body.minutes !== undefined ||
    body.soreness !== undefined ||
    body.lowEnergy === true ||
    (body.equipment !== undefined && body.equipment.mode !== 'gym') ||
    body.gymId !== undefined ||
    (body.freeText !== undefined && body.freeText.trim().length > 0)
  );
}

/** A human sentence for the first problem in a request, or null when it can be sent. */
export function adaptationRequestProblem(body: AdaptationRequest): string | null {
  const { minutes, soreness, equipment, freeText } = body;
  if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < ADAPTATION_LIMITS.minutes.min || minutes > ADAPTATION_LIMITS.minutes.max)) {
    return `Minutes must be a whole number from ${ADAPTATION_LIMITS.minutes.min} to ${ADAPTATION_LIMITS.minutes.max}.`;
  }
  if (soreness && soreness.muscles.length < ADAPTATION_LIMITS.soreMuscles.min) return 'Choose where you are sore.';
  if (soreness && soreness.muscles.length > ADAPTATION_LIMITS.soreMuscles.max) {
    return `Choose at most ${ADAPTATION_LIMITS.soreMuscles.max} sore areas.`;
  }
  if (equipment?.mode === 'only' && equipment.equipmentTypeIds.length < ADAPTATION_LIMITS.onlyEquipment.min) {
    return 'Choose the equipment you have.';
  }
  if (equipment?.mode === 'only' && equipment.equipmentTypeIds.length > ADAPTATION_LIMITS.onlyEquipment.max) {
    return `Choose at most ${ADAPTATION_LIMITS.onlyEquipment.max} kinds of equipment.`;
  }
  if (freeText && freeText.trim().length > ADAPTATION_LIMITS.freeTextChars) {
    return `Keep it under ${ADAPTATION_LIMITS.freeTextChars} characters.`;
  }
  if (!requestsAChange(body)) return NOTHING_TO_CHANGE_MESSAGE;
  return null;
}

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

export interface AdaptationSentData {
  sections: SentDataSection[];
  dropped: string[];
  excluded: string[];
}

export interface AdaptationRoleModel {
  role: 'planner' | 'critic';
  state: RoleResolutionState;
  model: { provider: string; modelId: string; displayName: string } | null;
  effectiveEffort: TaskReasoningEffort | null;
  fix: 'settings' | 'keys' | 'admin' | null;
  runnable: boolean;
}

export interface AdaptationSafety {
  level: 'ok' | 'conservative' | 'blocked';
  reasons: string[];
}

/** `POST /context-preview`: exactly what would be sent, and whether a model would be called. */
export interface AdaptationPreview {
  baseWorkout: 'planned' | 'none';
  base: { programWorkoutId: string; name: string; date: string; planVersion: number } | null;
  sentData: AdaptationSentData;
  models: { planner: AdaptationRoleModel; critic: AdaptationRoleModel };
  willCallProvider: boolean;
  safety: AdaptationSafety;
  blocked: { reason: string; guidance: string } | null;
}

/** `POST /`: 202 `queued`, or 200 `blocked_safety` with `guidance` (no run, no job). */
export interface AdaptationStarted {
  adaptationId: string;
  jobId: string | null;
  runId: string | null;
  status: 'queued' | 'blocked_safety';
  guidance?: string;
}

export const ADAPTATION_STATUSES = [
  'queued',
  'running',
  'ready',
  'failed',
  'cancelled',
  'blocked_safety',
  'applied',
  'discarded',
] as const;
export type AdaptationStatus = (typeof ADAPTATION_STATUSES)[number];
export const ACTIVE_ADAPTATION_STATUSES: readonly AdaptationStatus[] = ['queued', 'running'];

export type AdaptationDropReason = 'time' | 'sore' | 'equipment' | 'energy' | 'other';
export type AdaptationExerciseSource = 'kept' | 'swapped' | 'added';

export interface AdaptedExercise {
  exerciseId: string;
  /** The library slug. */
  exerciseKey: string;
  name: string;
  position: number;
  source: AdaptationExerciseSource;
  replacesExerciseId: string | null;
  replacesExerciseKey: string | null;
  isPriority: boolean;
  sets: number;
  repMin: number;
  repMax: number;
  targetRpe: number | null;
  restSeconds: number;
  note: string | null;
  primaryMuscles: string[];
  trackingMode: string;
}

export interface AdaptedWorkout {
  title: string;
  summary: string;
  estimatedMinutes: number;
  exercises: AdaptedExercise[];
  dropped: Array<{ exerciseId: string; exerciseKey: string; name: string; reason: AdaptationDropReason }>;
  rationale: string[];
  uncertainty: string[];
}

export interface GuardrailFinding {
  code: string;
  exerciseKey: string | null;
  message: string;
}

export interface AdaptationGuardrailReport {
  repairs: GuardrailFinding[];
  rejected: GuardrailFinding[];
  estimatedMinutes: number;
  fitsRequest: boolean;
  promptVersion: number;
  warnings: string[];
}

export interface AdaptationCriticReport {
  verdict: 'accept' | 'revise' | null;
  checks: { honoursRequest: boolean; preservesIntent: boolean; avoidsSoreAreas: boolean; sensibleOrder: boolean } | null;
  issues: Array<{ code: string; severity: 'minor' | 'major'; note: string }>;
  rounds: number;
  skipped?: 'token_cap' | 'error';
}

/** `GET /:id`. */
export interface AdaptationView {
  id: string;
  status: AdaptationStatus;
  request: AdaptationRequest & Record<string, unknown>;
  gymId: string | null;
  baseRef: { planId: string; planVersionId: string | null; planVersion: number; planWorkoutId: string; date: string } | null;
  proposal: AdaptedWorkout | null;
  guardrailReport: AdaptationGuardrailReport | null;
  criticReport: AdaptationCriticReport | null;
  safety: AdaptationSafety | null;
  sentData: AdaptationSentData | null;
  models: { planner: { provider: string; modelId: string } | null; critic: { provider: string; modelId: string } | null };
  runId: string | null;
  jobId: string | null;
  stage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  appliedAs: 'one_off' | 'plan_change' | null;
  appliedWorkoutId: string | null;
  appliedPlanVersionId: string | null;
  appliedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  guidance: string | null;
}

export interface ApplyWorkoutResult {
  workoutId: string;
  linkedToPlan: boolean;
  planChanged: boolean;
}

export interface ApplyPlanResult {
  programId: string;
  planVersionId: string;
  versionNumber: number;
  changeLogId: string;
}

// -----------------------------------------------------------------------------
// Calls
// -----------------------------------------------------------------------------

const BASE = '/ai/training/adaptations';
const path = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export function previewAdaptation(body: AdaptationRequest, options: { signal?: AbortSignal } = {}): Promise<AdaptationPreview> {
  return api.post<AdaptationPreview>(`${BASE}/context-preview`, body, { signal: options.signal });
}

export function startAdaptation(body: AdaptationRequest): Promise<AdaptationStarted> {
  return api.post<AdaptationStarted>(BASE, body);
}

export function getAdaptation(id: string): Promise<AdaptationView> {
  return api.get<AdaptationView>(path(id));
}

export function cancelAdaptation(id: string): Promise<AdaptationView> {
  return api.post<AdaptationView>(`${path(id)}/cancel`);
}

export function applyAdaptationWorkout(id: string): Promise<ApplyWorkoutResult> {
  return api.post<ApplyWorkoutResult>(`${path(id)}/apply/workout`);
}

export function applyAdaptationPlan(id: string): Promise<ApplyPlanResult> {
  return api.post<ApplyPlanResult>(`${path(id)}/apply/plan`);
}

export function discardAdaptation(id: string): Promise<void> {
  return api.delete<void>(path(id));
}

// -----------------------------------------------------------------------------
// Refusals
// -----------------------------------------------------------------------------

/** `details.reason` values (mirrors `ADAPTATION_REASONS`), plus the kill switch's. */
export const ADAPTATION_REFUSALS = {
  NOTHING_TO_CHANGE: 'ADAPTATION_NOTHING_TO_CHANGE',
  EQUIPMENT_NOT_IN_GYM: 'ADAPTATION_EQUIPMENT_NOT_IN_GYM',
  IN_PROGRESS: 'ADAPTATION_IN_PROGRESS',
  ROLE_UNAVAILABLE: 'TRAINING_ROLE_UNAVAILABLE',
  NOT_READY: 'ADAPTATION_NOT_READY',
  ALREADY_APPLIED: 'ADAPTATION_ALREADY_APPLIED',
  STALE: 'ADAPTATION_STALE',
  NO_BASE: 'ADAPTATION_NO_BASE',
  WORKOUT_IN_PROGRESS: 'WORKOUT_IN_PROGRESS',
  NOT_CANCELLABLE: 'ADAPTATION_NOT_CANCELLABLE',
  AI_DISABLED: 'AI_DISABLED',
} as const;

export interface AdaptationRefusal {
  status: number;
  reason: string | null;
  details: Record<string, unknown>;
  message: string;
}

/** The refusal behind a failed call: `details.reason`, else the error `code` (the kill switch's `AI_DISABLED`). */
export function adaptationRefusalOf(error: unknown): AdaptationRefusal | null {
  if (!(error instanceof ApiError)) return null;
  const details = (error.details && typeof error.details === 'object' ? error.details : {}) as Record<string, unknown>;
  const reason = typeof details.reason === 'string' ? details.reason : (error.code ?? null);
  return { status: error.status, reason, details, message: error.message };
}

// -----------------------------------------------------------------------------
// The latest adaptation (the "Adjusted workout ready" resume chip)
// -----------------------------------------------------------------------------
//
// There is no list route: the browser remembers the id of the adaptation it
// last started and asks `GET /:id` whether it is still ready. Per-viewer
// convenience only (the row itself is the truth); every access is guarded
// because storage can be missing or throw.

export const LATEST_ADAPTATION_KEY = 'evopath.latestAdaptation';
/** How long the resume chip may offer an adaptation. */
export const RESUME_WINDOW_MS = 24 * 60 * 60_000;

export interface RememberedAdaptation {
  id: string;
  at: number;
}

export function rememberAdaptation(id: string, now = Date.now()): void {
  try {
    window.localStorage.setItem(LATEST_ADAPTATION_KEY, JSON.stringify({ id, at: now }));
  } catch {
    // Storage unavailable: the chip simply never shows.
  }
}

export function recallAdaptation(now = Date.now()): RememberedAdaptation | null {
  try {
    const raw = window.localStorage.getItem(LATEST_ADAPTATION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<RememberedAdaptation>;
    if (typeof value.id !== 'string' || typeof value.at !== 'number') return null;
    if (now - value.at > RESUME_WINDOW_MS) {
      forgetAdaptation();
      return null;
    }
    return { id: value.id, at: value.at };
  } catch {
    return null;
  }
}

export function forgetAdaptation(id?: string): void {
  try {
    if (id) {
      const raw = window.localStorage.getItem(LATEST_ADAPTATION_KEY);
      const value = raw ? (JSON.parse(raw) as Partial<RememberedAdaptation>) : null;
      if (value?.id !== id) return;
    }
    window.localStorage.removeItem(LATEST_ADAPTATION_KEY);
  } catch {
    // Nothing to do.
  }
}
