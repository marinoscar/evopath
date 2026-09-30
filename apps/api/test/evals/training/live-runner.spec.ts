import { z } from 'zod';

import { AiError } from '../../../src/ai/core/ai-error';
import type { AiResponseRequest } from '../../../src/ai/core/types/responses.types';
import type { AiUserClient } from '../../../src/ai/runtime/ai.service';
import { criticScript, plannerScript } from '../../../src/training-agents/testing/agent-scripts';
import { stubVerdict } from '../../../src/training-agents/testing/stub-agent-nodes';
import { HARNESS_USER } from '../../../src/ai/testing/ai-runtime-harness';
import { createAiRuntimeHarness } from '../../../src/ai/testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES } from '../../../src/ai/testing/fake-ai-provider';
import { synthesizeDraft } from '../support/draft-synth';
import { judgeModelOf, judgePlan } from '../support/judge';
import { backoffMs, createLiveClient, routeByAgent } from '../support/live-client';
import { parseEvalEnv } from './eval-env';
import { errorCodeOf, frozenModels, runLivePersona, runSamples } from './live-runner';
import { loadPersonas } from './personas';

// The live runner, proven offline: a scripted client stands in for the
// provider, so the wiring (frozen models, routing, first-draft capture,
// error recording, samples, judge) is covered without a key or the network.

const personas = loadPersonas();
const persona = (id: string) => personas.find((p) => p.id === id)!;

const ENV = parseEvalEnv({ EVAL_LIVE: '1', EVAL_MODELS: 'planner=openai:gpt-x:high,critic=openai:gpt-y:medium', EVAL_JUDGE: '1' });

/** An AiUserClient answering planner and critic from scripts, through the real fake provider. */
function scriptedLive(planner: ReturnType<typeof plannerScript>, critic: ReturnType<typeof criticScript>, seen: AiResponseRequest[] = []): AiUserClient {
  const runtime = createAiRuntimeHarness({
    models: [{ modelId: 'gpt-x', capabilities: FAKE_TEXT_MODEL_CAPABILITIES }, { modelId: 'gpt-y', capabilities: FAKE_TEXT_MODEL_CAPABILITIES }],
    fake: {
      responses: (req, ctx) => {
        seen.push(req);
        const agent = req.metadata?.agent;
        if (agent === 'planner') return planner(req, ctx);
        if (agent === 'critic') return critic(req, ctx);
        if (agent === 'judge') return { outputText: JSON.stringify({ goalFit: 4, realism: 5, rationaleQuality: 3 }) };
        throw new Error(`unexpected agent ${String(agent)}`);
      },
    },
  });
  return runtime.ai.forUser(HARNESS_USER);
}

describe('runLivePersona', () => {
  it('runs the real graph with EVAL_MODELS for planner and critic, the stored brief for the researcher, and scores both layers', async () => {
    const seen: AiResponseRequest[] = [];
    const live = scriptedLive(plannerScript([synthesizeDraft(persona('knee-pain-intermediate'), 'good')]), criticScript(() => stubVerdict('approve')), seen);

    const result = await runLivePersona(persona('knee-pain-intermediate'), { live, env: ENV });

    expect(result.error).toBeNull();
    expect(result.evaluation!.run.status).toBe('completed');
    expect(result.evaluation!.shipped!.hardFailures).toEqual([]);
    expect(result.evaluation!.raw).not.toBeNull();
    // planner and critic went to the live client with their frozen models; the researcher never did.
    expect(seen.filter((r) => r.metadata?.agent === 'planner').every((r) => r.model === 'gpt-x')).toBe(true);
    expect(seen.filter((r) => r.metadata?.agent === 'critic').every((r) => r.model === 'gpt-y')).toBe(true);
    expect(seen.some((r) => r.metadata?.agent === 'researcher')).toBe(false);
    expect(Object.keys(result.usage).sort()).toEqual(['critic', 'planner', 'researcher']);
    expect(result.judge).toEqual({ goalFit: 4, realism: 5, rationaleQuality: 3 });
  });

  it('records a model that cannot produce strict-mode output as an error with score 0, not a crash', async () => {
    const live = scriptedLive(plannerScript([() => ({ outputText: 'not json at all' })]), criticScript(() => stubVerdict('approve')));

    const result = await runLivePersona(persona('knee-pain-intermediate'), { live, env: ENV });

    expect(result.evaluation).toBeNull();
    expect(result.error).toBe('AI_STRUCTURED_OUTPUT_INVALID');
  });

  it('captures the first planner draft as the raw layer even when the critic asks for a revision', async () => {
    const p = persona('knee-pain-intermediate');
    const live = scriptedLive(plannerScript([synthesizeDraft(p, 'mediocre'), synthesizeDraft(p, 'good')]), criticScript((round) => stubVerdict(round <= 1 ? 'revise' : 'approve')));

    const result = await runLivePersona(p, { live, env: ENV });

    expect(result.evaluation!.run.criticRounds).toBe(2);
    expect(result.evaluation!.raw!.hardFailures.length).toBeGreaterThan(0);
    expect(result.evaluation!.shipped!.hardFailures).toEqual([]);
  });

  it('makes zero model calls for a safety persona', async () => {
    const seen: AiResponseRequest[] = [];
    const live = scriptedLive(plannerScript([]), criticScript(() => stubVerdict('approve')), seen);

    const result = await runLivePersona(persona('urgent-symptom-text'), { live, env: ENV });

    expect(seen).toEqual([]);
    expect(result.evaluation!.run.status).toBe('stopped');
    expect(result.evaluation!.passes).toBe(true);
  });

  it('samples sequentially and reports mean and spread', async () => {
    const p = persona('beginner-bodyweight-only');
    const live = scriptedLive(plannerScript([synthesizeDraft(p, 'good')]), criticScript(() => stubVerdict('approve')));

    const result = await runSamples(p, 3, { live, env: ENV });

    expect(result.results).toHaveLength(3);
    expect(result.shipped.mean).toBeGreaterThan(0.9);
    expect(result.shipped.min).toBeLessThanOrEqual(result.shipped.max);
  });
});

describe('frozenModels and the judge', () => {
  it('freezes the live roles and keeps the stored-brief researcher on the fake model', () => {
    const frozen = frozenModels(ENV);
    expect(frozen.planner).toMatchObject({ provider: 'openai', modelId: 'gpt-x', effort: 'high', keySource: 'user' });
    expect(frozen.critic).toMatchObject({ modelId: 'gpt-y', effort: 'medium' });
    expect(frozen.researcher.modelId).toBe('fake-model');
    expect(frozenModels(parseEvalEnv({ EVAL_MODELS: 'planner=openai:a,critic=openai:b,researcher=openai:c', EVAL_RESEARCH: 'live' })).researcher.modelId).toBe('c');
  });

  it('refuses a judge that is the planner model', () => {
    expect(() => judgeModelOf(parseEvalEnv({ EVAL_MODELS: 'planner=openai:a,critic=openai:a' }).models)).toThrow('must not grade its own plan');
    expect(judgeModelOf(ENV.models).modelId).toBe('gpt-y');
  });

  it('judgePlan returns the three scores from the structured answer', async () => {
    const p = persona('knee-pain-intermediate');
    const live = scriptedLive(plannerScript([]), criticScript(() => stubVerdict('approve')));
    const run = await runLivePersona(p, { live: scriptedLive(plannerScript([synthesizeDraft(p, 'good')]), criticScript(() => stubVerdict('approve'))), env: { ...ENV, judge: false } });

    const scores = await judgePlan(live, ENV.models.critic!, run.evaluation!.run.shipped!, p);

    expect(scores).toEqual({ goalFit: 4, realism: 5, rationaleQuality: 3 });
  });
});

describe('the live client', () => {
  const ok = { outputText: 'hi', output: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' } as never;

  it('retries a throttle with backoff (honouring retryAfter), then answers', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = createLiveClient({
      keys: { openai: 'sk-test-key-value' },
      sleep: async (ms) => void sleeps.push(ms),
      ports: {
        openai: {
          create: async () => {
            calls += 1;
            if (calls === 1) throw new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 2_500 });
            if (calls === 2) throw new AiError('AI_RATE_LIMITED', 'slow down');
            return ok;
          },
        },
      },
    });

    await client.respond({ provider: 'openai', model: 'm', input: 'x' } as never);

    expect(calls).toBe(3);
    expect(sleeps).toEqual([2_500, 2_000]);
  });

  it('gives up after the retries and throws the throttle; other errors are not retried', async () => {
    let calls = 0;
    const throttled = createLiveClient({ keys: { openai: 'sk-test-key-value' }, maxRetries: 2, sleep: async () => undefined, ports: { openai: { create: async () => { calls += 1; throw new AiError('AI_RATE_LIMITED', 'x'); } } } });
    await expect(throttled.respond({ provider: 'openai', model: 'm', input: 'x' } as never)).rejects.toMatchObject({ code: 'AI_RATE_LIMITED' });
    expect(calls).toBe(3);

    calls = 0;
    const broken = createLiveClient({ keys: { openai: 'sk-test-key-value' }, ports: { openai: { create: async () => { calls += 1; throw new AiError('AI_INVALID_REQUEST', 'x'); } } } });
    await expect(broken.respond({ provider: 'openai', model: 'm', input: 'x' } as never)).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
    expect(calls).toBe(1);
  });

  it('passes the key to the adapter call only, and refuses a provider without a key', async () => {
    const seenContexts: Array<Record<string, unknown>> = [];
    const client = createLiveClient({ keys: { openai: 'sk-test-key-value' }, ports: { openai: { create: async (_req, ctx) => { seenContexts.push({ ...ctx }); return ok; } } } });

    await client.respond({ provider: 'openai', model: 'm', input: 'x' } as never);
    expect(seenContexts[0].apiKey).toBe('sk-test-key-value');

    await expect(client.respond({ provider: 'anthropic', model: 'm', input: 'x' } as never)).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
    await expect(client.respond({ provider: 'anthropic', model: 'm', input: 'x' } as never)).rejects.toThrow(/^(?!.*sk-test-key-value)/);
  });

  it('validates a structured answer the adapter left unparsed and raises AI_STRUCTURED_OUTPUT_INVALID on bad JSON', async () => {
    const client = createLiveClient({ keys: { openai: 'sk-test-key-value' }, ports: { openai: { create: async () => ({ ...(ok as object), outputText: '{"a":1}' }) as never } } });
    const good = await client.respondStructured({ provider: 'openai', model: 'm', input: 'x', schema: z.object({ a: z.number() }), schemaName: 's' } as never);
    expect(good.parsed).toEqual({ a: 1 });

    const bad = createLiveClient({ keys: { openai: 'sk-test-key-value' }, ports: { openai: { create: async () => ({ ...(ok as object), outputText: 'nope' }) as never } } });
    await expect(bad.respondStructured({ provider: 'openai', model: 'm', input: 'x', schema: z.object({ a: z.number() }), schemaName: 's' } as never)).rejects.toMatchObject({ code: 'AI_STRUCTURED_OUTPUT_INVALID' });
  });

  it('backoff doubles from one second to a 30 second ceiling and prefers the hint', () => {
    expect([0, 1, 2, 3, 10].map((n) => backoffMs(n))).toEqual([1_000, 2_000, 4_000, 8_000, 30_000]);
    expect(backoffMs(0, 7_000)).toBe(7_000);
    expect(backoffMs(0, 90_000)).toBe(30_000);
  });

  it('routes by agent', async () => {
    const a = { userId: 'a', respond: async () => 'a' } as unknown as AiUserClient;
    const b = { userId: 'b', respond: async () => 'b' } as unknown as AiUserClient;
    const routed = routeByAgent(a, b, (agent) => agent === 'researcher');

    expect(await routed.respond({ metadata: { agent: 'researcher' } } as never)).toBe('b');
    expect(await routed.respond({ metadata: { agent: 'planner' } } as never)).toBe('a');
  });

  it('errorCodeOf reads an AiError code, another code, or falls back', () => {
    expect(errorCodeOf(new AiError('AI_RATE_LIMITED', 'x'))).toBe('AI_RATE_LIMITED');
    expect(errorCodeOf({ code: 'TRAINING_OUTPUT_TRUNCATED' })).toBe('TRAINING_OUTPUT_TRUNCATED');
    expect(errorCodeOf(new Error('x'))).toBe('TRAINING_RUN_FAILED');
  });
});
