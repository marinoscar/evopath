#!/usr/bin/env node
// =============================================================================
// Fake OpenAI Responses API server for the agentic training plan flow. TEST-ONLY.
// =============================================================================
//
// A dependency-free `node:http` server the API reaches as its `openai`
// provider (the provider's base URL is a runtime setting, so there is no
// production hook and no environment variable on the application). It replays
// the scenario fixtures in apps/api/test/fixtures/training/scenarios, the same
// files the Jest scenario suites replay, so a contributor can run the whole
// planner flow with no key, no cost and no outbound network.
//
//   GET  /v1/models              fake-frontier and fake-fast
//   POST /v1/responses           an OpenAI Responses object: a message with
//                                output_text (url_citation annotations for the
//                                researcher), a web_search_call item, usage with
//                                output_tokens_details.reasoning_tokens. Routed
//                                on body.metadata.agent and a per-scenario call
//                                counter; not streamed.
//   POST /__control/scenario     { "name": "critic-reject-once" }  resets counters
//   GET  /__control/scenarios    { current, scenarios: [{ name, description }] }
//   GET  /__control/requests     one entry per request (see below), ?after=<seq>
//   POST /__control/reset        clear counters and the request log
//
// A request answers from calls[role][n] (n counts that role's COUNTED calls;
// the last entry repeats). A critic call without a structured-output schema is
// an investigation round trip: it gets a fixed note and is not counted.
// http.rateLimitOnCall answers ONE 429 with retry-after on that request number
// (1-based, since the scenario was selected) without consuming a call index;
// http.delayMs delays every answer. Keep this in step with
// apps/api/test/training-agents/support/scenario-script.ts.
//
// Auth: any bearer token of 8 or more characters is accepted; a token starting
// `sk-invalid`, a short one or none is a 401. THE FAKE NEVER LOGS, ECHOES OR
// STORES A KEY, and the request log holds no prompt, body or header value:
//   { seq, time, scenario, path, status, agent, node, round, model,
//     reasoningEffort, toolTypes, hasSchema, inputChars, canaryHits, hasAuthorization }
//
// CANARY_TOKENS (fake container only, set by the compose overlay): comma
// separated strings whose occurrences in any request body are counted in
// `canaryHits`, so a test can prove data minimisation from outside the API.
//
// SCENARIO_DIR defaults to the repository's fixtures folder; PORT to 4011
// (0 picks a free port). Runs in compose as service `fake-ai-responses`.
// =============================================================================

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCENARIO_DIR = resolve(HERE, '../../../apps/api/test/fixtures/training/scenarios');
const MODELS = ['fake-frontier', 'fake-fast'];
const ROLES = ['researcher', 'planner', 'critic', 'evaluator'];
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const INVESTIGATION_NOTE = 'Checked volume and substitutes; see the verdict.';
const DEFAULT_USAGE = { inputTokens: 100, outputTokens: 50, reasoningTokens: 0 };

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

/** Occurrences of any canary token in `text` (empty tokens are ignored). */
export function countCanaries(text, tokens) {
  let hits = 0;
  for (const token of tokens) {
    if (!token) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(token, from);
      if (at === -1) break;
      hits += 1;
      from = at + token.length;
    }
  }
  return hits;
}

/** A bearer token is acceptable when it is 8 or more characters and not `sk-invalid...`. */
export function tokenAccepted(header) {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!match) return false;
  return match[1].length >= 8 && !match[1].startsWith('sk-invalid');
}

/** The call spec to answer with, or null when the role has none. */
export function pickCall(specs, index) {
  if (!Array.isArray(specs) || specs.length === 0) return null;
  return specs[Math.min(index, specs.length - 1)];
}

function isResearchFixture(value) {
  return value && typeof value === 'object' && 'searchSources' in value && 'brief' in value && 'citations' in value;
}

function inputChars(input) {
  if (typeof input === 'string') return input.length;
  return input === undefined ? 0 : JSON.stringify(input).length;
}

/** The Responses API object for a scripted answer. */
export function buildResponse(id, model, metadata, spec, json, investigation) {
  const usage = { ...DEFAULT_USAGE, ...(spec?.usage ?? {}) };
  const output = [];
  let text = INVESTIGATION_NOTE;
  let annotations = [];

  if (!investigation) {
    const research = isResearchFixture(json)
      ? json
      : spec?.webSearch
        ? { queries: spec.webSearch.queries, searchSources: spec.webSearch.sources, citations: spec.webSearch.citations, brief: json }
        : null;
    if (research) {
      output.push({
        id: `ws_${id}`,
        type: 'web_search_call',
        status: 'completed',
        action: { type: 'search', queries: research.queries, sources: research.searchSources.map((url) => ({ type: 'url', url })) },
      });
      text = JSON.stringify(research.brief);
      annotations = research.citations.map((url) => ({ type: 'url_citation', url, title: 'cited', start_index: 0, end_index: 1 }));
    } else {
      text = JSON.stringify(json);
    }
  }

  output.push({
    id: `msg_${id}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations }],
  });

  return {
    id: `resp_${id}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: metadata ?? {},
    output,
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    usage: {
      input_tokens: usage.inputTokens,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: usage.outputTokens,
      output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
  };
}

export function startFakeResponsesServer({ port = Number(process.env.PORT ?? 4011), scenarioDir = process.env.SCENARIO_DIR ?? DEFAULT_SCENARIO_DIR, canaries } = {}) {
  const canaryTokens = canaries ?? (process.env.CANARY_TOKENS ?? '').split(',').map((token) => token.trim()).filter(Boolean);

  const listScenarios = () =>
    readdirSync(scenarioDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''))
      .sort();
  const loadScenario = (name) => JSON.parse(readFileSync(join(scenarioDir, `${name}.json`), 'utf8'));
  const loadOutput = (spec) => JSON.parse(readFileSync(join(scenarioDir, spec.outputJson), 'utf8'));

  const state = { scenario: 'happy', counters: {}, requestNumber: 0, log: [], seq: 0, responses: 0 };

  function resetCounters(name) {
    state.scenario = name;
    state.counters = {};
    state.requestNumber = 0;
  }

  async function respond(req, res, raw) {
    const body = parseJson(raw);
    const authorized = tokenAccepted(req.headers.authorization);
    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const hasSchema = body.text?.format?.type === 'json_schema';
    const entry = {
      seq: (state.seq += 1),
      time: new Date().toISOString(),
      scenario: state.scenario,
      path: '/v1/responses',
      status: 200,
      agent: typeof metadata.agent === 'string' ? metadata.agent : null,
      node: typeof metadata.node === 'string' ? metadata.node : null,
      round: metadata.round !== undefined ? Number(metadata.round) : null,
      model: typeof body.model === 'string' ? body.model : null,
      reasoningEffort: typeof body.reasoning?.effort === 'string' ? body.reasoning.effort : null,
      toolTypes: tools.map((tool) => String(tool?.type ?? 'unknown')),
      hasSchema,
      inputChars: inputChars(body.input) + (typeof body.instructions === 'string' ? body.instructions.length : 0),
      canaryHits: countCanaries(raw, canaryTokens),
      hasAuthorization: Boolean(req.headers.authorization),
    };
    state.log.push(entry);
    const fail = (status, error, headers) => {
      entry.status = status;
      return send(res, status, { error }, headers);
    };

    if (!authorized) {
      return fail(401, { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' });
    }
    if (body.stream) {
      return fail(400, { message: 'The fake Responses server does not stream.', type: 'invalid_request_error' });
    }

    const scenario = loadScenario(state.scenario);
    state.requestNumber += 1;

    if (scenario.http?.delayMs) await sleep(scenario.http.delayMs);

    if (scenario.http?.rateLimitOnCall === state.requestNumber) {
      const seconds = scenario.http.retryAfterSeconds ?? 2;
      return fail(429, { message: 'Rate limit reached for the fake model.', type: 'rate_limit_error', code: 'rate_limit_exceeded' }, { 'retry-after': String(seconds) });
    }

    const role = entry.agent;
    if (!role || !ROLES.includes(role)) {
      return fail(400, { message: 'Request carries no known metadata.agent.', type: 'invalid_request_error' });
    }

    const investigation = role === 'critic' && !hasSchema;
    let spec = null;
    let json = null;
    if (!investigation) {
      const index = state.counters[role] ?? 0;
      spec = pickCall(scenario.calls?.[role], index);
      if (!spec) {
        return fail(500, { message: `Scenario ${state.scenario} has no scripted call for ${role}.`, type: 'fake_scenario_error' });
      }
      state.counters[role] = index + 1;
      json = loadOutput(spec);
    }

    state.responses += 1;
    const model = typeof body.model === 'string' ? body.model : MODELS[0];
    return send(res, 200, buildResponse(`fake_${String(state.responses).padStart(6, '0')}`, model, metadata, spec, json, investigation));
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && path === '/v1/models') {
      if (!tokenAccepted(req.headers.authorization)) {
        return send(res, 401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } });
      }
      return send(res, 200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model', created: 0, owned_by: 'fake' })) });
    }

    if (req.method === 'POST' && path === '/v1/responses') return respond(req, res, await readBody(req));

    if (req.method === 'POST' && path === '/__control/scenario') {
      const body = parseJson(await readBody(req));
      if (typeof body.name !== 'string' || !listScenarios().includes(body.name)) {
        return send(res, 400, { error: `name must be one of ${listScenarios().join(', ')}` });
      }
      resetCounters(body.name);
      return send(res, 200, { scenario: state.scenario });
    }

    if (req.method === 'GET' && path === '/__control/scenarios') {
      return send(res, 200, {
        current: state.scenario,
        scenarios: listScenarios().map((name) => ({ name, description: loadScenario(name).description })),
      });
    }

    if (req.method === 'GET' && path === '/__control/requests') {
      const after = Number(url.searchParams.get('after') ?? 0);
      return send(res, 200, state.log.filter((entry) => entry.seq > after));
    }

    if (req.method === 'POST' && path === '/__control/reset') {
      resetCounters(state.scenario);
      state.log = [];
      state.seq = 0;
      state.responses = 0;
      return send(res, 200, { reset: true, scenario: state.scenario });
    }

    if (req.method === 'GET' && (path === '/' || path === '/health')) return send(res, 200, { ok: true });

    return send(res, 404, { error: { message: `No route for ${req.method} ${path}`, type: 'not_found' } });
  }

  if (!existsSync(scenarioDir)) throw new Error(`Scenario directory not found: ${scenarioDir}`);

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      send(res, error.status ?? 500, { error: { message: error.message ?? 'internal error' } });
    });
  });

  return new Promise((resolveServer) => {
    server.listen(port, '0.0.0.0', () => resolveServer(server));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startFakeResponsesServer();
  const address = server.address();
  // Names and counts only: never a key, header or body.
  console.log(`fake-responses-server listening on :${typeof address === 'object' && address ? address.port : '?'}`);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
