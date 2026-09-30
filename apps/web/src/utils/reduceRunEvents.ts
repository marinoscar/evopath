/**
 * The live run view model, built from a training run's event stream.
 *
 * PURE and IDEMPOTENT BY `seq`. The API numbers a run's events 1, 2, 3 ...
 * without gaps, and the stream replays everything after a cursor, so the same
 * event can arrive twice (a reconnect, a reload) and a later one can arrive
 * before an earlier one (a reconnect racing a slow read). The reducer:
 *
 * - ignores an event whose `seq` it has already applied or buffered;
 * - applies the next `seq` and then drains any buffered successors;
 * - buffers an event past a gap (`hasGap` tells the caller to reconnect from
 *   `lastSeq`, the last contiguous cursor, so the server replays the hole).
 *
 * The state is AGGREGATED, never an unbounded list of events: a run that
 * emits hundreds of events keeps one entry per stage, round, source and role.
 * Nothing here carries prompt text: the API's events hold identifiers,
 * counts, codes and server-authored summaries only.
 */
import type { TrainingAgentRole } from '../types';
import type { TrainingRunEvent, TrainingRunStatus } from '../services/trainingAgents';

/** The stages the stepper shows, in order. */
export const RUN_STAGES = ['context', 'research', 'plan', 'guardrails', 'critique', 'ready'] as const;
export type RunStage = (typeof RUN_STAGES)[number];

/** Graph node name (`stage.*` events) to the stepper stage. */
export const NODE_STAGE: Record<string, RunStage> = {
  prepare_context: 'context',
  research: 'research',
  plan: 'plan',
  guardrails: 'guardrails',
  critique: 'critique',
  finalize: 'ready',
};

/** The agent that works in a stage, for "Researcher (model) is searching the web". */
export const STAGE_ROLE: Partial<Record<RunStage, TrainingAgentRole>> = {
  research: 'researcher',
  plan: 'planner',
  critique: 'critic',
};

export const CRITIC_DIMENSIONS = [
  'goal_fit',
  'equipment_feasibility',
  'volume_intensity',
  'recovery',
  'injury_handling',
  'progression',
  'adherence_realism',
  'evidence_alignment',
] as const;
export type CriticDimension = (typeof CRITIC_DIMENSIONS)[number];

/** At most this many sources are kept (the API caps a brief at 20). */
export const MAX_SOURCES = 50;
/** At most this many out-of-order events are buffered before the caller must resync. */
export const MAX_PENDING = 200;

export type StageState = 'pending' | 'active' | 'done';

export interface RunSource {
  id: string;
  url: string;
  title: string;
  domain: string;
  kind: string;
}

export interface RunDraft {
  round: number;
  weeks: number;
  workouts: number;
  exercises: number;
}

export interface RunGuardrailReport {
  round: number;
  status: 'clean' | 'repaired' | 'blocked';
  counts: { block: number; repair: number; warn: number };
  repairs: Array<{ rule: string; summary: string }>;
}

export interface RunCriticRound {
  round: number;
  verdict: 'approve' | 'revise' | 'skipped';
  scores: Partial<Record<CriticDimension, number>> | null;
  blockers: Array<{ dimension: string; issue: string }>;
  summary: string;
}

export interface RunRoleUsage {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface RunViewState {
  /** The last contiguous `seq` applied: the cursor to resume the stream from. */
  lastSeq: number;
  /** Events past a gap, by `seq`. */
  pending: Record<number, TrainingRunEvent>;
  /** Status as the events tell it; null until an event says. */
  status: TrainingRunStatus | null;
  stages: Record<RunStage, StageState>;
  current: RunStage | null;
  /** The critique round in progress or last run. */
  criticRound: number;
  queries: string[];
  sources: RunSource[];
  brief: { claimCount: number; sourceCount: number; droppedClaims: number; droppedSources: number } | null;
  drafts: RunDraft[];
  guardrails: RunGuardrailReport[];
  critic: RunCriticRound[];
  usage: Partial<Record<TrainingAgentRole, RunRoleUsage>>;
  finalized: { programId: string; versionNumber: number; warnings: string[] } | null;
  failedCode: string | null;
  interruptedReason: string | null;
  awaitingApproval: { kind: string; expiresAt: string } | null;
}

export function initialRunViewState(): RunViewState {
  return {
    lastSeq: 0,
    pending: {},
    status: null,
    stages: { context: 'pending', research: 'pending', plan: 'pending', guardrails: 'pending', critique: 'pending', ready: 'pending' },
    current: null,
    criticRound: 0,
    queries: [],
    sources: [],
    brief: null,
    drafts: [],
    guardrails: [],
    critic: [],
    usage: {},
    finalized: null,
    failedCode: null,
    interruptedReason: null,
    awaitingApproval: null,
  };
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Replace (or add) the entry for `round`, keeping the list ordered by round. */
function upsertRound<T extends { round: number }>(list: T[], entry: T): T[] {
  return [...list.filter((item) => item.round !== entry.round), entry].sort((a, b) => a.round - b.round);
}

function startStage(state: RunViewState, stage: RunStage): RunViewState {
  const stages = { ...state.stages };
  // Every earlier stage is behind us once a later one starts (a skipped
  // research stage, a loop back to Plan leaves Critique "done" for its round).
  for (const key of RUN_STAGES) {
    if (key === stage) break;
    if (stages[key] === 'active') stages[key] = 'done';
  }
  stages[stage] = 'active';
  return { ...state, stages, current: stage };
}

function completeStage(state: RunViewState, stage: RunStage): RunViewState {
  return { ...state, stages: { ...state.stages, [stage]: 'done' }, current: state.current === stage ? null : state.current };
}

/** Apply one event's meaning, ignoring the cursor. Unknown types change nothing. */
function applyEvent(state: RunViewState, event: TrainingRunEvent): RunViewState {
  const d = event.data;
  switch (event.type) {
    case 'run.queued':
      return { ...state, status: 'queued' };
    case 'run.started':
    case 'run.resumed':
      return { ...state, status: 'running', interruptedReason: null, awaitingApproval: null };
    case 'stage.started': {
      const stage = NODE_STAGE[str(d.node)];
      if (!stage) return state;
      const next = startStage(state, stage);
      return stage === 'critique' && num(d.round) > 0 ? { ...next, criticRound: num(d.round) } : next;
    }
    case 'stage.completed': {
      const stage = NODE_STAGE[str(d.node)];
      return stage ? completeStage(state, stage) : state;
    }
    case 'agent.usage': {
      const role = str(d.role) as TrainingAgentRole;
      if (!role) return state;
      const prev = state.usage[role];
      return {
        ...state,
        usage: {
          ...state.usage,
          [role]: {
            provider: str(d.provider) || prev?.provider || '',
            model: str(d.model) || prev?.model || '',
            calls: (prev?.calls ?? 0) + 1,
            inputTokens: (prev?.inputTokens ?? 0) + num(d.inputTokens),
            outputTokens: (prev?.outputTokens ?? 0) + num(d.outputTokens),
            reasoningTokens: (prev?.reasoningTokens ?? 0) + num(d.reasoningTokens),
          },
        },
      };
    }
    case 'research.query': {
      const queries = Array.isArray(d.queries) ? d.queries.filter((q): q is string => typeof q === 'string') : [];
      return { ...state, queries: [...new Set([...state.queries, ...queries])].slice(0, 50) };
    }
    case 'research.source': {
      const id = str(d.id);
      const url = str(d.url);
      if (!id || !url || d.verified !== true) return state;
      if (state.sources.some((source) => source.id === id)) return state;
      if (state.sources.length >= MAX_SOURCES) return state;
      return {
        ...state,
        sources: [...state.sources, { id, url, title: str(d.title), domain: str(d.domain), kind: str(d.kind) || 'other' }],
      };
    }
    case 'research.brief':
      return {
        ...state,
        brief: {
          claimCount: num(d.claimCount),
          sourceCount: num(d.sourceCount),
          droppedClaims: num(d.droppedClaims),
          droppedSources: num(d.droppedSources),
        },
      };
    case 'plan.draft':
      return {
        ...state,
        drafts: upsertRound(state.drafts, {
          round: num(d.round),
          weeks: num(d.weeks),
          workouts: num(d.workouts),
          exercises: num(d.exercises),
        }),
      };
    case 'guardrail.report': {
      const counts = (d.counts ?? {}) as Record<string, unknown>;
      const repairs = Array.isArray(d.repairs)
        ? d.repairs
            .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
            .map((r) => ({ rule: str(r.rule), summary: str(r.summary) }))
        : [];
      const status = d.status === 'repaired' || d.status === 'blocked' ? d.status : 'clean';
      return {
        ...state,
        guardrails: upsertRound(state.guardrails, {
          round: num(d.round),
          status,
          counts: { block: num(counts.block), repair: num(counts.repair), warn: num(counts.warn) },
          repairs,
        }),
      };
    }
    case 'critic.round': {
      const verdict = d.verdict === 'approve' || d.verdict === 'revise' ? d.verdict : 'skipped';
      const scores =
        d.scores && typeof d.scores === 'object'
          ? (Object.fromEntries(
              CRITIC_DIMENSIONS.filter((key) => typeof (d.scores as Record<string, unknown>)[key] === 'number').map((key) => [
                key,
                (d.scores as Record<string, number>)[key],
              ]),
            ) as Partial<Record<CriticDimension, number>>)
          : null;
      const blockers = Array.isArray(d.blockers)
        ? d.blockers
            .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
            .map((b) => ({ dimension: str(b.dimension), issue: str(b.issue) }))
        : [];
      const round = num(d.round);
      return {
        ...state,
        criticRound: Math.max(state.criticRound, round),
        critic: upsertRound(state.critic, { round, verdict, scores, blockers, summary: str(d.summary) }),
      };
    }
    case 'plan.finalized': {
      const warnings = Array.isArray(d.warnings) ? d.warnings.filter((w): w is string => typeof w === 'string') : [];
      const next = completeStage(startStage(state, 'ready'), 'ready');
      return { ...next, finalized: { programId: str(d.programId), versionNumber: num(d.versionNumber), warnings } };
    }
    case 'run.completed': {
      const status = str(d.status) as TrainingRunStatus;
      return { ...state, status: status || 'succeeded', current: status === 'succeeded' ? null : state.current };
    }
    case 'run.failed':
      return { ...state, status: 'failed', failedCode: str(d.code) || null, current: null };
    case 'run.cancelled':
      return { ...state, status: 'cancelled', current: null };
    case 'run.interrupted':
      return { ...state, status: 'interrupted', interruptedReason: str(d.reason) || null };
    case 'run.deferred':
      return { ...state, status: 'queued' };
    case 'run.awaiting_approval':
      return { ...state, status: 'awaiting_approval', awaitingApproval: { kind: str(d.kind), expiresAt: str(d.expiresAt) } };
    default:
      return state;
  }
}

/** Fold one event in, idempotently by `seq`. */
export function reduceRunEvents(state: RunViewState, event: TrainingRunEvent): RunViewState {
  if (!Number.isInteger(event.seq) || event.seq <= state.lastSeq || state.pending[event.seq]) return state;

  if (event.seq > state.lastSeq + 1) {
    if (Object.keys(state.pending).length >= MAX_PENDING) return state;
    return { ...state, pending: { ...state.pending, [event.seq]: event } };
  }

  let next = { ...applyEvent(state, event), lastSeq: event.seq };
  // Drain successors that were waiting for this one.
  while (next.pending[next.lastSeq + 1]) {
    const successor = next.pending[next.lastSeq + 1];
    const { [successor.seq]: _drained, ...rest } = next.pending;
    next = { ...applyEvent({ ...next, pending: rest }, successor), lastSeq: successor.seq };
  }
  return next;
}

/** Fold a batch (a replay) in. */
export function reduceRunEventList(state: RunViewState, events: TrainingRunEvent[]): RunViewState {
  return events.reduce(reduceRunEvents, state);
}

/** Events are waiting past a hole: resume the stream from `lastSeq` to fill it. */
export function hasGap(state: RunViewState): boolean {
  return Object.keys(state.pending).length > 0;
}

/**
 * Give up on a hole the server could not fill (an event it no longer has):
 * apply the buffered events in order, as if the hole were empty.
 */
export function skipGap(state: RunViewState): RunViewState {
  const seqs = Object.keys(state.pending).map(Number).sort((a, b) => a - b);
  if (seqs.length === 0) return state;
  let next: RunViewState = { ...state, pending: {} };
  for (const seq of seqs) next = { ...applyEvent(next, state.pending[seq]), lastSeq: seq };
  return next;
}
