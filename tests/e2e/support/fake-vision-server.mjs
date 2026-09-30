#!/usr/bin/env node
// =============================================================================
// Fake OpenAI-compatible vision server for "Scan gym" (E3.4) and "Prefill
// from photo" (E4.5). TEST-ONLY.
// =============================================================================
//
// A dependency-free `node:http` server the API reaches as its
// OpenAI-compatible provider (API style `chat_completions`, "requires key"
// off), so owner testing and e2e exercise the real gate pipeline, storage
// resolution and job path with no key, no cost and a deterministic answer.
//
//   GET  /v1/models              one model, `fake-vision`
//   POST /v1/chat/completions    a chat completion whose message content is
//                                the chosen fixture's `*.model-output.json`
//   POST /__control/next         { "fixture": "cardio-row-wide" | "leg-curl-placard" | "both"
//                                  | "workout-placard" | "workout-notebook" | "workout-empty" }
//                                answers the NEXT completion with it (one-shot)
//   GET  /__control/requests     [{ model, imageCount, hasResponseFormat }] per
//                                completion received — never bytes or URLs
//   POST /__control/reset        forget the queue and the request log
//
// Without a queued fixture: `cardio-row-wide` for one image, `both` for two or
// more (and for none).
//
// Fixtures are read from FIXTURE_DIR (default: apps/api/test/fixtures next to
// this repository): the gym scan answers from its `gym-scan/` folder, the
// workout prefill answers from `workout-prefill/`. PORT defaults to 4010. The
// compose overlay `infra/compose/fake-ai.compose.yml` runs it as service
// `fake-ai`.
// =============================================================================

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = process.env.FIXTURE_DIR ?? resolve(HERE, '../../../apps/api/test/fixtures');
const PORT = Number(process.env.PORT ?? 4010);
const MODEL_ID = 'fake-vision';
/** Fixture name -> its `*.model-output.json` path under FIXTURE_DIR, without the suffix. */
const FIXTURE_FILES = {
  'cardio-row-wide': 'gym-scan/cardio-row-wide',
  'leg-curl-placard': 'gym-scan/leg-curl-placard',
  both: 'gym-scan/both',
  'workout-placard': 'workout-prefill/placard',
  'workout-notebook': 'workout-prefill/notebook',
  'workout-empty': 'workout-prefill/workout-empty',
};
const FIXTURES = Object.keys(FIXTURE_FILES);
/** A request body this big is refused (inline images are base64). */
const MAX_BODY_BYTES = 200 * 1024 * 1024;

const state = { next: null, requests: [], counter: 0 };

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

export function chooseFixture(queued, imageCount) {
  if (queued) return queued;
  return imageCount === 1 ? 'cardio-row-wide' : 'both';
}

function completion(body, content) {
  state.counter += 1;
  const promptTokens = 1000;
  const completionTokens = Math.ceil(content.length / 4);

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
      data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'fake' }],
    });
  }

  if (req.method === 'POST' && path === '/v1/chat/completions') {
    const body = await readJson(req);
    const imageCount = countImages(body);
    const fixture = chooseFixture(state.next, imageCount);
    state.next = null;
    state.requests.push({
      model: typeof body.model === 'string' ? body.model : null,
      imageCount,
      hasResponseFormat: Boolean(body.response_format),
    });

    if (body.stream) {
      return send(res, 400, { error: { message: 'The fake vision server does not stream.', type: 'invalid_request_error' } });
    }

    const content = JSON.stringify(JSON.parse(loadFixture(fixture)));
    return send(res, 200, completion(body, content));
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
