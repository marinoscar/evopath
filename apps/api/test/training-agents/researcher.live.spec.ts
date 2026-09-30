// OPTIONAL live check of the researcher against the real OpenAI API.
//
// Skipped unless OPENAI_API_KEY_FOR_TESTS and OPENAI_MODEL_FOR_TESTS are set: never in CI, and the
// variables are read by this test only, never by the application (keys are
// runtime settings). It decides which research mode works as the default
// for a web-search-capable model and proves the citation guardrail against
// real search results. To run it locally:
//
//   OPENAI_API_KEY_FOR_TESTS=sk-... \
//   OPENAI_MODEL_FOR_TESTS=<web-search-capable model> \
//   npx jest --config ./test/jest.config.js researcher.live
//
// It costs some cents of tokens per run (two goals, high search context).

import { randomUUID } from 'node:crypto';

import { AiProviderRegistry } from '../../src/ai/core/provider-registry';
import type { AiResponseRequest } from '../../src/ai/core/types/responses.types';
import { OpenAiClientFactory } from '../../src/ai/providers/openai/openai-client.factory';
import { OpenAiProviderAdapter } from '../../src/ai/providers/openai/openai.adapter';
import type { AiUserClient } from '../../src/ai/runtime/ai.service';
import type { VerifiedEvidenceBrief } from '../../src/training-agents/agents/researcher/evidence-brief.contract';
import { buildResearcherContext, type ResearcherContextSource } from '../../src/training-agents/agents/researcher/researcher-context';
import type { NodeContext } from '../../src/training-agents/graph/node-context';
import { collectVerifiedUrls } from '../../src/training-agents/guardrails/citations';
import { researchNode } from '../../src/training-agents/nodes/research.node';
import { AgentCaller } from '../../src/training-agents/runtime/agent-caller';
import { ContextBudget } from '../../src/training-agents/runtime/context-budget';
import { RunBudget } from '../../src/training-agents/runtime/run-budget';
import { initialRunState } from '../../src/training-agents/graph/run-state';

const LIVE_KEY = process.env.OPENAI_API_KEY_FOR_TESTS;
const LIVE_MODEL = process.env.OPENAI_MODEL_FOR_TESTS ?? '';

const GOALS: Array<[string, ResearcherContextSource]> = [
  [
    'beginner strength with a knee limitation',
    {
      goal: { type: 'strength', description: 'Get stronger at squats and deadlifts.' },
      experience: 'beginner',
      daysPerWeek: 3,
      minutesPerSession: 60,
      equipmentClass: 'full_gym',
      limitations: [{ area: 'knee', description: 'Mild knee discomfort on deep squats.' }],
      preferences: '',
      tailorResearch: false,
    },
  ],
  [
    'intermediate hypertrophy at home',
    {
      goal: { type: 'hypertrophy', description: 'Build upper body muscle.' },
      experience: 'intermediate',
      daysPerWeek: 4,
      minutesPerSession: 45,
      equipmentClass: 'home_basic',
      limitations: [],
      preferences: 'Dumbbells only.',
      tailorResearch: false,
    },
  ],
];

/**
 * A minimal `AiUserClient` over the real adapter: the gateway's gates are
 * covered by the scripted specs; this check is about the provider's answers.
 */
function liveClient(adapter: OpenAiProviderAdapter, seen: Array<Awaited<ReturnType<AiUserClient['respond']>>>): AiUserClient {
  const call = async (req: AiResponseRequest, signal?: AbortSignal) => {
    const response = await adapter.responses!.create(req, { apiKey: LIVE_KEY!, requestId: `live-${randomUUID()}`, signal });
    seen.push(response);
    return response;
  };
  const strip = <T extends { provider?: string }>(req: T) => {
    const { provider: _provider, ...rest } = req;
    return rest;
  };

  const client: Pick<AiUserClient, 'userId' | 'respond' | 'respondStructured'> = {
    userId: 'live',
    respond: (req, opts) => call(strip(req) as AiResponseRequest, opts?.signal),
    respondStructured: async (req, opts) => {
      const { schema, schemaName, strict, ...rest } = strip(req);
      return call({ ...(rest as AiResponseRequest), structuredOutput: { name: schemaName ?? 'response', schema, strict: strict ?? true } }, opts?.signal) as never;
    },
  };

  return client as AiUserClient;
}

if (LIVE_KEY && LIVE_MODEL) {
  jest.setTimeout(300_000);

  describe('researcher (LIVE)', () => {
    it.each(GOALS)('%s: at least three verified claims, and every source URL was returned by the search', async (_label, source) => {
      const adapter = new OpenAiProviderAdapter(new AiProviderRegistry(), new OpenAiClientFactory());
      const seen: Array<Awaited<ReturnType<AiUserClient['respond']>>> = [];
      const controller = new AbortController();
      const budget = new RunBudget(400_000);
      const roleModels = { researcher: { provider: 'openai', modelId: LIVE_MODEL, effort: null, keySource: 'user' as const } };
      const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
      const ctx: NodeContext = {
        runId: randomUUID(),
        userId: 'live',
        jobId: randomUUID(),
        kind: 'create',
        signal: controller.signal,
        roleModels,
        emit: async (type, data) => void events.push({ type, data }),
        agent: new AgentCaller({ ai: liveClient(adapter, seen), signal: controller.signal, roleModels, budget }),
        budget,
        contextBudget: new ContextBudget(),
        now: () => new Date(),
        interrupt: () => {
          throw new Error('no interrupt');
        },
      };
      const state = {
        ...initialRunState({ runId: ctx.runId, userId: 'live', kind: 'create' }),
        context: { researcher: buildResearcherContext(source) },
      };

      const brief = (await researchNode.run(state, ctx)).brief as VerifiedEvidenceBrief;
      const returned = collectVerifiedUrls(seen);

      // Recorded in the PR: which mode ran, and how much was dropped.
      console.log(`[researcher.live] ${_label}: mode=${brief.researchMode} claims=${brief.claims.length} sources=${brief.sources.length} dropped=${brief.droppedSources}/${brief.droppedClaims}`);
      expect(brief.claims.length).toBeGreaterThanOrEqual(3);
      expect(brief.sources.length).toBeGreaterThanOrEqual(2);
      for (const s of brief.sources) expect(returned.has(s.url)).toBe(true);
      expect(events.map((e) => e.type).at(-1)).toBe('research.brief');
    });
  });
} else {
  describe.skip('researcher (LIVE): set OPENAI_API_KEY_FOR_TESTS and OPENAI_MODEL_FOR_TESTS to run', () => {
    it('is skipped without a key', () => undefined);
  });
}
