/**
 * `/ai` Chat hosted tools — the WIRE contract (issue #445 against #442).
 *
 * `tools` carries exactly the switched-on, offered tools in the shapes
 * `aiHostedToolSchema` accepts (`.strict()`), on both the streamed turn and a
 * background run; nothing is sent when no tool is on.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import {
  mockAiPublicConfigHostedTools,
  mockAiResponse,
  mockPlaygroundHostedToolsModel,
  toSseBody,
} from '../mocks/fixtures/ai';
import AiPlaygroundPage from '../../pages/AiPlaygroundPage';
import { AiConfigContext, type UseAiConfigReturn } from '../../hooks/useAiConfig';

function capture() {
  const bodies: { stream: unknown[]; runs: unknown[] } = { stream: [], runs: [] };
  server.use(
    http.post('*/api/ai/responses/stream', async ({ request }) => {
      bodies.stream.push(await request.json());
      return new HttpResponse(
        toSseBody([
          { type: 'response.created', id: mockAiResponse.id },
          { type: 'response.completed', response: mockAiResponse },
        ]),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }),
    http.post('*/api/ai/runs', async ({ request }) => {
      bodies.runs.push(await request.json());
      return HttpResponse.json({ data: { runId: 'run_tools_1', jobId: 'job_tools_1' } }, { status: 202 });
    }),
  );
  return bodies;
}

async function renderChat() {
  const user = userEvent.setup();
  const aiValue: UseAiConfigReturn = {
    config: mockAiPublicConfigHostedTools,
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
  const select = await screen.findByRole('combobox', { name: 'Model' });
  await waitFor(() => expect(select).toHaveTextContent('GPT-5.1'));
  return user;
}

async function enableAll(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('switch', { name: 'Web search' }));
  await user.click(screen.getByRole('combobox', { name: 'Search context size' }));
  await user.click(screen.getByRole('option', { name: 'High' }));
  await user.click(screen.getByRole('switch', { name: 'File search' }));
  await user.type(screen.getByRole('textbox', { name: 'Vector store IDs' }), 'vs_1, vs_2');
  await user.click(screen.getByRole('switch', { name: 'Code interpreter' }));
  await user.click(screen.getByRole('switch', { name: 'Image generation' }));
}

const EXPECTED_TOOLS = [
  { type: 'web_search', searchContextSize: 'high' },
  { type: 'file_search', vectorStoreIds: ['vs_1', 'vs_2'] },
  { type: 'code_interpreter' },
  { type: 'image_generation' },
];

beforeEach(() => {
  server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data: [mockPlaygroundHostedToolsModel] })));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AiPlaygroundPage hosted tools — wire', () => {
  it('sends no tools when none is switched on', async () => {
    const bodies = capture();
    const user = await renderChat();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hi');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(bodies.stream).toHaveLength(1));
    expect(bodies.stream[0]).toEqual({ provider: 'openai', model: 'gpt-5.1', input: 'hi' });
  });

  it('streams the switched-on tools in their API shapes', async () => {
    const bodies = capture();
    const user = await renderChat();
    await enableAll(user);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'research');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(bodies.stream).toHaveLength(1));
    expect(bodies.stream[0]).toEqual({ provider: 'openai', model: 'gpt-5.1', input: 'research', tools: EXPECTED_TOOLS });
  });

  it('sends the same tools on a background run', async () => {
    const bodies = capture();
    const user = await renderChat();
    await enableAll(user);
    await user.click(screen.getByRole('switch', { name: 'Run in background' }));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'research');
    await user.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() => expect(bodies.runs).toHaveLength(1));
    expect(bodies.runs[0]).toEqual({ provider: 'openai', model: 'gpt-5.1', input: 'research', tools: EXPECTED_TOOLS });
  });
});
