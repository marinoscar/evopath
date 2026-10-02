/**
 * AI model assignments and per-feature resolution (#173), as the web app sees
 * them.
 *
 * Every AI model choice is an administrator's: `/api/admin/ai/assignments`
 * (`ai_config:read` / `ai_config:write`) stores an organization default and a
 * model per feature, and `GET /api/ai/features` (`ai:use`, AI enabled) answers
 * which model each feature will use for the caller, or why it cannot run and
 * who can fix that. Users never pick a model; the browser only renders what
 * the API resolved. No response here carries key material: `keySource` says
 * whose key pays, never the key.
 */
import { api, ApiError } from './api';
import type { AiKeySource } from './ai';
import type { TaskReasoningEffort } from '../types';

/** Mirrors `AI_FEATURE_IDS` in the API's settings schema. */
export const AI_FEATURE_IDS = [
  'gym_scan',
  'workout_prefill',
  'body_metric_reading',
  'lab_report',
  'training.researcher',
  'training.planner',
  'training.critic',
  'training.evaluator',
  'health_summary',
  'coach.decision',
  'coach.chat',
  'coach.voice',
  'memory.extract',
] as const;

export type AiFeatureId = (typeof AI_FEATURE_IDS)[number];

/** The photo features, the ones `useVisionAvailability` resolves. */
export type AiPhotoFeatureId = Extract<AiFeatureId, 'gym_scan' | 'workout_prefill' | 'body_metric_reading' | 'lab_report'>;

export type AiFeatureGroup = 'photo' | 'training' | 'coach' | 'memory';

export interface AiModelRef {
  provider: string;
  modelId: string;
}

export interface AiFeatureAssignment extends AiModelRef {
  /** Training features only; `null`/absent = the feature default. */
  reasoningEffort?: TaskReasoningEffort | null;
}

// -----------------------------------------------------------------------------
// Admin: /api/admin/ai/assignments
// -----------------------------------------------------------------------------

/** Why a stored assignment is flagged (GET) or refused (PUT). Mirrors `AI_ASSIGNMENT_ISSUES`. */
export type AiAssignmentIssueCode =
  | 'AI_ASSIGNMENT_MODEL_NOT_FOUND'
  | 'AI_ASSIGNMENT_MODEL_DISABLED'
  | 'AI_ASSIGNMENT_MODEL_DEPRECATED'
  | 'AI_ASSIGNMENT_PROVIDER_DISABLED'
  | 'AI_ASSIGNMENT_MODEL_INCAPABLE'
  | 'AI_ASSIGNMENT_EFFORT_UNSUPPORTED';

export interface AiAssignmentWarning {
  code: AiAssignmentIssueCode;
  message: string;
  missing?: string[];
}

export interface AiEligibleModel extends AiModelRef {
  displayName: string;
  /** Efforts the model offers (empty for a model without `reasoning`). */
  reasoningEfforts: string[];
}

export interface AiAssignmentFeatureRow {
  featureId: AiFeatureId;
  label: string;
  group: AiFeatureGroup;
  needs: string[];
  inputModalities: string[];
  /** Providers the feature is restricted to; `null` = any. */
  providers: string[] | null;
  requiresWebSearch: boolean;
  /** `null` = the feature takes no reasoning effort. */
  defaultReasoningEffort: TaskReasoningEffort | null;
  assignment: AiFeatureAssignment | null;
  eligibleModels: AiEligibleModel[];
  warning: AiAssignmentWarning | null;
}

export interface AiAssignments {
  default: AiModelRef | null;
  features: Partial<Record<AiFeatureId, AiFeatureAssignment | null>>;
}

export interface AiAssignmentsView {
  /** The stored value, exactly what `PUT` takes back. */
  assignments: AiAssignments;
  default: { eligibleModels: AiEligibleModel[]; warning: AiAssignmentWarning | null };
  features: AiAssignmentFeatureRow[];
  /** Send back as `If-Match`. */
  version: number;
  updatedAt: string | null;
  updatedBy: { id: string; email: string } | null;
}

/** One refused assignment in a PUT's 400 `details.errors`. */
export interface AiAssignmentFieldError {
  /** `'default'` or `'features.<featureId>'`. */
  field: string;
  provider: string;
  modelId: string;
  code: AiAssignmentIssueCode;
  message: string;
  missing?: string[];
}

export const AI_ASSIGNMENT_INVALID = 'AI_ASSIGNMENT_INVALID';

export function getAiAssignments(): Promise<AiAssignmentsView> {
  return api.get<AiAssignmentsView>('/admin/ai/assignments');
}

/** Full replace; `expectedVersion` travels as `If-Match` (a stale one answers 409). */
export function updateAiAssignments(input: AiAssignments, expectedVersion?: number): Promise<AiAssignmentsView> {
  return api.put<AiAssignmentsView>('/admin/ai/assignments', input, {
    headers: expectedVersion === undefined ? undefined : { 'If-Match': String(expectedVersion) },
  });
}

/** The per-field refusals of a PUT's 400 `AI_ASSIGNMENT_INVALID`, or `null` for any other error. */
export function assignmentFieldErrorsOf(error: unknown): AiAssignmentFieldError[] | null {
  if (!(error instanceof ApiError) || error.status !== 400) return null;
  const details = (error.details ?? {}) as { reason?: unknown; errors?: unknown };
  if (details.reason !== AI_ASSIGNMENT_INVALID || !Array.isArray(details.errors)) return null;
  return details.errors as AiAssignmentFieldError[];
}

// -----------------------------------------------------------------------------
// Consumer: /api/ai/features
// -----------------------------------------------------------------------------

/** Mirrors `FEATURE_RESOLUTION_STATES`. */
export type FeatureResolutionState =
  | 'ready'
  | 'auto'
  | 'no_key'
  | 'no_models'
  | 'missing_capability'
  | 'web_search_disabled'
  | 'ai_disabled';

/** States in which the feature has a model to run on. */
export const RUNNABLE_FEATURE_STATES: readonly FeatureResolutionState[] = ['ready', 'auto'];

export type FeatureModelSource = 'admin_feature' | 'admin_default' | 'auto';

export interface FeatureResolution {
  featureId: AiFeatureId;
  state: FeatureResolutionState;
  /** Absent in every blocking state. */
  model?: AiModelRef & { displayName: string; keySource: AiKeySource };
  source?: FeatureModelSource | null;
  needs: string[];
  inputModalities: string[];
  requestedEffort: TaskReasoningEffort | null;
  effectiveEffort: TaskReasoningEffort | null;
  effortNote?: 'clamped' | 'model_has_no_reasoning';
  /** An administrator's assignment the caller's key cannot use; resolution fell through. */
  assignmentUnavailable?: AiModelRef;
  /** For `missing_capability`: catalog models that would work. */
  candidates?: Array<AiModelRef & { displayName: string; enabled: boolean }>;
  /** Who can fix a blocking state. */
  fix: 'keys' | 'admin' | null;
}

export interface AiFeatureView extends FeatureResolution {
  label: string;
  group: AiFeatureGroup;
}

export interface AiFeaturesView {
  features: AiFeatureView[];
}

export function getAiFeatures(): Promise<AiFeaturesView> {
  return api.get<AiFeaturesView>('/ai/features');
}
