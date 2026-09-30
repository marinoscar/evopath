/**
 * The training agents' models, read side (`/api/ai/training/*`), as the web
 * app sees it.
 *
 * Shaped after `services/ai.ts`: `services/api.ts` stays the transport and this
 * module holds the two calls next to the types they produce. Both routes sit
 * behind `ai:use` and the AI kill switch (`403 AI_DISABLED` while AI is off).
 *
 * The role resolution is GUIDANCE computed by the API from the
 * administrator's model assignments (#173: every model and effort is an
 * administrator's choice at `/admin/settings/ai/assignments`), the caller's
 * usable models and the administrator's switches; the browser only renders
 * it. The caller's own run limits are written through the user settings
 * document (`ai.training`), not through these routes.
 *
 * No response here carries key material: `keySource` says whose key pays,
 * never the key.
 */
import { API_BASE_URL, api, ApiError } from './api';
import type { AiKeySource } from './ai';
import type { FeatureModelSource } from './aiAssignments';
import { connectSse, type SseConnection, type SseState } from './sse';
import type { TaskReasoningEffort, TrainingAgentRole } from '../types';

/** The roles in the order the page shows them; mirrors `TRAINING_AGENT_ROLES`. */
export const TRAINING_AGENT_ROLES: readonly TrainingAgentRole[] = [
  'researcher',
  'planner',
  'critic',
  'evaluator',
];

/** Mirrors `ROLE_RESOLUTION_STATES` in the API's `role-resolution.dto.ts`. */
export type RoleResolutionState =
  | 'ready'
  | 'auto'
  | 'no_key'
  | 'no_models'
  | 'missing_capability'
  | 'web_search_disabled'
  | 'ai_disabled';

export interface TrainingModelRef {
  provider: string;
  modelId: string;
}

/** One role, resolved: the model it will use, or why it cannot run and where to fix it. */
export interface RoleResolution {
  role: TrainingAgentRole;
  state: RoleResolutionState;
  /** Absent in every blocking state. */
  model?: TrainingModelRef & { displayName: string; keySource: AiKeySource };
  /** Where the model came from: an administrator's assignment or default, or the automatic pick. */
  source?: FeatureModelSource | null;
  /** Capabilities this role requires of its model. */
  needs: string[];
  /** What the administrator assigned, or the role default. */
  requestedEffort: TaskReasoningEffort | null;
  /** What will actually be sent: always an effort the model offers, or null. */
  effectiveEffort: TaskReasoningEffort | null;
  effortNote?: 'clamped' | 'model_has_no_reasoning';
  /** An administrator's assignment the caller's key cannot use; resolution fell through. */
  assignmentUnavailable?: TrainingModelRef;
  /** For `missing_capability`: up to five catalog models that would work. */
  candidates?: Array<TrainingModelRef & { displayName: string; enabled: boolean }>;
  /** Who can fix a blocking state: the caller (add a key) or an administrator. */
  fix: 'keys' | 'admin' | null;
}

/**
 * A training run's kind as the run view reports it. `adapt` (E6.1) is a quick
 * workout adaptation (`/api/ai/training/adaptations`); it has no entry in the
 * models view's limits or `canRun`, which cover the plan kinds only.
 */
export type TrainingRunKind = 'create' | 'revise' | 'evaluate' | 'adapt';

/** The plan-making kinds `GET /api/ai/training/models` and the estimate know about. */
export type TrainingPlanRunKind = Exclude<TrainingRunKind, 'adapt'>;

/** `GET /api/ai/training/models`. */
export interface TrainingModelsView {
  roles: Record<TrainingAgentRole, RoleResolution>;
  webSearch: { adminEnabled: boolean };
  limits: {
    defaultRunTokens: Record<TrainingPlanRunKind, number>;
    minRunTokens: number;
    hardMaxRunTokens: number;
  };
  canRun: {
    create: boolean;
    revise: boolean;
    evaluate: boolean;
    blockers: Array<{ role: TrainingAgentRole; state: RoleResolutionState }>;
  };
}

export interface TokenRange {
  low: number;
  high: number;
}

/** `POST /api/ai/training/estimate` body. */
export interface EstimateTrainingRunInput {
  kind: TrainingPlanRunKind;
  criticRounds?: 1 | 2 | 3;
  contextChars?: number;
  /** `create`: with it the answer carries `sentData`. */
  intake?: TrainingIntake;
  /** `revise`: the three together make the answer carry `sentData`. */
  programId?: string;
  basedOnVersion?: number;
  instruction?: string;
}

/** One section of what an agent is sent (`goal`, `history`, ...), rendered by the API's context builder. */
export interface SentDataSection {
  key: string;
  title: string;
  items: string[];
  count?: number;
}

/** What one agent that will run is sent. Identifiers only: never a key. */
export interface SentDataEntry {
  role: TrainingAgentRole;
  provider: string | null;
  model: string | null;
  keySource: AiKeySource | null;
  sections: SentDataSection[];
  /** Titles of sections the context budget leaves out for this model. */
  dropped: string[];
  /** What is never sent. */
  excluded: string[];
}

/** `POST /api/ai/training/estimate` (answers 200). An estimate, not a quote: tokens only. */
export interface TrainingRunEstimate {
  tokens: TokenRange & { byRole: Partial<Record<TrainingAgentRole, TokenRange>> };
  /** The per-run cap that applies: the user's `maxRunTokens`, else the default for this kind. */
  cap: number;
  /** `tokens.high` exceeds `cap`: a run may stop at the cap. */
  capBinding: boolean;
  /** What each agent is sent; empty unless the request carried an intake (or the revise fields). */
  sentData: SentDataEntry[];
}

export async function getTrainingModels(): Promise<TrainingModelsView> {
  return api.get<TrainingModelsView>('/ai/training/models');
}

export async function estimateTrainingRun(input: EstimateTrainingRunInput): Promise<TrainingRunEstimate> {
  return api.post<TrainingRunEstimate>('/ai/training/estimate', input);
}

// -----------------------------------------------------------------------------
// The intake (mirrors `training-agents/contracts/training-intake.contract.ts`)
// -----------------------------------------------------------------------------
//
// Duplicated so the wizard can explain a problem before the round trip; the
// API decides. `__tests__/services/trainingIntake.contract.test.ts` reads the
// API contract source and fails when these drift.

export const TRAINING_GOAL_TYPES = ['strength', 'hypertrophy', 'fat_loss', 'general', 'endurance', 'custom'] as const;
export type TrainingGoalType = (typeof TRAINING_GOAL_TYPES)[number];

export const TRAINING_EXPERIENCE_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export type TrainingExperience = (typeof TRAINING_EXPERIENCE_LEVELS)[number];

export const TRAINING_LIMITATION_AREAS = [
  'shoulder',
  'elbow',
  'wrist',
  'back',
  'hip',
  'knee',
  'ankle',
  'neck',
  'other',
] as const;
export type TrainingLimitationArea = (typeof TRAINING_LIMITATION_AREAS)[number];

export const TRAINING_AUTONOMY = ['autonomous', 'ask_first'] as const;
export type TrainingAutonomy = (typeof TRAINING_AUTONOMY)[number];

export const TRAINING_INTAKE_LIMITS = {
  goalChars: 300,
  limitationChars: 200,
  maxLimitations: 6,
  maxAvoidKeys: 20,
  avoidKeyChars: 80,
  preferencesChars: 300,
  daysPerWeek: { min: 1, max: 7 },
  minutesPerSession: { min: 20, max: 180 },
  durationWeeks: { min: 4, max: 24, default: 8 },
  instructionChars: 500,
} as const;

export interface TrainingIntake {
  goal: { type: TrainingGoalType; description: string };
  experience: TrainingExperience;
  daysPerWeek: number;
  /** ISO weekdays (1 Monday .. 7 Sunday); when set, at least `daysPerWeek` of them. */
  preferredWeekdays: number[] | null;
  minutesPerSession: number;
  durationWeeks: number;
  /** Null plans for no equipment. */
  gymId: string | null;
  limitations: Array<{ area: TrainingLimitationArea; description: string }>;
  /** Exercise slugs. */
  avoidExerciseKeys: string[];
  preferences: string;
  includeBio: boolean;
  tailorResearch: boolean;
  autonomy: TrainingAutonomy;
}

// -----------------------------------------------------------------------------
// Runs (`/api/ai/training/runs`, `/api/ai/training/stream/:runId`)
// -----------------------------------------------------------------------------

export const TRAINING_RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'interrupted',
  'succeeded',
  'failed',
  'cancelled',
  'blocked_safety',
] as const;
export type TrainingRunStatus = (typeof TRAINING_RUN_STATUSES)[number];

/** A run in one of these is finished for good. */
export const TERMINAL_RUN_STATUSES: readonly TrainingRunStatus[] = ['succeeded', 'failed', 'cancelled', 'blocked_safety'];
/** At most one run per user in these. */
export const ACTIVE_RUN_STATUSES: readonly TrainingRunStatus[] = ['queued', 'running', 'awaiting_approval'];

/** `details.reason` values the run routes answer with. */
export const TRAINING_REFUSALS = {
  RUN_ACTIVE: 'TRAINING_RUN_ACTIVE',
  ROLE_UNAVAILABLE: 'TRAINING_ROLE_UNAVAILABLE',
  NOT_IMPLEMENTED: 'TRAINING_NOT_IMPLEMENTED',
  NOT_RESUMABLE: 'TRAINING_RUN_NOT_RESUMABLE',
  NOT_AWAITING_DECISION: 'TRAINING_RUN_NOT_AWAITING_DECISION',
  STALE_PLAN: 'TRAINING_STALE_PLAN',
  /** "Re-evaluate now" within 30 minutes of the last one (409, `details.retryAfterSeconds`). */
  EVALUATION_COOLDOWN: 'TRAINING_EVALUATION_COOLDOWN',
} as const;

export type StartTrainingRunInput =
  | { kind: 'create'; intake: TrainingIntake }
  | { kind: 'revise'; programId: string; basedOnVersion: number; instruction: string }
  /** "Re-evaluate now": `programId` defaults to the active plan on the server. */
  | { kind: 'evaluate'; programId?: string; trigger: 'manual' };

/** `POST /api/ai/training/runs`: 202 `queued`, or 200 `blocked_safety` with `guidance`. */
export interface TrainingRunStarted {
  runId: string;
  jobId: string | null;
  status: 'queued' | 'blocked_safety';
  guidance?: string;
}

export interface TrainingUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface TrainingRunView {
  id: string;
  kind: TrainingRunKind;
  trigger: string;
  status: TrainingRunStatus;
  stage: string | null;
  programId: string | null;
  roleModels: Partial<
    Record<
      TrainingAgentRole,
      { provider: string; modelId: string; effort: TaskReasoningEffort | null; keySource: AiKeySource }
    >
  >;
  tokenCap: number;
  /**
   * The cap as a meter (E6.3): `usedTokens` counts what the budget enforces
   * (input, output and reasoning); `reached` when the count is at or over the
   * limit or the run failed `TRAINING_RUN_BUDGET_EXCEEDED`.
   */
  cap: { limitTokens: number; usedTokens: number; reached: boolean; reason?: 'token_cap' };
  usage: {
    byRole: Record<string, TrainingUsageTotals>;
    byNode: Record<string, TrainingUsageTotals>;
    total: TrainingUsageTotals;
  };
  /** Once succeeded: `{ programId, versionNumber, changeLogId, verdict, warnings }`. */
  result: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  pendingDecision: 'approve' | 'reject' | null;
  cancelRequested: boolean;
  resumeCount: number;
  lastEventSeq: number;
  heartbeatAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface TrainingRunList {
  items: TrainingRunView[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const runPath = (id: string) => `/ai/training/runs/${encodeURIComponent(id)}`;

export function startTrainingRun(input: StartTrainingRunInput): Promise<TrainingRunStarted> {
  return api.post<TrainingRunStarted>('/ai/training/runs', input);
}

export function listTrainingRuns(
  params: { programId?: string; status?: TrainingRunStatus; page?: number; pageSize?: number } = {},
): Promise<TrainingRunList> {
  const search = new URLSearchParams();
  if (params.programId) search.set('programId', params.programId);
  if (params.status) search.set('status', params.status);
  if (params.page) search.set('page', String(params.page));
  if (params.pageSize) search.set('pageSize', String(params.pageSize));
  const query = search.toString();
  return api.get<TrainingRunList>(`/ai/training/runs${query ? `?${query}` : ''}`);
}

export function getTrainingRun(id: string): Promise<TrainingRunView> {
  return api.get<TrainingRunView>(runPath(id));
}

export function cancelTrainingRun(id: string): Promise<TrainingRunView> {
  return api.post<TrainingRunView>(`${runPath(id)}/cancel`);
}

export function resumeTrainingRun(id: string): Promise<TrainingRunView> {
  return api.post<TrainingRunView>(`${runPath(id)}/resume`);
}

export function decideTrainingRun(id: string, input: { decision: 'approve' | 'reject'; note?: string }) {
  return api.post<TrainingRunView>(`${runPath(id)}/decision`, input);
}

/** The refusal reason of a run route error (`details.reason`), with its details. */
export function trainingRefusalOf(error: unknown): { reason: string; details: Record<string, unknown> } | null {
  if (!(error instanceof ApiError)) return null;
  const details = (error.details ?? {}) as Record<string, unknown>;
  return typeof details.reason === 'string' ? { reason: details.reason, details } : null;
}

// -----------------------------------------------------------------------------
// The run's event stream
// -----------------------------------------------------------------------------

/** One persisted run event, as a stream frame carries it (`id: seq`, `event: type`, `data`). */
export interface TrainingRunEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

export interface TrainingRunStreamHandlers {
  onEvent: (event: TrainingRunEvent) => void;
  /** `event: end` with the run's status: the run is terminal (or paused) and every event was sent. */
  onEnd: (status: string) => void;
  onOpen?: () => void;
  onStateChange?: (state: SseState) => void;
}

export function trainingRunStreamUrl(runId: string, after: number): string {
  return `${API_BASE_URL}/ai/training/stream/${encodeURIComponent(runId)}?after=${Math.max(0, Math.floor(after))}`;
}

function parseData(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Follow a run's events after `after` over the fetch-based SSE client (a
 * bearer header, never a token in the URL). `connectSse` reuses one URL on
 * its own reconnects, so a caller that wants to continue from a newer cursor
 * closes this connection and opens another (`useTrainingRun` does).
 */
export function connectTrainingRunStream(
  runId: string,
  after: number,
  handlers: TrainingRunStreamHandlers,
): SseConnection {
  return connectSse({
    url: trainingRunStreamUrl(runId, after),
    authorization: () => {
      const token = api.getAccessToken();
      return token ? `Bearer ${token}` : null;
    },
    reauthenticate: () => api.refreshToken(),
    onOpen: () => handlers.onOpen?.(),
    onStateChange: handlers.onStateChange,
    onFrame: (frame) => {
      const data = parseData(frame.data);
      if (frame.event === 'end') {
        handlers.onEnd(typeof data?.status === 'string' ? data.status : 'unknown');
        return;
      }
      const seq = frame.id === null ? NaN : Number(frame.id);
      if (!Number.isInteger(seq) || seq < 1 || !data) return;
      handlers.onEvent({ seq, type: frame.event, data });
    },
  });
}

export type TrainingRunConnect = typeof connectTrainingRunStream;
export type { SseConnection, SseState };
