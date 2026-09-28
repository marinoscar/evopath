import { AiError } from '../../core/ai-error';
import { OPENAI_DEFAULT_BASE_URL, OPENAI_DEFAULT_TIMEOUT_MS, OpenAiClientFactory } from './openai-client.factory';

describe('OpenAiClientFactory', () => {
  const ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID'] as const;
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

  it('disables SDK retries — retries are the caller’s job', () => {
    const client = new OpenAiClientFactory().create({ apiKey: 'sk-test', requestId: 'r1' });

    expect(client.maxRetries).toBe(0);
    expect(client.timeout).toBe(OPENAI_DEFAULT_TIMEOUT_MS);
  });

  it('uses the per-call key and base URL', () => {
    const client = new OpenAiClientFactory({ timeoutMs: 5_000 }).create({
      apiKey: 'sk-call',
      baseUrl: 'https://proxy.example.com/v1',
      requestId: 'r1',
    });

    expect(client.apiKey).toBe('sk-call');
    expect(client.baseURL).toBe('https://proxy.example.com/v1');
    expect(client.timeout).toBe(5_000);
  });

  it('ignores ambient OPENAI_* environment variables', () => {
    process.env.OPENAI_API_KEY = 'sk-from-env';
    process.env.OPENAI_BASE_URL = 'https://env.example.com/v1';
    process.env.OPENAI_ORG_ID = 'org-env';
    process.env.OPENAI_PROJECT_ID = 'proj-env';

    const client = new OpenAiClientFactory().create({ apiKey: 'sk-call', requestId: 'r1' });

    expect(client.apiKey).toBe('sk-call');
    expect(client.baseURL).toBe(OPENAI_DEFAULT_BASE_URL);
    expect(client.organization).toBeNull();
    expect(client.project).toBeNull();
  });

  it('rejects an empty key as AI_KEY_INVALID without building a client', () => {
    let caught: unknown;

    try {
      new OpenAiClientFactory().create({ apiKey: '  ', requestId: 'r1' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AiError);
    expect((caught as AiError).code).toBe('AI_KEY_INVALID');
  });
});
