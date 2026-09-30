import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AiError } from '../../../src/ai/core/ai-error';
import type { AiOutputItem, AiResponseRequest } from '../../../src/ai/core/types/responses.types';
import type { FakeAiScriptedResponse } from '../../../src/ai/testing/fake-ai-provider';
import { TRAINING_AGENT_ROLES, type TrainingAgentRole } from '../../../src/common/schemas/settings.schema';
import type { AgentScript } from '../../../src/training-agents/testing/node-context-harness';

// =============================================================================
// Scenario fixtures as a FakeAiProvider script (TEST-ONLY)
// =============================================================================
//
// `test/fixtures/training/scenarios/<name>.json` maps an agent role and a call
// index to a response spec. The same files feed the fake OpenAI Responses
// server (`tests/e2e/support/fake-responses-server.mjs`), so Jest and the
// browser replay identical behaviour. Keep the two readers in step:
//
//   - a call is answered from `calls[role][n]`, n counting the role's earlier
//     COUNTED calls; past the end the last entry repeats;
//   - a critic call with no structured output is an investigation round trip
//     (tools, no verdict): it answers a fixed note and is not counted;
//   - `outputJson` is resolved from the scenarios folder. A research fixture
//     (`queries`, `searchSources`, `citations`, `brief`) becomes a hosted
//     `web_search` call plus a cited message; any other file is the message text;
//   - `http.rateLimitOnCall` (1-based, over every request since the script was
//     created) answers one `AI_RATE_LIMITED` with `retryAfterSeconds`. It does
//     not consume a call index, so the retry gets the same answer;
//   - `http.delayMs` is honoured by the server only (Jest does not sleep).
// =============================================================================

export const SCENARIOS_DIR = join(__dirname, '../../fixtures/training/scenarios');

export interface ScenarioCallSpec {
  outputJson: string;
  usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number };
  webSearch?: { queries: string[]; sources: string[]; citations: string[] };
}

export interface Scenario {
  name: string;
  description: string;
  calls: Record<TrainingAgentRole, ScenarioCallSpec[]>;
  http: { rateLimitOnCall: number | null; retryAfterSeconds: number; delayMs: number };
}

interface ResearchFixture {
  queries: string[];
  searchSources: string[];
  citations: string[];
  brief: unknown;
}

export const DEFAULT_SCENARIO_USAGE = { inputTokens: 100, outputTokens: 50, reasoningTokens: 0 } as const;

export function scenarioNames(): string[] {
  return readdirSync(SCENARIOS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .sort();
}

export function loadScenario(name: string): Scenario {
  return JSON.parse(readFileSync(join(SCENARIOS_DIR, `${name}.json`), 'utf8')) as Scenario;
}

/** The parsed file a call spec points at. */
export function readOutputJson(spec: ScenarioCallSpec): unknown {
  return JSON.parse(readFileSync(join(SCENARIOS_DIR, spec.outputJson), 'utf8'));
}

function isResearchFixture(value: unknown): value is ResearchFixture {
  return typeof value === 'object' && value !== null && 'searchSources' in value && 'brief' in value && 'citations' in value;
}

function answerFor(spec: ScenarioCallSpec): FakeAiScriptedResponse {
  const json = readOutputJson(spec);
  const usage = { ...DEFAULT_SCENARIO_USAGE, ...spec.usage };
  const research: ResearchFixture | null = isResearchFixture(json)
    ? json
    : spec.webSearch
      ? { queries: spec.webSearch.queries, searchSources: spec.webSearch.sources, citations: spec.webSearch.citations, brief: json }
      : null;

  if (!research) return { outputText: JSON.stringify(json), usage, finishReason: 'stop' };

  const output: AiOutputItem[] = [
    {
      type: 'hosted_tool_call',
      tool: 'web_search',
      status: 'completed',
      result: { queries: research.queries, sources: research.searchSources.map((url) => ({ url })) },
    },
    {
      type: 'message',
      text: JSON.stringify(research.brief),
      citations: research.citations.map((url) => ({ url, title: 'cited', startIndex: 0, endIndex: 1 })),
    },
  ];
  return { output, usage, finishReason: 'stop' };
}

/** One script answering every role from the scenario, by `req.metadata.agent`. */
export function scriptFromScenario(name: string, seen: AiResponseRequest[] = []): AgentScript {
  const scenario = loadScenario(name);
  const counters = new Map<string, number>();
  let requests = 0;

  return (req) => {
    seen.push(req);
    requests += 1;

    if (scenario.http.rateLimitOnCall === requests) {
      throw new AiError('AI_RATE_LIMITED', 'Slow down', { retryAfterMs: scenario.http.retryAfterSeconds * 1000 });
    }

    const role = req.metadata?.agent as TrainingAgentRole | undefined;
    if (!role || !TRAINING_AGENT_ROLES.includes(role)) throw new Error(`Scenario ${name}: request without a known agent role`);

    if (role === 'critic' && !req.structuredOutput) {
      return { outputText: 'Checked volume and substitutes; see the verdict.', usage: DEFAULT_SCENARIO_USAGE, finishReason: 'stop' };
    }

    const specs = scenario.calls[role] ?? [];
    if (specs.length === 0) throw new Error(`Scenario ${name}: no scripted call for ${role}`);
    const index = counters.get(role) ?? 0;
    counters.set(role, index + 1);
    return answerFor(specs[Math.min(index, specs.length - 1)]);
  };
}

/** The harness `scripts` option: every role answers from the scenario. */
export function scenarioScripts(name: string, seen: AiResponseRequest[] = []): Record<TrainingAgentRole, AgentScript> {
  const script = scriptFromScenario(name, seen);
  return Object.fromEntries(TRAINING_AGENT_ROLES.map((role) => [role, script])) as Record<TrainingAgentRole, AgentScript>;
}
