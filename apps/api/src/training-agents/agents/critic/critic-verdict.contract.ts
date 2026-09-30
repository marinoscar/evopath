import { z } from 'zod';

// =============================================================================
// CriticVerdict: the critic's output, scored against a fixed rubric
// =============================================================================
//
// Strict-mode compatible (every property required, no records): the schema
// is sent to the provider as the structured output format. The field names
// are the ones the planner's `<review>` block reads back from
// `state.verdicts.at(-1)` (`blockers[{dimension, path, issue, fix}]`,
// `suggestions[{dimension, issue, fix}]`, `summary`).
//
// The verdict is ADVICE. The server decides whether a draft ships
// (`graph/routes.ts`): a critic cannot approve a plan the guardrails block.
// =============================================================================

export const CRITIC_VERDICT_SCHEMA_NAME = 'critic_verdict';

/** The rubric's dimensions, in the order the prompt lists them. */
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

export const CRITIC_LIMITS = {
  pathChars: 120,
  issueChars: 300,
  fixChars: 300,
  summaryChars: 500,
  blockersMax: 8,
  suggestionsMax: 8,
  /** A dimension scoring below this blocks shipping (the ship rule's "all scores >= 4"). */
  passScore: 4,
} as const;

const L = CRITIC_LIMITS;

const score = z.number().int().min(1).max(5);
const dimension = z.enum(CRITIC_DIMENSIONS);

export const criticScoresSchema = z.object(
  Object.fromEntries(CRITIC_DIMENSIONS.map((d) => [d, score])) as Record<CriticDimension, typeof score>,
);

export const criticBlockerSchema = z.object({
  dimension,
  /** Where in the plan (`week 3 > Mon > barbell_back_squat`). */
  path: z.string().max(L.pathChars),
  issue: z.string().max(L.issueChars),
  fix: z.string().max(L.fixChars),
});

export const criticSuggestionSchema = z.object({
  dimension,
  issue: z.string().max(L.issueChars),
  fix: z.string().max(L.fixChars),
});

export const criticVerdictSchema = z.object({
  verdict: z.enum(['approve', 'revise']),
  scores: criticScoresSchema,
  blockers: z.array(criticBlockerSchema).max(L.blockersMax),
  suggestions: z.array(criticSuggestionSchema).max(L.suggestionsMax),
  summary: z.string().max(L.summaryChars),
});

export type CriticVerdict = z.infer<typeof criticVerdictSchema>;
export type CriticScores = z.infer<typeof criticScoresSchema>;

/** Why a critique round produced no review (the run may still ship, see `routes.ts`). */
export const CRITIC_SKIP_REASONS = ['budget', 'unavailable'] as const;
export type CriticSkipReason = (typeof CRITIC_SKIP_REASONS)[number];

/**
 * One entry of `RunState.verdicts`: the (sanitised) verdict with its round,
 * or a marker that the round was skipped. Kept flat so the planner's review
 * reads `blockers`, `suggestions` and `summary` straight off it.
 */
export type CriticRoundState =
  | (CriticVerdict & { round: number; skipped?: undefined })
  | { round: number; skipped: CriticSkipReason };

const verdictStateSchema = criticVerdictSchema.extend({ round: z.number().int().min(1) });
const skippedStateSchema = z.object({ round: z.number().int().min(1), skipped: z.enum(CRITIC_SKIP_REASONS) });

/** A `verdicts` entry, narrowed; `null` for anything else (a stub marker, a malformed value). */
export function criticRoundOf(value: unknown): CriticRoundState | null {
  const skipped = skippedStateSchema.safeParse(value);
  if (skipped.success) return skipped.data;
  const verdict = verdictStateSchema.safeParse(value);
  return verdict.success ? verdict.data : null;
}

/** Whether a verdict approves by the rubric: `approve`, every score at least 4, no blocker. */
export function verdictPasses(verdict: CriticVerdict): boolean {
  return (
    verdict.verdict === 'approve' &&
    verdict.blockers.length === 0 &&
    CRITIC_DIMENSIONS.every((d) => verdict.scores[d] >= L.passScore)
  );
}

/** The dimensions scoring below the pass mark, lowest first. */
export function lowScores(verdict: CriticVerdict): Array<{ dimension: CriticDimension; score: number }> {
  return CRITIC_DIMENSIONS.filter((d) => verdict.scores[d] < L.passScore)
    .map((d) => ({ dimension: d, score: verdict.scores[d] }))
    .sort((a, b) => a.score - b.score || CRITIC_DIMENSIONS.indexOf(a.dimension) - CRITIC_DIMENSIONS.indexOf(b.dimension));
}
