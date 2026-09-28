// =============================================================================
// Provider-hosted tools over HTTP Integration (issue #442, epic #420)
// =============================================================================
//
//   * `GET /api/ai/config` publishes which hosted tools are switched on.
//   * `POST /api/ai/responses` / `/stream` / `/runs` accept hosted tools:
//       - a type the admin has not switched on  -> 403 AI_TOOL_DISABLED
//       - a model without `hosted_tools`         -> 400 AI_CAPABILITY_UNSUPPORTED
//       - an MCP host outside the allowlist      -> 403 AI_TOOL_DISABLED
//       - a function tool, or http:// MCP        -> 400 (validation)
//       - a background run with MCP headers      -> 400 AI_INVALID_REQUEST
//     every refusal before any provider call.
//   * Web-search citations reach the body; a generated image is stored as a
//     storage object the caller owns (and downloads like any upload) — its
//     bytes never reach a body or frame; with storage unavailable the answer
//     still succeeds and the image carries `storageError`.
//
// The runtime is the #432 harness (real AiService over FakeAiProvider), see
// `ai-http.helper.ts`.
// =============================================================================

import request from 'supertest';

import type { AiModelCapabilities } from '../../src/ai/core/capabilities';
import type { AiOutputItem } from '../../src/ai/core/types/responses.types';
import { HARNESS_EMBEDDING_MODEL, HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { FAKE_EMBEDDING_MODEL_CAPABILITIES, FAKE_TEXT_MODEL_CAPABILITIES } from '../../src/ai/testing/fake-ai-provider';
import { authHeader, createMockTestUser, TestUser } from '../helpers/auth-mock.helper';
import { AiHttpTestApp, createAiHttpTestApp, parseSse } from './ai-http.helper';

const HOSTED_MODEL = 'hosted-model';
const PLAIN_MODEL = 'plain-model';

const HOSTED_CAPS: AiModelCapabilities = {
  ...FAKE_TEXT_MODEL_CAPABILITIES,
  capabilities: [...FAKE_TEXT_MODEL_CAPABILITIES.capabilities, 'hosted_tools'],
};

const ALL_ON = {
  web_search: true,
  file_search: true,
  code_interpreter: true,
  image_generation: true,
  mcp: true,
  mcpAllowedHosts: [] as string[],
};
const ALL_OFF = {
  web_search: false,
  file_search: false,
  code_interpreter: false,
  image_generation: false,
  mcp: false,
  mcpAllowedHosts: [] as string[],
};

const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe('AI hosted tools HTTP Integration (#442)', () => {
  let t: AiHttpTestApp;
  let alice: TestUser;

  beforeAll(async () => {
    t = await createAiHttpTestApp({
      models: [
        { modelId: HOSTED_MODEL, capabilities: HOSTED_CAPS },
        { modelId: PLAIN_MODEL },
        { modelId: HARNESS_EMBEDDING_MODEL, capabilities: FAKE_EMBEDDING_MODEL_CAPABILITIES },
      ],
      fake: { hostedTools: ['web_search', 'file_search', 'code_interpreter', 'image_generation', 'mcp'] },
    });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    t.harness.setPolicy({ hostedTools: { ...ALL_ON } });
    alice = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
  });

  const server = () => t.context.app.getHttpServer();
  const post = (path: string, body: object) =>
    request(server()).post(path).set(authHeader(alice.accessToken)).send(body);

  describe('GET /api/ai/config', () => {
    it('publishes each switch as a boolean and never the MCP allowlist', async () => {
      t.harness.setPolicy({ hostedTools: { ...ALL_OFF, web_search: true, mcp: true, mcpAllowedHosts: ['hidden.example'] } });

      const res = await request(server()).get('/api/ai/config').set(authHeader(alice.accessToken)).expect(200);

      expect(res.body.data.hostedTools).toEqual({
        web_search: true,
        file_search: false,
        code_interpreter: false,
        image_generation: false,
        mcp: true,
      });
      expect(res.text).not.toContain('hidden.example');
    });
  });

  describe('gates, before any provider call', () => {
    it.each([
      ['web_search', { type: 'web_search' }],
      ['file_search', { type: 'file_search', vectorStoreIds: ['vs_1'] }],
      ['code_interpreter', { type: 'code_interpreter' }],
      ['image_generation', { type: 'image_generation' }],
      ['mcp', { type: 'mcp', serverLabel: 'docs', serverUrl: 'https://mcp.example.com' }],
    ])('%s switched off -> 403 AI_TOOL_DISABLED on both routes', async (type, tool) => {
      t.harness.setPolicy({ hostedTools: { ...ALL_ON, [type]: false } });

      const res = await post('/api/ai/responses', { model: HOSTED_MODEL, input: 'go', tools: [tool] }).expect(403);
      expect(res.body.details).toMatchObject({ reason: 'AI_TOOL_DISABLED', tool: type });

      const streamed = await post('/api/ai/responses/stream', { model: HOSTED_MODEL, input: 'go', tools: [tool] })
        .set('Accept', 'text/event-stream')
        .expect(403);
      expect(streamed.body.details.reason).toBe('AI_TOOL_DISABLED');
      expect(t.harness.fake.calls).toHaveLength(0);
    });

    it('a model without hosted_tools -> 400 AI_CAPABILITY_UNSUPPORTED', async () => {
      const res = await post('/api/ai/responses', {
        model: PLAIN_MODEL,
        input: 'go',
        tools: [{ type: 'web_search' }],
      }).expect(400);

      expect(res.body.details.reason).toBe('AI_CAPABILITY_UNSUPPORTED');
      expect(t.harness.fake.calls).toHaveLength(0);
    });

    it('an MCP host outside the allowlist -> 403 AI_TOOL_DISABLED', async () => {
      t.harness.setPolicy({ hostedTools: { ...ALL_ON, mcpAllowedHosts: ['mcp.allowed.example'] } });

      const res = await post('/api/ai/responses', {
        model: HOSTED_MODEL,
        input: 'go',
        tools: [{ type: 'mcp', serverLabel: 'x', serverUrl: 'https://evil.example/mcp' }],
      }).expect(403);

      expect(res.body.details).toMatchObject({ reason: 'AI_TOOL_DISABLED', tool: 'mcp' });
    });

    it.each([
      ['a function tool', { type: 'function', name: 'f', description: 'd', parameters: {} }],
      ['an http:// MCP server', { type: 'mcp', serverLabel: 'x', serverUrl: 'http://mcp.example.com' }],
      ['file search with no vector store', { type: 'file_search', vectorStoreIds: [] }],
      ['an unknown hosted tool', { type: 'computer_use' }],
    ])('%s is a 400 validation error', async (_label, tool) => {
      await post('/api/ai/responses', { model: HOSTED_MODEL, input: 'go', tools: [tool] }).expect(400);
      expect(t.harness.fake.calls).toHaveLength(0);
    });

    it('a background run with MCP headers -> 400 AI_INVALID_REQUEST, nothing stored', async () => {
      const res = await post('/api/ai/runs', {
        model: HOSTED_MODEL,
        input: 'go',
        tools: [{ type: 'mcp', serverLabel: 'x', serverUrl: 'https://mcp.example.com', headers: { Authorization: 'Bearer abcdef' } }],
      }).expect(400);

      expect(res.body.details.reason).toBe('AI_INVALID_REQUEST');
      expect(t.harness.runRows).toHaveLength(0);
    });

    it('a background run with hosted tools is queued with them', async () => {
      await post('/api/ai/runs', { model: HOSTED_MODEL, input: 'go', tools: [{ type: 'web_search' }] }).expect(202);

      expect((t.harness.runRows[0].request as { tools: unknown }).tools).toEqual([{ type: 'web_search' }]);
    });
  });

  describe('outputs', () => {
    const scripted = (): AiOutputItem[] => [
      {
        type: 'hosted_tool_call',
        id: 'ws_1',
        tool: 'web_search',
        status: 'completed',
        result: { queries: ['weather paris'], sources: [{ url: 'https://w.example' }] },
      },
      {
        type: 'hosted_tool_call',
        id: 'ig_1',
        tool: 'image_generation',
        status: 'completed',
        result: { storageObjectId: null, mimeType: 'image/png', image: { data: IMAGE_BYTES, mimeType: 'image/png' } },
      },
      {
        type: 'message',
        text: 'Sunny.',
        citations: [{ url: 'https://w.example', title: 'Weather', startIndex: 0, endIndex: 6 }],
      },
    ];

    it('the tools reach the provider, citations reach the body, and the image is a stored object', async () => {
      t.script(() => ({ output: scripted() }));

      const res = await post('/api/ai/responses', {
        model: HOSTED_MODEL,
        input: 'weather?',
        tools: [{ type: 'web_search', searchContextSize: 'low' }, { type: 'image_generation', size: '1024x1024' }],
      }).expect(200);

      expect(t.harness.fake.callsTo('responses.create')[0].request?.tools).toEqual([
        { type: 'web_search', searchContextSize: 'low' },
        { type: 'image_generation', size: '1024x1024' },
      ]);

      const output = res.body.data.output;
      expect(output[0]).toMatchObject({ tool: 'web_search', result: { sources: [{ url: 'https://w.example' }] } });
      expect(t.harness.storage.objects).toHaveLength(1);
      const [stored] = t.harness.storage.objects;
      expect(stored).toMatchObject({ uploadedById: HARNESS_USER, status: 'ready' });
      expect(stored.storageKey.startsWith(`ai-outputs/${HARNESS_USER}/`)).toBe(true);
      expect(output[1]).toEqual({
        type: 'hosted_tool_call',
        id: 'ig_1',
        tool: 'image_generation',
        status: 'completed',
        result: { storageObjectId: stored.id, mimeType: 'image/png' },
      });
      expect(output[2].citations).toEqual([{ url: 'https://w.example', title: 'Weather', startIndex: 0, endIndex: 6 }]);
      expect(res.text).not.toContain('"data":{"0"');
    });

    it('SSE: hosted items arrive as output_item.done frames, with no image bytes in any frame', async () => {
      t.script(() => ({ output: scripted() }));

      const res = await post('/api/ai/responses/stream', {
        model: HOSTED_MODEL,
        input: 'weather?',
        tools: [{ type: 'web_search' }, { type: 'image_generation' }],
      })
        .set('Accept', 'text/event-stream')
        .expect(200);

      const frames = parseSse(res.text).filter((frame) => frame.event);
      const done = frames.filter((frame) => frame.event === 'output_item.done').map((frame) => frame.data.item);

      expect(done.map((item) => item.tool ?? item.type)).toEqual(['web_search', 'image_generation', 'message']);
      expect(t.harness.storage.objects).toHaveLength(1);
      expect(done[1].result).toEqual({ storageObjectId: t.harness.storage.objects[0].id, mimeType: 'image/png' });
      expect(frames.at(-1)?.event).toBe('response.completed');
      expect(frames.at(-1)?.data.response.output[1]).toEqual(done[1]);
      expect(res.text).not.toMatch(/"image":/);
    });

    it('storage unavailable: 200 with the text, the image null with storageError', async () => {
      t.script(() => ({ output: scripted() }));
      t.harness.storage.setConfigured(false);

      const res = await post('/api/ai/responses', {
        model: HOSTED_MODEL,
        input: 'weather?',
        tools: [{ type: 'image_generation' }],
      }).expect(200);

      expect(res.body.data.outputText).toBe('Sunny.');
      expect(res.body.data.output[1].result).toEqual({
        storageObjectId: null,
        storageError: 'AI_STORAGE_UNAVAILABLE',
        mimeType: 'image/png',
      });
      expect(t.harness.storage.objects).toHaveLength(0);
    });
  });
});
