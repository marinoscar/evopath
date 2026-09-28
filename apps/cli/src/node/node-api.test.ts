import { describe, expect, it } from 'vitest';

import type { FetchLike } from '../api-client.js';
import { ApiClient } from '../api-client.js';
import { HttpNodeApi, claimTokenBody } from './node-api.js';

// =============================================================================
// HttpNodeApi — the claim token on the wire  (issue #364, epic #254)
// =============================================================================
//
// ⚠ EVERY ASSERTION ABOUT THE TOKEN IS MADE AGAINST THE SERIALISED BODY
// STRING, never against an object literal, and that is the whole point of this
// file. The bug this suite exists to prevent is invisible in the object:
// `{ claimToken: undefined }` and `{}` are indistinguishable with `toEqual`,
// while `JSON.stringify` — which is what `ApiClient` actually sends — drops
// the first and would have written the second as a key had the value been
// `null`. The server reads three distinct states off that key (absent, a uuid,
// `null`), so the only test that can tell them apart is one that reads the
// same bytes the server will.
//
// No socket is opened: `fetch` is injected, exactly as in `api-client.test.ts`.
// =============================================================================

const NODE = 'node-1';
const JOB = 'job-1';
const TOKEN = '7b0d9a1e-3c5f-4a8b-9d2e-6f1c4b8a0e35';

interface Recorded {
  url: string;
  /** EXACTLY what would go down the socket, before anybody re-parses it. */
  body: string | undefined;
}

function harness(payload: unknown = {}): { api: HttpNodeApi; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: FetchLike = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(JSON.stringify({ data: payload }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as FetchLike;

  return { api: new HttpNodeApi(new ApiClient({ baseUrl: 'http://h/api', fetch })), calls };
}

/** The serialised body of the one call this harness recorded. */
function sentBody(calls: Recorded[]): string {
  expect(calls).toHaveLength(1);
  return calls[0]?.body ?? '';
}

describe('claimTokenBody', () => {
  it('yields the key for a token', () => {
    expect(claimTokenBody(TOKEN)).toEqual({ claimToken: TOKEN });
  });

  it('OMITS the key for `null`, `undefined` and an empty string', () => {
    // `null` is the case that matters: it is what the server sends for a row
    // claimed before `claim_token` existed, and spelling it back would assert
    // `claim_token IS NULL` — a different, and wrong, statement.
    for (const empty of [null, undefined, '']) {
      const body = claimTokenBody(empty);
      expect(body).toEqual({});
      expect(Object.keys(body)).toHaveLength(0);
      expect(JSON.stringify(body)).toBe('{}');
    }
  });
});

describe('HttpNodeApi — quoting the claim', () => {
  it('sends the token on renew, result and failure', async () => {
    for (const call of [
      (api: HttpNodeApi) => api.renewLease(NODE, JOB, TOKEN),
      (api: HttpNodeApi) => api.submitResult(NODE, JOB, 'example.checksum', { ok: true }, TOKEN),
      (api: HttpNodeApi) => api.reportJobFailure(NODE, JOB, { error: 'boom' }, TOKEN),
    ]) {
      const h = harness();
      await call(h.api);
      expect(JSON.parse(sentBody(h.calls))).toMatchObject({ claimToken: TOKEN });
    }
  });

  it('sends the token on the data plane and the secret broker', async () => {
    for (const call of [
      (api: HttpNodeApi) => api.downloadUrl(NODE, JOB, TOKEN),
      (api: HttpNodeApi) => api.uploadUrl(NODE, JOB, 'application/octet-stream', TOKEN),
      (api: HttpNodeApi) => api.jobSecret(NODE, JOB, TOKEN),
    ]) {
      const h = harness();
      await call(h.api);
      expect(JSON.parse(sentBody(h.calls))).toMatchObject({ claimToken: TOKEN });
    }
  });

  it('keeps the rest of each body intact around the token', async () => {
    const h = harness();
    await h.api.submitResult(NODE, JOB, 'example.checksum', { sha256: 'abc' }, TOKEN);
    expect(JSON.parse(sentBody(h.calls))).toEqual({
      type: 'example.checksum',
      result: { sha256: 'abc' },
      claimToken: TOKEN,
    });

    const f = harness();
    await f.api.reportJobFailure(NODE, JOB, { error: 'boom', rateLimited: true, retryAfterMs: 5 }, TOKEN);
    expect(JSON.parse(sentBody(f.calls))).toEqual({
      error: 'boom',
      rateLimited: true,
      retryAfterMs: 5,
      claimToken: TOKEN,
    });

    const u = harness();
    await u.api.uploadUrl(NODE, JOB, 'application/octet-stream', TOKEN);
    expect(JSON.parse(sentBody(u.calls))).toEqual({
      contentType: 'application/octet-stream',
      claimToken: TOKEN,
    });
  });

  it('OMITS the key from the SERIALISED body when the assignment carried `null`', async () => {
    // The pre-#361 row. Asserted on the string because the parsed object
    // cannot distinguish "absent" from "present and undefined" — and the
    // difference between them is the entire fix.
    for (const call of [
      (api: HttpNodeApi) => api.renewLease(NODE, JOB, null),
      (api: HttpNodeApi) => api.submitResult(NODE, JOB, 'example.checksum', { ok: true }, null),
      (api: HttpNodeApi) => api.reportJobFailure(NODE, JOB, { error: 'boom' }, null),
      (api: HttpNodeApi) => api.downloadUrl(NODE, JOB, null),
      (api: HttpNodeApi) => api.uploadUrl(NODE, JOB, undefined, null),
      (api: HttpNodeApi) => api.jobSecret(NODE, JOB, null),
    ]) {
      const h = harness();
      await call(h.api);
      const body = sentBody(h.calls);
      expect(body).not.toContain('claimToken');
      expect(body).not.toContain('null');
      expect(Object.keys(JSON.parse(body) as object)).not.toContain('claimToken');
    }
  });

  it('OMITS the key when no token was passed at all — an older server', async () => {
    // Forward compatibility downward: a new CLI against a control plane that
    // never heard of #364. The request is byte-for-byte the pre-#364 one, and
    // nothing about it is treated as an error.
    for (const call of [
      (api: HttpNodeApi) => api.renewLease(NODE, JOB),
      (api: HttpNodeApi) => api.downloadUrl(NODE, JOB),
      (api: HttpNodeApi) => api.jobSecret(NODE, JOB),
    ]) {
      const h = harness();
      await call(h.api);
      expect(sentBody(h.calls)).toBe('{}');
    }
  });

  it('reads `claimToken` off the assignment, as a sibling of `renewIntervalMs`', async () => {
    // It is assignment-level on the server DTO, deliberately NOT a member of
    // `job` — see `toNodeJobAssignment`. A client that looked for it under
    // `job` would silently find nothing and quote nothing.
    const h = harness({
      jobs: [
        {
          job: { id: JOB, type: 'example.checksum' },
          params: {},
          renewIntervalMs: 20_000,
          claimToken: TOKEN,
        },
      ],
    });

    const [assignment] = await h.api.claim(NODE, { limit: 1 });

    expect(assignment?.claimToken).toBe(TOKEN);
    expect(assignment?.job).not.toHaveProperty('claimToken');
  });
});
