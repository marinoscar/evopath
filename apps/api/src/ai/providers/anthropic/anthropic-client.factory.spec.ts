import { AiError } from '../../core/ai-error';
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_TIMEOUT_MS,
  AnthropicClientFactory,
} from './anthropic-client.factory';

describe('AnthropicClientFactory', () => {
  const ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_LOG'] as const;
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
    const client = new AnthropicClientFactory().create({ apiKey: 'sk-ant-test', requestId: 'r1' });

    expect(client.maxRetries).toBe(0);
    expect(client.timeout).toBe(ANTHROPIC_DEFAULT_TIMEOUT_MS);
  });

  it('uses the per-call key and base URL', () => {
    const client = new AnthropicClientFactory({ timeoutMs: 5_000 }).create({
      apiKey: 'sk-ant-call',
      baseUrl: 'https://gateway.example.com',
      requestId: 'r1',
    });

    expect(client.apiKey).toBe('sk-ant-call');
    expect(client.baseURL).toBe('https://gateway.example.com');
    expect(client.timeout).toBe(5_000);
  });

  it('ignores ambient ANTHROPIC_* credentials and endpoint', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    process.env.ANTHROPIC_AUTH_TOKEN = 'bearer-from-env';
    process.env.ANTHROPIC_BASE_URL = 'https://env.example.com';

    const client = new AnthropicClientFactory().create({ apiKey: 'sk-ant-call', requestId: 'r1' });

    expect(client.apiKey).toBe('sk-ant-call');
    expect(client.authToken).toBeNull();
    expect(client.baseURL).toBe(ANTHROPIC_DEFAULT_BASE_URL);
  });

  it('rejects an empty key as AI_KEY_INVALID without building a client', () => {
    let caught: unknown;

    try {
      new AnthropicClientFactory().create({ apiKey: '  ', requestId: 'r1' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AiError);
    expect((caught as AiError).code).toBe('AI_KEY_INVALID');
  });
});
