/**
 * Words for agent usage (E6.3), shared by the per-run panel and the monthly
 * section. Pure, so the tests read the same strings the UI shows.
 */
import { ROLE_LABEL } from '../../../hooks/useTrainingAvailability';
import type { TrainingAgentRole } from '../../../types';
import { UNATTRIBUTED_ROLE } from '../../../services/trainingUsage';

/** Whose key paid. A keyless server is never "your key". */
export const KEY_SOURCE_USAGE_LABEL: Record<string, string> = {
  user: 'your key',
  org: "the organisation's key",
  none: 'keyless server',
};

export function keySourceLabel(keySource: string | null | undefined): string {
  if (!keySource) return 'unknown key';
  return KEY_SOURCE_USAGE_LABEL[keySource] ?? keySource;
}

/** The graph nodes, as steps a user recognises. Unknown nodes show their own name. */
const NODE_LABEL: Record<string, string> = {
  research: 'Research',
  plan: 'Planning',
  critique: 'Critic review',
  critic: 'Critic review',
  adapt: 'Adapting',
  evaluate: 'Evaluation',
  revise: 'Revision',
  scan: 'Scan',
};

export const UNATTRIBUTED_STEP = 'Not attributed to one step';

export function nodeLabel(node: string | null): string {
  if (node === null) return UNATTRIBUTED_STEP;
  return NODE_LABEL[node] ?? node;
}

export function roleLabel(role: string | null | undefined): string {
  if (!role || role === UNATTRIBUTED_ROLE) return 'Not attributed to one role';
  return ROLE_LABEL[role as TrainingAgentRole] ?? role;
}

const KIND_LABEL: Record<string, string> = {
  create: 'New plans',
  revise: 'Plan revisions',
  evaluate: 'Evaluations',
  adapt: 'Workout adjustments',
  scan: 'Scans',
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** Summed provider latency: `850 ms`, `4.2 s`, `2 min 5 s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 s';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

/** Why the app shows tokens and never money. */
export const TOKENS_NOT_CURRENCY = 'Tokens, not currency';
export const TOKENS_NOT_CURRENCY_WHY =
  'Providers bill by tokens, and the price per token differs by model and by contract. This app has no price list, so it shows the tokens counted, the model and whose key paid, never an amount of money.';
