import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AiInputItem, AiOutputItem, AiResponseRequest } from '../../ai/core/types/responses.types';
import type { FakeAiScriptedResponse } from '../../ai/testing/fake-ai-provider';
import type { CriticVerdict } from '../agents/critic/critic-verdict.contract';
import type { EvidenceBrief } from '../agents/researcher/evidence-brief.contract';
import type { PlanDraft } from '../agents/planner/plan-draft.contract';
import type { AgentScript } from './node-context-harness';

// =============================================================================
// Scripted agents for node and graph specs over the fake provider
// =============================================================================
//
// Each script answers the calls of one role (the harness routes by
// `req.metadata.agent`) and records what it was sent. Usage is reported on
// every answer so budgets and `agent.usage` events behave as in a real run.
// =============================================================================

export const SCRIPT_USAGE = { inputTokens: 100, outputTokens: 50 } as const;

interface ResearchFixture {
  queries: string[];
  searchSources: string[];
  citations: string[];
  brief?: EvidenceBrief;
}

const RESEARCH_FIXTURES = join(__dirname, '../../../test/fixtures/training/research');

/** The researcher's answer for a reference fixture: the web search item and the cited message. */
export function researchAnswer(name = 'valid'): FakeAiScriptedResponse {
  const f = JSON.parse(readFileSync(join(RESEARCH_FIXTURES, `${name}.json`), 'utf8')) as ResearchFixture;
  const output: AiOutputItem[] = [
    {
      type: 'hosted_tool_call',
      tool: 'web_search',
      status: 'completed',
      result: { queries: f.queries, sources: f.searchSources.map((url) => ({ url })) },
    },
    {
      type: 'message',
      text: JSON.stringify(f.brief),
      citations: f.citations.map((url) => ({ url, title: 'cited', startIndex: 0, endIndex: 1 })),
    },
  ];
  return { output, usage: SCRIPT_USAGE, finishReason: 'stop' };
}

/** A researcher that always answers the fixture. */
export function researcherScript(name = 'valid', seen: AiResponseRequest[] = []): AgentScript {
  return (req) => {
    seen.push(req);
    return researchAnswer(name);
  };
}

/** A planner answering `drafts[i]` on its i-th call (the last one repeats). */
export function plannerScript(drafts: Array<PlanDraft | (() => FakeAiScriptedResponse)>, seen: AiResponseRequest[] = []): AgentScript {
  let i = 0;
  return (req) => {
    seen.push(req);
    const next = drafts[Math.min(i, drafts.length - 1)];
    i += 1;
    return typeof next === 'function' ? next() : { outputText: JSON.stringify(next), usage: SCRIPT_USAGE };
  };
}

export interface CriticScriptOptions {
  /** Tool calls the critic makes on its first investigation round-trip. */
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  /** Replaces the verdict answer (malformed output, a throw). */
  verdictAnswer?: (round: number) => FakeAiScriptedResponse;
}

function functionOutputs(req: AiResponseRequest): Extract<AiInputItem, { type: 'function_call_output' }>[] {
  if (typeof req.input === 'string') return [];
  return req.input.filter((item): item is Extract<AiInputItem, { type: 'function_call_output' }> => item.type === 'function_call_output');
}

/**
 * A critic: on an investigation call (function tools offered) it calls
 * `toolCalls` once, then answers notes; on the verdict call (structured
 * output) it answers `verdicts(round)`. `seen` records every request and
 * `toolOutputs` what the tools returned to it.
 */
export function criticScript(
  verdicts: (round: number) => CriticVerdict,
  opts: CriticScriptOptions = {},
  seen: AiResponseRequest[] = [],
  toolOutputs: string[] = [],
): AgentScript {
  return (req) => {
    seen.push(req);
    const round = Number(req.metadata?.round ?? '1');

    if (req.structuredOutput) {
      if (opts.verdictAnswer) return opts.verdictAnswer(round);
      return { outputText: JSON.stringify(verdicts(round)), usage: SCRIPT_USAGE };
    }

    const outputs = functionOutputs(req);
    if (outputs.length > 0 || !opts.toolCalls?.length) {
      toolOutputs.push(...outputs.map((o) => o.output));
      return { outputText: 'Checked volume and substitutes; see the verdict.', usage: SCRIPT_USAGE };
    }
    return {
      output: opts.toolCalls.map((call, i) => ({
        type: 'function_call' as const,
        callId: `call_${round}_${i}`,
        name: call.name,
        arguments: JSON.stringify(call.args),
      })),
      usage: SCRIPT_USAGE,
    };
  };
}
