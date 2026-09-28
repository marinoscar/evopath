import { AiError } from '../../core/ai-error';
import {
  GEMINI_DEFAULT_BASE_URL,
  GEMINI_DEFAULT_TIMEOUT_MS,
  GeminiClientFactory,
  GeminiFetch,
} from './gemini-client.factory';

/** A fetch that records every request and answers an empty model list. */
function recordingFetch() {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetch: GeminiFetch = async (input, init) => {
    calls.push({ url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers) });

    return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  return { calls, fetch };
}

describe('GeminiClientFactory', () => {
  const ENV_KEYS = [
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_GEMINI_BASE_URL',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_GENAI_USE_ENTERPRISE',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
  ] as const;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('sends the per-call key to the default Gemini API host, v1beta', async () => {
    const { calls, fetch } = recordingFetch();
    const client = new GeminiClientFactory({ fetch }).create({ apiKey: 'AIza-call', requestId: 'r1' });

    await client.models.list({ config: { pageSize: 1 } });

    expect(calls).toHaveLength(1);
    expect(calls[0].url.startsWith(`${GEMINI_DEFAULT_BASE_URL}/v1beta/models`)).toBe(true);
    expect(calls[0].headers.get('x-goog-api-key')).toBe('AIza-call');
    expect(client.vertexai).toBe(false);
  });

  it('uses the per-call base URL', async () => {
    const { calls, fetch } = recordingFetch();
    const client = new GeminiClientFactory({ fetch, timeoutMs: 5_000 }).create({
      apiKey: 'AIza-call',
      baseUrl: 'https://gateway.example.com',
      requestId: 'r1',
    });

    await client.models.list({ config: { pageSize: 1 } });

    expect(calls[0].url.startsWith('https://gateway.example.com/v1beta/models')).toBe(true);
  });

  it('ignores ambient GOOGLE_* / GEMINI_* credentials, endpoint and Vertex switch', async () => {
    process.env.GOOGLE_API_KEY = 'AIza-from-env';
    process.env.GEMINI_API_KEY = 'AIza-from-env-2';
    process.env.GOOGLE_GEMINI_BASE_URL = 'https://env.example.com';
    process.env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
    process.env.GOOGLE_CLOUD_PROJECT = 'someone-elses-project';

    const { calls, fetch } = recordingFetch();
    const client = new GeminiClientFactory({ fetch }).create({ apiKey: 'AIza-call', requestId: 'r1' });

    await client.models.list({ config: { pageSize: 1 } });

    expect(client.vertexai).toBe(false);
    expect(calls[0].url.startsWith(GEMINI_DEFAULT_BASE_URL)).toBe(true);
    expect(calls[0].headers.get('x-goog-api-key')).toBe('AIza-call');
  });

  it('never retries — retries are the caller’s job', async () => {
    let attempts = 0;
    const fetch: GeminiFetch = async () => {
      attempts += 1;

      return new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'busy' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new GeminiClientFactory({ fetch }).create({ apiKey: 'AIza-call', requestId: 'r1' });

    await expect(client.models.list({ config: { pageSize: 1 } })).rejects.toBeDefined();
    expect(attempts).toBe(1);
  });

  it('exposes the per-request timeout', () => {
    expect(new GeminiClientFactory().timeoutMs).toBe(GEMINI_DEFAULT_TIMEOUT_MS);
    expect(new GeminiClientFactory({ timeoutMs: 1234 }).timeoutMs).toBe(1234);
  });

  it('rejects an empty key as AI_KEY_INVALID without building a client', () => {
    let caught: unknown;

    try {
      new GeminiClientFactory().create({ apiKey: '  ', requestId: 'r1' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AiError);
    expect((caught as AiError).code).toBe('AI_KEY_INVALID');
  });
});
