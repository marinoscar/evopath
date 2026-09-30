import { z } from 'zod';

import { AiError } from '../../ai/core/ai-error';
import { defineTool } from '../../ai/core/tools';
import { HARNESS_MODEL, HARNESS_PROVIDER } from '../../ai/testing/ai-runtime-harness';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { createNodeContextHarness, HARNESS_FROZEN_MODEL } from '../testing/node-context-harness';
import { AgentOutputTruncated, RunDeferredError } from './agent-caller';
import { RunBudgetExceededError } from './run-budget';

const draftSchema = z.object({ title: z.string() });
const DRAFT = { title: 'Week 1' };
const USAGE = { inputTokens: 100, outputTokens: 40, reasoningTokens: 10 };

const call = (overrides: Record<string, unknown> = {}) => ({
  role: 'planner' as const,
  node: 'plan',
  round: 1,
  schema: draftSchema,
  schemaName: 'plan_draft',
  instructions: 'SECRET-INSTRUCTIONS-CANARY',
  input: 'SECRET-INPUT-CANARY',
  ...overrides,
});

describe('AgentCaller.structured', () => {
  it('builds the request from the frozen model: provider, model, effort, metadata and the clamp', async () => {
    const h = createNodeContextHarness({
      scripts: { planner: () => ({ outputText: JSON.stringify(DRAFT), usage: USAGE }) },
    });

    const { parsed } = await h.context.agent.structured(call({ maxOutputTokens: 500 }));

    expect(parsed).toEqual(DRAFT);
    const request = h.runtime.fake.calls[0].request!;
    expect(request).toMatchObject({
      model: HARNESS_MODEL,
      reasoning: { effort: 'medium' },
      metadata: { agent: 'planner', node: 'plan', round: '1' },
      maxOutputTokens: 500,
      instructions: 'SECRET-INSTRUCTIONS-CANARY',
    });
    expect(h.runtime.fake.calls[0].request?.structuredOutput?.name).toBe('plan_draft');
  });

  it('clamps maxOutputTokens to the model maximum and to the budget left', async () => {
    const h = createNodeContextHarness({
      tokenCap: 20_000,
      scripts: { planner: () => ({ outputText: JSON.stringify(DRAFT), usage: { inputTokens: 19_000 } }) },
    });

    await h.context.agent.structured(call());
    await h.context.agent.structured(call());

    expect(h.runtime.fake.calls[0].request?.maxOutputTokens).toBe(HARNESS_FROZEN_MODEL.maxOutputTokens);
    expect(h.runtime.fake.calls[1].request?.maxOutputTokens).toBe(1_000);
  });

  it('sends no reasoning for a model frozen without an effort, and appends hosted tools', async () => {
    const h = createNodeContextHarness({
      roleModels: { researcher: { ...HARNESS_FROZEN_MODEL, effort: null } },
      scripts: { researcher: () => ({ outputText: JSON.stringify(DRAFT) }) },
    });

    await h.context.agent.structured(call({ role: 'researcher', node: 'research', hostedTools: [{ type: 'web_search' }] }));

    const request = h.runtime.fake.calls[0].request!;
    expect(request.reasoning).toBeUndefined();
    expect(request.tools).toEqual([{ type: 'web_search' }]);
  });

  it('charges usage to the budget by role and node, reports identifiers and counts only, and tags usage rows with the job', async () => {
    const h = createNodeContextHarness({
      scripts: {
        planner: () => ({ outputText: JSON.stringify(DRAFT), usage: USAGE }),
        critic: () => ({ outputText: JSON.stringify(DRAFT), usage: { inputTokens: 5, outputTokens: 5 } }),
      },
    });

    await h.context.agent.structured(call());
    await h.context.agent.structured(call({ role: 'critic', node: 'critique' }));
    await h.context.agent.structured(call());

    expect(h.budget.snapshot().byRole).toEqual({
      planner: { calls: 2, inputTokens: 200, outputTokens: 80, reasoningTokens: 20 },
      critic: { calls: 1, inputTokens: 5, outputTokens: 5, reasoningTokens: 0 },
    });
    expect(h.budget.used).toBe(310);
    expect(h.usage.map((u) => [u.role, u.node, u.provider, u.model])).toEqual([
      ['planner', 'plan', HARNESS_PROVIDER, HARNESS_MODEL],
      ['critic', 'critique', HARNESS_PROVIDER, HARNESS_MODEL],
      ['planner', 'plan', HARNESS_PROVIDER, HARNESS_MODEL],
    ]);
    expect(h.runtime.usageEvents).toHaveLength(3);
    expect(h.runtime.usageEvents.every((row) => row.jobId === h.jobId)).toBe(true);

    // The agent.usage events carry no prompt text or model output.
    const serialized = JSON.stringify([...(h.events.events.get(h.runId) ?? []), h.usage]);
    expect(h.events.types(h.runId)).toEqual(['agent.usage', 'agent.usage', 'agent.usage']);
    expect(serialized).not.toContain('CANARY');
    expect(serialized).not.toContain('Week 1');
  });

  it('throws AgentOutputTruncated on finishReason length, after charging the call', async () => {
    const h = createNodeContextHarness({
      scripts: { planner: () => ({ outputText: JSON.stringify(DRAFT), usage: USAGE, finishReason: 'length' }) },
    });

    await expect(h.context.agent.structured(call({ maxOutputTokens: 300 }))).rejects.toBeInstanceOf(AgentOutputTruncated);
    expect(h.budget.used).toBe(150);
  });

  it('maps a provider throttle to RunDeferredError carrying the queue signal', async () => {
    const h = createNodeContextHarness({
      scripts: {
        planner: () => {
          throw new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 7_000 });
        },
      },
    });

    const error = await h.context.agent.structured(call()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunDeferredError);
    expect((error as RunDeferredError).retryAfterMs).toBe(7_000);
    expect((error as RunDeferredError).toRateLimitError()).toBeInstanceOf(RateLimitError);
  });

  it('lets any other AI error propagate unchanged (the handler maps terminal codes)', async () => {
    const h = createNodeContextHarness({
      roleModels: { planner: { ...HARNESS_FROZEN_MODEL, modelId: 'not-in-catalog' } },
      scripts: { planner: () => ({ outputText: '{}' }) },
    });

    const error = await h.context.agent.structured(call()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).not.toBe('AI_RATE_LIMITED');
    expect(h.runtime.fake.calls).toHaveLength(0);
  });

  it('refuses before any provider call once the budget is spent', async () => {
    const h = createNodeContextHarness({
      tokenCap: 100,
      scripts: { planner: () => ({ outputText: JSON.stringify(DRAFT), usage: { inputTokens: 150 } }) },
    });

    await h.context.agent.structured(call());
    await expect(h.context.agent.structured(call())).rejects.toBeInstanceOf(RunBudgetExceededError);
    expect(h.runtime.fake.calls).toHaveLength(1);
  });

  it('refuses before any provider call once the run is aborted, and aborts an in-flight call', async () => {
    const h = createNodeContextHarness({
      runtime: { fake: { delayMs: 30_000 } },
      scripts: { planner: () => ({ outputText: JSON.stringify(DRAFT) }) },
    });

    const inFlight = h.context.agent.structured(call()).catch((e: unknown) => e);
    await waitFor(() => h.runtime.fake.calls.length === 1);
    h.abort(new Error('cancelled'));

    expect(await inFlight).toBeInstanceOf(Error);
    expect(h.runtime.fake.calls[0].aborted).toBe(true);
    await expect(h.context.agent.structured(call())).rejects.toThrow('cancelled');
    expect(h.runtime.fake.calls).toHaveLength(1);
  });

  it('refuses a role the run froze no model for', async () => {
    const h = createNodeContextHarness({ roleModels: {}, scripts: {} });

    await expect(h.context.agent.structured(call())).rejects.toMatchObject({
      code: 'AI_INVALID_REQUEST',
    });
    expect(h.runtime.fake.calls).toHaveLength(0);
  });
});

describe('AgentCaller.withTools', () => {
  it('charges every round-trip of the loop as it happens', async () => {
    let step = 0;
    const h = createNodeContextHarness({
      scripts: {
        critic: () => {
          step += 1;
          return step === 1
            ? {
                output: [{ type: 'function_call', callId: 'c1', name: 'lookup', arguments: '{"q":"x"}' }],
                usage: { inputTokens: 10, outputTokens: 2 },
              }
            : { outputText: 'done', usage: { inputTokens: 20, outputTokens: 3 } };
        },
      },
    });
    const lookup = defineTool({
      name: 'lookup',
      description: 'Looks something up',
      parameters: z.object({ q: z.string() }),
      execute: async () => ({ ok: true }),
    });

    const result = await h.context.agent.withTools({
      role: 'critic',
      node: 'critique',
      instructions: 'i',
      input: 'x',
      tools: [lookup],
      maxSteps: 4,
    });

    expect(result.stopReason).toBe('completed');
    expect(h.budget.snapshot().byRole.critic).toEqual({ calls: 2, inputTokens: 30, outputTokens: 5, reasoningTokens: 0 });
    expect(h.usage.map((u) => u.step)).toEqual([1, 2]);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('AgentCaller.respond', () => {
  it('sends free text with hosted tools from the frozen model, charges it, and throws AgentOutputTruncated on length', async () => {
    let finishReason: 'stop' | 'length' = 'stop';
    const h = createNodeContextHarness({
      scripts: { researcher: () => ({ outputText: 'notes', usage: USAGE, finishReason }) },
    });
    const textCall = {
      role: 'researcher' as const,
      node: 'research',
      instructions: 'SECRET-INSTRUCTIONS-CANARY',
      input: 'SECRET-INPUT-CANARY',
      hostedTools: [{ type: 'web_search' as const }],
    };

    const response = await h.context.agent.respond(textCall);

    expect(response.outputText).toBe('notes');
    expect(h.runtime.fake.calls[0].request).toMatchObject({
      model: HARNESS_MODEL,
      reasoning: { effort: 'medium' },
      metadata: { agent: 'researcher', node: 'research' },
      tools: [{ type: 'web_search' }],
    });
    expect(h.runtime.fake.calls[0].request?.structuredOutput).toBeUndefined();
    expect(h.budget.used).toBe(150);

    finishReason = 'length';
    await expect(h.context.agent.respond(textCall)).rejects.toBeInstanceOf(AgentOutputTruncated);
    expect(h.budget.used).toBe(300);
  });
});
