// =============================================================================
// runTools — the function-calling agent loop (issue #432)
// =============================================================================

import { z } from 'zod';

import { AiError } from '../core/ai-error';
import { defineTool } from '../core/tools';
import { AI_PROVIDER_STATE, type AiInputItem, type AiResponseRequest } from '../core/types/responses.types';
import { createAiRuntimeHarness, HARNESS_MODEL, HARNESS_USER } from '../testing/ai-runtime-harness';
import type { FakeAiScriptedResponse } from '../testing/fake-ai-provider';
import type { AiToolStep } from './ai-runtime.types';

const call = (callId: string, name: string, args: unknown): FakeAiScriptedResponse => ({
  output: [
    {
      type: 'function_call',
      callId,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  ],
});

function outputsOf(req: AiResponseRequest | undefined): Extract<AiInputItem, { type: 'function_call_output' }>[] {
  if (!req || typeof req.input === 'string') return [];
  return req.input.filter(
    (item): item is Extract<AiInputItem, { type: 'function_call_output' }> => item.type === 'function_call_output',
  );
}

const lookupCity = defineTool({
  name: 'lookup_city',
  description: 'Find the city a person lives in.',
  parameters: z.object({ person: z.string() }),
  execute: ({ person }, ctx) => ({ person, city: 'Lima', askedBy: ctx.userId }),
});

const weather = defineTool({
  name: 'weather',
  description: 'Current weather for a city.',
  parameters: z.object({ city: z.string() }),
  execute: ({ city }) => `${city}: 22C, sunny`,
});

describe('runTools', () => {
  it('executes a two-step tool chain, chaining each round with previousResponseId', async () => {
    const h = createAiRuntimeHarness({
      fake: {
        responses: [
          call('c1', 'lookup_city', { person: 'Ana' }),
          call('c2', 'weather', { city: 'Lima' }),
          { outputText: 'Ana is in Lima, where it is 22C and sunny.' },
        ],
      },
    });
    const seen: AiToolStep[] = [];

    const result = await h.ai.forUser(HARNESS_USER).runTools({
      model: HARNESS_MODEL,
      input: "What's the weather where Ana lives?",
      tools: [lookupCity, weather],
      onStep: (step) => seen.push(step),
    });

    expect(result.stopReason).toBe('completed');
    expect(result.final.outputText).toBe('Ana is in Lima, where it is 22C and sunny.');
    expect(result.steps).toHaveLength(3);
    expect(seen).toEqual(result.steps);
    expect(result.steps[0].calls).toEqual([
      expect.objectContaining({ callId: 'c1', name: 'lookup_city', status: 'ok' }),
    ]);
    expect(JSON.parse(result.steps[0].calls[0].output)).toEqual({
      person: 'Ana',
      city: 'Lima',
      askedBy: HARNESS_USER,
    });
    expect(result.steps[1].calls[0]).toMatchObject({ status: 'ok', output: 'Lima: 22C, sunny' });

    const requests = h.fake.callsTo('responses.create').map((c) => c.request);
    expect(requests).toHaveLength(3);
    expect(requests[0]?.previousResponseId).toBeUndefined();
    expect(requests[1]?.previousResponseId).toBe(result.steps[0].response.id);
    expect(requests[2]?.previousResponseId).toBe(result.steps[1].response.id);
    expect(outputsOf(requests[2])).toEqual([
      { type: 'function_call_output', callId: 'c2', output: 'Lima: 22C, sunny' },
    ]);
    // The tools are declared to the provider on every round.
    for (const req of requests) {
      expect(req?.tools?.map((t) => (t.type === 'function' ? t.name : t.type))).toEqual(['lookup_city', 'weather']);
    }
  });

  it('records exactly one usage row per provider round-trip', async () => {
    const h = createAiRuntimeHarness({
      fake: { responses: [call('c1', 'weather', { city: 'Quito' }), { outputText: 'done' }] },
    });

    await h.ai.forUser(HARNESS_USER).runTools({ model: HARNESS_MODEL, input: 'x', tools: [weather] });

    expect(h.usageEvents).toHaveLength(2);
    expect(h.usageEvents.every((e) => e.status === 'succeeded' && e.keySource === 'user')).toBe(true);
  });

  it('feeds invalid arguments back to the model instead of throwing', async () => {
    const execute = jest.fn();
    const strictTool = defineTool({
      name: 'weather',
      description: 'w',
      parameters: z.object({ city: z.string() }),
      execute,
    });
    const h = createAiRuntimeHarness({
      fake: {
        responses: [call('c1', 'weather', { town: 'Lima' }), call('c2', 'weather', 'not json'), { outputText: 'ok' }],
      },
    });

    const result = await h.ai
      .forUser(HARNESS_USER)
      .runTools({ model: HARNESS_MODEL, input: 'x', tools: [strictTool] });

    expect(execute).not.toHaveBeenCalled();
    expect(result.steps[0].calls[0]).toMatchObject({ status: 'invalid_arguments' });
    expect(result.steps[0].calls[0].output).toMatch(/^Error: Invalid arguments for "weather": city/);
    expect(result.steps[1].calls[0]).toMatchObject({ status: 'invalid_arguments' });
    expect(result.steps[1].calls[0].output).toContain('not valid JSON');
    expect(outputsOf(h.fake.calls[1].request)[0].output).toBe(result.steps[0].calls[0].output);
    expect(result.stopReason).toBe('completed');
  });

  it('feeds an unknown tool, a throwing tool and a timed-out tool back as text', async () => {
    const boom = defineTool({
      name: 'boom',
      description: 'fails',
      parameters: z.object({}),
      execute: () => {
        throw new Error('database unavailable');
      },
    });
    let sawAbort = false;
    const slow = defineTool({
      name: 'slow',
      description: 'hangs',
      parameters: z.object({}),
      execute: (_args, ctx) =>
        new Promise((resolve) => {
          ctx.signal?.addEventListener('abort', () => {
            sawAbort = true;
            resolve('late');
          });
        }),
    });
    const h = createAiRuntimeHarness({
      fake: {
        responses: [
          {
            output: [
              { type: 'function_call', callId: 'a', name: 'nope', arguments: '{}' },
              { type: 'function_call', callId: 'b', name: 'boom', arguments: '{}' },
              { type: 'function_call', callId: 'c', name: 'slow', arguments: '{}' },
            ],
          },
          { outputText: 'recovered' },
        ],
      },
    });

    const result = await h.ai.forUser(HARNESS_USER).runTools({
      model: HARNESS_MODEL,
      input: 'x',
      tools: [boom, slow],
      toolTimeoutMs: 20,
    });

    expect(result.steps[0].calls.map((c) => c.status)).toEqual(['unknown_tool', 'error', 'timeout']);
    expect(result.steps[0].calls[1]).toMatchObject({ error: 'database unavailable' });
    expect(result.steps[0].calls[1].output).toContain('database unavailable');
    expect(result.steps[0].calls[2].output).toContain('timed out after 20 ms');
    expect(sawAbort).toBe(true);
    expect(outputsOf(h.fake.calls[1].request).map((o) => o.callId)).toEqual(['a', 'b', 'c']);
    expect(result.final.outputText).toBe('recovered');
  });

  it('enforces maxSteps: stops with steps_exhausted and does not run the last round of calls', async () => {
    const execute = jest.fn(() => 'again');
    const loopy = defineTool({ name: 'loopy', description: 'l', parameters: z.object({}), execute });
    const h = createAiRuntimeHarness({ fake: { responses: () => call('c', 'loopy', {}) } });

    const result = await h.ai
      .forUser(HARNESS_USER)
      .runTools({ model: HARNESS_MODEL, input: 'x', tools: [loopy], maxSteps: 3 });

    expect(result.stopReason).toBe('steps_exhausted');
    expect(h.fake.callsTo('responses.create')).toHaveLength(3);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[2].calls).toEqual([]);
    expect(result.final.finishReason).toBe('tool_calls');
  });

  it('defaults to 8 steps', async () => {
    const loopy = defineTool({ name: 'loopy', description: 'l', parameters: z.object({}), execute: () => 'x' });
    const h = createAiRuntimeHarness({ fake: { responses: () => call('c', 'loopy', {}) } });

    const result = await h.ai.forUser(HARNESS_USER).runTools({ model: HARNESS_MODEL, input: 'x', tools: [loopy] });

    expect(result.stopReason).toBe('steps_exhausted');
    expect(h.fake.callsTo('responses.create')).toHaveLength(8);
  });

  it.each([0, 21, 2.5])('refuses maxSteps=%s before any provider call', async (maxSteps) => {
    const h = createAiRuntimeHarness();

    await expect(
      h.ai.forUser(HARNESS_USER).runTools({ model: HARNESS_MODEL, input: 'x', tools: [weather], maxSteps }),
    ).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
    expect(h.fake.calls).toHaveLength(0);
  });

  it('refuses an empty tool list and duplicate tool names', async () => {
    const h = createAiRuntimeHarness();
    const client = h.ai.forUser(HARNESS_USER);

    await expect(client.runTools({ model: HARNESS_MODEL, input: 'x', tools: [] })).rejects.toMatchObject({
      code: 'AI_INVALID_REQUEST',
    });
    await expect(
      client.runTools({ model: HARNESS_MODEL, input: 'x', tools: [weather, weather] }),
    ).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
  });

  it('runs every round through the gates (a model without tools is refused)', async () => {
    const h = createAiRuntimeHarness({
      models: [
        {
          modelId: HARNESS_MODEL,
          capabilities: { capabilities: ['responses'], inputModalities: ['text'], outputModalities: ['text'] },
        },
      ],
    });

    await expect(
      h.ai.forUser(HARNESS_USER).runTools({ model: HARNESS_MODEL, input: 'x', tools: [weather] }),
    ).rejects.toMatchObject({ code: 'AI_CAPABILITY_UNSUPPORTED' });
    expect(h.fake.calls).toHaveLength(0);
  });

  it('a provider failure mid-loop propagates as an AiError', async () => {
    const h = createAiRuntimeHarness({ fake: { responses: [call('c1', 'weather', { city: 'Lima' })] } });

    const error = await h.ai
      .forUser(HARNESS_USER)
      .runTools({ model: HARNESS_MODEL, input: 'x', tools: [weather] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect(h.usageEvents.map((e) => e.status)).toEqual(['succeeded', 'failed']);
  });

  it('cancellation while a tool runs aborts the tool and ends the loop', async () => {
    const controller = new AbortController();
    const blocking = defineTool({
      name: 'blocking',
      description: 'b',
      parameters: z.object({}),
      execute: (_args, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          controller.abort();
        }),
    });
    const h = createAiRuntimeHarness({ fake: { responses: [call('c1', 'blocking', {}), { outputText: 'no' }] } });

    await expect(
      h.ai
        .forUser(HARNESS_USER)
        .runTools({ model: HARNESS_MODEL, input: 'x', tools: [blocking] }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(h.fake.callsTo('responses.create')).toHaveLength(1);
  });

  describe('a provider that cannot chain (supportsPreviousResponseId: false, #446)', () => {
    it('resends the full history each round instead of chaining', async () => {
      const state = { provider: 'openai', data: { signature: 'sig-1' } };
      const h = createAiRuntimeHarness({
        fake: {
          supportsPreviousResponseId: false,
          responses: [
            {
              output: [
                { type: 'reasoning', summary: ['Need the city first.'], [AI_PROVIDER_STATE]: state },
                { type: 'message', text: 'Let me look that up.' },
                { type: 'function_call', callId: 'c1', name: 'lookup_city', arguments: '{"person":"Ana"}' },
              ],
            },
            call('c2', 'weather', { city: 'Lima' }),
            { outputText: 'Ana is in Lima: 22C, sunny.' },
          ],
        },
      });

      const result = await h.ai.forUser(HARNESS_USER).runTools({
        model: HARNESS_MODEL,
        instructions: 'Be brief.',
        input: "What's the weather where Ana lives?",
        tools: [lookupCity, weather],
      });

      expect(result.stopReason).toBe('completed');
      expect(result.final.outputText).toBe('Ana is in Lima: 22C, sunny.');

      const requests = h.fake.callsTo('responses.create').map((c) => c.request);
      expect(requests).toHaveLength(3);

      for (const req of requests) {
        expect(req?.previousResponseId).toBeUndefined();
        expect(req?.instructions).toBe('Be brief.');
      }

      const user: AiInputItem = {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: "What's the weather where Ana lives?" }],
      };
      const round1: AiInputItem[] = [
        { type: 'reasoning', summary: ['Need the city first.'], [AI_PROVIDER_STATE]: state },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Let me look that up.' }] },
        { type: 'function_call', callId: 'c1', name: 'lookup_city', arguments: '{"person":"Ana"}' },
        { type: 'function_call_output', callId: 'c1', output: result.steps[0].calls[0].output },
      ];
      const round2: AiInputItem[] = [
        { type: 'function_call', callId: 'c2', name: 'weather', arguments: '{"city":"Lima"}' },
        { type: 'function_call_output', callId: 'c2', output: 'Lima: 22C, sunny' },
      ];

      expect(requests[0]?.input).toBe("What's the weather where Ana lives?");
      expect(requests[1]?.input).toEqual([user, ...round1]);
      expect(requests[2]?.input).toEqual([user, ...round1, ...round2]);

      // The reasoning item's opaque provider state is replayed with it (the
      // equality above compares symbol keys) — and stays invisible to JSON.
      const replayed = (requests[2]?.input as AiInputItem[])[1] as Extract<AiInputItem, { type: 'reasoning' }>;
      expect(replayed[AI_PROVIDER_STATE]).toEqual(state);
      expect(JSON.stringify(replayed)).not.toContain('sig-1');
    });

    it('keeps an array input as the head of the history', async () => {
      const h = createAiRuntimeHarness({
        fake: { supportsPreviousResponseId: false, responses: [call('c1', 'weather', { city: 'Quito' }), { outputText: 'ok' }] },
      });
      const input: AiInputItem[] = [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'first' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      ];

      await h.ai.forUser(HARNESS_USER).runTools({ model: HARNESS_MODEL, input, tools: [weather] });

      const second = h.fake.callsTo('responses.create')[1]?.request;
      expect((second?.input as AiInputItem[]).slice(0, 3)).toEqual(input);
      expect(outputsOf(second)).toEqual([{ type: 'function_call_output', callId: 'c1', output: 'Quito: 22C, sunny' }]);
    });

    it('refuses a caller-supplied previousResponseId before calling the provider', async () => {
      const h = createAiRuntimeHarness({ fake: { supportsPreviousResponseId: false } });

      await expect(
        h.ai.forUser(HARNESS_USER).respond({ model: HARNESS_MODEL, input: 'more', previousResponseId: 'resp_1' }),
      ).rejects.toMatchObject({
        code: 'AI_CAPABILITY_UNSUPPORTED',
        response: { details: { capability: 'previous_response_id' } },
      });
      await expect(
        h.ai.forUser(HARNESS_USER).runTools({
          model: HARNESS_MODEL,
          input: 'more',
          previousResponseId: 'resp_1',
          tools: [weather],
        }),
      ).rejects.toMatchObject({ code: 'AI_CAPABILITY_UNSUPPORTED' });
      expect(h.fake.calls.filter((c) => c.method === 'responses.create')).toHaveLength(0);
    });

    it('still accepts previousResponseId on a provider that chains', async () => {
      const h = createAiRuntimeHarness({ fake: { responses: [{ outputText: 'ok' }] } });

      await expect(
        h.ai.forUser(HARNESS_USER).respond({ model: HARNESS_MODEL, input: 'more', previousResponseId: 'resp_1' }),
      ).resolves.toMatchObject({ outputText: 'ok' });
    });
  });
});
