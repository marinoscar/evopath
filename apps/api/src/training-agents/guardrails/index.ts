import type { PlanTree } from '../../programs/contracts/plan-tree.contract';
import { estimateMinutes, checkTime } from './duration';
import { checkEquipment } from './equipment';
import { checkInjury } from './injury';
import { checkLoads } from './loads';
import { checkCitations } from './plan-citations';
import { checkProgression } from './progression';
import { checkRecovery } from './recovery';
import { checkSchema, checkShape, checkWeeksNotEmpty } from './shape';
import { normalizeTree, sortWeek, weeksOf } from './tree';
import type { GuardrailContext, GuardrailOutcome, GuardrailReport, Violation } from './types';
import { checkVolume } from './volume';

// =============================================================================
// applyGuardrails: the server decides what may ship
// =============================================================================
//
// Pure and deterministic. Works on a normalised copy of `tree` (so exercise
// input order never matters) and runs the rules in a FIXED order, each
// repairing what it can:
//
//   G1 shape, G2 equipment, G6 injury and pain, G3 time, G4 volume and
//   intensity, G5 recovery, G7 progression, G9 loads (then G7's bounds again
//   for any load G9 moved), G8 citations
//
// then renumbers positions, recomputes every workout's estimated minutes,
// re-checks that no week is empty and strictly parses the tree.
//
// Idempotent: a second run over the result changes nothing (the rules only
// ever lower volume, time and loads after G1, which is what makes it so).
//
// `report.status`: `clean` (no violation), `repaired` (repairs and warnings
// only), `blocked` (an unrepaired `block`: the plan may not ship).
// =============================================================================

export * from './types';
export { LEVEL_LIMITS, GUARDRAIL_LIMITS, DURATION_MODEL, PROGRESSION_LIMITS, LOAD_LIMITS, effectiveLimits, LIMITATION_PATTERN_MAP } from './limits';
export { estimateMinutes, trimToFit } from './duration';
export { findSubstitutes, fallbackTier, SUBSTITUTION_LADDER } from './substitution';

export function summarizeReport(violations: Violation[]): GuardrailReport {
  const counts = { block: 0, repair: 0, warn: 0 };
  for (const violation of violations) counts[violation.severity] += 1;
  const status = counts.block > 0 ? 'blocked' : violations.length > 0 ? 'repaired' : 'clean';
  return { status, violations, counts };
}

export function applyGuardrails(input: PlanTree, ctx: GuardrailContext): GuardrailOutcome {
  const tree = normalizeTree(input);
  const violations: Violation[] = [];

  violations.push(...checkShape(tree, ctx));
  violations.push(...checkEquipment(tree, ctx));
  violations.push(...checkInjury(tree, ctx));
  violations.push(...checkTime(tree, ctx));
  violations.push(...checkVolume(tree, ctx));
  violations.push(...checkRecovery(tree, ctx));
  violations.push(...checkProgression(tree, ctx));

  const loads = checkLoads(tree, ctx);
  violations.push(...loads);
  if (loads.some((v) => v.severity === 'repair')) {
    violations.push(...checkProgression(tree, ctx).filter((v) => v.severity !== 'warn'));
  }

  violations.push(...checkCitations(tree, ctx));

  for (const { week } of weeksOf(tree)) {
    sortWeek(week);
    for (const workout of week.workouts) workout.estimatedMinutes = estimateMinutes(workout);
  }
  const shapeViolations = [...checkWeeksNotEmpty(tree), ...checkSchema(tree)];
  for (const violation of shapeViolations) {
    if (!violations.some((v) => v.code === violation.code && v.path === violation.path)) violations.push(violation);
  }

  return { tree, report: summarizeReport(violations) };
}
