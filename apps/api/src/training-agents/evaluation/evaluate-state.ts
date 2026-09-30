import { CHANGE_RATIONALE_MAX, CHANGE_SUMMARY_MAX } from '../../programs/programs.constants';
import type { EvaluationResult } from '../agents/evaluator/evaluation-result.contract';
import type { RunState } from '../graph/run-state';
import type { EvaluationDecision } from '../graph/routes';
import type { EnvelopeFinding } from '../guardrails/envelope';
import type { AcceptedOperation } from './apply-operations';

// =============================================================================
// The evaluate run's agent state (`RunState.evaluation` and `.changeSet`)
// =============================================================================
//
// Checkpointed with the run, so: node outputs only, sanitised model text,
// row ids the server resolved, no provider message, no key, no note.
//
// - `evaluation` (node `evaluate`): the sanitised `EvaluationResult`, or why
//   there is none (`thin_data`: no completed session, no model call;
//   `budget`: the token budget ran out, so nothing changes).
// - `changeSet` (nodes `envelope` .. `notify`): the accepted operations
//   (forced safety removals first) with their row targets, what was clamped
//   and dropped and why, the server-composed summary and rationale, the
//   citations, the decision, and what was written (`proposal`, `applied`,
//   `result`).
// =============================================================================

export const EVALUATION_STATE_VERSION = 1;

export type EvaluationSkip = 'thin_data' | 'budget';

export interface EvaluationState {
  version: typeof EVALUATION_STATE_VERSION;
  result: EvaluationResult | null;
  skipped: EvaluationSkip | null;
  /** Exercise keys the gym supports that the evaluator could swap in or add. */
  alternatives: string[];
  attempts: number;
  /** Claim ids the model cited that the run never sent (dropped). */
  inventedClaimIds: string[];
}

export interface ChangeSetCritique {
  verdict: 'approve' | 'revise' | 'skipped';
  skipped: 'budget' | 'unavailable' | 'no_model' | null;
  blockers: number;
}

/** How the change set ended (`notify` reads it). */
export type ChangeSetResult = 'reviewed' | 'applied' | 'proposed' | 'rejected' | 'superseded';

export interface ChangeSet {
  version: typeof EVALUATION_STATE_VERSION;
  accepted: AcceptedOperation[];
  clamped: EnvelopeFinding[];
  dropped: EnvelopeFinding[];
  critique: ChangeSetCritique | null;
  /** Set by `decide`. */
  decision: EvaluationDecision | null;
  /** The change log summary (the sanitised message plus server notes), at most 300 characters. */
  summary: string;
  /** The change log rationale (assessment, follow-up, server findings), at most 2000 characters. */
  rationale: string;
  citations: Array<Record<string, unknown>>;
  /** The plan version the operations are based on (after any forced pre-apply in ask-first mode). */
  basedOnVersion: number;
  /** Set by `record_proposal`. */
  proposal: { changeLogId: string; fromVersion: number; expiresAt: string } | null;
  /** The version this run wrote (forced safety changes first in ask-first mode, then the change set). */
  applied: { versionNumber: number; changeLogId: string } | null;
  result: ChangeSetResult | null;
}

export function evaluationStateOf(state: Pick<RunState, 'evaluation'>): EvaluationState | null {
  const value = state.evaluation as Partial<EvaluationState> | null;
  return value && value.version === EVALUATION_STATE_VERSION ? (value as EvaluationState) : null;
}

export function changeSetOf(state: Pick<RunState, 'changeSet'>): ChangeSet | null {
  const value = state.changeSet as Partial<ChangeSet> | null;
  return value && value.version === EVALUATION_STATE_VERSION && Array.isArray(value.accepted) ? (value as ChangeSet) : null;
}

/** The ordinary review summary when the model said nothing usable. */
export const DEFAULT_REVIEW_SUMMARY = 'Reviewed your recent training: no change to your plan.';
export const DEFAULT_ADAPTED_SUMMARY = 'Your coach adjusted your plan.';
export const THIN_DATA_SUMMARY = 'Not enough completed sessions yet to judge progress; your plan stays as it is.';
export const BUDGET_NOTE = 'The review ran out of its token budget, so nothing was changed.';
export const SERVER_CHECKS_HEADING = 'Checked by the server:';

/** The change log summary: the message (or a fallback) plus server notes, capped. */
export function composeSummary(message: string, notes: readonly string[], fallback: string): string {
  const text = [message.trim() || fallback, ...notes].join(' ').replace(/\s+/g, ' ').trim();
  return text.length > CHANGE_SUMMARY_MAX ? `${text.slice(0, CHANGE_SUMMARY_MAX - 1)}…` : text;
}

/** The change log rationale: the assessment, a follow-up note, and every clamp and drop (unique), capped. */
export function composeRationale(args: {
  assessment: string;
  followUp: string | null;
  findings: ReadonlyArray<Pick<EnvelopeFinding, 'message'>>;
}): string {
  const parts = [args.assessment.trim()];
  if (args.followUp) parts.push(args.followUp.trim());
  const messages = [...new Set(args.findings.map((f) => f.message))];
  if (messages.length) parts.push(`${SERVER_CHECKS_HEADING} ${messages.map((m) => `- ${m}`).join(' ')}`);
  const text = parts.filter(Boolean).join('\n\n');
  return text.length > CHANGE_RATIONALE_MAX ? `${text.slice(0, CHANGE_RATIONALE_MAX - 1)}…` : text;
}
