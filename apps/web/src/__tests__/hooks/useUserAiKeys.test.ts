/**
 * `useUserAiKeys` (#430) against the MSW network — the real `services/ai`
 * client and the real `ApiError` translation, so the `details.reason` shape
 * the page switches on is exercised end to end.
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useUserAiKeys } from '../../hooks/useUserAiKeys';
import { ApiError } from '../../services/api';
import {
  mockAiKeyInvalidErrorBody,
  mockAiProbeResultFailed,
  mockAiProbeResultPassed,
  mockUserAiKeys,
  mockUserAiKeysNone,
} from '../mocks/fixtures/ai';

async function renderLoaded() {
  const hook = renderHook(() => useUserAiKeys());
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return hook;
}

describe('useUserAiKeys', () => {
  it('loads the masked key views', async () => {
    const { result } = await renderLoaded();
    expect(result.current.error).toBeNull();
    expect(result.current.keys).toEqual(mockUserAiKeys);
  });

  it('reports a list failure as the hook error', async () => {
    server.use(
      http.get('*/api/ai/keys', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'AI is disabled', details: { reason: 'AI_DISABLED' } },
          { status: 403 },
        ),
      ),
    );
    const { result } = await renderLoaded();
    expect(result.current.error).toBe('AI is disabled');
    expect(result.current.keys).toEqual([]);
  });

  it('setKey sends the key once and keeps only the returned masked view', async () => {
    server.use(http.get('*/api/ai/keys', () => HttpResponse.json({ data: mockUserAiKeysNone })));
    let sent: unknown;
    server.use(
      http.put('*/api/ai/keys/:provider', async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ data: mockUserAiKeys[0] });
      }),
    );
    const { result } = await renderLoaded();

    await act(async () => {
      await result.current.setKey('openai', 'sk-test-secret-1234');
    });

    expect(sent).toEqual({ apiKey: 'sk-test-secret-1234' });
    expect(result.current.keys).toEqual([mockUserAiKeys[0]]);
    expect(JSON.stringify(result.current.keys)).not.toContain('sk-test-secret-1234');
  });

  it('setKey rejects with the AI reason in details and does not touch the list or error', async () => {
    server.use(
      http.get('*/api/ai/keys', () => HttpResponse.json({ data: mockUserAiKeysNone })),
      http.put('*/api/ai/keys/:provider', () =>
        HttpResponse.json(mockAiKeyInvalidErrorBody, { status: 400 }),
      ),
    );
    const { result } = await renderLoaded();

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.setKey('openai', 'sk-bad-key-0000');
      } catch (err) {
        thrown = err;
      }
    });

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(400);
    expect((thrown as ApiError).details).toEqual({ reason: 'AI_KEY_INVALID' });
    expect(result.current.keys).toEqual(mockUserAiKeysNone);
    expect(result.current.error).toBeNull();
  });

  it('deleteKey calls DELETE and re-reads the list', async () => {
    let deleted: string | null = null;
    const { result } = await renderLoaded();
    server.use(
      http.delete('*/api/ai/keys/:provider', ({ params }) => {
        deleted = String(params.provider);
        return new HttpResponse(null, { status: 204 });
      }),
      http.get('*/api/ai/keys', () => HttpResponse.json({ data: mockUserAiKeysNone })),
    );

    await act(async () => {
      await result.current.deleteKey('openai');
    });

    expect(deleted).toBe('openai');
    expect(result.current.keys).toEqual(mockUserAiKeysNone);
  });

  it('testKey with no key probes the stored key and re-reads the list', async () => {
    let body: unknown;
    let listCalls = 0;
    server.use(
      http.get('*/api/ai/keys', () => {
        listCalls += 1;
        return HttpResponse.json({ data: mockUserAiKeys });
      }),
      http.post('*/api/ai/keys/:provider/test', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: mockAiProbeResultPassed });
      }),
    );
    const { result } = await renderLoaded();
    const before = listCalls;

    let probe;
    await act(async () => {
      probe = await result.current.testKey('openai');
    });

    expect(body).toEqual({});
    expect(probe).toEqual(mockAiProbeResultPassed);
    expect(listCalls).toBe(before + 1);
  });

  it('testKey with a typed key sends it and leaves the list alone', async () => {
    let body: unknown;
    let listCalls = 0;
    server.use(
      http.get('*/api/ai/keys', () => {
        listCalls += 1;
        return HttpResponse.json({ data: mockUserAiKeys });
      }),
      http.post('*/api/ai/keys/:provider/test', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: mockAiProbeResultFailed });
      }),
    );
    const { result } = await renderLoaded();
    const before = listCalls;

    let probe;
    await act(async () => {
      probe = await result.current.testKey('openai', 'sk-typed-9999');
    });

    expect(body).toEqual({ apiKey: 'sk-typed-9999' });
    expect(probe).toEqual(mockAiProbeResultFailed);
    expect(listCalls).toBe(before);
  });
});
