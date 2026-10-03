import { AiError } from '../../../ai/core/ai-error';
import type { AiResponse, AiWebSearchTool } from '../../../ai/core/types/responses.types';
import type { NodeContext } from '../../graph/node-context';
import { collectSearchQueries, collectVerifiedUrls, verifyBrief } from '../../guardrails/citations';
import { AgentOutputTruncated } from '../../runtime/agent-caller';
import {
  EVIDENCE_BRIEF_SCHEMA_NAME,
  evidenceBriefSchema,
  KNOWLEDGE_BRIEF_SCHEMA_NAME,
  knowledgeBriefSchema,
  type EvidenceBrief,
  type KnowledgeBrief,
  type ResearchMode,
  type VerifiedEvidenceBrief,
} from './evidence-brief.contract';
import { mergeFallbackBrief } from './knowledge-fallback';
import type { ResearcherContext } from './researcher-context';
import {
  RESEARCH_RETRY_NUDGE,
  RESEARCH_TRUNCATION_NUDGE,
  RESEARCHER_INSTRUCTIONS,
  RESEARCHER_KNOWLEDGE_INSTRUCTIONS,
  RESEARCHER_NOTES_INSTRUCTIONS,
  RESEARCHER_SHAPE_INSTRUCTIONS,
  renderResearcherInput,
  renderShapeInput,
} from './researcher.prompt';

// =============================================================================
// The researcher agent: search, shape, verify, retry once, never fail on a shortfall
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
// Too few verified claims or sources, or a truncated answer, earns ONE retry.
//
// A research shortfall NEVER fails the run. After the retry (or at once when
// web search is off, refused or unusable for this model), one more call, with
// no tools, asks for the brief from established training principles
// (`knowledge-fallback.ts`); what the web attempts verified is kept, and the
// brief's `basis` records `web_partial` or `model_knowledge`. If that call
// fails too, a fixed set of conservative principles is used. Only platform
// errors that are not about research quality propagate: the kill switch, a
// key or model problem, the run budget, a throttle (deferred), an abort.
// =============================================================================

export const RESEARCH_NODE = 'research';

/** The mode tried first. The two-step path ships as the fallback. */
export const DEFAULT_RESEARCH_MODE: ResearchMode = 'single';

/** The round the knowledge fallback call is metered under (after the two web attempts). */
export const KNOWLEDGE_ROUND = 3;

/**
 * Kept because runs failed before the knowledge fallback existed are stored
 * with it (`TRAINING_REASONS.RESEARCH_INSUFFICIENT`); nothing throws it any more.
 */
export const RESEARCH_INSUFFICIENT_MESSAGE =
  'The research agent could not find enough reliable sources; try again, or simplify the goal.';

/** Codes from the tool-plus-schema call that switch to the two-step mode. */
const TWO_STEP_FALLBACK_CODES = new Set(['AI_STRUCTURED_OUTPUT_INVALID', 'AI_INVALID_REQUEST']);

/**
 * Codes that mean web research cannot help this run (web search switched off,
 * a model without hosted tools, a refused request or filtered content): go to
 * the knowledge fallback at once instead of retrying the search.
 */
const WEB_UNAVAILABLE_CODES = new Set(['AI_TOOL_DISABLED', 'AI_CAPABILITY_UNSUPPORTED', 'AI_INVALID_REQUEST', 'AI_CONTENT_FILTERED']);

/** Why the web research fell short and the knowledge fallback ran. */
export type ResearchFallbackCause = 'too_few_sources' | 'truncated' | 'web_unavailable';

export interface ResearchFallback {
  cause: ResearchFallbackCause;
  /** `model` when the knowledge call answered, `static` when the fixed principles were used. */
  knowledge: 'model' | 'static';
}

export interface ResearchOutcome {
  brief: VerifiedEvidenceBrief;
  /** Web attempts made: 1, or 2 when the one retry ran (0 when web search was unavailable from the start). */
  attempts: number;
  /** Set when the knowledge fallback produced (part of) the brief. */
  fallback: ResearchFallback | null;
}

export interface ResearchOptions {
  mode?: ResearchMode;
}

/** Runs the researcher for `context` and returns a brief; throws only for platform errors (see the header). */
export async function runResearcher(
  ctx: NodeContext,
  context: ResearcherContext,
  opts: ResearchOptions = {},
): Promise<ResearchOutcome> {
  const responses: AiResponse[] = [];
  const state: OnceState = { mode: opts.mode ?? DEFAULT_RESEARCH_MODE };
  let nudge: string | undefined;
  let searchContextSize: AiWebSearchTool['searchContextSize'] = 'high';
  let best: VerifiedEvidenceBrief | null = null;
  let cause: ResearchFallbackCause = 'too_few_sources';
  let attempts = 0;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let raw: EvidenceBrief;

    try {
      raw = await researchOnce(ctx, context, { nudge, searchContextSize, round: attempt }, state, responses);
      attempts = attempt;
    } catch (err) {
      // A cut-off answer: the free-text search call reports it directly; a
      // structured answer cut off mid-JSON surfaces as an invalid structured
      // output (the single-mode one already fell back to two-step).
      if (err instanceof AgentOutputTruncated || isInvalidStructuredOutput(err)) {
        attempts = attempt;
        cause = 'truncated';
        searchContextSize = 'medium';
        nudge = RESEARCH_TRUNCATION_NUDGE;
        continue;
      }
      if (err instanceof AiError && WEB_UNAVAILABLE_CODES.has(err.code)) {
        cause = 'web_unavailable';
        break;
      }
      throw err;
    }

    const verified = verifyBrief(raw, collectVerifiedUrls(responses), {
      now: ctx.now(),
      researchMode: state.mode,
      searchQueries: collectSearchQueries(responses),
    });

    if (verified.sufficient) {
      return { brief: verified.brief, attempts: attempt, fallback: null };
    }

    if (!best || strength(verified.brief) > strength(best)) best = verified.brief;
    cause = 'too_few_sources';
    nudge = RESEARCH_RETRY_NUDGE;
  }

  const knowledge = await knowledgeOnce(ctx, context);
  const brief = mergeFallbackBrief({
    partial: best,
    knowledge,
    researchMode: state.mode,
    searchQueries: collectSearchQueries(responses),
  });

  return { brief, attempts, fallback: { cause, knowledge: knowledge ? 'model' : 'static' } };
}

/** How much of an insufficient verified attempt is worth keeping: claims first, then sources. */
function strength(brief: VerifiedEvidenceBrief): number {
  return brief.claims.length * 100 + brief.sources.length;
}

/**
 * The knowledge fallback call: no tools, the knowledge schema, the same
 * delimited user context. `null` when it fails for a reason a fixed brief can
 * stand in for (cut off, invalid output, refused, filtered); a platform error
 * (kill switch, budget, throttle, abort, key or model) propagates.
 */
async function knowledgeOnce(ctx: NodeContext, context: ResearcherContext): Promise<KnowledgeBrief | null> {
  try {
    const { parsed } = await ctx.agent.structured({
      role: 'researcher',
      node: RESEARCH_NODE,
      round: KNOWLEDGE_ROUND,
      schema: knowledgeBriefSchema,
      schemaName: KNOWLEDGE_BRIEF_SCHEMA_NAME,
      instructions: RESEARCHER_KNOWLEDGE_INSTRUCTIONS,
      input: renderResearcherInput(context),
    });
    return parsed;
  } catch (err) {
    if (err instanceof AgentOutputTruncated) return null;
    if (err instanceof AiError && (err.code === 'AI_STRUCTURED_OUTPUT_INVALID' || WEB_UNAVAILABLE_CODES.has(err.code))) return null;
    throw err;
  }
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
