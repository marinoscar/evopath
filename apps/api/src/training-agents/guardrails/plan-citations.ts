import { PLAN_LIMITS, type PlanTree } from '../../programs/contracts/plan-tree.contract';
import type { VerifiedEvidenceBrief } from '../agents/researcher/evidence-brief.contract';
import { normalizeUrl, sanitizeModelText } from './citations';
import { Findings, pathOf, weeksOf } from './tree';
import type { GuardrailContext, Violation } from './types';

// =============================================================================
// G8 Citations, applied to a plan (reuses the E5.4 citation guardrail)
// =============================================================================
//
// - Every `evidenceRefs` id must be a claim id of the run's verified brief
//   (`E1`, `E2`, ...); anything else is removed. No brief: every ref goes.
// - Rationale text passes through `sanitizeModelText` with the brief's
//   verified URLs: HTML, control characters and any URL the brief does not
//   hold are stripped (repair).
// - A numeric statistic in a rationale (`20%`, `12 studies`) whose number
//   appears nowhere in the brief is FLAGGED (warn): kept, but the critic and
//   the user see it.
// =============================================================================

const STATISTIC = /\b(\d+(?:[.,]\d+)?)\s?(?:%|percent\b|per ?cent\b|(?:studies|trials|participants|subjects|meta-analyses)\b)/gi;

/** The brief's verified URLs, normalised. */
export function briefUrls(brief: VerifiedEvidenceBrief | null): Set<string> {
  const urls = new Set<string>();
  for (const source of brief?.sources ?? []) {
    const normalized = normalizeUrl(source.url);
    if (normalized) urls.add(normalized);
  }
  return urls;
}

/** Every text of the brief, for the statistic check. */
function briefText(brief: VerifiedEvidenceBrief | null): string {
  if (!brief) return '';
  return [brief.summary, ...brief.claims.flatMap((c) => [c.claim, c.applicability]), ...(brief.cautions ?? [])].join(' ');
}

/** The numeric statistics in `text` whose number is not in the brief. */
export function unverifiedStatistics(text: string, brief: VerifiedEvidenceBrief | null): string[] {
  const known = briefText(brief);
  const out: string[] = [];
  for (const match of text.matchAll(STATISTIC)) {
    const number = match[1].replace(',', '.');
    if (!new RegExp(`(^|[^\\d.])${number.replace('.', '[.,]')}([^\\d]|$)`).test(known)) out.push(match[0].trim());
  }
  return out;
}

/** Sanitises one model text for storage; reports what changed. */
export function checkText(
  f: Findings,
  text: string | null,
  max: number,
  path: string,
  ctx: Pick<GuardrailContext, 'brief'>,
  verified: ReadonlySet<string>,
): string | null {
  if (text === null) return null;
  const clean = sanitizeModelText(text, max, verified);
  if (clean !== text) {
    f.add('repair', 'text_sanitized', path, 'Removed a link, markup or unverified URL from the rationale.');
  }
  for (const stat of unverifiedStatistics(clean, ctx.brief)) {
    f.add('warn', 'unverified_statistic', path, `The rationale states "${stat}", which the evidence brief does not contain.`);
  }
  return clean === '' ? null : clean;
}

export function checkCitations(tree: PlanTree, ctx: GuardrailContext): Violation[] {
  const f = new Findings('G8');
  const claimIds = new Set((ctx.brief?.claims ?? []).map((c) => c.id));
  const verified = briefUrls(ctx.brief);

  for (const block of tree.blocks) {
    block.rationale = checkText(f, block.rationale, PLAN_LIMITS.nodeRationaleMax, `block ${block.position + 1}`, ctx, verified);
  }

  for (const { week } of weeksOf(tree)) {
    for (const workout of week.workouts) {
      workout.rationale = checkText(f, workout.rationale, PLAN_LIMITS.nodeRationaleMax, pathOf(ctx, week, workout), ctx, verified);
      for (const exercise of workout.exercises) {
        const path = pathOf(ctx, week, workout, exercise);
        const kept = [...new Set(exercise.evidenceRefs)].filter((ref) => claimIds.has(ref));
        const removed = exercise.evidenceRefs.filter((ref) => !claimIds.has(ref));
        if (removed.length > 0 || kept.length !== exercise.evidenceRefs.length) {
          if (removed.length > 0) {
            f.add('repair', 'unknown_evidence_ref', path, `Removed evidence reference ${[...new Set(removed)].sort().join(', ')}: not a claim in the verified brief.`);
          }
          exercise.evidenceRefs = kept;
        }
        exercise.rationale = checkText(f, exercise.rationale, PLAN_LIMITS.nodeRationaleMax, path, ctx, verified);
      }
    }
  }

  return f.list;
}
