import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import { AiProviderRegistry } from '../../src/ai/core/provider-registry';
import { OpenAiClientFactory } from '../../src/ai/providers/openai/openai-client.factory';
import { OpenAiProviderAdapter } from '../../src/ai/providers/openai/openai.adapter';
import { SCENARIOS_DIR, scenarioNames } from '../training-agents/support/scenario-script';

// The fake OpenAI Responses server (tests/e2e/support/fake-responses-server.mjs),
// started as a real child process: scenario selection and call counting, the
// 429, auth, the request log (never a key or a body), canary counting, and
// that the REAL OpenAI adapter maps its answers.

const SERVER = join(__dirname, '../../../../tests/e2e/support/fake-responses-server.mjs');
const KEY = 'sk-fake-secret-key-7d41';
const CANARY = 'CANARY-ZEBRA-42';

let child: ChildProcess;
let base = '';

async function startServer(): Promise<void> {
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: '0', SCENARIO_DIR: SCENARIOS_DIR, CANARY_TOKENS: `${CANARY}, ,OTHER-CANARY` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`fake server did not start: ${output}`)), 10_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening on :(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('exit', (code) => reject(new Error(`fake server exited ${code}: ${output}`)));
  });
  base = `http://127.0.0.1:${port}`;
}

const auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

async function control(path: string, body?: unknown) {
  const res = await fetch(`${base}/__control${path}`, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

async function responses(body: Record<string, unknown>, headers: Record<string, string> = auth) {
  const res = await fetch(`${base}/v1/responses`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

const call = (agent: string, extra: Record<string, unknown> = {}) => ({
  model: 'fake-frontier',
  input: 'some prompt',
  metadata: { agent, node: 'n', round: '1' },
  ...extra,
});
const schema = { text: { format: { type: 'json_schema', name: 's', schema: {}, strict: true } } };

beforeAll(startServer, 20_000);
afterAll(() => child?.kill('SIGTERM'));
beforeEach(async () => {
  await control('/reset', {});
  await control('/scenario', { name: 'happy' });
});

describe('fake responses server', () => {
  it('lists fake-frontier, fake-fast and fake-tts', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: auth });
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe('list');
    expect(body.data.map((m) => m.id)).toEqual(['fake-frontier', 'fake-fast', 'fake-tts']);
  });

  it('lists every scenario fixture with its description and the current one', async () => {
    const { body } = await control('/scenarios');
    expect(body.current).toBe('happy');
    expect(body.scenarios.map((s: { name: string }) => s.name)).toEqual(scenarioNames());
    expect(body.scenarios.every((s: { description: string }) => s.description.length > 0)).toBe(true);
  });

  it('rejects an unknown scenario name', async () => {
    expect((await control('/scenario', { name: 'nope' })).status).toBe(400);
  });

  it('routes on metadata.agent and the per-role call counter, repeating the last entry', async () => {
    await control('/scenario', { name: 'critic-reject-once' });
    const titles: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { body } = await responses(call('planner', schema));
      titles.push(JSON.parse(body.output.at(-1).content[0].text).title);
    }
    expect(titles).toEqual(['Eight-week dumbbell base', 'Eight-week dumbbell base (revised)', 'Eight-week dumbbell base (revised)']);
    const verdicts: string[] = [];
    for (let i = 0; i < 2; i += 1) verdicts.push(JSON.parse((await responses(call('critic', schema))).body.output[0].content[0].text).verdict);
    expect(verdicts).toEqual(['revise', 'approve']);
  });

  it('a critic call without a schema is an uncounted investigation note', async () => {
    await control('/scenario', { name: 'critic-reject-once' });
    const note = await responses(call('critic', { tools: [{ type: 'function', name: 'find_substitutes' }] }));
    expect(note.body.output[0].content[0].text).toContain('see the verdict');
    const verdict = await responses(call('critic', schema));
    expect(JSON.parse(verdict.body.output[0].content[0].text).verdict).toBe('revise');
  });

  it('selecting a scenario resets the counters', async () => {
    await control('/scenario', { name: 'critic-reject-once' });
    await responses(call('planner', schema));
    await control('/scenario', { name: 'critic-reject-once' });
    const { body } = await responses(call('planner', schema));
    expect(JSON.parse(body.output[0].content[0].text).title).toBe('Eight-week dumbbell base');
  });

  it('answers a role the scenario does not script with a scenario error', async () => {
    await control('/scenario', { name: 'urgent-symptom' });
    const { status, body } = await responses(call('planner', schema));
    expect(status).toBe(500);
    expect(body.error.type).toBe('fake_scenario_error');
  });

  it('answers 429 with retry-after once on the configured request, then the same call succeeds', async () => {
    await control('/scenario', { name: 'rate-limit-once' });
    const first = await responses(call('researcher', schema));
    const limited = await responses(call('planner', schema));
    const retry = await responses(call('planner', schema));
    expect([first.status, limited.status, retry.status]).toEqual([200, 429, 200]);
    expect(limited.headers.get('retry-after')).toBe('2');
    expect(JSON.parse(retry.body.output[0].content[0].text).title).toBe('Eight-week dumbbell base');
  });

  it('delays a response by the scenario delayMs', async () => {
    await control('/scenario', { name: 'slow' });
    const started = Date.now();
    await responses(call('researcher', schema));
    expect(Date.now() - started).toBeGreaterThanOrEqual(3900);
  }, 15_000);

  it.each([[{ authorization: 'Bearer sk-invalid-abcdefgh' }], [{ authorization: 'Bearer short' }], [{}]])('answers 401 for %j', async (headers) => {
    expect((await responses(call('planner', schema), { 'content-type': 'application/json', ...headers })).status).toBe(401);
  });

  it('never echoes, logs or stores a key, a prompt or a body', async () => {
    await responses(call('planner', { ...schema, input: `PROMPT-SECRET ${CANARY}` }));
    await responses(call('planner', schema), { authorization: 'Bearer sk-invalid-abcdefgh', 'content-type': 'application/json' });
    const { body: log } = await control('/requests');
    const text = JSON.stringify(log);
    expect(log).toHaveLength(2);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('sk-invalid');
    expect(text).not.toContain('PROMPT-SECRET');
    expect(log[0]).toMatchObject({ agent: 'planner', node: 'n', round: 1, model: 'fake-frontier', hasSchema: true, hasAuthorization: true, status: 200, canaryHits: 1 });
    expect(Object.keys(log[0]).sort()).toEqual(
      ['agent', 'canaryHits', 'hasAuthorization', 'hasSchema', 'inputChars', 'model', 'node', 'path', 'reasoningEffort', 'round', 'scenario', 'seq', 'status', 'time', 'toolTypes'].sort(),
    );
  });

  it('records reasoning effort and tool types, counts canaries across the whole body, and supports ?after', async () => {
    await responses(call('researcher', { ...schema, reasoning: { effort: 'high' }, tools: [{ type: 'web_search' }], input: [{ role: 'user', content: `${CANARY} and OTHER-CANARY and ${CANARY}` }] }));
    await responses(call('planner', schema));
    const all = (await control('/requests')).body;
    expect(all[0]).toMatchObject({ reasoningEffort: 'high', toolTypes: ['web_search'], canaryHits: 3 });
    expect(all[1]).toMatchObject({ canaryHits: 0, reasoningEffort: null, toolTypes: [] });
    expect((await control(`/requests?after=${all[0].seq}`)).body).toHaveLength(1);
  });

  it('reset clears the log', async () => {
    await responses(call('planner', schema));
    await control('/reset', {});
    expect((await control('/requests')).body).toEqual([]);
  });

  describe('through the real OpenAI adapter', () => {
    const adapter = new OpenAiProviderAdapter(new AiProviderRegistry(), new OpenAiClientFactory());
    const ctx = () => ({ apiKey: KEY, requestId: 'fake-e2e', baseUrl: `${base}/v1` });

    it('maps the researcher answer: a hosted web_search call, a cited message and reasoning usage', async () => {
      const result = await adapter.responses.create(
        { provider: 'openai', model: 'fake-frontier', input: 'research', tools: [{ type: 'web_search' }], metadata: { agent: 'researcher', node: 'research' } } as never,
        ctx(),
      );
      expect(result.output.map((item) => item.type)).toEqual(['hosted_tool_call', 'message']);
      const message = result.output.find((item) => item.type === 'message') as { citations?: Array<{ url: string }> };
      expect(message.citations?.length).toBeGreaterThan(0);
      expect(result.usage).toMatchObject({ inputTokens: 9000, outputTokens: 4200, reasoningTokens: 1500 });
    });

    it('speaks: the real adapter gets a playable audio payload over the coach floor of 1 KiB', async () => {
      const result = await adapter.audio!.speech!(
        { provider: 'openai', model: 'fake-tts', input: 'Hello there', voice: 'alloy' } as never,
        ctx(),
      );
      expect(result.audio.data.length).toBeGreaterThan(1_024);
      expect(result.audio.mimeType).toBe('audio/mpeg');
    });

    it('lists its models through listModels', async () => {
      const models = await adapter.listModels(ctx());
      expect(models.map((m) => m.id).sort()).toEqual(['fake-fast', 'fake-frontier', 'fake-tts']);
    });
  });
});
