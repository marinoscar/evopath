/**
 * `/ai` — the AI Playground (issue #434, epic #419).
 *
 * Real hooks, real services; only the network is faked (MSW). Streaming runs
 * through a hand-driven `ReadableStream` (`utils/aiStream.ts`) so a test can
 * assert what is on screen between frames.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import { setViewportWidth } from '../setup';
import {
  aiErrorBody,
  mockAiPublicConfigEnabled,
  mockAiReasoningResponse,
  mockAiReasoningStreamEvents,
  mockAiResponse,
  mockAiRun,
  mockAiStructuredResponse,
  mockPlaygroundEmbeddingsModel,
  mockPlaygroundModels,
} from '../mocks/fixtures/ai';
import { controlledAiStream } from '../utils/aiStream';
import AiPlaygroundPage from '../../pages/AiPlaygroundPage';
import { AiConfigContext, type UseAiConfigReturn } from '../../hooks/useAiConfig';
import { AI_RUN_POLL_INTERVAL_MS } from '../../hooks/useAiRun';
import type { AiRunStatus, UsableAiModel } from '../../services/ai';

function serveModels(models: UsableAiModel[] = mockPlaygroundModels) {
  server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data: models })));
}

function serveUserSettings(extra: Record<string, unknown>) {
  server.use(
    http.get('*/api/user-settings', () =>
      HttpResponse.json({
        data: {
          theme: 'system',
          profile: { imageSource: 'provider' },
          updatedAt: new Date().toISOString(),
          version: 1,
          ...extra,
        },
      }),
    ),
  );
}

interface RenderOptions {
  allowBackgroundRuns?: boolean;
  userEventOptions?: Parameters<typeof userEvent.setup>[0];
}

async function renderPage(options: RenderOptions = {}) {
  const user = userEvent.setup(options.userEventOptions);
  const config = {
    ...mockAiPublicConfigEnabled,
    ...(options.allowBackgroundRuns !== undefined ? { allowBackgroundRuns: options.allowBackgroundRuns } : {}),
  };
  const aiValue: UseAiConfigReturn = {
    config,
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  render(
    <AiConfigContext.Provider value={aiValue}>
      <AiPlaygroundPage />
    </AiConfigContext.Provider>,
    { wrapperOptions: { route: '/ai', aiEnabled: true } },
  );
  return { user, aiValue };
}

async function waitForModel(label: string) {
  const select = await screen.findByRole('combobox', { name: 'Model' });
  await waitFor(() => expect(select).toHaveTextContent(label));
  return select;
}

async function pickModel(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole('combobox', { name: 'Model' }));
  await user.click(screen.getByRole('option', { name }));
}

async function sendPrompt(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), text);
  await user.click(screen.getByRole('button', { name: /^(Send|Start run)$/ }));
}

describe('AiPlaygroundPage', () => {
  beforeEach(() => serveModels());

  describe('models and empty state', () => {
    it('explains and links to /settings/ai when no model is usable', async () => {
      serveModels([]);
      await renderPage();

      expect(await screen.findByText(/No models are available to you yet/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Manage API keys' })).toHaveAttribute('href', '/settings/ai');
      expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    });

    it('opens on the first usable mode when no model can answer text prompts', async () => {
      serveModels([mockPlaygroundEmbeddingsModel]);
      await renderPage();

      expect(await screen.findByRole('button', { name: 'Embeddings' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-disabled', 'true');
      expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    });

    it('explains when no usable model can serve any playground mode', async () => {
      serveModels([
        {
          ...mockPlaygroundEmbeddingsModel,
          modelId: 'realtime-only',
          capabilities: { capabilities: ['realtime'], inputModalities: ['audio'], outputModalities: ['audio'] },
        },
      ]);
      await renderPage();

      expect(await screen.findByText(/None of the models available to you can be used in the playground/)).toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Playground mode' })).not.toBeInTheDocument();
    });

    it("selects the user's saved default model when it is usable", async () => {
      serveUserSettings({ ai: { defaultModel: { provider: 'openai', modelId: 'gpt-4.1-mini' } } });
      await renderPage();

      await waitForModel('GPT-4.1 mini');
    });

    it('falls back to the first text model when the saved default is not usable', async () => {
      serveUserSettings({ ai: { defaultModel: { provider: 'openai', modelId: 'retired-model' } } });
      await renderPage();

      await waitForModel('GPT-5 mini');
    });

    it('lists only the models Chat can use — capability-driven, not by name', async () => {
      const { user } = await renderPage();
      await waitForModel('GPT-5 mini');

      await user.click(screen.getByRole('combobox', { name: 'Model' }));
      expect(screen.getByRole('option', { name: /GPT-5 mini/ })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /GPT-4.1 mini/ })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /text-embedding-3-small/ })).not.toBeInTheDocument();
    });

    it('shows the selected model’s capabilities as chips', async () => {
      await renderPage();
      await waitForModel('GPT-5 mini');

      const chips = screen.getByRole('list', { name: 'Capabilities' });
      expect(within(chips).getByText('Reasoning')).toBeInTheDocument();
      expect(within(chips).getByText('Structured output')).toBeInTheDocument();
    });

    it('redirects a user without ai:use', async () => {
      render(<AiPlaygroundPage />, {
        wrapperOptions: { aiEnabled: true, user: { ...mockUser, permissions: ['user_settings:read'] } },
      });
      expect(screen.queryByRole('heading', { name: 'AI Playground' })).not.toBeInTheDocument();
    });
  });

  describe('mode selector (#445)', () => {
    it('offers the five modes in a labelled group, Chat selected', async () => {
      await renderPage();
      await waitForModel('GPT-5 mini');

      const group = screen.getByRole('group', { name: 'Playground mode' });
      const names = within(group)
        .getAllByRole('button')
        .map((button) => button.textContent);
      expect(names).toEqual(['Chat', 'Image', 'Transcribe', 'Speech', 'Embeddings']);
      expect(within(group).getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('disables a mode no usable model can serve, with the reason as its tooltip', async () => {
      const { user } = await renderPage();
      await waitForModel('GPT-5 mini');

      const image = screen.getByRole('button', { name: 'Image' });
      expect(image).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByRole('button', { name: 'Embeddings' })).not.toHaveAttribute('aria-disabled');

      await user.hover(image);
      expect(await screen.findByRole('tooltip')).toHaveTextContent('None of the models available to you can generate images');

      // Clicking it does nothing.
      await user.click(image);
      expect(image).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('is keyboard-operable: arrows move focus, Enter selects', async () => {
      const { user } = await renderPage();
      await waitForModel('GPT-5 mini');

      screen.getByRole('button', { name: 'Chat' }).focus();
      await user.keyboard('{End}');
      const embeddings = screen.getByRole('button', { name: 'Embeddings' });
      expect(embeddings).toHaveFocus();
      await user.keyboard('{ArrowRight}');
      expect(screen.getByRole('button', { name: 'Chat' })).toHaveFocus();
      await user.keyboard('{ArrowLeft}');
      expect(embeddings).toHaveFocus();

      await user.keyboard('{Enter}');
      expect(embeddings).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'New conversation' })).not.toBeInTheDocument();
    });

    it('keeps the chat thread when switching modes and back', async () => {
      const { user } = await renderPage();
      await waitForModel('GPT-5 mini');
      await sendPrompt(user, 'Hello');
      await screen.findByText('Hello! How can I help?');

      await user.click(screen.getByRole('button', { name: 'Embeddings' }));
      expect(screen.queryByText('Hello! How can I help?')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Chat' }));
      expect(screen.getByText('Hello! How can I help?')).toBeInTheDocument();
    });
  });

  describe('controls follow the selected model', () => {
    it('shows reasoning and structured-output controls for a reasoning model, and hides temperature', async () => {
      await renderPage();
      await waitForModel('GPT-5 mini');

      expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Show reasoning summary' })).toBeChecked();
      expect(screen.getByRole('switch', { name: 'Structured output' })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Max output tokens' })).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Temperature' })).not.toBeInTheDocument();
    });

    it('swaps them for temperature on a plain chat model', async () => {
      const { user } = await renderPage();
      await waitForModel('GPT-5 mini');

      await pickModel(user, /GPT-4\.1 mini/);

      expect(screen.getByRole('textbox', { name: 'Temperature' })).toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'Reasoning effort' })).not.toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: 'Structured output' })).not.toBeInTheDocument();
    });

    it('offers "Run in background" unless the config says background runs are off', async () => {
      await renderPage();
      await waitForModel('GPT-5 mini');
      expect(screen.getByRole('switch', { name: 'Run in background' })).toBeInTheDocument();
    });

    it('hides "Run in background" when allowBackgroundRuns is false', async () => {
      await renderPage({ allowBackgroundRuns: false });
      await waitForModel('GPT-5 mini');
      expect(screen.queryByRole('switch', { name: 'Run in background' })).not.toBeInTheDocument();
    });

    it('blocks sending while max output tokens is invalid', async () => {
      const { user } = await renderPage();
      await waitForModel('GPT-5 mini');

      await user.type(screen.getByRole('textbox', { name: 'Max output tokens' }), '999999999');
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hi');

      expect(screen.getByText('Enter a whole number from 1 to 128000')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    });
  });

  describe('streaming chat', () => {
    it('renders the answer incrementally, then the usage footer', async () => {
      const stream = controlledAiStream();
      const { user } = await renderPage();
      await waitForModel('GPT-5 mini');

      await sendPrompt(user, 'Hello');
      await waitFor(() => expect(stream.requests).toHaveLength(1));

      expect(screen.getByTestId('user-message')).toHaveTextContent('Hello');
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();

      act(() => stream.push({ type: 'output_text.delta', delta: 'Hello! ' }));
      expect(await screen.findByTestId('assistant-text')).toHaveTextContent(/^Hello!$/);

      act(() => stream.push({ type: 'output_text.delta', delta: 'How can I help?' }));
      await waitFor(() => expect(screen.getByTestId('assistant-text')).toHaveTextContent('Hello! How can I help?'));

      act(() => {
        stream.push({ type: 'response.completed', response: mockAiResponse });
        stream.close();
      });

      expect(await screen.findByText('Tokens: 9 in · 7 out')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    });

    it('Stop aborts the stream and keeps what arrived', async () => {
      const stream = controlledAiStream();
      const { user } = await renderPage();
      await waitForModel('GPT-5 mini');

      await sendPrompt(user, 'Tell me a story');
      await waitFor(() => expect(stream.requests).toHaveLength(1));
      act(() => stream.push({ type: 'output_text.delta', delta: 'Once upon' }));
      await screen.findByText('Once upon');

      await user.click(screen.getByRole('button', { name: 'Stop' }));

      // `clientSignal` is the exact AbortSignal the hook passed to `fetch` —
      // it flips synchronously with `stop()`'s `abort()` call, unlike the
      // interceptor-side `signal` below, which MSW links asynchronously and
      // which can lag under CI/CPU load (issue #483).
      expect(stream.requests[0].clientSignal.aborted).toBe(true);
      // Secondary, network-side proof the abort actually reached the
      // intercepted request; a generous timeout is safe here because the
      // synchronous assertion above already proves the abort happened.
      await waitFor(() => expect(stream.requests[0].signal.aborted).toBe(true), { timeout: 5000 });
      expect(screen.getByText('Stopped')).toBeInTheDocument();
      expect(screen.getByTestId('assistant-message')).toHaveAttribute('data-status', 'stopped');
      act(() => stream.push({ type: 'output_text.delta', delta: ' a time' }));
      expect(screen.queryByText(/a time/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    });

    it('streams the reasoning summary into its collapsible panel', async () => {
      const stream = controlledAiStream();
      const { user } = await renderPage();
      await waitForModel('GPT-5 mini');

      await sendPrompt(user, 'Which is cheaper?');
      await waitFor(() => expect(stream.requests).toHaveLength(1));

      act(() => stream.push(...mockAiReasoningStreamEvents.slice(0, 2)));
      expect(await screen.findByTestId('reasoning-text')).toHaveTextContent('Comparing');

      act(() => {
        stream.push(...mockAiReasoningStreamEvents.slice(2));
        stream.close();
      });
      await waitFor(() =>
        expect(screen.getByTestId('reasoning-text')).toHaveTextContent('Comparing both options.'),
      );
      expect(screen.getByTestId('assistant-text')).toHaveTextContent(mockAiReasoningResponse.outputText);
      expect(await screen.findByText('Tokens: 20 in · 6 out · 64 reasoning')).toBeInTheDocument();

      const toggle = screen.getByRole('button', { name: 'Reasoning summary' });
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });

    it('renders an AI error code from a refused stream with its specific copy', async () => {
      server.use(
        http.post('*/api/ai/responses/stream', () =>
          HttpResponse.json(aiErrorBody('AI_KEY_REQUIRED', 'No key for openai'), { status: 403 }),
        ),
      );
      const { user } = await renderPage();
      await waitForModel('GPT-5 mini');

      await sendPrompt(user, 'hi');

      expect(await screen.findByText('Add your API key')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Add API key' })).toHaveAttribute('href', '/settings/ai');
    });

    it('refreshes the AI config when a turn fails with AI_DISABLED', async () => {
      server.use(
        http.post('*/api/ai/responses/stream', () =>
          HttpResponse.json(aiErrorBody('AI_DISABLED', 'AI is disabled'), { status: 403 }),
        ),
      );
      const { user, aiValue } = await renderPage();
      await waitForModel('GPT-5 mini');

      await sendPrompt(user, 'hi');

      expect(await screen.findByText('AI is disabled by your administrator')).toBeInTheDocument();
      expect(aiValue.refresh).toHaveBeenCalled();
    });

    it('New conversation clears the thread', async () => {
      const { user } = await renderPage();
      await waitForModel('GPT-5 mini');

      await sendPrompt(user, 'Hello');
      await screen.findByText('Tokens: 9 in · 7 out');

      await user.click(screen.getByRole('button', { name: 'New conversation' }));
      expect(screen.queryByTestId('assistant-message')).not.toBeInTheDocument();
      expect(screen.getByText('Send a message to start a conversation.')).toBeInTheDocument();
    });
  });

  describe('structured output', () => {
    it('sends a preset schema and pretty-prints the parsed result', async () => {
      let body: Record<string, unknown> | null = null;
      server.use(
        http.post('*/api/ai/responses/stream', async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>;
          const frames = [
            { type: 'response.created', id: mockAiStructuredResponse.id },
            { type: 'response.completed', response: mockAiStructuredResponse },
          ]
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join('');
          return new HttpResponse(frames, { headers: { 'Content-Type': 'text/event-stream' } });
        }),
      );
      const { user } = await renderPage();
      await waitForModel('GPT-5 mini');

      await user.click(screen.getByRole('switch', { name: 'Structured output' }));
      expect(screen.getByRole('combobox', { name: 'Schema' })).toHaveTextContent('Extract contact');
      const composer = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
      // Turning it on into an empty composer offers the preset's example prompt…
      expect(composer.value).toContain('Dana Ruiz');

      // …and switching presets swaps an untouched example for the new one.
      await user.click(screen.getByRole('combobox', { name: 'Schema' }));
      await user.click(screen.getByRole('option', { name: 'Classify sentiment' }));
      expect(composer.value).toContain('Classify the sentiment');
      await user.click(screen.getByRole('combobox', { name: 'Schema' }));
      await user.click(screen.getByRole('option', { name: 'Extract contact' }));
      expect(composer.value).toContain('Dana Ruiz');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      const panel = await screen.findByTestId('structured-output-panel');
      expect(within(panel).getByLabelText('Structured output').textContent).toBe(
        JSON.stringify(mockAiStructuredResponse.parsed, null, 2),
      );
      expect(body).toMatchObject({
        structuredOutput: { name: 'contact', strict: true, jsonSchema: { type: 'object' } },
      });
    });

    it('validates the free-form schema editor and blocks sending on invalid JSON', async () => {
      const { user } = await renderPage();
      await waitForModel('GPT-5 mini');

      await user.click(screen.getByRole('switch', { name: 'Structured output' }));
      const editor = screen.getByRole('textbox', { name: 'JSON Schema' });
      await user.clear(editor);
      await user.type(editor, '{{ nope');

      expect(screen.getByText(/^Invalid JSON/)).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Schema' })).toHaveTextContent('Custom JSON Schema');
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

      await user.clear(editor);
      await user.type(editor, '[[]');
      expect(screen.getByText('The schema must be a JSON object')).toBeInTheDocument();
    });
  });

  describe('background runs', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function scriptRun(statuses: AiRunStatus[]) {
      const reads: string[] = [];
      server.use(
        http.get('*/api/ai/runs/:id', ({ params }) => {
          reads.push(String(params.id));
          const status = statuses[Math.min(reads.length - 1, statuses.length - 1)];
          return HttpResponse.json({
            data: {
              ...mockAiRun,
              id: String(params.id),
              status,
              output: status === 'succeeded' ? mockAiResponse : null,
              completedAt: null,
            },
          });
        }),
      );
      return reads;
    }

    async function startRun() {
      const { user } = await renderPage({
        userEventOptions: { advanceTimers: vi.advanceTimersByTime },
      });
      await waitForModel('GPT-5 mini');
      await user.click(screen.getByRole('switch', { name: 'Run in background' }));
      await sendPrompt(user, 'Summarise the report');
      return user;
    }

    it('polls the run to completion and appends the answer to the thread', async () => {
      const reads = scriptRun(['running', 'succeeded']);
      await startRun();

      const card = await screen.findByRole('region', { name: 'Background run' });
      expect(within(card).getByText('Summarise the report')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AI_RUN_POLL_INTERVAL_MS);
      });
      await waitFor(() => expect(within(card).getByTestId('run-status')).toHaveTextContent('Running'));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AI_RUN_POLL_INTERVAL_MS);
      });
      await waitFor(() => expect(within(card).getByTestId('run-status')).toHaveTextContent('Succeeded'));

      expect(within(card).getByText('The answer was added to the conversation.')).toBeInTheDocument();
      expect(screen.getByTestId('assistant-text')).toHaveTextContent(mockAiResponse.outputText);
      expect(screen.getByText('Background run', { selector: '.MuiChip-label' })).toBeInTheDocument();

      // Terminal: polling stops.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AI_RUN_POLL_INTERVAL_MS * 3);
      });
      expect(reads).toHaveLength(2);
    });

    it('cancels a running run', async () => {
      scriptRun(['running']);
      let cancelled = false;
      server.use(
        http.post('*/api/ai/runs/:id/cancel', ({ params }) => {
          cancelled = true;
          return HttpResponse.json({
            data: { ...mockAiRun, id: String(params.id), status: 'cancelled', output: null },
          });
        }),
      );
      const user = await startRun();

      const card = await screen.findByRole('region', { name: 'Background run' });
      await user.click(await within(card).findByRole('button', { name: 'Cancel run' }));

      await waitFor(() => expect(within(card).getByTestId('run-status')).toHaveTextContent('Cancelled'));
      expect(cancelled).toBe(true);
      expect(screen.queryByTestId('assistant-message')).not.toBeInTheDocument();

      await user.click(within(card).getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByRole('region', { name: 'Background run' })).not.toBeInTheDocument();
    });

    it('renders a failed run through the shared error mapping', async () => {
      server.use(
        http.get('*/api/ai/runs/:id', ({ params }) =>
          HttpResponse.json({
            data: { ...mockAiRun, id: String(params.id), status: 'failed', output: null, errorCode: 'AI_CONTENT_FILTERED' },
          }),
        ),
      );
      await startRun();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AI_RUN_POLL_INTERVAL_MS);
      });

      expect(await screen.findByText('Blocked by the content filter')).toBeInTheDocument();
    });

    it('shows a refused start (e.g. background runs switched off) as an error', async () => {
      server.use(
        http.post('*/api/ai/runs', () =>
          HttpResponse.json(aiErrorBody('AI_INVALID_REQUEST', 'Background runs are disabled'), { status: 400 }),
        ),
      );
      await startRun();

      expect(await screen.findByText('The request was invalid')).toBeInTheDocument();
      expect(screen.getByText('Background runs are disabled')).toBeInTheDocument();
    });
  });

  describe('compact layout (360px)', () => {
    it('collapses the settings panel behind a toggle and keeps the chat usable', async () => {
      act(() => setViewportWidth(360));
      const { user } = await renderPage();

      const toggle = await screen.findByRole('button', { name: 'Settings' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible();

      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await waitFor(() => expect(screen.getByRole('combobox', { name: 'Model' })).toBeVisible());
    });

    it('shows the settings panel inline from sm up', async () => {
      act(() => setViewportWidth(1024));
      await renderPage();
      await waitForModel('GPT-5 mini');
      expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
    });
  });
});
