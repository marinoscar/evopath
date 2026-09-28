import { describe, expect, it } from 'vitest';

import {
  GOOGLE_TOKEN_ENDPOINT,
  INVALID_PROBE_CODE,
  checkCallbackUrl,
  checkClientIdShape,
  classifyTokenResponse,
  expectedCallbackUrl,
  probeGoogleCredentials,
  runOAuthCheck,
} from './oauth-check.js';

const CLIENT_ID = '123456789012-abc123def456.apps.googleusercontent.com';
const SECRET = 'GOCSPX-this-is-the-secret-value';
const CALLBACK = 'https://app.example.test/api/auth/google/callback';

function answering(status: number, body: unknown): { fetch: typeof globalThis.fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('classifyTokenResponse', () => {
  it('reads invalid_grant as a PASS: the client was accepted, only the code was not', () => {
    expect(classifyTokenResponse(400, { error: 'invalid_grant' }, CALLBACK).status).toBe('pass');
  });

  it.each(['invalid_client', 'unauthorized_client'])('reads %s as a FAIL', (error) => {
    const finding = classifyTokenResponse(401, { error }, CALLBACK);
    expect(finding.status).toBe('fail');
    expect(finding.remedy).toBeDefined();
  });

  it('reads redirect_uri_mismatch as a FAIL naming the redirect URI', () => {
    const finding = classifyTokenResponse(400, { error: 'redirect_uri_mismatch' }, CALLBACK);
    expect(finding.status).toBe('fail');
    expect(finding.remedy).toContain(CALLBACK);
  });

  it('reads anything else as a WARNING, never a failure', () => {
    expect(classifyTokenResponse(500, undefined, CALLBACK).status).toBe('warn');
    expect(classifyTokenResponse(400, { error: 'invalid_request' }, CALLBACK).status).toBe('warn');
  });
});

describe('probeGoogleCredentials', () => {
  it('posts a form-encoded authorization_code grant with a deliberately invalid code', async () => {
    const { fetch, calls } = answering(400, { error: 'invalid_grant' });
    const finding = await probeGoogleCredentials({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      redirectUri: CALLBACK,
      fetch,
    });

    expect(finding.status).toBe('pass');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(calls[0]?.init?.method).toBe('POST');
    const body = new URLSearchParams(String(calls[0]?.init?.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe(INVALID_PROBE_CODE);
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('client_secret')).toBe(SECRET);
    expect(body.get('redirect_uri')).toBe(CALLBACK);
  });

  it('turns a network failure into a warning that does not carry the secret', async () => {
    const fetch = (async () => {
      throw new TypeError(`fetch failed while sending client_secret=${SECRET}`, {
        cause: { code: 'ENOTFOUND' },
      });
    }) as unknown as typeof globalThis.fetch;

    const finding = await probeGoogleCredentials({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      redirectUri: CALLBACK,
      fetch,
    });

    expect(finding.status).toBe('warn');
    expect(finding.detail).toContain('ENOTFOUND');
    expect(JSON.stringify(finding)).not.toContain(SECRET);
  });

  it('never puts the secret in a failure finding', async () => {
    const { fetch } = answering(401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
    const finding = await probeGoogleCredentials({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUri: CALLBACK, fetch });
    expect(finding.status).toBe('fail');
    expect(JSON.stringify(finding)).not.toContain(SECRET);
  });
});

describe('checkClientIdShape', () => {
  it('passes a well-formed client id', () => {
    expect(checkClientIdShape(CLIENT_ID).status).toBe('pass');
  });

  it('fails a malformed one, and only warns when lenient (--skip-oauth-check)', () => {
    expect(checkClientIdShape('e2e-google-client-id').status).toBe('fail');
    expect(checkClientIdShape('e2e-google-client-id', { lenient: true }).status).toBe('warn');
    expect(checkClientIdShape('').status).toBe('fail');
  });
});

describe('checkCallbackUrl', () => {
  it('derives the expected callback the way the wizard does', () => {
    expect(expectedCallbackUrl('app.example.test')).toBe(CALLBACK);
  });

  it('passes only an exact match', () => {
    expect(checkCallbackUrl(CALLBACK, 'app.example.test').status).toBe('pass');
    expect(checkCallbackUrl(`${CALLBACK}/`, 'app.example.test').status).toBe('fail');
    expect(checkCallbackUrl(CALLBACK.replace('https', 'http'), 'app.example.test').status).toBe('fail');
    const missing = checkCallbackUrl(undefined, 'app.example.test');
    expect(missing.status).toBe('fail');
    expect(missing.remedy).toContain(CALLBACK);
  });
});

describe('runOAuthCheck', () => {
  const env = new Map([
    ['GOOGLE_CLIENT_ID', CLIENT_ID],
    ['GOOGLE_CLIENT_SECRET', SECRET],
    ['GOOGLE_CALLBACK_URL', CALLBACK],
  ]);

  it('runs all three layers and passes on invalid_grant', async () => {
    const { fetch, calls } = answering(400, { error: 'invalid_grant' });
    const result = await runOAuthCheck({ env, domain: 'app.example.test', fetch });
    expect(result.ok).toBe(true);
    expect(result.findings.map((finding) => finding.status)).toEqual(['pass', 'pass', 'pass']);
    expect(calls).toHaveLength(1);
  });

  it('fails on invalid_client', async () => {
    const { fetch } = answering(401, { error: 'invalid_client' });
    const result = await runOAuthCheck({ env, domain: 'app.example.test', fetch });
    expect(result.ok).toBe(false);
  });

  it('does not probe at all with --skip-oauth-check, and a malformed id only warns', async () => {
    const { fetch, calls } = answering(400, { error: 'invalid_grant' });
    const result = await runOAuthCheck({
      env: new Map([...env, ['GOOGLE_CLIENT_ID', 'e2e-google-client-id']]),
      skipLiveProbe: true,
      fetch,
    });
    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(true);
    expect(result.findings[0]?.status).toBe('warn');
  });

  it('does not probe when a cheaper layer already failed', async () => {
    const { fetch, calls } = answering(400, { error: 'invalid_grant' });
    const result = await runOAuthCheck({
      env: new Map([...env, ['GOOGLE_CALLBACK_URL', 'https://wrong.example.test/cb']]),
      domain: 'app.example.test',
      fetch,
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('treats an unreachable Google as a warning, not a failure', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof globalThis.fetch;
    const result = await runOAuthCheck({ env, domain: 'app.example.test', fetch });
    expect(result.ok).toBe(true);
    expect(result.findings[2]?.status).toBe('warn');
  });
});
