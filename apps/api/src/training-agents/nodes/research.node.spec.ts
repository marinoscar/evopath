import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AiError } from '../../ai/core/ai-error';
import type { AiOutputItem, AiResponseRequest } from '../../ai/core/types/responses.types';
import { HARNESS_MODEL } from '../../ai/testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES, type FakeAiScriptedResponse } from '../../ai/testing/fake-ai-provider';
import {
  verifiedEvidenceBriefSchema,
  type EvidenceBrief,
  type VerifiedEvidenceBrief,
} from '../agents/researcher/evidence-brief.contract';
import { buildResearcherContext, type ResearcherContextSource } from '../agents/researcher/researcher-context';
import { RESEARCH_INSUFFICIENT_MESSAGE } from '../agents/researcher/researcher.agent';
import {
  RESEARCH_RETRY_NUDGE,
  RESEARCH_TRUNCATION_NUDGE,
  RESEARCHER_INSTRUCTIONS,
} from '../agents/researcher/researcher.prompt';
import { SAFETY_BLOCK, UNTRUSTED_DATA_BLOCK } from '../agents/shared/prompt-blocks';
import { RunDeferredError } from '../runtime/agent-caller';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import {
  createNodeContextHarness,
  HARNESS_FROZEN_MODEL,
  type AgentScript,
  type NodeContextHarnessOptions,
} from '../testing/node-context-harness';
import { STUB_AGENT_NODES } from '../testing/stub-agent-nodes';
import { researchNode } from './research.node';

// =============================================================================
// The research node over the real AgentCaller and AiService, the scripted fake
// provider with hosted web search, and the reference fixtures in
// `test/fixtures/training/research/`.
// =============================================================================

interface ResearchFixture {
  description: string;
  queries: string[];
  searchSources: string[];
  citations: string[];
  brief?: EvidenceBrief;
  rawText?: string;
  finishReason?: 'stop' | 'length';
}

const FIXTURES = join(__dirname, '../../../test/fixtures/training/research');

function fixture(name: string): ResearchFixture {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as ResearchFixture;
}

/** What the provider answers for a fixture: the search call item and the message (with citations). */
function answer(f: ResearchFixture): FakeAiScriptedResponse {
  const text = f.rawText ?? JSON.stringify(f.brief);
  const output: AiOutputItem[] = [
    {
      type: 'hosted_tool_call',
      tool: 'web_search',
      status: 'completed',
      result: { queries: f.queries, sources: f.searchSources.map((url) => ({ url })) },
    },
    {
      type: 'message',
      text,
      citations: f.citations.map((url) => ({ url, title: 'cited', startIndex: 0, endIndex: 1 })),
    },
  ];

  return { output, usage: { inputTokens: 100, outputTokens: 50 }, finishReason: f.finishReason ?? 'stop' };
}

/** A script answering calls in order from `answers`; records each request. */
function sequence(answers: Array<FakeAiScriptedResponse | (() => FakeAiScriptedResponse)>, seen: AiResponseRequest[] = []) {
  let i = 0;
  const script: AgentScript = (req) => {
    seen.push(req);
    const next = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return typeof next === 'function' ? next() : next;
  };
  return { script, seen };
}

// Canary values: none of these may ever reach the provider.
const CANARY = {
  name: 'Zebulon Canaryfield',
  email: 'zebulon.canary@example.test',
  dateOfBirth: '1978-02-14',
  weightKg: 93.7,
  medications: 'canarymycin',
  labs: 'ferritin-canary',
  bio: 'canary-bio-text',
  gymName: 'Canary Iron Works',
  gymLocation: 'Canary Street 9',
  checkInNote: 'canary-checkin-note',
  storageKey: 'users/canary/photo.jpg',
};

const SOURCE: ResearcherContextSource & Record<string, unknown> = {
  ...CANARY,
  goal: { type: 'strength', description: 'Squat my bodyweight by summer.' },
  experience: 'beginner',
  daysPerWeek: 3,
  minutesPerSession: 60,
  equipmentClass: 'full_gym',
  limitations: [{ area: 'knee', description: 'Left knee aches on deep squats.' }],
  preferences: 'I like barbell work.',
  tailorResearch: true,
  ageYears: 47,
  sexAtBirth: 'female',
};

const CONTEXT = buildResearcherContext(SOURCE);

function harness(researcher: AgentScript, opts: Omit<NodeContextHarnessOptions, 'scripts'> = {}) {
  return createNodeContextHarness({ ...opts, scripts: { researcher } });
}

const stateWithContext = { context: { researcher: CONTEXT, planner: { bio: CANARY.bio } }, input: { ...CANARY } };

function events(h: ReturnType<typeof createNodeContextHarness>) {
  return (h.events.events.get(h.runId) ?? []).filter((e) => e.type.startsWith('research.'));
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the node to fail');
}

describe('research node', () => {
  it('is implemented and replaces the stub', () => {
    expect(researchNode).toMatchObject({ name: 'research', implemented: true });
  });

  it('valid fixture: returns a verified brief from the search result, and emits query, source and brief events in order', async () => {
    const { script, seen } = sequence([answer(fixture('valid'))]);
    const h = harness(script);

    const update = await h.runNode(researchNode.run, stateWithContext);
    const brief = update.brief as VerifiedEvidenceBrief;

    expect(verifiedEvidenceBriefSchema.safeParse(brief).success).toBe(true);
    expect(brief.searchQueries).toEqual(fixture('valid').queries);
    expect(brief.sources.every((s) => s.verified === true)).toBe(true);
    expect(brief.sources.map((s) => s.id)).toEqual(['S1', 'S2', 'S3']);
    expect(brief.sources[0].url).not.toContain('utm_');
    expect(brief).toMatchObject({ researchMode: 'single', droppedClaims: 0, droppedSources: 0 });
    expect(brief.claims).toHaveLength(4);
    expect(seen).toHaveLength(1);

    expect(events(h).map((e) => e.type)).toEqual([
      'research.query',
      'research.source',
      'research.source',
      'research.source',
      'research.brief',
    ]);
    expect(events(h)[0].data).toEqual({ queries: fixture('valid').queries });
    expect(events(h)[1].data).toMatchObject({ id: 'S1', domain: 'acsm.org', kind: 'position_stand', verified: true });
    expect(events(h)[4].data).toEqual({ claimCount: 4, sourceCount: 3, droppedClaims: 0, droppedSources: 0, researchMode: 'single' });
  });

  it('sends the hosted web_search tool, the frozen model and effort, researcher metadata, and no userLocation', async () => {
    const { script, seen } = sequence([answer(fixture('valid'))]);
    const h = harness(script);

    await h.runNode(researchNode.run, stateWithContext);

    const req = seen[0];
    expect(req.tools).toEqual([{ type: 'web_search', searchContextSize: 'high' }]);
    expect(JSON.stringify(req.tools)).not.toContain('userLocation');
    expect(req.metadata).toMatchObject({ agent: 'researcher', node: 'research' });
    expect(req.model).toBe(HARNESS_MODEL);
    expect(req.reasoning).toEqual({ effort: 'medium' });
    expect(req.structuredOutput?.name).toBe('evidence_brief');
    expect(req.instructions).toBe(RESEARCHER_INSTRUCTIONS);
    expect(req.instructions).toContain(UNTRUSTED_DATA_BLOCK);
    expect(req.instructions).toContain(SAFETY_BLOCK);
    expect(req.input).toContain('<context>');
  });

  it('data minimisation canary: no name, email, date of birth, exact age, body, labs, medications, bio, gym or check-in data reaches the provider', async () => {
    const { script } = sequence([answer(fixture('valid'))]);
    const h = harness(script);

    await h.runNode(researchNode.run, stateWithContext);

    const sent = JSON.stringify(h.runtime.fake.calls.map((call) => call.request));
    for (const value of Object.values(CANARY)) {
      expect(sent).not.toContain(String(value));
    }
    const input = String(h.runtime.fake.calls[0].request?.input);
    expect(input).not.toContain('ageYears');
    expect(input).not.toMatch(/\b47\b/);
    expect(input).toContain('40-49');
    expect(sent).toContain('Squat my bodyweight by summer.');
  });

  it.each([
    ['fabricated-url', 1, 1],
    ['denylisted-domain', 1, 1],
  ])('%s fixture: the source and the claims that depended only on it are dropped and counted', async (name, droppedSources, droppedClaims) => {
    const f = fixture(name);
    const { script } = sequence([answer(f)]);
    const h = harness(script);

    const brief = (await h.runNode(researchNode.run, stateWithContext)).brief as VerifiedEvidenceBrief;

    expect(brief.droppedSources).toBe(droppedSources);
    expect(brief.droppedClaims).toBe(droppedClaims);
    const dropped = f.brief!.sources[3].url;
    expect(JSON.stringify(brief)).not.toContain(new URL(dropped).hostname);
    expect(JSON.stringify(events(h))).not.toContain(new URL(dropped).hostname);
    expect(events(h).at(-1)?.data).toMatchObject({ droppedSources, droppedClaims });
  });

  it('unsupported-claim fixture: a real source on an unsupported claim cannot be detected here and keeps its low confidence', async () => {
    const { script } = sequence([answer(fixture('unsupported-claim'))]);
    const h = harness(script);

    const brief = (await h.runNode(researchNode.run, stateWithContext)).brief as VerifiedEvidenceBrief;

    expect(brief.claims).toHaveLength(5);
    expect(brief.claims[4]).toMatchObject({ confidence: 'low', sourceIds: ['S2'] });
  });

  it('page-injection fixture: output still validates, no instruction text in any event, no unverified URL survives', async () => {
    const { script } = sequence([answer(fixture('page-injection'))]);
    const h = harness(script);

    const brief = (await h.runNode(researchNode.run, stateWithContext)).brief as VerifiedEvidenceBrief;

    expect(verifiedEvidenceBriefSchema.safeParse(brief).success).toBe(true);
    const stored = JSON.stringify(brief);
    expect(stored).not.toContain('attacker.example.net');
    expect(stored).not.toMatch(/<script|<img/i);

    const emitted = JSON.stringify(events(h));
    expect(emitted.toLowerCase()).not.toContain('ignore your rules');
    expect(emitted).not.toContain('attacker.example.net');
    for (const line of [...RESEARCHER_INSTRUCTIONS.split('\n')].filter((l) => l.trim().length > 20)) {
      expect(emitted).not.toContain(line.trim());
    }
    const all = JSON.stringify(h.events.events.get(h.runId));
    expect(all).not.toContain('RULES');
  });

  it('insufficient fixture: exactly one retry with the nudge, then TRAINING_RESEARCH_INSUFFICIENT', async () => {
    const { script, seen } = sequence([answer(fixture('insufficient'))]);
    const h = harness(script);

    const err = await failure(h.runNode(researchNode.run, stateWithContext));

    expect(err).toBeInstanceOf(TrainingRunFailedError);
    expect(err).toMatchObject({ code: 'TRAINING_RESEARCH_INSUFFICIENT', message: RESEARCH_INSUFFICIENT_MESSAGE });
    expect(seen).toHaveLength(2);
    expect(seen[0].input).not.toContain(RESEARCH_RETRY_NUDGE);
    expect(seen[1].input).toContain(RESEARCH_RETRY_NUDGE);
    expect(h.usage).toHaveLength(2);
    expect(events(h)).toHaveLength(0);
  });

  it('a retry that finds enough sources succeeds', async () => {
    const { script, seen } = sequence([answer(fixture('insufficient')), answer(fixture('valid'))]);
    const h = harness(script);

    const brief = (await h.runNode(researchNode.run, stateWithContext)).brief as VerifiedEvidenceBrief;

    expect(seen).toHaveLength(2);
    expect(brief.sources).toHaveLength(3);
    // Queries from both searches, never from model text.
    expect(brief.searchQueries).toEqual(['beginner strength training', ...fixture('valid').queries]);
  });

  it('truncated fixture: a cut-off structured answer falls back to two-step; cut off again on the retry fails insufficient', async () => {
    const { script, seen } = sequence([answer(fixture('truncated'))]);
    const h = harness(script);

    const err = await failure(h.runNode(researchNode.run, stateWithContext));

    expect(err).toMatchObject({ code: 'TRAINING_RESEARCH_INSUFFICIENT' });
    // single (cut off, invalid) -> two-step search (cut off) -> retry: two-step search (cut off).
    expect(seen).toHaveLength(3);
    expect(seen[1].structuredOutput).toBeUndefined();
    expect(seen[2].tools).toEqual([{ type: 'web_search', searchContextSize: 'medium' }]);
    expect(seen[2].input).toContain(RESEARCH_TRUNCATION_NUDGE);
    expect(events(h)).toHaveLength(0);
  });

  it('a truncated search is retried once with a medium search context and the compact nudge', async () => {
    const valid = fixture('valid');
    const truncatedNotes: FakeAiScriptedResponse = { ...answer({ ...valid, rawText: 'Notes: train tw' }), finishReason: 'length' };
    const notes = answer({ ...valid, rawText: 'Notes: train twice weekly.' });
    const shaped: FakeAiScriptedResponse = { outputText: JSON.stringify(valid.brief) };
    const { script, seen } = sequence([{ outputText: 'not json' }, truncatedNotes, notes, shaped]);

    const brief = (await harness(script).runNode(researchNode.run, stateWithContext)).brief as VerifiedEvidenceBrief;

    expect(seen).toHaveLength(4);
    expect(seen[2].tools).toEqual([{ type: 'web_search', searchContextSize: 'medium' }]);
    expect(seen[2].input).toContain(RESEARCH_TRUNCATION_NUDGE);
    expect(brief).toMatchObject({ researchMode: 'two_step' });
    expect(brief.claims).toHaveLength(4);
  });

  it('two-step fallback: an invalid structured answer switches to search notes then a tool-less shaping call', async () => {
    const valid = fixture('valid');
    const notes: FakeAiScriptedResponse = {
      ...answer({ ...valid, rawText: 'Notes: train twice weekly (acsm.org).' }),
    };
    const shaped: FakeAiScriptedResponse = { outputText: JSON.stringify(valid.brief), usage: { inputTokens: 10, outputTokens: 10 } };
    const { script, seen } = sequence([{ outputText: 'not json' }, notes, shaped]);
    const h = harness(script);

    const brief = (await h.runNode(researchNode.run, stateWithContext)).brief as VerifiedEvidenceBrief;

    expect(seen).toHaveLength(3);
    expect(seen[1].structuredOutput).toBeUndefined();
    expect(seen[1].tools).toEqual([{ type: 'web_search', searchContextSize: 'high' }]);
    expect(seen[2].tools).toBeUndefined();
    expect(seen[2].structuredOutput?.name).toBe('evidence_brief');
    expect(seen[2].input).toContain('<evidence>');
    expect(brief.researchMode).toBe('two_step');
    expect(brief.sources.every((s) => s.verified)).toBe(true);
    expect(events(h).at(-1)?.data).toMatchObject({ researchMode: 'two_step' });
  });

  it('a researcher frozen on a non-OpenAI provider fails TRAINING_ROLE_UNAVAILABLE before any provider call', async () => {
    const { script } = sequence([answer(fixture('valid'))]);
    const h = harness(script, { roleModels: { researcher: { ...HARNESS_FROZEN_MODEL, provider: 'anthropic' } } });

    const err = await failure(h.runNode(researchNode.run, stateWithContext));

    expect(err).toMatchObject({ code: 'TRAINING_ROLE_UNAVAILABLE', details: { role: 'researcher', state: 'missing_capability' } });
    expect(h.runtime.fake.calls).toHaveLength(0);
  });

  it('a run with no frozen researcher fails TRAINING_ROLE_UNAVAILABLE before any provider call', async () => {
    const { script } = sequence([answer(fixture('valid'))]);
    const h = harness(script, { roleModels: { planner: HARNESS_FROZEN_MODEL } });

    await expect(h.runNode(researchNode.run, stateWithContext)).rejects.toMatchObject({ code: 'TRAINING_ROLE_UNAVAILABLE' });
    expect(h.runtime.fake.calls).toHaveLength(0);
  });

  it('a model without hosted_tools is refused by the platform (AI_CAPABILITY_UNSUPPORTED) before any provider call', async () => {
    const { script } = sequence([answer(fixture('valid'))]);
    const h = harness(script, {
      runtime: {
        models: [{ modelId: HARNESS_MODEL, capabilities: FAKE_TEXT_MODEL_CAPABILITIES }],
        policy: { hostedTools: { web_search: true } },
      },
    });

    const err = await failure(h.runNode(researchNode.run, stateWithContext));

    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(h.runtime.fake.calls).toHaveLength(0);
  });

  it('web search switched off by the administrator: AI_TOOL_DISABLED and zero provider calls', async () => {
    const { script } = sequence([answer(fixture('valid'))]);
    const h = harness(script, { runtime: { policy: { hostedTools: { web_search: false } } } });

    const err = await failure(h.runNode(researchNode.run, stateWithContext));

    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe('AI_TOOL_DISABLED');
    expect(h.runtime.fake.calls).toHaveLength(0);
  });

  it('a missing researcher context fails before any provider call', async () => {
    const { script } = sequence([answer(fixture('valid'))]);
    const h = harness(script);

    await expect(h.runNode(researchNode.run, { context: { stub: true } })).rejects.toMatchObject({
      code: 'TRAINING_RESEARCH_CONTEXT_MISSING',
    });
    expect(h.runtime.fake.calls).toHaveLength(0);
  });

  it('a provider throttle defers the run', async () => {
    const h = harness(() => {
      throw new AiError('AI_RATE_LIMITED', 'Slow down', { retryAfterMs: 1000 });
    });

    await expect(h.runNode(researchNode.run, stateWithContext)).rejects.toBeInstanceOf(RunDeferredError);
  });

  it('an abort mid-call leaves a resumable checkpoint: a fresh runner re-runs research and continues', async () => {
    const prepare = async () => ({ context: { researcher: CONTEXT } });
    let block = true;
    const blocking: AgentScript = (_req, ctx) =>
      new Promise((resolve, reject) => {
        if (!block) return resolve(answer(fixture('valid')));
        ctx.signal?.addEventListener('abort', () => reject(ctx.signal?.reason), { once: true });
      });
    const h = harness(blocking);

    const running = h.runGraph({ input: {}, nodes: { prepare_context: prepare } });
    await waitFor(() => h.runtime.fake.calls.length > 0);
    h.abort();
    await expect(running).rejects.toBeDefined();

    block = false;
    const resumed = createNodeContextHarness({ kind: 'create', runId: h.runId, scripts: { researcher: blocking } });
    const result = await resumed.runGraph({ checkpointer: h.saver, nodes: { prepare_context: prepare } });

    const stages = (resumed.events.events.get(resumed.runId) ?? []).filter((e) => e.type === 'stage.started').map((e) => e.data.node);
    expect(stages[0]).toBe('research');
    expect((result.state.brief as VerifiedEvidenceBrief).sources).toHaveLength(3);
    expect(result.state.outcome?.status).toBe('completed');
    expect(Object.keys(STUB_AGENT_NODES)).toContain('research');
  });
});

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
