import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  mockAiAdminConfig,
  mockAiModelList,
  mockAiProbeResultPassed,
  mockAiPublicConfigDisabled,
  mockAiResponse,
  mockAiRun,
  mockAiStreamEvents,
  mockUsableAiModels,
  mockUserAiKeys,
  toSseBody,
} from '../mocks/fixtures/ai';
import {
  AI_KEY_REMOVE_CONFIRMATION,
  aiAdminConfigToInput,
  aiModelLimitKey,
  withModelLimits,
  cancelAiRun,
  createAiResponse,
  createAiRun,
  deleteAiProviderKey,
  deleteUserAiKey,
  getAiAdminConfig,
  getAiConfig,
  getAiRun,
  listAiModels,
  listUsableAiModels,
  listUserAiKeys,
  refreshAiModels,
  setAiProviderKey,
  setUserAiKey,
  streamAiResponse,
  testAiProvider,
  testUserAiKey,
  updateAiAdminConfig,
  updateAiModel,
} from '../../services/ai';
import type { AiAdminConfigInput } from '../../services/ai';
import { ApiError } from '../../services/api';

/**
 * `services/ai.ts` — issue #425, epic #419. Every call against the default MSW
 * handlers (`mocks/handlers.ts`, fixtures in `mocks/fixtures/ai.ts`), plus
 * request capture where the wire shape is the contract: the `If-Match`
 * header, the `REMOVE` confirmation, "blank means use the stored key", the
 * model-list query string, and the streamed response.
 */

interface Captured {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

/** Record the next request to `method path` while answering with `reply`. */
function capture(
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  reply: unknown,
  status = 200,
): { request: () => Captured } {
  let captured: Captured | null = null;
  server.use(
    http[method](`*/api${path}`, async ({ request }) => {
      const text = await request.text();
      captured = {
        method: request.method,
        url: new URL(request.url),
        headers: request.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      return status === 204
        ? new HttpResponse(null, { status })
        : HttpResponse.json({ data: reply }, { status });
    }),
  );
  return {
    request: () => {
      if (!captured) throw new Error(`no ${method.toUpperCase()} ${path} was made`);
      return captured;
    },
  };
}

const adminInput: AiAdminConfigInput = {
  enabled: true,
  keyPolicy: 'byok',
  logPromptContent: false,
  defaults: { allowBackgroundRuns: true },
  providers: { openai: { enabled: true } },
};

describe('AI public config', () => {
  it('reads GET /ai/config — disabled by default in the fixtures', async () => {
    await expect(getAiConfig()).resolves.toEqual(mockAiPublicConfigDisabled);
  });
});

describe('AI administration', () => {
  it('reads the admin config', async () => {
    await expect(getAiAdminConfig()).resolves.toEqual(mockAiAdminConfig);
  });

  it('sends the expected version as If-Match on PUT', async () => {
    const spy = capture('put', '/admin/ai/config', mockAiAdminConfig);

    await updateAiAdminConfig(adminInput, 3);

    expect(spy.request().headers.get('If-Match')).toBe('3');
    expect(spy.request().body).toEqual(adminInput);
  });

  it('omits If-Match when no version is given', async () => {
    const spy = capture('put', '/admin/ai/config', mockAiAdminConfig);

    await updateAiAdminConfig(adminInput);

    expect(spy.request().headers.get('If-Match')).toBeNull();
  });

  it('surfaces a stale version as a 409 ApiError (default handler)', async () => {
    await expect(updateAiAdminConfig(adminInput, 1)).rejects.toMatchObject({ status: 409 });
  });

  it('stores an org key with PUT /admin/ai/providers/:p/key', async () => {
    const spy = capture('put', '/admin/ai/providers/:provider/key', mockAiAdminConfig);

    await setAiProviderKey('openai', 'sk-test-12345678');

    expect(spy.request().url.pathname).toMatch(/\/admin\/ai\/providers\/openai\/key$/);
    expect(spy.request().body).toEqual({ apiKey: 'sk-test-12345678' });
  });

  it('deletes an org key with the REMOVE confirmation body', async () => {
    const spy = capture('delete', '/admin/ai/providers/:provider/key', mockAiAdminConfig);

    await deleteAiProviderKey('openai');

    expect(spy.request().method).toBe('DELETE');
    expect(spy.request().body).toEqual({ confirmation: AI_KEY_REMOVE_CONFIRMATION });
    expect(AI_KEY_REMOVE_CONFIRMATION).toBe('REMOVE');
  });

  it('probes a provider with blank fields dropped, so the stored key is used', async () => {
    const spy = capture('post', '/admin/ai/providers/:provider/test', mockAiProbeResultPassed);

    await expect(testAiProvider('openai', { apiKey: '   ', baseUrl: '' })).resolves.toEqual(
      mockAiProbeResultPassed,
    );
    expect(spy.request().body).toEqual({});
  });

  it('sends a typed key and base URL when given', async () => {
    const spy = capture('post', '/admin/ai/providers/:provider/test', mockAiProbeResultPassed);

    await testAiProvider('openai', { apiKey: 'sk-new-12345678', baseUrl: 'https://proxy.example' });

    expect(spy.request().body).toEqual({
      apiKey: 'sk-new-12345678',
      baseUrl: 'https://proxy.example',
    });
  });

  it('lists models with no query string by default', async () => {
    const spy = capture('get', '/admin/ai/models', mockAiModelList);

    await expect(listAiModels()).resolves.toEqual(mockAiModelList);
    expect(spy.request().url.search).toBe('');
  });

  it('builds the model-list query from the filter', async () => {
    const spy = capture('get', '/admin/ai/models', mockAiModelList);

    await listAiModels({
      provider: 'openai',
      capability: 'vision',
      enabled: false,
      includeDeprecated: true,
      q: '  gpt ',
      page: 2,
      pageSize: 50,
    });

    const params = spy.request().url.searchParams;
    expect(Object.fromEntries(params)).toEqual({
      provider: 'openai',
      capability: 'vision',
      enabled: 'false',
      includeDeprecated: 'true',
      q: 'gpt',
      page: '2',
      pageSize: '50',
    });
  });

  it('patches a model and gets the updated row back', async () => {
    const updated = await updateAiModel('model-2', { enabled: true });
    expect(updated).toMatchObject({ id: 'model-2', enabled: true });
  });

  it('requests a catalogue refresh and returns the job id', async () => {
    const spy = capture('post', '/admin/ai/models/refresh', { jobId: 'job-9' });

    await expect(refreshAiModels('openai')).resolves.toEqual({ jobId: 'job-9' });
    expect(spy.request().body).toEqual({ provider: 'openai' });
  });
});

describe('AI — the caller’s own keys and models', () => {
  it('lists the caller’s keys', async () => {
    await expect(listUserAiKeys()).resolves.toEqual(mockUserAiKeys);
  });

  it('stores a key at PUT /ai/keys/:provider, URL-encoding the provider', async () => {
    const spy = capture('put', '/ai/keys/:provider', mockUserAiKeys[0]);

    await setUserAiKey('my provider', 'sk-user-12345678');

    expect(spy.request().url.pathname).toMatch(/\/ai\/keys\/my%20provider$/);
    expect(spy.request().body).toEqual({ apiKey: 'sk-user-12345678' });
  });

  it('deletes a key (204)', async () => {
    await expect(deleteUserAiKey('openai')).resolves.toBeUndefined();
  });

  it('tests the stored key when none is typed', async () => {
    const spy = capture('post', '/ai/keys/:provider/test', mockAiProbeResultPassed);

    await testUserAiKey('openai');

    expect(spy.request().body).toEqual({});
  });

  it('tests a typed key when one is given', async () => {
    const spy = capture('post', '/ai/keys/:provider/test', mockAiProbeResultPassed);

    await testUserAiKey('openai', 'sk-typed-12345678');

    expect(spy.request().body).toEqual({ apiKey: 'sk-typed-12345678' });
  });

  it('lists the models usable right now', async () => {
    await expect(listUsableAiModels()).resolves.toEqual(mockUsableAiModels);
  });
});

describe('AI — responses and runs', () => {
  it('creates a non-streamed response', async () => {
    await expect(createAiResponse({ input: 'hi' })).resolves.toEqual(mockAiResponse);
  });

  it('starts, reads and cancels a background run', async () => {
    await expect(createAiRun({ input: 'hi' })).resolves.toEqual({
      runId: mockAiRun.id,
      jobId: 'job-ai-run-1',
    });
    await expect(getAiRun('run_7')).resolves.toMatchObject({ id: 'run_7', status: 'succeeded' });
    await expect(cancelAiRun('run_7')).resolves.toMatchObject({ id: 'run_7', status: 'cancelled' });
  });

  it('surfaces AI_DISABLED from a gated route as an ApiError with its code', async () => {
    server.use(
      http.post('*/api/ai/responses', () =>
        HttpResponse.json(
          { code: 'AI_DISABLED', message: 'AI is disabled', details: { reason: 'AI_DISABLED' } },
          { status: 403 },
        ),
      ),
    );

    await expect(createAiResponse({ input: 'hi' })).rejects.toMatchObject({
      status: 403,
      code: 'AI_DISABLED',
    });
  });
});

describe('streamAiResponse', () => {
  it('streams the deltas in order and resolves with the completed response', async () => {
    const onEvent = vi.fn();
    const onTextDelta = vi.fn();
    const onCompleted = vi.fn();

    const result = await streamAiResponse(
      { input: 'hi', model: 'gpt-5-mini' },
      { onEvent, onTextDelta, onCompleted },
    );

    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(
      mockAiStreamEvents.map((event) => event.type),
    );
    expect(onTextDelta.mock.calls.map(([delta]) => delta).join('')).toBe(
      mockAiResponse.outputText,
    );
    expect(onCompleted).toHaveBeenCalledWith(mockAiResponse);
    expect(result).toEqual(mockAiResponse);
  });

  it('POSTs the request body to /ai/responses/stream', async () => {
    let body: unknown;
    let accept: string | null = null;
    server.use(
      http.post('*/api/ai/responses/stream', async ({ request }) => {
        body = await request.json();
        accept = request.headers.get('Accept');
        return new HttpResponse(toSseBody(mockAiStreamEvents), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );

    await streamAiResponse({ input: 'hello', maxOutputTokens: 64 });

    expect(body).toEqual({ input: 'hello', maxOutputTokens: 64 });
    expect(accept).toBe('text/event-stream');
  });

  it('delivers a mid-stream error event and resolves null', async () => {
    server.use(
      http.post(
        '*/api/ai/responses/stream',
        () =>
          new HttpResponse(
            toSseBody([
              { type: 'response.created', id: 'r' },
              { type: 'error', code: 'AI_PROVIDER_UNAVAILABLE', message: 'Upstream down' },
            ]),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      ),
    );
    const onError = vi.fn();

    await expect(streamAiResponse({ input: 'hi' }, { onError })).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith('AI_PROVIDER_UNAVAILABLE', 'Upstream down');
  });

  it('rejects with the gate’s ApiError when refused before the first byte', async () => {
    server.use(
      http.post('*/api/ai/responses/stream', () =>
        HttpResponse.json(
          { code: 'AI_KEY_REQUIRED', message: 'Add a key first' },
          { status: 403 },
        ),
      ),
    );

    const promise = streamAiResponse({ input: 'hi' });
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 403, code: 'AI_KEY_REQUIRED' });
  });

  it('resolves null when aborted before it starts', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(streamAiResponse({ input: 'hi' }, {}, controller.signal)).resolves.toBeNull();
  });
});

describe('AI limits helpers (#450)', () => {
  it('aiModelLimitKey is <provider>:<modelId>, colons in the id kept', () => {
    expect(aiModelLimitKey('openai', 'ft:gpt-4.1:acme')).toBe('openai:ft:gpt-4.1:acme');
  });

  it('withModelLimits replaces one entry and keeps everything else', () => {
    const limits = {
      perUser: { requestsPerMinute: 10 },
      perModel: { 'openai:a': { maxOutputTokens: 1 }, 'openai:b': { requestsPerMinutePerUser: 2 } },
    };
    expect(withModelLimits(limits, 'openai:a', { requestsPerMinutePerUser: 3 })).toEqual({
      perUser: { requestsPerMinute: 10 },
      perModel: { 'openai:a': { requestsPerMinutePerUser: 3 }, 'openai:b': { requestsPerMinutePerUser: 2 } },
    });
    // The input is not mutated.
    expect(limits.perModel['openai:a']).toEqual({ maxOutputTokens: 1 });
  });

  it('withModelLimits removes an empty entry, and perModel once it is empty', () => {
    expect(withModelLimits({ perModel: { 'openai:a': { maxOutputTokens: 1 } } }, 'openai:a', {})).toEqual({});
    expect(withModelLimits(undefined, 'openai:a', { maxOutputTokens: 5 })).toEqual({
      perModel: { 'openai:a': { maxOutputTokens: 5 } },
    });
  });

  it('aiAdminConfigToInput re-sends the configuration as loaded, limits included', () => {
    const limits = { perUser: { requestsPerDay: 7 } };
    expect(aiAdminConfigToInput({ ...mockAiAdminConfig, limits })).toEqual({
      enabled: mockAiAdminConfig.enabled,
      keyPolicy: mockAiAdminConfig.keyPolicy,
      logPromptContent: mockAiAdminConfig.logPromptContent,
      defaults: mockAiAdminConfig.defaults,
      hostedTools: mockAiAdminConfig.hostedTools,
      limits,
      providers: { openai: { enabled: false, baseUrl: null } },
    });
  });
});
