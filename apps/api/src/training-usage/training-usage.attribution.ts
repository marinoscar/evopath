import type { TrainingAgentRole } from '../common/schemas/settings.schema';
import { EVALUATE_NODE } from '../training-agents/agents/evaluator/evaluator.agent';
import { CRITIQUE_NODE } from '../training-agents/agents/critic/critic.agent';
import { PLAN_NODE } from '../training-agents/agents/planner/planner.agent';
import { RESEARCH_NODE } from '../training-agents/agents/researcher/researcher.agent';
import { CRITIQUE_LIGHT_NODE } from '../training-agents/nodes/critique-light.node';
import { ADAPT_NODE } from '../training-adaptation/graph/nodes/adapt.node';
import { CRITIC_NODE } from '../training-adaptation/graph/nodes/critic.node';
import type { UsageTotals } from '../training-agents/runtime/run-budget';
import type { TrainingUsageBucket } from './dto/training-usage.dto';

// =============================================================================
// Attributing a run's usage rows to its nodes or roles (pure)
// =============================================================================
//
// `ai_usage_events` knows the provider, model and key source of each round
// trip, and the job (so the run), but not the node or role that made it. The
// run knows, per node and per role, what its budget was charged (the kit's
// tally: successful calls and their input/output/reasoning tokens) and which
// model each role was frozen to.
//
// A UNIT is a node (per-run report) or a role (monthly report) with the model
// of its role and its tally. Per run, the rows are taken by (provider, model):
//
//   exactly one unit on that model  the unit gets every row of it (requests,
//                                    failures, cached input, latency): exact
//   several units share the model   each unit gets its own tally (requests =
//                                    its successful calls, its tokens); what
//                                    the rows hold beyond that (failed calls,
//                                    cached input, latency) is UNATTRIBUTED
//   no unit on that model           the rows are unattributed
//
// With no rows at all (retention removed them) every unit reports its tally.
// So the attributed rows plus the unattributed ones add up to the rows'
// totals, and nothing is invented: a share is only ever split by the tally
// the budget recorded, never by a guess.
// =============================================================================

/** One (run, provider, model, key source, succeeded?) group of `ai_usage_events`. */
export interface UsageRowGroup {
  runId: string;
  provider: string;
  modelId: string;
  keySource: string;
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  latencyMs: number;
}

export interface AttributionUnit {
  key: string;
  role: TrainingAgentRole | null;
  provider: string | null;
  modelId: string | null;
  keySource: string | null;
  tally: UsageTotals;
  /** Latency known from elsewhere (run events), used when rows cannot give it. */
  latencyMs: number;
}

export interface AttributedUnit extends AttributionUnit {
  bucket: TrainingUsageBucket;
}

export interface UnattributedUsage {
  provider: string;
  modelId: string;
  keySource: string;
  bucket: TrainingUsageBucket;
}

export interface Attribution {
  units: AttributedUnit[];
  unattributed: UnattributedUsage[];
}

/** Nodes that call a model, by role: the fallback once a run's events are gone. */
export const NODE_ROLES: Readonly<Record<string, TrainingAgentRole>> = {
  [RESEARCH_NODE]: 'researcher',
  [PLAN_NODE]: 'planner',
  [CRITIQUE_NODE]: 'critic',
  [CRITIQUE_LIGHT_NODE]: 'critic',
  [EVALUATE_NODE]: 'evaluator',
  // The quick adaptation graph (E6.1).
  [ADAPT_NODE]: 'planner',
  [CRITIC_NODE]: 'critic',
};

export function emptyBucket(): TrainingUsageBucket {
  return {
    requests: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    latencyMs: 0,
    orgKeyRequests: 0,
    orgKeyInputTokens: 0,
    orgKeyOutputTokens: 0,
  };
}

export function addBuckets(a: TrainingUsageBucket, b: TrainingUsageBucket): TrainingUsageBucket {
  return {
    requests: a.requests + b.requests,
    failed: a.failed + b.failed,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    latencyMs: a.latencyMs + b.latencyMs,
    orgKeyRequests: a.orgKeyRequests + b.orgKeyRequests,
    orgKeyInputTokens: a.orgKeyInputTokens + b.orgKeyInputTokens,
    orgKeyOutputTokens: a.orgKeyOutputTokens + b.orgKeyOutputTokens,
  };
}

/** `a - b`, field by field, never below zero. */
function subtractBuckets(a: TrainingUsageBucket, b: TrainingUsageBucket): TrainingUsageBucket {
  const out = emptyBucket();
  for (const key of Object.keys(out) as Array<keyof TrainingUsageBucket>) {
    out[key] = Math.max(0, a[key] - b[key]);
  }
  return out;
}

export function isEmptyBucket(bucket: TrainingUsageBucket): boolean {
  return Object.values(bucket).every((value) => value === 0);
}

/** A row group as a bucket (the org subtotal when the org key paid). */
export function bucketOfGroup(group: UsageRowGroup): TrainingUsageBucket {
  const org = group.keySource === 'org';
  return {
    requests: group.requests,
    failed: group.failed,
    inputTokens: group.inputTokens,
    outputTokens: group.outputTokens,
    reasoningTokens: group.reasoningTokens,
    cachedInputTokens: group.cachedInputTokens,
    latencyMs: group.latencyMs,
    orgKeyRequests: org ? group.requests : 0,
    orgKeyInputTokens: org ? group.inputTokens : 0,
    orgKeyOutputTokens: org ? group.outputTokens : 0,
  };
}

/** A unit's own tally as a bucket (no failures, no cached input: the tally has neither). */
export function bucketOfTally(unit: AttributionUnit): TrainingUsageBucket {
  const org = unit.keySource === 'org';
  return {
    ...emptyBucket(),
    requests: unit.tally.calls,
    inputTokens: unit.tally.inputTokens,
    outputTokens: unit.tally.outputTokens,
    reasoningTokens: unit.tally.reasoningTokens,
    latencyMs: unit.latencyMs,
    orgKeyRequests: org ? unit.tally.calls : 0,
    orgKeyInputTokens: org ? unit.tally.inputTokens : 0,
    orgKeyOutputTokens: org ? unit.tally.outputTokens : 0,
  };
}

const modelKey = (provider: string | null, modelId: string | null) => `${provider ?? ''}\u0000${modelId ?? ''}`;

/** Attributes ONE run's row groups to its units (see the header). */
export function attributeRun(units: readonly AttributionUnit[], groups: readonly UsageRowGroup[]): Attribution {
  if (groups.length === 0) {
    return { units: units.map((unit) => ({ ...unit, bucket: bucketOfTally(unit) })), unattributed: [] };
  }

  const buckets = new Map<string, TrainingUsageBucket>(units.map((unit) => [unit.key, emptyBucket()]));
  const unattributed: UnattributedUsage[] = [];

  const byModel = new Map<string, UsageRowGroup[]>();
  for (const group of groups) {
    const key = modelKey(group.provider, group.modelId);
    byModel.set(key, [...(byModel.get(key) ?? []), group]);
  }

  const matched = new Set<string>();

  for (const [key, modelGroups] of byModel) {
    const candidates = units.filter((unit) => unit.provider !== null && modelKey(unit.provider, unit.modelId) === key);
    candidates.forEach((unit) => matched.add(unit.key));

    if (candidates.length === 1) {
      const unit = candidates[0];
      buckets.set(unit.key, modelGroups.reduce((sum, group) => addBuckets(sum, bucketOfGroup(group)), buckets.get(unit.key)!));
      continue;
    }

    if (candidates.length === 0) {
      for (const group of modelGroups) {
        unattributed.push({ provider: group.provider, modelId: group.modelId, keySource: group.keySource, bucket: bucketOfGroup(group) });
      }
      continue;
    }

    // Shared model: each unit its own tally, the rest unattributed.
    let given = emptyBucket();
    for (const unit of candidates) {
      const own = bucketOfTally(unit);
      buckets.set(unit.key, addBuckets(buckets.get(unit.key)!, own));
      given = addBuckets(given, own);
    }
    const all = modelGroups.reduce((sum, group) => addBuckets(sum, bucketOfGroup(group)), emptyBucket());
    const rest = subtractBuckets(all, given);
    if (!isEmptyBucket(rest)) {
      const dominant = [...modelGroups].sort((a, b) => b.requests - a.requests)[0];
      unattributed.push({ provider: dominant.provider, modelId: dominant.modelId, keySource: dominant.keySource, bucket: rest });
    }
  }

  // A unit no row matched (its role's model is unknown): report its tally
  // rather than hide it.
  for (const unit of units) {
    if (!matched.has(unit.key) && unit.tally.calls > 0) buckets.set(unit.key, bucketOfTally(unit));
  }

  return { units: units.map((unit) => ({ ...unit, bucket: buckets.get(unit.key)! })), unattributed };
}

/** The median of `values` (the mean of the two middle ones, rounded, for an even count). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
