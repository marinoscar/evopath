import '../agents/planner/plan.events';

import { GUARDRAIL_EVENT_MAX_REPAIRS, GUARDRAIL_EVENT_SUMMARY_CHARS } from '../agents/planner/plan.events';
import { compileDraft, type PlanHeader } from '../compile/compile-plan';
import type { GraphNode, NodeFn } from '../graph/node-context';
import { applyGuardrails, summarizeReport } from '../guardrails';
import { type GuardrailReport, guardrailContextOf } from '../guardrails/types';
import type { PlanTree } from '../../programs/contracts/plan-tree.contract';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { draftStateOf } from './plan.node';
import { runContextOf } from './prepare-context.node';

// =============================================================================
// Node `guardrails`: compile the draft, then check and repair it server-side
// =============================================================================
//
// `compileDraft` expands the latest `PlanDraft` into a PlanTree (derived ids
// seeded by the run id and round); `applyGuardrails` validates and repairs
// it against the run context (library, gym, history, conservative mode) and
// the verified brief. The compiler's own findings (layout normalised, text
// sanitised) join the report.
//
// Returns `{ guardrailReport: GuardrailNodeOutput }`: the REPAIRED tree (what
// the critic reviews and `finalize` writes), the sanitised plan header and
// the report. `report.status === 'blocked'` means the tree may not ship;
// the server, not the critic, decides that. Emits `guardrail.report` with
// counts and server-authored repair summaries (never model text).
// =============================================================================

export interface GuardrailNodeOutput {
  /** The draft round this report is about. */
  round: number;
  /** The repaired plan. */
  tree: PlanTree;
  /** Title, summary, rationale, assumptions and safety notes, sanitised. */
  header: PlanHeader;
  report: GuardrailReport;
}

export const DRAFT_MISSING = 'TRAINING_DRAFT_MISSING';

/** Unique `{ rule, summary }` of the repairs and blocks, for the event (at most 50). */
export function eventRepairs(report: GuardrailReport): Array<{ rule: GuardrailReport['violations'][number]['rule']; summary: string }> {
  const seen = new Set<string>();
  const out: Array<{ rule: GuardrailReport['violations'][number]['rule']; summary: string }> = [];
  for (const violation of report.violations) {
    if (violation.severity === 'warn') continue;
    const summary = violation.message.slice(0, GUARDRAIL_EVENT_SUMMARY_CHARS);
    const key = `${violation.rule}|${summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rule: violation.rule, summary });
    if (out.length >= GUARDRAIL_EVENT_MAX_REPAIRS) break;
  }
  return out;
}

export const runGuardrails: NodeFn = async (state, ctx) => {
  const context = runContextOf(state);
  const drafted = draftStateOf(state);
  if (!drafted) {
    throw new TrainingRunFailedError(DRAFT_MISSING, 'There is no plan draft to check.');
  }

  const compiled = compileDraft(drafted.draft, { library: context.library, brief: state.brief, seed: `${ctx.runId}:${drafted.round}` });
  const { tree, report } = applyGuardrails(compiled.tree, guardrailContextOf(context, state.brief));
  const merged = summarizeReport([...compiled.issues, ...report.violations]);

  await ctx.emit('guardrail.report', {
    round: drafted.round,
    status: merged.status,
    counts: merged.counts,
    repairs: eventRepairs(merged),
  });

  const guardrailReport: GuardrailNodeOutput = { round: drafted.round, tree, header: compiled.header, report: merged };
  return { guardrailReport };
};

/** Checks and repairs the draft server-side (the guardrails). */
export const guardrailsNode: GraphNode = { name: 'guardrails', run: runGuardrails, implemented: true };
