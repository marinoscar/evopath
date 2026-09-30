import { z } from 'zod';

import type { AiUserClient } from '../../../src/ai/runtime/ai.service';
import { CRITIC_INSTRUCTIONS } from '../../../src/training-agents/agents/critic/critic.prompt';
import { delimit } from '../../../src/training-agents/agents/shared/prompt-blocks';
import { compactPlan } from '../../../src/training-agents/context/build-planner-context';
import type { EvalModelSpec, EvalEnv } from '../training/eval-env';
import type { EvalArtifact } from '../training/properties';

// =============================================================================
// The optional model-graded score (EVAL_JUDGE=1). TEST-ONLY, NEVER GATING.
//
// The critic's rubric prompt is reused, with a DIFFERENT model than the
// planner (a model grading its own plan is biased toward it), to score goal
// fit, realism and rationale quality from 1 to 5. Judges are noisy and prefer
// fluent text: the score is reported beside the structural properties and
// never fails anything.
// =============================================================================

const score = z.number().int().min(1).max(5);

export const judgeSchema = z.object({ goalFit: score, realism: score, rationaleQuality: score });
export type JudgeScores = z.output<typeof judgeSchema>;

const JUDGE_TASK = `JUDGE TASK (this replaces the verdict format above)
You are grading a finished training plan, not reviewing a draft. Using the rubric above, give three integer scores from 1 to 5:
- goalFit: how well the plan serves the person's goal, level and schedule.
- realism: whether the sessions, volume and progression are realistic for this person to complete.
- rationaleQuality: whether the stated reasons are specific, correct and grounded in the evidence claims.
Return only the JSON object that matches the schema.`;

/** The judge model: the critic's model, which must differ from the planner's. */
export function judgeModelOf(models: EvalEnv['models']): EvalModelSpec {
  const critic = models.critic;
  const planner = models.planner;
  if (!critic) throw new Error('EVAL_JUDGE needs a critic model in EVAL_MODELS');
  if (planner && planner.provider === critic.provider && planner.modelId === critic.modelId) {
    throw new Error('EVAL_JUDGE needs a critic model that differs from the planner model: a model must not grade its own plan');
  }
  return critic;
}

export async function judgePlan(ai: AiUserClient, model: EvalModelSpec, artifact: EvalArtifact, persona: { id: string }): Promise<JudgeScores> {
  const plan = compactPlan(artifact.tree, artifact.ctx.library);
  const person = {
    goal: artifact.ctx.goal,
    experience: artifact.ctx.experience,
    daysPerWeek: artifact.ctx.daysPerWeek,
    minutesPerSession: artifact.ctx.minutesPerSession,
    limitationAreas: artifact.ctx.limitationAreas,
  };
  const evidence = (artifact.ctx.brief?.claims ?? []).map((c) => ({ id: c.id, claim: c.claim }));
  const response = await ai.respondStructured({
    provider: model.provider,
    model: model.modelId,
    ...(model.effort ? { reasoning: { effort: model.effort as never } } : {}),
    instructions: `${CRITIC_INSTRUCTIONS}\n\n${JUDGE_TASK}`,
    input: [delimit('context', JSON.stringify({ person, plan, rationale: artifact.header?.rationale ?? null })), delimit('evidence', JSON.stringify(evidence)), 'Grade the plan.'].join('\n\n'),
    schema: judgeSchema,
    schemaName: 'plan_judgement',
    metadata: { agent: 'judge', persona: persona.id },
  } as never);
  return response.parsed as JudgeScores;
}
