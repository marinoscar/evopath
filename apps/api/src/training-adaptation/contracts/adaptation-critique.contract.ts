import { z } from 'zod';

// =============================================================================
// The light critic's answer (`schemaName: 'training_adaptation_critique'`)
// =============================================================================
//
// Strict-mode compatible. The critic ADVISES: `revise` triggers the one
// allowed second planner pass only when the server also finds a `major`
// issue in the answer (`wantsRevision`). The guardrails, not the critic, are
// the safety net: they run after every planner pass regardless.
// =============================================================================

export const CRITIQUE_LIMITS = { issuesMax: 8, codeChars: 40, noteChars: 200 } as const;

export const adaptationCritiqueModelSchema = z.object({
  verdict: z.enum(['accept', 'revise']),
  checks: z.object({
    honoursRequest: z.boolean(),
    preservesIntent: z.boolean(),
    avoidsSoreAreas: z.boolean(),
    sensibleOrder: z.boolean(),
  }),
  issues: z
    .array(
      z.object({
        code: z.string().max(80),
        severity: z.enum(['minor', 'major']),
        note: z.string().max(600),
      }),
    )
    .max(16),
});

export type AdaptationCritiqueModel = z.infer<typeof adaptationCritiqueModelSchema>;

/** One critic round as stored (`critic_report.rounds[]`): sanitised and bounded. */
export interface AdaptationCritiqueRound {
  round: number;
  verdict: 'accept' | 'revise';
  checks: AdaptationCritiqueModel['checks'];
  issues: Array<{ code: string; severity: 'minor' | 'major'; note: string }>;
}

/** `workout_adaptations.critic_report`. */
export interface AdaptationCriticReport {
  /** The last round's verdict, or `null` when the critic was skipped. */
  verdict: 'accept' | 'revise' | null;
  checks: AdaptationCritiqueModel['checks'] | null;
  issues: AdaptationCritiqueRound['issues'];
  /** Critic rounds that ran. */
  rounds: number;
  /** Why the critic did not review (`token_cap`: the run budget; `error`: no usable answer). */
  skipped?: 'token_cap' | 'error';
}

/** Lower-case machine code: `[a-z0-9_]`, at most 40 characters. */
export function sanitizeIssueCode(code: string): string {
  const clean = code
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, CRITIQUE_LIMITS.codeChars);
  return clean || 'other';
}

/** The stored round: codes sanitised, notes clipped, at most `issuesMax` issues. */
export function toCritiqueRound(round: number, answer: AdaptationCritiqueModel): AdaptationCritiqueRound {
  return {
    round,
    verdict: answer.verdict,
    checks: { ...answer.checks },
    issues: answer.issues.slice(0, CRITIQUE_LIMITS.issuesMax).map((issue) => ({
      code: sanitizeIssueCode(issue.code),
      severity: issue.severity,
      note: issue.note.trim().slice(0, CRITIQUE_LIMITS.noteChars),
    })),
  };
}

/** The server's reading of a critique: revise only on `revise` WITH a major issue. */
export function wantsRevision(round: Pick<AdaptationCritiqueRound, 'verdict' | 'issues'> | null | undefined): boolean {
  return !!round && round.verdict === 'revise' && round.issues.some((issue) => issue.severity === 'major');
}
