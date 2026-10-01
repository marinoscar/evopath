#!/usr/bin/env node
// =============================================================================
// Fake OpenAI-compatible vision server for "Scan gym" (E3.4), "Prefill
// from photo" (E4.5), "Read from photo" body metrics, PDFs included
// (E2.6, H2 #186) and lab report reading (H4 #188). TEST-ONLY.
// =============================================================================
//
// A dependency-free `node:http` server the API reaches as its
// OpenAI-compatible provider (API style `chat_completions`, "requires key"
// off), so owner testing and e2e exercise the real gate pipeline, storage
// resolution and job path with no key, no cost and a deterministic answer.
//
//   GET  /v1/models              `fake-vision` (vision + structured output), plus the
//                                adaptation roles: `fake-planner`, `fake-critic`
//                                (text + structured output) and `fake-text-only`
//   POST /v1/chat/completions    a chat completion whose message content is
//                                the chosen fixture's `*.model-output.json`
//   POST /__control/next         { "fixture": "cardio-row-wide" | "leg-curl-placard" | "both"
//                                  | "workout-placard" | "workout-notebook" | "workout-empty"
//                                  | "body-metric-scale" | "body-metric-smart-scale-report"
//                                  | "lab-report-panel" }
//                                answers the NEXT completion with it (one-shot)
//   GET  /__control/requests     [{ model, imageCount, fileCount, hasResponseFormat }] per
//                                completion received — never bytes, file names or URLs
//   POST /__control/reset        forget the queue, the request log and the call counters
//
// Quick adaptation and the hotel scan (E6.4), scenarios in
// `fake-adaptation-scenarios.mjs`: a completion is routed on
// `response_format.json_schema.name` (`training_adaptation_proposal`,
// `training_adaptation_critique`, `gym_equipment_scan`), and the planner's
// answer is COMPUTED from the `<context-json>` block of the request.
//
//   POST /__control/scenario     { "name": "valid" | "critic-revise" | ... } (resets the counters)
//   GET  /__control/scenario     { current, scenarios: [{ name, description }] }
//   GET  /__control/log          one entry per completion: { seq, scenario, schemaName, model,
//                                imageCount, status, text } (?after=<seq>); `text` is the
//                                message text (no image bytes), so a test can assert what was
//                                NOT sent: a PII canary, a gym name, a photo
//
// AI Coach (E7.13), answers in `fake-coach-scenarios.mjs`: `coach_nudge` and
// `coach_weekly_review` by schema name, and a chat turn (a request carrying the
// `get_training_signals` tool) as a tool call then an answer; model `fake-coach`
// (classify it responses, structured_output, tools and streaming).
//
//   POST /__control/coach        { "nudge": "send" | "decline", "speech": "ok" | "fail" | "refuse" }
//                                (reset by /__control/reset)
//   POST /v1/audio/speech        valid silent MP3 (> 1 KiB); the `openai` provider is the one that
//                                speaks, see fake-responses-server.mjs
//
// The scenario is global to the process; a `SCENARIO:<name>` token in a
// request's free text overrides it for that request. The default is `valid`.
//
// Without a queued fixture: a `body_metric_reading` request (by schema name) is
// answered `body-metric-smart-scale-report` when it carries a file (PDF) part,
// else `body-metric-scale`; a `lab_report` request `lab-report-panel` (PDF or
// page photos alike); anything else `cardio-row-wide` for one image, `both`
// for two or more (and for none).
//
// Fixtures are read from FIXTURE_DIR (default: apps/api/test/fixtures next to
// this repository): the gym scan answers from its `gym-scan/` folder, the
// workout prefill answers from `workout-prefill/`, the body-metric answers
// from `body-metric/`, the lab report answer from `lab-report/`. PORT
// defaults to 4010. The
// compose overlay `infra/compose/fake-ai.compose.yml` runs it as service
// `fake-ai`.
// =============================================================================

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COACH_NUDGE_SCHEMA,
  COACH_WEEKLY_REVIEW_SCHEMA,
  NUDGE_MODES,
  SPEECH_MODES,
  SPEECH_REFUSAL,
  coachChatTurn,
  fakeSpeech,
  isCoachChat,
  nudgeAnswer,
  parseNudgeContext,
  weeklyReviewAnswer,
} from './fake-coach-scenarios.mjs';
import {
  SCENARIOS,
  SCENARIO_NAMES,
  SCHEMA_CRITIQUE,
  SCHEMA_PROPOSAL,
  SCHEMA_SCAN,
  SLOW_DELAY_MS,
  RATE_LIMIT_RETRY_AFTER_SECONDS,
  critiqueAnswer,
  effectiveScenario,
  isScanScenario,
  parseContext,
  parseCriticNotes,
  proposalAnswer,
  scanAnswer,
  usageFor,
} from './fake-adaptation-scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = process.env.FIXTURE_DIR ?? resolve(HERE, '../../../apps/api/test/fixtures');
const PORT = Number(process.env.PORT ?? 4010);
const MODEL_ID = 'fake-vision';
/** Listed by /v1/models: the vision model first, then the adaptation roles. */
export const MODEL_IDS = [MODEL_ID, 'fake-planner', 'fake-critic', 'fake-text-only', 'fake-coach'];
/** Fixture name -> its `*.model-output.json` path under FIXTURE_DIR, without the suffix. */
const FIXTURE_FILES = {
  'cardio-row-wide': 'gym-scan/cardio-row-wide',
  'leg-curl-placard': 'gym-scan/leg-curl-placard',
  both: 'gym-scan/both',
  'workout-placard': 'workout-prefill/placard',
  'workout-notebook': 'workout-prefill/notebook',
  'workout-empty': 'workout-prefill/workout-empty',
  'body-metric-scale': 'body-metric/scale-display',
  'body-metric-smart-scale-report': 'body-metric/smart-scale-report',
  'lab-report-panel': 'lab-report/lipid-glucose-panel',
};
/** The body-metric reading's structured-output name (`ai.health.body_metric_reading`). */
const SCHEMA_BODY_METRIC = 'body_metric_reading';
/** The lab report reading's structured-output name (`ai.health.lab_report`, H4 #188). */
const SCHEMA_LAB_REPORT = 'lab_report';
const FIXTURES = Object.keys(FIXTURE_FILES);
/** A request body this big is refused (inline images are base64). */
const MAX_BODY_BYTES = 200 * 1024 * 1024;

const state = { next: null, requests: [], counter: 0, scenario: 'valid', plannerCalls: 0, criticCalls: 0, adaptCalls: 0, log: [], seq: 0, coach: { nudge: 'send', speech: 'ok' } };

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function resetCounters(scenario) {
  state.scenario = scenario;
  state.plannerCalls = 0;
  state.criticCalls = 0;
  state.adaptCalls = 0;
}

function loadFixture(name) {
  return readFileSync(join(FIXTURE_DIR, `${FIXTURE_FILES[name]}.model-output.json`), 'utf8');
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req) {
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
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Image parts across every message (`image_url` in Chat Completions; `input_image` tolerated). */
export function countImages(body) {
  let count = 0;

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'image_url' || part?.type === 'input_image' || part?.type === 'image') count += 1;
    }
  }

  return count;
}

/** File parts (a PDF) across every message (`file` in Chat Completions; `input_file` tolerated). */
export function countFiles(body) {
  let count = 0;

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'file' || part?.type === 'input_file') count += 1;
    }
  }

  return count;
}

/** The text of every message (`user` only when `role` is given); image parts are skipped. */
export function messageText(body, role = null) {
  const parts = [];

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (role && message?.role !== role) continue;
    if (typeof message?.content === 'string') parts.push(message.content);
    else if (Array.isArray(message?.content)) {
      for (const part of message.content) if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    }
  }

  return parts.join('\n');
}

export function chooseFixture(queued, imageCount, schemaName = null, fileCount = 0) {
  if (queued) return queued;
  if (schemaName === SCHEMA_BODY_METRIC) return fileCount > 0 ? 'body-metric-smart-scale-report' : 'body-metric-scale';
  if (schemaName === SCHEMA_LAB_REPORT) return 'lab-report-panel';
  return imageCount === 1 ? 'cardio-row-wide' : 'both';
}

function completion(body, content, scripted = null) {
  state.counter += 1;
  const promptTokens = scripted?.promptTokens ?? 1000;
  const completionTokens = scripted?.completionTokens ?? Math.ceil(content.length / 4);

  return {
    id: `chatcmpl-fake-${state.counter}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: typeof body.model === 'string' ? body.model : MODEL_ID,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, refusal: null },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && path === '/v1/models') {
    return send(res, 200, {
      object: 'list',
      data: MODEL_IDS.map((id) => ({ id, object: 'model', created: 0, owned_by: 'fake' })),
    });
  }

  if (req.method === 'POST' && path === '/v1/chat/completions') {
    const body = await readJson(req);
    const imageCount = countImages(body);
    const fileCount = countFiles(body);
    const schemaName = typeof body.response_format?.json_schema?.name === 'string' ? body.response_format.json_schema.name : null;
    const allText = messageText(body);
    const userText = messageText(body, 'user');
    const scenario = effectiveScenario(state.scenario, allText);
    const model = typeof body.model === 'string' ? body.model : null;
    const entry = { seq: (state.seq += 1), scenario, schemaName, model, imageCount, status: 200, text: allText };
    state.log.push(entry);
    state.requests.push({ model, imageCount, fileCount, hasResponseFormat: Boolean(body.response_format) });

    if (body.stream) {
      entry.status = 400;
      return send(res, 400, { error: { message: 'The fake vision server does not stream.', type: 'invalid_request_error' } });
    }

    // The AI Coach (E7.13): the structured nudge and weekly review, and the chat tool loop.
    if (schemaName === COACH_NUDGE_SCHEMA) {
      const moment = parseNudgeContext(userText)?.moment ?? 'streak_at_risk';
      return send(res, 200, completion(body, JSON.stringify(nudgeAnswer(moment, state.coach.nudge))));
    }
    if (schemaName === COACH_WEEKLY_REVIEW_SCHEMA) {
      return send(res, 200, completion(body, JSON.stringify(weeklyReviewAnswer())));
    }
    if (isCoachChat(body)) {
      const turn = coachChatTurn(body);
      const result = completion(body, turn.message.content ?? '');
      result.choices[0].message = turn.message;
      result.choices[0].finish_reason = turn.finish;
      return send(res, 200, result);
    }

    // The adaptation planner and critic.
    if (schemaName === SCHEMA_PROPOSAL || schemaName === SCHEMA_CRITIQUE) {
      state.adaptCalls += 1;
      if (scenario === 'slow') await sleep(SLOW_DELAY_MS);

      if (scenario === 'rate-limit' && state.adaptCalls === 1) {
        entry.status = 429;
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(RATE_LIMIT_RETRY_AFTER_SECONDS) });
        return res.end(JSON.stringify({ error: { message: 'Rate limit reached for the fake model.', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }));
      }

      if (schemaName === SCHEMA_CRITIQUE) {
        state.criticCalls += 1;
        const content = JSON.stringify(critiqueAnswer(scenario, state.criticCalls));
        return send(res, 200, completion(body, content, usageFor(schemaName, scenario, state.plannerCalls)));
      }

      state.plannerCalls += 1;
      if (scenario === 'malformed') {
        return send(res, 200, completion(body, '{"title": "Adjusted workout", "exercises": [', usageFor(schemaName, scenario, state.plannerCalls)));
      }
      const context = parseContext(userText);
      if (!context) {
        entry.status = 400;
        return send(res, 400, { error: { message: 'The request carries no <context-json> block.', type: 'invalid_request_error' } });
      }
      const content = JSON.stringify(proposalAnswer(scenario, context, parseCriticNotes(userText)));
      return send(res, 200, completion(body, content, usageFor(schemaName, scenario, state.plannerCalls)));
    }

    // The hotel scan scenarios; anything else falls back to the fixtures below.
    if (schemaName === SCHEMA_SCAN && !state.next && isScanScenario(scenario)) {
      return send(res, 200, completion(body, JSON.stringify(scanAnswer(scenario, imageCount))));
    }

    const fixture = chooseFixture(state.next, imageCount, schemaName, fileCount);
    state.next = null;
    const content = JSON.stringify(JSON.parse(loadFixture(fixture)));
    return send(res, 200, completion(body, content));
  }

  // Fake speech (E7.13). The `openai` provider normally speaks; this lets a custom setup try it here too.
  if (req.method === 'POST' && path === '/v1/audio/speech') {
    await readJson(req);
    if (state.coach.speech === 'fail') return send(res, 500, { error: { message: 'The fake speech model is set to fail.', type: 'server_error' } });
    if (state.coach.speech === 'refuse') return send(res, 400, SPEECH_REFUSAL);
    const audio = fakeSpeech();
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length });
    return res.end(audio);
  }

  if (req.method === 'POST' && path === '/__control/coach') {
    const body = await readJson(req);
    if (body.nudge !== undefined && !NUDGE_MODES.includes(body.nudge)) return send(res, 400, { error: `nudge must be one of ${NUDGE_MODES.join(', ')}` });
    if (body.speech !== undefined && !SPEECH_MODES.includes(body.speech)) return send(res, 400, { error: `speech must be one of ${SPEECH_MODES.join(', ')}` });
    state.coach = { ...state.coach, ...(body.nudge ? { nudge: body.nudge } : {}), ...(body.speech ? { speech: body.speech } : {}) };
    return send(res, 200, state.coach);
  }

  if (req.method === 'POST' && path === '/__control/scenario') {
    const body = await readJson(req);
    if (!SCENARIO_NAMES.includes(body.name)) {
      return send(res, 400, { error: `name must be one of ${SCENARIO_NAMES.join(', ')}` });
    }
    resetCounters(body.name);
    return send(res, 200, { scenario: state.scenario });
  }

  if (req.method === 'GET' && path === '/__control/scenario') {
    return send(res, 200, {
      current: state.scenario,
      scenarios: SCENARIO_NAMES.map((name) => ({ name, description: SCENARIOS[name] })),
    });
  }

  if (req.method === 'GET' && path === '/__control/log') {
    const after = Number(url.searchParams.get('after') ?? 0);
    return send(res, 200, state.log.filter((entry) => entry.seq > after));
  }

  if (req.method === 'POST' && path === '/__control/next') {
    const body = await readJson(req);
    if (!FIXTURES.includes(body.fixture)) {
      return send(res, 400, { error: `fixture must be one of ${FIXTURES.join(', ')}` });
    }
    state.next = body.fixture;
    return send(res, 200, { next: state.next });
  }

  if (req.method === 'GET' && path === '/__control/requests') {
    return send(res, 200, state.requests);
  }

  if (req.method === 'POST' && path === '/__control/reset') {
    state.next = null;
    state.requests = [];
    state.log = [];
    state.seq = 0;
    state.coach = { nudge: 'send', speech: 'ok' };
    resetCounters(state.scenario);
    return send(res, 200, { reset: true });
  }

  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: { message: `No route for ${req.method} ${path}`, type: 'not_found' } });
}

export function startFakeVisionServer(port = PORT) {
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
  const server = await startFakeVisionServer();
  const address = server.address();
  console.log(`fake-vision-server listening on :${typeof address === 'object' && address ? address.port : PORT} (fixtures: ${FIXTURE_DIR})`);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
