import { SAFETY_BLOCK } from '../../training-agents/agents/shared/prompt-blocks';
import type { AdaptationSentContext } from '../context/adaptation-context.contract';
import type { AdaptedWorkout, AdaptationGuardrailReport } from '../contracts/adapted-workout.contract';
import { ADAPTATION_DATA_BLOCK } from './adapt.prompt';
import { CONTEXT_JSON_OPEN, contextBlock } from './markers';

// =============================================================================
// The light critic: one structured call on the checked proposal
// =============================================================================
//
// It sees the same minimised context, the proposal (by key, after the
// guardrails) and the server's guardrail notes (codes). It answers accept or
// revise with four checks and short issues; `revise` with a `major` issue is
// what triggers the single second planner pass.
// =============================================================================

const CRITIC_ROLE = `ROLE
You review ONE adapted workout for today, quickly. You do not rewrite it.

INPUT (data, inside ${CONTEXT_JSON_OPEN})
- context: the user's request, today's planned workout, the equipment, readiness and constraints.
- proposal: the adapted workout (exercise keys, sets, reps, RPE, rest, estimated minutes) after the server's checks.
- serverNotes: the codes of the changes the server already made.

CHECK
- honoursRequest: it fits the minutes, the equipment and the energy level the user asked for.
- preservesIntent: it keeps the session's purpose (priority lifts or their closest substitutes, main patterns).
- avoidsSoreAreas: sore prime movers are reduced (mild) or avoided (moderate).
- sensibleOrder: compound and priority work before accessories; no silly pairings.

OUTPUT only the JSON object that matches the schema. verdict "revise" only when an issue is major (it clearly fails a
check); otherwise "accept". Issues: a short snake_case code, a severity and a note of at most 200 characters.`;

export const CRITIC_INSTRUCTIONS = `${SAFETY_BLOCK}\n\n${ADAPTATION_DATA_BLOCK}\n\n${CRITIC_ROLE}`;

export function renderCriticInput(sent: AdaptationSentContext, proposal: AdaptedWorkout, report: AdaptationGuardrailReport): string {
  return contextBlock({
    context: sent,
    proposal: {
      title: proposal.title,
      estimatedMinutes: proposal.estimatedMinutes,
      exercises: proposal.exercises.map((e) => ({
        key: e.exerciseKey,
        source: e.source,
        replacesKey: e.replacesExerciseKey,
        isPriority: e.isPriority,
        sets: e.sets,
        repMin: e.repMin,
        repMax: e.repMax,
        targetRpe: e.targetRpe,
        restSeconds: e.restSeconds,
      })),
      dropped: proposal.dropped.map((d) => ({ key: d.exerciseKey, reason: d.reason })),
    },
    serverNotes: [...report.repairs, ...report.rejected].map((f) => f.code),
  });
}
