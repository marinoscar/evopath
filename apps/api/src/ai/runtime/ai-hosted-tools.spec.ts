// =============================================================================
// AiService — hosted tools (issue #442): the admin gate, the capability gate,
// the MCP header secret, and the image-output seam. Real facade over the
// runtime harness; "no provider call" is a fact about the fake's own record.
// =============================================================================

import { Logger } from '@nestjs/common';

import { AiError, type AiErrorCode } from '../core/ai-error';
import type { AiModelCapabilities } from '../core/capabilities';
import type { AiHostedTool, AiHostedToolType, AiOutputItem, AiStreamEvent } from '../core/types/responses.types';
import { createAiRuntimeHarness, HARNESS_USER, type AiRuntimeHarnessOptions } from '../testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES } from '../testing/fake-ai-provider';
import type { AiRequest } from './ai-runtime.types';

const HOSTED_MODEL = 'hosted-model';
const PLAIN_MODEL = 'plain-model';

const HOSTED_CAPS: AiModelCapabilities = {
  ...FAKE_TEXT_MODEL_CAPABILITIES,
  capabilities: [...FAKE_TEXT_MODEL_CAPABILITIES.capabilities, 'hosted_tools'],
};

const ALL_TYPES: AiHostedToolType[] = ['web_search', 'file_search', 'code_interpreter', 'image_generation', 'mcp'];
const ALL_ON = { web_search: true, file_search: true, code_interpreter: true, image_generation: true, mcp: true };

const HEADER_SECRET = 'mcp-header-secret-7Hq2Zp';

const TOOL: Record<AiHostedToolType, AiHostedTool> = {
  web_search: { type: 'web_search' },
  file_search: { type: 'file_search', vectorStoreIds: ['vs_1'] },
  code_interpreter: { type: 'code_interpreter' },
  image_generation: { type: 'image_generation' },
  mcp: {
    type: 'mcp',
    serverLabel: 'docs',
    serverUrl: 'https://mcp.example.com/sse',
    headers: { Authorization: `Bearer ${HEADER_SECRET}` },
  },
};

function harness(opts: AiRuntimeHarnessOptions = {}) {
  return createAiRuntimeHarness({
    ...opts,
    models: [{ modelId: HOSTED_MODEL, capabilities: HOSTED_CAPS }, { modelId: PLAIN_MODEL }],
    fake: { hostedTools: ALL_TYPES, ...opts.fake },
    policy: { hostedTools: ALL_ON, ...opts.policy },
  });
}

async function codeOf(promise: Promise<unknown>): Promise<AiErrorCode | 'resolved'> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    expect(err).toBeInstanceOf(AiError);
    return (err as AiError).code;
  }
}

async function collect(iterable: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const ask = (tools: AiHostedTool[], model = HOSTED_MODEL): AiRequest => ({ model, input: 'go', tools });

describe('AiService — hosted tools (#442)', () => {
  describe('gates', () => {
    it.each(ALL_TYPES)('%s switched off by the admin is AI_TOOL_DISABLED (403), before any provider call', async (type) => {
      const h = harness({ policy: { hostedTools: { ...ALL_ON, [type]: false } } });

      await expect(codeOf(h.ai.forUser(HARNESS_USER).respond(ask([TOOL[type]])))).resolves.toBe('AI_TOOL_DISABLED');
      await expect(codeOf(h.ai.forUser(HARNESS_USER).openStream(ask([TOOL[type]])))).resolves.toBe('AI_TOOL_DISABLED');
      expect(h.fake.calls).toHaveLength(0);
    });

    it('the default policy (every tool off) refuses every hosted tool', async () => {
      const h = createAiRuntimeHarness({ models: [{ modelId: HOSTED_MODEL, capabilities: HOSTED_CAPS }] });

      for (const type of ALL_TYPES) {
        await expect(codeOf(h.ai.forUser(HARNESS_USER).respond(ask([TOOL[type]])))).resolves.toBe('AI_TOOL_DISABLED');
      }
      expect(h.fake.calls).toHaveLength(0);
    });

    it('a model without hosted_tools is AI_CAPABILITY_UNSUPPORTED even when the tool is on', async () => {
      const h = harness();

      await expect(codeOf(h.ai.forUser(HARNESS_USER).respond(ask([TOOL.web_search], PLAIN_MODEL)))).resolves.toBe(
        'AI_CAPABILITY_UNSUPPORTED',
      );
      expect(h.fake.calls).toHaveLength(0);
    });

    it('an admin-disabled tool is refused as AI_TOOL_DISABLED even on a model without the capability', async () => {
      const h = harness({ policy: { hostedTools: { ...ALL_ON, web_search: false } } });

      await expect(codeOf(h.ai.forUser(HARNESS_USER).respond(ask([TOOL.web_search], PLAIN_MODEL)))).resolves.toBe(
        'AI_TOOL_DISABLED',
      );
    });

    it('an MCP host outside the allowlist is AI_TOOL_DISABLED; an allowed one passes', async () => {
      const h = harness({ policy: { hostedTools: { ...ALL_ON, mcpAllowedHosts: ['*.allowed.example'] } } });

      await expect(codeOf(h.ai.forUser(HARNESS_USER).respond(ask([TOOL.mcp])))).resolves.toBe('AI_TOOL_DISABLED');
      await expect(
        codeOf(
          h.ai
            .forUser(HARNESS_USER)
            .respond(ask([{ type: 'mcp', serverLabel: 'ok', serverUrl: 'https://mcp.allowed.example/x' }])),
        ),
      ).resolves.toBe('resolved');
    });

    it('a malformed hosted tool is AI_INVALID_REQUEST (http:// MCP server)', async () => {
      const h = harness();

      await expect(
        codeOf(
          h.ai.forUser(HARNESS_USER).respond(ask([{ type: 'mcp', serverLabel: 'x', serverUrl: 'http://mcp.example.com' }])),
        ),
      ).resolves.toBe('AI_INVALID_REQUEST');
      expect(h.fake.calls).toHaveLength(0);
    });

    it('every tool on and a capable model: the tools reach the adapter unchanged', async () => {
      const h = harness();
      const tools = ALL_TYPES.map((type) => TOOL[type]);

      await h.ai.forUser(HARNESS_USER).respond(ask(tools));

      expect(h.fake.callsTo('responses.create')[0].request?.tools).toEqual(tools);
    });
  });

  describe('image generation outputs are stored as the user\'s objects', () => {
    const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const imageItem = (): AiOutputItem => ({
      type: 'hosted_tool_call',
      id: 'ig_1',
      tool: 'image_generation',
      status: 'completed',
      result: {
        storageObjectId: null,
        mimeType: 'image/png',
        revisedPrompt: 'a fox',
        image: { data: BYTES, mimeType: 'image/png' },
      },
    });

    it('respond: the bytes become a ready storage object the user owns; only its id is published', async () => {
      const h = harness({
        fake: { responses: () => ({ id: 'resp_42', output: [imageItem(), { type: 'message', text: 'Here.' }] }) },
      });

      const response = await h.ai.forUser(HARNESS_USER).respond(ask([TOOL.image_generation]));

      expect(h.storage.objects).toHaveLength(1);
      const [row] = h.storage.objects;
      expect(row).toMatchObject({ uploadedById: HARNESS_USER, status: 'ready', mimeType: 'image/png', size: BigInt(BYTES.length) });
      expect(row.storageKey.startsWith(`ai-outputs/${HARNESS_USER}/resp_42/`)).toBe(true);
      expect(Array.from(h.storage.blobs.get(row.storageKey) ?? [])).toEqual(Array.from(BYTES));

      expect(response.output[0]).toEqual({
        type: 'hosted_tool_call',
        id: 'ig_1',
        tool: 'image_generation',
        status: 'completed',
        result: { storageObjectId: row.id, mimeType: 'image/png', revisedPrompt: 'a fox' },
      });
      expect(JSON.stringify(response)).not.toContain('"data"');
      expect(h.usageEvents[0]).toMatchObject({ status: 'succeeded', units: { images: 1 } });
    });

    it('a background run stores under its run id', async () => {
      const h = harness({ fake: { responses: () => ({ output: [imageItem()] }) } });

      await h.ai.forUser(HARNESS_USER, { runId: 'run-7' }).respond(ask([TOOL.image_generation]));

      expect(h.storage.objects[0].storageKey.startsWith(`ai-outputs/${HARNESS_USER}/run-7/`)).toBe(true);
    });

    it('stream: stores the image once though the item appears twice, and no frame carries bytes', async () => {
      const h = harness({ fake: { responses: () => ({ output: [imageItem()] }) } });

      const events = await collect(await h.ai.forUser(HARNESS_USER).openStream(ask([TOOL.image_generation])));
      const done = events.find((e) => e.type === 'output_item.done') as Extract<AiStreamEvent, { type: 'output_item.done' }>;
      const completed = events.at(-1) as Extract<AiStreamEvent, { type: 'response.completed' }>;

      expect(h.storage.objects).toHaveLength(1);
      expect(done.item).toMatchObject({ result: { storageObjectId: h.storage.objects[0].id, mimeType: 'image/png' } });
      expect(completed.response.output[0]).toEqual(done.item);
      for (const event of events) expect(JSON.stringify(event)).not.toContain('"data"');
      expect(h.usageEvents[0]).toMatchObject({ units: { images: 1 } });
    });

    it('storage unavailable: the response still succeeds, the image says why it was not kept', async () => {
      const h = harness({ fake: { responses: () => ({ output: [imageItem(), { type: 'message', text: 'Here.' }] }) } });
      h.storage.setConfigured(false);

      const response = await h.ai.forUser(HARNESS_USER).respond(ask([TOOL.image_generation]));

      expect(response.outputText).toBe('Here.');
      expect(response.output[0]).toMatchObject({
        result: { storageObjectId: null, storageError: 'AI_STORAGE_UNAVAILABLE', mimeType: 'image/png' },
      });
      expect(h.storage.objects).toHaveLength(0);
      expect(JSON.stringify(response)).not.toContain('"data"');
    });

    it('a response that drew nothing records no image units and stores nothing', async () => {
      const h = harness();

      await h.ai.forUser(HARNESS_USER).respond(ask([TOOL.image_generation]));

      expect(h.storage.objects).toHaveLength(0);
      expect(h.usageEvents[0].units ?? null).toBeNull();
    });
  });

  describe('MCP headers are secret', () => {
    it('an MCP server echoing its credential back is scrubbed from respond and from every stream frame', async () => {
      const echo = (): AiOutputItem[] => [
        {
          type: 'hosted_tool_call',
          id: 'mcp_1',
          tool: 'mcp',
          status: 'completed',
          result: {
            kind: 'call',
            serverLabel: 'docs',
            name: 'whoami',
            arguments: '{}',
            output: `token is ${HEADER_SECRET}`,
            error: null,
          },
        },
        { type: 'message', text: `I saw Bearer ${HEADER_SECRET}.` },
      ];
      const h = harness({ fake: { responses: () => ({ output: echo() }) } });

      const response = await h.ai.forUser(HARNESS_USER).respond(ask([TOOL.mcp]));
      expect(JSON.stringify(response)).not.toContain(HEADER_SECRET);
      expect(response.outputText).toContain('[REDACTED]');

      const events = await collect(await h.ai.forUser(HARNESS_USER).openStream(ask([TOOL.mcp])));
      expect(JSON.stringify(events)).not.toContain(HEADER_SECRET);
    });

    it('never reaches a log line (even with logPromptContent on) or a usage row', async () => {
      const lines: string[] = [];
      const spies = (['log', 'debug', 'warn', 'error', 'verbose'] as const).map((m) =>
        jest.spyOn(Logger.prototype, m).mockImplementation((...args: unknown[]) => {
          lines.push(JSON.stringify(args));
        }),
      );

      try {
        const h = harness({ policy: { logPromptContent: true } });

        await h.ai.forUser(HARNESS_USER).respond(ask([TOOL.mcp]));

        expect(lines.length).toBeGreaterThan(0);
        expect(lines.join('\n')).not.toContain(HEADER_SECRET);
        expect(JSON.stringify(h.usageEvents)).not.toContain(HEADER_SECRET);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });

    it('a background run with MCP headers is refused and nothing is stored', async () => {
      const h = harness();

      await expect(codeOf(h.ai.forUser(HARNESS_USER).startRun(ask([TOOL.mcp])))).resolves.toBe('AI_INVALID_REQUEST');
      expect(h.runRows).toHaveLength(0);
      expect(h.enqueued).toHaveLength(0);
    });

    it('a background run with header-less hosted tools is stored with them', async () => {
      const h = harness();
      const tools: AiHostedTool[] = [TOOL.web_search, { type: 'mcp', serverLabel: 'docs', serverUrl: 'https://mcp.example.com' }];

      await h.ai.forUser(HARNESS_USER).startRun(ask(tools));

      expect((h.runRows[0].request as { tools: unknown }).tools).toEqual(tools);
    });
  });
});
