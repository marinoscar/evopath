import type { GraphNode } from '../graph/node-context';
import { applyNode } from './apply.node';
import { awaitApprovalNode } from './await-approval.node';
import { critiqueLightNode } from './critique-light.node';
import { critiqueNode } from './critique.node';
import { decideNode } from './decide.node';
import { envelopeNode } from './envelope.node';
import { evaluateNode } from './evaluate.node';
import { finalizeNode } from './finalize.node';
import { guardrailsNode } from './guardrails.node';
import { loadSignalsNode } from './load-signals.node';
import { notifyNode } from './notify.node';
import { planNode } from './plan.node';
import { prepareContextNode } from './prepare-context.node';
import { recordProposalNode } from './record-proposal.node';
import { recordReviewNode } from './record-review.node';
import { researchNode } from './research.node';
import { safetyGateNode } from './safety-gate.node';

// One file per node; this is the table the graphs wire. A story implementing
// a node replaces that node's file and leaves this table alone.

export const CREATE_GRAPH_NODE_NAMES = [
  'prepare_context',
  'research',
  'plan',
  'guardrails',
  'critique',
  'finalize',
] as const;

export type CreateGraphNodeName = (typeof CREATE_GRAPH_NODE_NAMES)[number];

export const EVALUATE_GRAPH_NODE_NAMES = [
  'load_signals',
  'safety_gate',
  'evaluate',
  'envelope',
  'critique_light',
  'decide',
  'record_review',
  'record_proposal',
  'await_approval',
  'apply',
  'notify',
] as const;

export type EvaluateGraphNodeName = (typeof EVALUATE_GRAPH_NODE_NAMES)[number];

export const CREATE_GRAPH_NODES: Readonly<Record<CreateGraphNodeName, GraphNode>> = {
  prepare_context: prepareContextNode,
  research: researchNode,
  plan: planNode,
  guardrails: guardrailsNode,
  critique: critiqueNode,
  finalize: finalizeNode,
};

export const EVALUATE_GRAPH_NODES: Readonly<Record<EvaluateGraphNodeName, GraphNode>> = {
  load_signals: loadSignalsNode,
  safety_gate: safetyGateNode,
  evaluate: evaluateNode,
  envelope: envelopeNode,
  critique_light: critiqueLightNode,
  decide: decideNode,
  record_review: recordReviewNode,
  record_proposal: recordProposalNode,
  await_approval: awaitApprovalNode,
  apply: applyNode,
  notify: notifyNode,
};
