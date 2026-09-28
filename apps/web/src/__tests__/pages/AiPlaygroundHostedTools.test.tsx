/**
 * `/ai` Chat — provider-hosted tools (issue #445; API #442).
 *
 * Toggles appear only for a model with `hosted_tools` AND a tool the
 * administrator switched on (MCP is never offered by the playground); file
 * search needs vector store ids; results render under the answer; and
 * `AI_TOOL_DISABLED` reads as its shared copy. Only the network is faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import {
  HOSTED_IMAGE_OBJECT_ID,
  aiErrorBody,
  mockAiHostedToolsResponse,
  mockAiPublicConfigHostedTools,
  mockPlaygroundChatModel,
  mockPlaygroundHostedToolsModel,
  mockSignedUrl,
  toSseBody,
} from '../mocks/fixtures/ai';
import AiPlaygroundPage from '../../pages/AiPlaygroundPage';
import { AiConfigContext, type UseAiConfigReturn } from '../../hooks/useAiConfig';
import type { AiPublicConfig } from '../../services/ai';

async function renderChat(config: AiPublicConfig = mockAiPublicConfigHostedTools) {
  const user = userEvent.setup();
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
  const select = await screen.findByRole('combobox', { name: 'Model' });
  await waitFor(() => expect(select).toHaveTextContent('GPT-5.1'));
  return user;
}

async function send(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), text);
  await user.click(screen.getByRole('button', { name: /^(Send|Start run)$/ }));
}

beforeEach(() => {
  server.use(
    http.get('*/api/ai/models', () =>
      HttpResponse.json({ data: [mockPlaygroundHostedToolsModel, mockPlaygroundChatModel] }),
    ),
  );
});

describe('AiPlaygroundPage — hosted tools', () => {
  it('offers a toggle for each admin-enabled tool, never MCP', async () => {
    await renderChat();
    const group = screen.getByRole('group', { name: 'Hosted tools' });
    expect(within(group).getAllByRole('switch').map((s) => s.closest('label')?.textContent)).toEqual([
      'Web search',
      'File search',
      'Code interpreter',
      'Image generation',
    ]);
  });

  it('hides a tool the administrator has not switched on', async () => {
    await renderChat({
      ...mockAiPublicConfigHostedTools,
      hostedTools: { web_search: true, file_search: false, code_interpreter: false, image_generation: false, mcp: false },
    });
    const group = screen.getByRole('group', { name: 'Hosted tools' });
    expect(within(group).getAllByRole('switch')).toHaveLength(1);
    expect(within(group).getByRole('switch', { name: 'Web search' })).toBeInTheDocument();
  });

  it('offers nothing for a model without hosted_tools, or when the config says none', async () => {
    const user = await renderChat();
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(screen.getByRole('option', { name: /GPT-4.1 mini/ }));
    expect(screen.queryByRole('group', { name: 'Hosted tools' })).not.toBeInTheDocument();
  });

  it('hides the section when the public config carries no hostedTools (older API)', async () => {
    const { hostedTools: _omit, ...older } = mockAiPublicConfigHostedTools;
    await renderChat(older);
    expect(screen.queryByRole('group', { name: 'Hosted tools' })).not.toBeInTheDocument();
  });

  it('requires a vector store id for file search', async () => {
    const user = await renderChat();
    await user.click(screen.getByRole('switch', { name: 'File search' }));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'find it');

    expect(screen.getByText('Enter at least one vector store ID for file search')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: 'Vector store IDs' }), 'vs_1');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('renders citations, web search, code interpreter and hosted images under the answer', async () => {
    server.use(
      http.post('*/api/ai/responses/stream', () =>
        new HttpResponse(
          toSseBody([
            { type: 'response.created', id: mockAiHostedToolsResponse.id },
            { type: 'output_text.delta', delta: mockAiHostedToolsResponse.outputText },
            { type: 'response.completed', response: mockAiHostedToolsResponse },
          ]),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
    );
    const user = await renderChat();
    await send(user, 'Tell me about lighthouses');

    const answer = await screen.findByTestId('assistant-message');
    await waitFor(() => expect(answer).toHaveAttribute('data-status', 'done'));

    const sources = within(answer).getByRole('navigation', { name: 'Sources' });
    const link = within(sources).getByRole('link', { name: 'Pharos of Alexandria' });
    expect(link).toHaveAttribute('href', 'https://example.org/pharos');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // A non-http(s) citation is shown as text, never as a link.
    expect(within(sources).getByText('Suspicious source')).toBeInTheDocument();
    expect(within(sources).getAllByRole('link')).toHaveLength(1);

    const search = within(answer).getByRole('group', { name: 'Web search' });
    expect(search).toHaveTextContent('Searched: lighthouse history');
    expect(within(search).getByRole('link', { name: 'https://example.org/lighthouses' })).toBeInTheDocument();

    const code = within(answer).getByRole('group', { name: 'Code interpreter' });
    expect(within(code).getByLabelText('Code run')).toHaveTextContent('print(2 + 2)');
    expect(within(code).getByLabelText('Code output')).toHaveTextContent('4');

    const images = within(answer).getAllByRole('group', { name: 'Image generation' });
    const img = await within(images[0]).findByRole('img');
    expect(img).toHaveAttribute('alt', 'A red lighthouse');
    expect(img).toHaveAttribute('src', mockSignedUrl(HOSTED_IMAGE_OBJECT_ID));
    expect(images[1]).toHaveTextContent('An image was generated but not saved — file storage is unavailable.');
  });

  it('renders AI_TOOL_DISABLED with its shared copy', async () => {
    server.use(
      http.post('*/api/ai/responses/stream', () =>
        HttpResponse.json(aiErrorBody('AI_TOOL_DISABLED', 'web_search is disabled'), { status: 403 }),
      ),
    );
    const user = await renderChat();
    await user.click(screen.getByRole('switch', { name: 'Web search' }));
    await send(user, 'search');

    expect(await screen.findByText("This tool isn't enabled")).toBeInTheDocument();
  });
});
