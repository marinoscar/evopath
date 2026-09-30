import { AiError } from '../../../ai/core/ai-error';
import type { AiResponse, AiWebSearchTool } from '../../../ai/core/types/responses.types';
import type { NodeContext } from '../../graph/node-context';
import { collectSearchQueries, collectVerifiedUrls, verifyBrief } from '../../guardrails/citations';
import { AgentOutputTruncated } from '../../runtime/agent-caller';
import { TrainingRunFailedError } from '../../runtime/training-run-errors';
import { TRAINING_REASONS } from '../../runtime/training-runs.constants';
import {
  EVIDENCE_BRIEF_SCHEMA_NAME,
  evidenceBriefSchema,
  type EvidenceBrief,
  type ResearchMode,
  type VerifiedEvidenceBrief,
} from './evidence-brief.contract';
import type { ResearcherContext } from './researcher-context';
import {
  RESEARCH_RETRY_NUDGE,
  RESEARCH_TRUNCATION_NUDGE,
  RESEARCHER_INSTRUCTIONS,
  RESEARCHER_NOTES_INSTRUCTIONS,
  RESEARCHER_SHAPE_INSTRUCTIONS,
  renderResearcherInput,
  renderShapeInput,
} from './researcher.prompt';

// =============================================================================
// The researcher agent: search, shape, verify, retry once
// =============================================================================
//
// Every model call goes through `ctx.agent` (AgentCaller), so the frozen
// model, the effort, the budget, the kill switch and the hosted-tool gates
// (`AI_TOOL_DISABLED` when the administrator switched web search off,
// `AI_CAPABILITY_UNSUPPORTED` when the model lacks `hosted_tools`) all apply.
//
// Modes: `single` asks for the evidence brief schema WITH the web search tool
// in one call. When that fails with an invalid structured output (or the
// provider refuses the tool plus schema combination), `two_step` searches
// without a schema and then shapes the notes, with no tools, in a second call.
//
// Verification uses only what the search RETURNED (hosted tool results and
// message citations, across every call of this run), never the model's text.
// Too few verified claims or sources, or a truncated answer, earns ONE retry;
// after it the run fails `TRAINING_RESEARCH_INSUFFICIENT`.
// =============================================================================

export const RESEARCH_NODE = 'research';

/** The mode tried first. The two-step path ships as the fallback. */
export const DEFAULT_RESEARCH_MODE: ResearchMode = 'single';

export const RESEARCH_INSUFFICIENT_MESSAGE =
  'The research agent could not find enough reliable sources; try again, or simplify the goal.';

/** Codes from the tool-plus-schema call that switch to the two-step mode. */
const TWO_STEP_FALLBACK_CODES = new Set(['AI_STRUCTURED_OUTPUT_INVALID', 'AI_INVALID_REQUEST']);

export interface ResearchOutcome {
  brief: VerifiedEvidenceBrief;
  /** 1, or 2 when the one retry ran. */
  attempts: number;
}

export interface ResearchOptions {
  mode?: ResearchMode;
}

export function researchInsufficient(reason: 'too_few_sources' | 'truncated'): TrainingRunFailedError {
  return new TrainingRunFailedError(TRAINING_REASONS.RESEARCH_INSUFFICIENT, RESEARCH_INSUFFICIENT_MESSAGE, {
    reason: TRAINING_REASONS.RESEARCH_INSUFFICIENT,
    cause: reason,
  });
}

/** Runs the researcher for `context` and returns the verified brief, or throws. */
export async function runResearcher(
  ctx: NodeContext,
  context: ResearcherContext,
  opts: ResearchOptions = {},
): Promise<ResearchOutcome> {
  const responses: AiResponse[] = [];
  const state: OnceState = { mode: opts.mode ?? DEFAULT_RESEARCH_MODE };
  let nudge: string | undefined;
  let searchContextSize: AiWebSearchTool['searchContextSize'] = 'high';

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let raw: EvidenceBrief;

    try {
      raw = await researchOnce(ctx, context, { nudge, searchContextSize, round: attempt }, state, responses);
    } catch (err) {
      // A cut-off answer: the free-text search call reports it directly; a
      // structured answer cut off mid-JSON surfaces as an invalid structured
      // output (the single-mode one already fell back to two-step).
      if (err instanceof AgentOutputTruncated || isInvalidStructuredOutput(err)) {
        if (attempt === 2) throw researchInsufficient('truncated');
        searchContextSize = 'medium';
        nudge = RESEARCH_TRUNCATION_NUDGE;
        continue;
      }
      throw err;
    }

    const verified = verifyBrief(raw, collectVerifiedUrls(responses), {
      now: ctx.now(),
      researchMode: state.mode,
      searchQueries: collectSearchQueries(responses),
    });

    if (verified.sufficient) {
      return { brief: verified.brief, attempts: attempt };
    }

    nudge = RESEARCH_RETRY_NUDGE;
  }

  throw researchInsufficient('too_few_sources');
}

function isInvalidStructuredOutput(err: unknown): boolean {
  return err instanceof AiError && err.code === 'AI_STRUCTURED_OUTPUT_INVALID';
}

/** Carried across attempts: once the run fell back to two-step, it stays there. */
interface OnceState {
  mode: ResearchMode;
}

interface OnceOptions {
  nudge?: string;
  searchContextSize: AiWebSearchTool['searchContextSize'];
  round: number;
}

/** One attempt in `state.mode`; a single-mode schema failure switches `state` to two-step. Appends every response. */
async function researchOnce(
  ctx: NodeContext,
  context: ResearcherContext,
  opts: OnceOptions,
  state: OnceState,
  responses: AiResponse[],
): Promise<EvidenceBrief> {
  const webSearch: AiWebSearchTool = { type: 'web_search', searchContextSize: opts.searchContextSize };

  if (state.mode === 'single') {
    try {
      const { parsed, response } = await ctx.agent.structured({
        role: 'researcher',
        node: RESEARCH_NODE,
        round: opts.round,
        schema: evidenceBriefSchema,
        schemaName: EVIDENCE_BRIEF_SCHEMA_NAME,
        hostedTools: [webSearch],
        instructions: RESEARCHER_INSTRUCTIONS,
        input: renderResearcherInput(context, opts.nudge),
      });
      responses.push(response);
      return parsed;
    } catch (err) {
      if (!(err instanceof AiError) || !TWO_STEP_FALLBACK_CODES.has(err.code)) throw err;
      state.mode = 'two_step';
    }
  }

  const notes = await ctx.agent.respond({
    role: 'researcher',
    node: RESEARCH_NODE,
    round: opts.round,
    hostedTools: [webSearch],
    instructions: RESEARCHER_NOTES_INSTRUCTIONS,
    input: renderResearcherInput(context, opts.nudge),
  });
  responses.push(notes);

  const { parsed, response } = await ctx.agent.structured({
    role: 'researcher',
    node: RESEARCH_NODE,
    round: opts.round,
    schema: evidenceBriefSchema,
    schemaName: EVIDENCE_BRIEF_SCHEMA_NAME,
    instructions: RESEARCHER_SHAPE_INSTRUCTIONS,
    input: renderShapeInput(context, notes.outputText, [...collectVerifiedUrls(notes)]),
  });
  // The shaping call has no tools: it cannot add a verified URL, only use one.
  responses.push({ ...response, output: [] });

  return parsed;
}
