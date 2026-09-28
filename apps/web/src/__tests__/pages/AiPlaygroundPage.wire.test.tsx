/**
 * `/ai` — the WIRE contract (issue #434, epic #419).
 *
 * The page test proves what renders; this one proves what the playground
 * PUTS ON THE WIRE, against the HTTP shapes #433 defines for
 * `POST /api/ai/responses/stream`, `POST /api/ai/runs`,
 * `GET /api/ai/runs/:id` and `POST /api/ai/runs/:id/cancel`. Nothing is
 * mocked but the network (MSW): the page, `useAiChat`, `useAiRun`,
 * `services/ai.ts` and `postSse` are all real.
 *
 * Bodies are compared with `toEqual`, not `toMatchObject`: a key the API's
 * Zod DTO does not know (a stray `stream` flag, say) is a contract break, and
 * a subset match would hide it.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import {
  mockAiPublicConfigWithAnthropic,
  mockAiResponse,
  mockAiRun,
  mockPlaygroundClaudeModel,
  mockPlaygroundModels,
  toSseBody,
} from '../mocks/fixtures/ai';
import { AiConfigContext, type UseAiConfigReturn } from '../../hooks/useAiConfig';
import AiPlaygroundPage from '../../pages/AiPlaygroundPage';
import { AI_SCHEMA_PRESETS } from '../../components/ai/aiSchemaPresets';
import { AI_RUN_POLL_INTERVAL_MS } from '../../hooks/useAiRun';
import { api } from '../../services/api';
import type { AiResponse } from '../../services/ai';

interface Captured {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
}

function captureStream(responses: AiResponse[] = [mockAiResponse]): Captured[] {
  const captured: Captured[] = [];
  server.use(
    http.post('*/api/ai/responses/stream', async ({ request }) => {
      const text = await request.text();
      captured.push({
        url: new URL(request.url),
        method: request.method,
        headers: request.headers,
        body: text ? JSON.parse(text) : undefined,
      });
      const response = responses[Math.min(captured.length - 1, responses.length - 1)];
      return new HttpResponse(
        toSseBody([
          { type: 'response.created', id: response.id },
          { type: 'output_text.delta', delta: response.outputText },
          { type: 'response.completed', response },
        ]),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }),
  );
  return captured;
}

async function renderPage(userOptions?: Parameters<typeof userEvent.setup>[0]) {
  const user = userEvent.setup(userOptions);
  render(<AiPlaygroundPage />, { wrapperOptions: { route: '/ai', aiEnabled: true } });
  const select = await screen.findByRole('combobox', { name: 'Model' });
  await waitFor(() => expect(select).toHaveTextContent('GPT-5 mini'));
  return user;
}

/** The playground with Anthropic configured as a provider that cannot chain (#446). */
async function renderPageWithAnthropic(userOptions?: Parameters<typeof userEvent.setup>[0]) {
  server.use(
    http.get('*/api/ai/models', () =>
      HttpResponse.json({ data: [...mockPlaygroundModels, mockPlaygroundClaudeModel] }),
    ),
  );
  const aiValue: UseAiConfigReturn = {
    config: mockAiPublicConfigWithAnthropic,
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  const user = userEvent.setup(userOptions);
  render(
    <AiConfigContext.Provider value={aiValue}>
      <AiPlaygroundPage />
    </AiConfigContext.Provider>,
    { wrapperOptions: { route: '/ai', aiEnabled: true } },
  );
  const select = await screen.findByRole('combobox', { name: 'Model' });
  await waitFor(() => expect(select).toHaveTextContent('GPT-5 mini'));
  return user;
}

async function pickModel(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole('combobox', { name: 'Model' }));
  await user.click(screen.getByRole('option', { name }));
}

const textItem = (role: 'user' | 'assistant', text: string) => ({
  type: 'message',
  role,
  content: [{ type: 'text', text }],
});

async function send(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), text);
  await user.click(screen.getByRole('button', { name: /^(Send|Start run)$/ }));
}

beforeEach(() => {
  server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data: mockPlaygroundModels })));
  api.setAccessToken('access-token-1');
});

afterEach(() => {
  api.setAccessToken(null);
});

describe('AiPlaygroundPage — wire', () => {
  it('POSTs the stream request with SSE Accept, JSON body and the bearer token', async () => {
    const captured = captureStream();
    const user = await renderPage();

    await send(user, 'Hello');
    await waitFor(() => expect(captured).toHaveLength(1));

    const [request] = captured;
    expect(request.method).toBe('POST');
    expect(request.url.pathname).toBe('/api/ai/responses/stream');
    expect(request.headers.get('accept')).toBe('text/event-stream');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.headers.get('authorization')).toBe('Bearer access-token-1');
    // Reasoning model, defaults untouched: the summary is requested, the effort is left to the model.
    expect(request.body).toEqual({
      provider: 'openai',
      model: 'gpt-5-mini',
      input: 'Hello',
      reasoning: { summary: 'auto' },
    });
  });

  it('continues the conversation with previousResponseId from the last completed turn', async () => {
    const second: AiResponse = { ...mockAiResponse, id: 'resp_456', outputText: 'Second answer' };
    const captured = captureStream([mockAiResponse, second]);
    const user = await renderPage();

    await send(user, 'first');
    await screen.findByText('Hello! How can I help?');
    await send(user, 'second');
    await screen.findByText('Second answer');
    await send(user, 'third');

    await waitFor(() => expect(captured).toHaveLength(3));
    expect((captured[0].body as Record<string, unknown>).previousResponseId).toBeUndefined();
    expect(captured[1].body).toMatchObject({ input: 'second', previousResponseId: 'resp_123' });
    expect(captured[2].body).toMatchObject({ input: 'third', previousResponseId: 'resp_456' });
  });

  describe('a provider that cannot chain (Anthropic, #446)', () => {
    it('resends the full conversation as input, with no previousResponseId', async () => {
      const second: AiResponse = { ...mockAiResponse, id: 'msg_2', outputText: 'Second answer' };
      const captured = captureStream([{ ...mockAiResponse, id: 'msg_1' }, second]);
      const user = await renderPageWithAnthropic();
      await pickModel(user, /Claude Sonnet 4\.5/);

      await send(user, 'first');
      await screen.findByText('Hello! How can I help?');
      await send(user, 'second');
      await screen.findByText('Second answer');
      await send(user, 'third');

      await waitFor(() => expect(captured).toHaveLength(3));
      expect(captured[0].body).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        input: [textItem('user', 'first')],
      });
      expect(captured[1].body).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        input: [textItem('user', 'first'), textItem('assistant', 'Hello! How can I help?'), textItem('user', 'second')],
      });
      expect(captured[2].body).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        input: [
          textItem('user', 'first'),
          textItem('assistant', 'Hello! How can I help?'),
          textItem('user', 'second'),
          textItem('assistant', 'Second answer'),
          textItem('user', 'third'),
        ],
      });
    });

    it('switching from OpenAI to Claude mid-conversation resends what OpenAI answered', async () => {
      const captured = captureStream();
      const user = await renderPageWithAnthropic();

      await send(user, 'first');
      await screen.findByText('Hello! How can I help?');
      await pickModel(user, /Claude Sonnet 4\.5/);
      await send(user, 'second');

      await waitFor(() => expect(captured).toHaveLength(2));
      expect(captured[0].body).toMatchObject({ provider: 'openai', input: 'first' });
      expect(captured[1].body).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        input: [textItem('user', 'first'), textItem('assistant', 'Hello! How can I help?'), textItem('user', 'second')],
      });
    });

    it('OpenAI keeps chaining by previousResponseId when Anthropic is also configured', async () => {
      const captured = captureStream();
      const user = await renderPageWithAnthropic();

      await send(user, 'first');
      await screen.findByText('Hello! How can I help?');
      await send(user, 'second');

      await waitFor(() => expect(captured).toHaveLength(2));
      expect(captured[1].body).toEqual({
        provider: 'openai',
        model: 'gpt-5-mini',
        input: 'second',
        reasoning: { summary: 'auto' },
        previousResponseId: 'resp_123',
      });
    });

    it('a background run resends the conversation too', async () => {
      captureStream();
      const runs: unknown[] = [];
      server.use(
        http.post('*/api/ai/runs', async ({ request }) => {
          runs.push(await request.json());
          return HttpResponse.json({ data: { runId: 'run_42', jobId: 'job_42' } }, { status: 202 });
        }),
        http.get('*/api/ai/runs/:id', ({ params }) =>
          HttpResponse.json({
            data: { ...mockAiRun, id: String(params.id), status: 'running', output: null, completedAt: null },
          }),
        ),
      );
      const user = await renderPageWithAnthropic();
      await pickModel(user, /Claude Sonnet 4\.5/);

      await send(user, 'context');
      await screen.findByText('Hello! How can I help?');
      await user.click(screen.getByRole('switch', { name: 'Run in background' }));
      await send(user, 'Summarise');

      await waitFor(() => expect(runs).toHaveLength(1));
      expect(runs[0]).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        input: [
          textItem('user', 'context'),
          textItem('assistant', 'Hello! How can I help?'),
          textItem('user', 'Summarise'),
        ],
      });
    });
  });

  it('sends effort, max output tokens and instructions exactly as the DTO names them', async () => {
    const captured = captureStream();
    const user = await renderPage();

    await user.type(screen.getByRole('textbox', { name: 'Instructions' }), 'Be terse.');
    await user.type(screen.getByRole('textbox', { name: 'Max output tokens' }), '256');
    await user.click(screen.getByRole('combobox', { name: 'Reasoning effort' }));
    await user.click(screen.getByRole('option', { name: 'High' }));
    await user.click(screen.getByRole('switch', { name: 'Show reasoning summary' }));

    await send(user, 'Go');
    await waitFor(() => expect(captured).toHaveLength(1));

    expect(captured[0].body).toEqual({
      provider: 'openai',
      model: 'gpt-5-mini',
      input: 'Go',
      instructions: 'Be terse.',
      maxOutputTokens: 256,
      reasoning: { effort: 'high' },
    });
  });

  it('sends temperature (and no reasoning) to a non-reasoning model', async () => {
    const captured = captureStream();
    const user = await renderPage();

    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(screen.getByRole('option', { name: /GPT-4\.1 mini/ }));
    await user.type(screen.getByRole('textbox', { name: 'Temperature' }), '0.3');

    await send(user, 'Go');
    await waitFor(() => expect(captured).toHaveLength(1));

    expect(captured[0].body).toEqual({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      input: 'Go',
      temperature: 0.3,
    });
  });

  it('sends a structured-output preset as { name, jsonSchema, strict: true }', async () => {
    const captured = captureStream([{ ...mockAiResponse, parsed: { sentiment: 'mixed' } }]);
    const user = await renderPage();
    const preset = AI_SCHEMA_PRESETS.find((entry) => entry.id === 'classify_sentiment')!;

    await user.click(screen.getByRole('switch', { name: 'Structured output' }));
    await user.click(screen.getByRole('combobox', { name: 'Schema' }));
    await user.click(screen.getByRole('option', { name: preset.label }));
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0].body).toEqual({
      provider: 'openai',
      model: 'gpt-5-mini',
      input: preset.examplePrompt,
      reasoning: { summary: 'auto' },
      structuredOutput: { name: preset.name, jsonSchema: preset.jsonSchema, strict: true },
    });
  });

  describe('background runs', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('starts with POST /ai/runs (no stream flag), polls GET /ai/runs/:runId and cancels by id', async () => {
      const streamCaptured = captureStream();
      const calls: Captured[] = [];
      const record = async (request: Request) => {
        const text = await request.text();
        calls.push({
          url: new URL(request.url),
          method: request.method,
          headers: request.headers,
          body: text ? JSON.parse(text) : undefined,
        });
      };
      server.use(
        http.post('*/api/ai/runs', async ({ request }) => {
          await record(request);
          return HttpResponse.json({ data: { runId: 'run_42', jobId: 'job_42' } }, { status: 202 });
        }),
        http.get('*/api/ai/runs/:id', async ({ request, params }) => {
          await record(request);
          return HttpResponse.json({
            data: { ...mockAiRun, id: String(params.id), status: 'running', output: null, completedAt: null },
          });
        }),
        http.post('*/api/ai/runs/:id/cancel', async ({ request, params }) => {
          await record(request);
          return HttpResponse.json({
            data: { ...mockAiRun, id: String(params.id), status: 'cancelled', output: null },
          });
        }),
      );

      const user = await renderPage({ advanceTimers: vi.advanceTimersByTime });

      // One streamed turn first, so the run continues the conversation.
      await send(user, 'context');
      await screen.findByText('Hello! How can I help?');
      expect(streamCaptured).toHaveLength(1);

      await user.click(screen.getByRole('switch', { name: 'Run in background' }));
      await send(user, 'Summarise');

      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0].method).toBe('POST');
      expect(calls[0].url.pathname).toBe('/api/ai/runs');
      expect(calls[0].headers.get('authorization')).toBe('Bearer access-token-1');
      expect(calls[0].body).toEqual({
        provider: 'openai',
        model: 'gpt-5-mini',
        input: 'Summarise',
        reasoning: { summary: 'auto' },
        previousResponseId: 'resp_123',
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AI_RUN_POLL_INTERVAL_MS);
      });
      await waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[1].method).toBe('GET');
      expect(calls[1].url.pathname).toBe('/api/ai/runs/run_42');

      const card = screen.getByRole('region', { name: 'Background run' });
      await user.click(within(card).getByRole('button', { name: 'Cancel run' }));

      await waitFor(() => expect(calls).toHaveLength(3));
      expect(calls[2].method).toBe('POST');
      expect(calls[2].url.pathname).toBe('/api/ai/runs/run_42/cancel');

      // Cancelled is terminal: no further reads.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AI_RUN_POLL_INTERVAL_MS * 3);
      });
      expect(calls).toHaveLength(3);
    });
  });
});
