import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  aiErrorBody,
  mockAiReasoningResponse,
  mockAiReasoningStreamEvents,
  mockAiResponse,
  mockAiStructuredResponse,
} from '../mocks/fixtures/ai';
import { controlledAiStream } from '../utils/aiStream';
import { buildHistoryInput, useAiChat, type AiChatMessage } from '../../hooks/useAiChat';
import type { AiChatAttachment } from '../../components/ai/playground/chatAttachments';

/**
 * `useAiChat` — issue #434. Streaming against a hand-driven MSW
 * `ReadableStream` (see `utils/aiStream.ts`) so each assertion sees the
 * message exactly as far as the frames released so far.
 */

function assistant(result: { current: ReturnType<typeof useAiChat> }) {
  const messages = result.current.messages.filter((m) => m.role === 'assistant');
  return messages[messages.length - 1];
}

describe('useAiChat', () => {
  it('appends the user turn and fills the assistant message token by token', async () => {
    const stream = controlledAiStream();
    const { result } = renderHook(() => useAiChat());

    act(() => {
      void result.current.send('  Hi there  ', { provider: 'openai', model: 'gpt-5-mini' });
    });

    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages[0]).toMatchObject({ role: 'user', text: 'Hi there' });
    expect(assistant(result)).toMatchObject({ text: '', status: 'streaming' });

    await waitFor(() => expect(stream.requests).toHaveLength(1));
    expect(stream.requests[0].body).toEqual({ provider: 'openai', model: 'gpt-5-mini', input: 'Hi there' });

    act(() => stream.push({ type: 'output_text.delta', delta: 'Hello! ' }));
    await waitFor(() => expect(assistant(result).text).toBe('Hello! '));
    expect(assistant(result).status).toBe('streaming');

    act(() => stream.push({ type: 'output_text.delta', delta: 'How can I help?' }));
    await waitFor(() => expect(assistant(result).text).toBe('Hello! How can I help?'));

    act(() => {
      stream.push({ type: 'response.completed', response: mockAiResponse });
      stream.close();
    });

    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(assistant(result)).toMatchObject({
      status: 'done',
      text: 'Hello! How can I help?',
      usage: { inputTokens: 9, outputTokens: 7 },
      responseId: 'resp_123',
    });
    expect(result.current.previousResponseId).toBe('resp_123');
  });

  it('sends previousResponseId on the next turn — multi-turn is server-side', async () => {
    const stream = controlledAiStream();
    const { result } = renderHook(() => useAiChat());

    act(() => void result.current.send('first'));
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    act(() => {
      stream.push({ type: 'response.completed', response: mockAiResponse });
      stream.close();
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));

    act(() => void result.current.send('second'));
    await waitFor(() => expect(stream.requests).toHaveLength(2));
    expect(stream.requests[0].body.previousResponseId).toBeUndefined();
    expect(stream.requests[1].body).toMatchObject({ input: 'second', previousResponseId: 'resp_123' });
  });

  it('accumulates reasoning summary deltas separately from the answer', async () => {
    const stream = controlledAiStream();
    const { result } = renderHook(() => useAiChat());

    act(() => void result.current.send('which is cheaper?'));
    await waitFor(() => expect(stream.requests).toHaveLength(1));

    act(() => stream.push(...mockAiReasoningStreamEvents.slice(0, 3)));
    await waitFor(() => expect(assistant(result).reasoning).toBe('Comparing both options.'));
    expect(assistant(result).text).toBe('');

    act(() => {
      stream.push(...mockAiReasoningStreamEvents.slice(3));
      stream.close();
    });
    await waitFor(() => expect(assistant(result).status).toBe('done'));
    expect(assistant(result)).toMatchObject({
      text: 'Option B is cheaper.',
      reasoning: 'Comparing both options.',
      usage: mockAiReasoningResponse.usage,
    });
  });

  it('stop() aborts the request, marks the message stopped and drops late frames', async () => {
    const stream = controlledAiStream();
    const { result } = renderHook(() => useAiChat());

    act(() => void result.current.send('tell me a long story'));
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    act(() => stream.push({ type: 'output_text.delta', delta: 'Once upon' }));
    await waitFor(() => expect(assistant(result).text).toBe('Once upon'));

    act(() => result.current.stop());

    expect(result.current.isStreaming).toBe(false);
    expect(assistant(result)).toMatchObject({ status: 'stopped', text: 'Once upon' });
    // `clientSignal` is the exact AbortSignal the hook passed to `fetch` — the
    // same object `stop()`'s AbortController owns — so it flips synchronously
    // with `abort()`, no `waitFor` needed (issue #483).
    expect(stream.requests[0].clientSignal.aborted).toBe(true);
    // Secondary, network-side proof that the abort actually reached the
    // intercepted request and not just the app's own controller. MSW's fetch
    // interceptor links its own Request's signal to the caller's ASYNCHRONOUSLY,
    // so this can lag the synchronous assertion above under CI/CPU load — a
    // generous timeout here is safe precisely because the assertion above
    // already proves the abort happened; this one is only checking propagation.
    await waitFor(() => expect(stream.requests[0].signal.aborted).toBe(true), { timeout: 5000 });

    // Anything that still arrives is ignored.
    act(() => stream.push({ type: 'output_text.delta', delta: ' a time' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(assistant(result).text).toBe('Once upon');
    // A stopped turn never becomes the thread's continuation point.
    expect(result.current.previousResponseId).toBeNull();
  });

  it('maps a pre-stream JSON failure through details.reason', async () => {
    server.use(
      http.post('*/api/ai/responses/stream', () =>
        HttpResponse.json(aiErrorBody('AI_KEY_REQUIRED', 'No key'), { status: 403 }),
      ),
    );
    const { result } = renderHook(() => useAiChat());

    await act(async () => {
      await result.current.send('hi');
    });

    expect(assistant(result)).toMatchObject({
      status: 'error',
      error: { code: 'AI_KEY_REQUIRED', message: 'No key', status: 403 },
    });
    expect(result.current.isStreaming).toBe(false);
  });

  it('maps a mid-stream error frame and keeps the text that already arrived', async () => {
    const stream = controlledAiStream();
    const { result } = renderHook(() => useAiChat());

    act(() => void result.current.send('hi'));
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    act(() => {
      stream.push(
        { type: 'output_text.delta', delta: 'Partial' },
        { type: 'error', code: 'AI_PROVIDER_UNAVAILABLE', message: 'upstream reset' },
      );
      stream.close();
    });

    await waitFor(() => expect(assistant(result).status).toBe('error'));
    expect(assistant(result)).toMatchObject({
      text: 'Partial',
      error: { code: 'AI_PROVIDER_UNAVAILABLE', message: 'upstream reset' },
    });
  });

  it('reports a stream that ends without response.completed', async () => {
    const stream = controlledAiStream();
    const { result } = renderHook(() => useAiChat());

    act(() => void result.current.send('hi'));
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    act(() => {
      stream.push({ type: 'output_text.delta', delta: 'Half' });
      stream.close();
    });

    await waitFor(() => expect(assistant(result).status).toBe('error'));
    expect(assistant(result).error?.code).toBeNull();
  });

  it('uses one JSON round trip when stream is false, keeping parsed output', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post('*/api/ai/responses', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ data: mockAiStructuredResponse });
      }),
    );
    const { result } = renderHook(() => useAiChat());

    await act(async () => {
      await result.current.send('extract', {
        stream: false,
        structuredOutput: { name: 'contact', jsonSchema: { type: 'object' }, strict: true },
      });
    });

    expect(body).toEqual({
      input: 'extract',
      structuredOutput: { name: 'contact', jsonSchema: { type: 'object' }, strict: true },
    });
    expect(assistant(result)).toMatchObject({ status: 'done', parsed: mockAiStructuredResponse.parsed });
  });

  it('ignores blank prompts and a second send while one is in flight', async () => {
    const stream = controlledAiStream();
    const { result } = renderHook(() => useAiChat());

    await act(async () => {
      await result.current.send('   ');
    });
    expect(result.current.messages).toHaveLength(0);

    act(() => void result.current.send('one'));
    act(() => void result.current.send('two'));
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    expect(result.current.messages).toHaveLength(2);
    act(() => result.current.stop());
  });

  it('appendExchange adds a finished exchange and continues from it; reset clears everything', () => {
    const { result } = renderHook(() => useAiChat());

    act(() => result.current.appendExchange('from a run', mockAiResponse, { runId: 'run_1' }));
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1]).toMatchObject({
      role: 'assistant',
      status: 'done',
      text: mockAiResponse.outputText,
      runId: 'run_1',
    });
    expect(result.current.previousResponseId).toBe('resp_123');

    act(() => result.current.reset());
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.previousResponseId).toBeNull();
  });

  describe('a provider that cannot chain (chainResponses: false, #446)', () => {
    const text = (role: 'user' | 'assistant', value: string) => ({
      type: 'message',
      role,
      content: [{ type: 'text', text: value }],
    });

    async function completeTurn(
      result: { current: ReturnType<typeof useAiChat> },
      stream: ReturnType<typeof controlledAiStream>,
      prompt: string,
      count: number,
      options: Parameters<ReturnType<typeof useAiChat>['send']>[1],
    ) {
      act(() => void result.current.send(prompt, options));
      await waitFor(() => expect(stream.requests).toHaveLength(count));
      act(() => {
        stream.push({ type: 'response.completed', response: mockAiResponse });
        stream.close();
      });
      await waitFor(() => expect(result.current.isStreaming).toBe(false));
    }

    it('sends the full conversation as input and never previousResponseId', async () => {
      const stream = controlledAiStream();
      const { result } = renderHook(() => useAiChat());
      const options = { provider: 'anthropic', model: 'claude-sonnet-4-5', chainResponses: false };

      await completeTurn(result, stream, 'first', 1, options);
      act(() => void result.current.send('second', options));
      await waitFor(() => expect(stream.requests).toHaveLength(2));

      expect(stream.requests[0].body).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        input: [text('user', 'first')],
      });
      expect(stream.requests[1].body).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        input: [text('user', 'first'), text('assistant', 'Hello! How can I help?'), text('user', 'second')],
      });
    });

    it('resends a conversation that started on a chaining provider', async () => {
      const stream = controlledAiStream();
      const { result } = renderHook(() => useAiChat());

      await completeTurn(result, stream, 'first', 1, { provider: 'openai', model: 'gpt-5-mini' });
      expect(result.current.previousResponseId).toBe('resp_123');

      act(() => void result.current.send('second', { provider: 'anthropic', chainResponses: false }));
      await waitFor(() => expect(stream.requests).toHaveLength(2));
      expect(stream.requests[1].body.previousResponseId).toBeUndefined();
      expect(stream.requests[1].body.input).toEqual([
        text('user', 'first'),
        text('assistant', 'Hello! How can I help?'),
        text('user', 'second'),
      ]);
    });

    it('sends attachments as storageObjectId parts on the new turn and resends them on later turns', async () => {
      const stream = controlledAiStream();
      const { result } = renderHook(() => useAiChat());
      const options = { provider: 'anthropic', model: 'claude-sonnet-4-5', chainResponses: false };
      const photo: AiChatAttachment = {
        storageObjectId: 'obj-photo',
        name: 'photo.png',
        mimeType: 'image/png',
        size: 2048,
        kind: 'image',
      };
      const report: AiChatAttachment = {
        storageObjectId: 'obj-report',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        size: 4096,
        kind: 'file',
      };
      const firstTurn = {
        type: 'message',
        role: 'user',
        content: [
          { type: 'text', text: 'describe these' },
          { type: 'image', storageObjectId: 'obj-photo' },
          { type: 'file', storageObjectId: 'obj-report', filename: 'report.pdf' },
        ],
      };

      act(() => void result.current.send('describe these', options, [photo, report]));
      await waitFor(() => expect(stream.requests).toHaveLength(1));
      expect(stream.requests[0].body).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5', input: [firstTurn] });
      act(() => {
        stream.push({ type: 'response.completed', response: mockAiResponse });
        stream.close();
      });
      await waitFor(() => expect(result.current.isStreaming).toBe(false));

      act(() => void result.current.send('and now?', options));
      await waitFor(() => expect(stream.requests).toHaveLength(2));
      expect(stream.requests[1].body.previousResponseId).toBeUndefined();
      expect(stream.requests[1].body.input).toEqual([
        firstTurn,
        text('assistant', 'Hello! How can I help?'),
        text('user', 'and now?'),
      ]);
      // The same history the background-run path reads.
      expect(result.current.historyInput('later', [photo])).toEqual([
        firstTurn,
        text('assistant', 'Hello! How can I help?'),
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'later' }, { type: 'image', storageObjectId: 'obj-photo' }] },
      ]);
    });

    it('buildHistoryInput drops unfinished exchanges, user half included', () => {
      const messages: AiChatMessage[] = [
        { id: 'u1', role: 'user', text: 'one', status: 'done' },
        { id: 'a1', role: 'assistant', text: 'answer one', status: 'done' },
        { id: 'u2', role: 'user', text: 'two', status: 'done' },
        { id: 'a2', role: 'assistant', text: 'partial', status: 'stopped' },
        { id: 'u3', role: 'user', text: 'three', status: 'done' },
        { id: 'a3', role: 'assistant', text: '', status: 'error' },
        { id: 'u4', role: 'user', text: 'four', status: 'done' },
        { id: 'a4', role: 'assistant', text: 'answer four', status: 'done' },
      ];
      expect(buildHistoryInput(messages, 'five')).toEqual([
        text('user', 'one'),
        text('assistant', 'answer one'),
        text('user', 'four'),
        text('assistant', 'answer four'),
        text('user', 'five'),
      ]);
    });
  });
});
