import type { GraphNode } from '../graph/node-context';
import { applyNode } from './apply.node';
import { awaitApprovalNode } from './await-approval.node';
import { critiqueNode } from './critique.node';
import { envelopeNode } from './envelope.node';
import { evaluateNode } from './evaluate.node';
import { finalizeNode } from './finalize.node';
import { guardrailsNode } from './guardrails.node';
import { loadSignalsNode } from './load-signals.node';
import { planNode } from './plan.node';
import { prepareContextNode } from './prepare-context.node';
import { researchNode } from './research.node';

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

export const EVALUATE_GRAPH_NODE_NAMES = ['load_signals', 'evaluate', 'envelope', 'await_approval', 'apply'] as const;

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
  evaluate: evaluateNode,
  envelope: envelopeNode,
  await_approval: awaitApprovalNode,
  apply: applyNode,
};
