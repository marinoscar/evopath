/**
 * `/ai` — the Playground's Embeddings mode (issue #445; API #440).
 *
 * Real page, hooks and services; only the network is faked (MSW).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import {
  aiErrorBody,
  mockAiEmbeddingsFor,
  mockAiPublicConfigEnabled,
  mockPlaygroundAllModeModels,
} from '../mocks/fixtures/ai';
import AiPlaygroundPage from '../../pages/AiPlaygroundPage';
import { AiConfigContext, type UseAiConfigReturn } from '../../hooks/useAiConfig';

async function renderEmbeddingsMode() {
  const user = userEvent.setup();
  const aiValue: UseAiConfigReturn = {
    config: mockAiPublicConfigEnabled,
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
  await user.click(await screen.findByRole('button', { name: 'Embeddings' }));
  const panel = screen.getByTestId('playground-mode-embeddings');
  await waitFor(() =>
    expect(within(panel).getByRole('combobox', { name: 'Model' })).toHaveTextContent('text-embedding-3-small'),
  );
  return { user, panel };
}

beforeEach(() => {
  server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data: mockPlaygroundAllModeModels })));
});

describe('AiPlaygroundPage — Embeddings mode', () => {
  it('lists only embedding models', async () => {
    const { user, panel } = await renderEmbeddingsMode();
    await user.click(within(panel).getByRole('combobox', { name: 'Model' }));
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('counts non-blank lines and embeds them: summary, first 8 values, similarity matrix', async () => {
    const { user, panel } = await renderEmbeddingsMode();
    const textarea = within(panel).getByRole('textbox', { name: 'Inputs' });
    await user.type(textarea, 'cat{Enter}{Enter}  dog  {Enter}cat');
    expect(within(panel).getByText('One input per line · 3 / 256')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Embed' }));

    const result = await within(panel).findByTestId('embeddings-result');
    const summary = within(result).getByRole('group', { name: 'Embeddings summary' });
    expect(summary).toHaveTextContent('3 vectors');
    expect(summary).toHaveTextContent('16 dimensions');

    const vectors = within(result).getByRole('table', { name: 'Vectors' });
    const expected = mockAiEmbeddingsFor(['cat', 'dog', 'cat']).vectors[1];
    const dogRow = within(vectors).getAllByRole('row')[2];
    expect(dogRow).toHaveTextContent('dog');
    expect(dogRow).toHaveTextContent(expected.slice(0, 8).map((v) => v.toFixed(4)).join(', '));
    expect(dogRow).toHaveTextContent('…');
    expect(dogRow).not.toHaveTextContent(expected[8].toFixed(4));

    const matrix = within(result).getByRole('table', { name: 'Cosine similarity' });
    const rows = within(matrix).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(within(rows[1]).getByRole('rowheader')).toHaveTextContent('1. cat');
    // Identical texts are identical vectors: row 1, column 3.
    expect(within(rows[1]).getAllByRole('cell')[2]).toHaveTextContent('1.000');
    expect(within(rows[2]).getAllByRole('cell')[1]).toHaveTextContent('1.000');
  });

  it('omits the similarity matrix beyond 10 inputs, and blocks more than 256', async () => {
    const { user, panel } = await renderEmbeddingsMode();
    const textarea = within(panel).getByRole('textbox', { name: 'Inputs' });

    fireEvent.change(textarea, { target: { value: Array.from({ length: 11 }, (_u, i) => `text ${i}`).join('\n') } });
    await user.click(within(panel).getByRole('button', { name: 'Embed' }));
    const result = await within(panel).findByTestId('embeddings-result');
    expect(within(result).getByRole('group', { name: 'Embeddings summary' })).toHaveTextContent('11 vectors');
    expect(within(result).queryByRole('table', { name: 'Cosine similarity' })).not.toBeInTheDocument();
    expect(within(result).getByText('The similarity matrix is shown for up to 10 inputs.')).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: Array.from({ length: 257 }, (_u, i) => `t${i}`).join('\n') } });
    expect(within(panel).getByText('At most 256 inputs — remove 1')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Embed' })).toBeDisabled();
  });

  it('validates dimensions and renders a refusal through the shared AI copy', async () => {
    server.use(
      http.post('*/api/ai/embeddings', () =>
        HttpResponse.json(aiErrorBody('AI_INVALID_REQUEST', 'This model cannot shorten its vectors'), { status: 400 }),
      ),
    );
    const { user, panel } = await renderEmbeddingsMode();
    await user.type(within(panel).getByRole('textbox', { name: 'Inputs' }), 'hello');

    const dims = within(panel).getByRole('textbox', { name: 'Dimensions' });
    await user.type(dims, '0');
    expect(within(panel).getByText('Enter a whole number of at least 1')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Embed' })).toBeDisabled();
    await user.clear(dims);
    await user.type(dims, '256');

    await user.click(within(panel).getByRole('button', { name: 'Embed' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveAttribute('data-ai-error-code', 'AI_INVALID_REQUEST');
    expect(alert).toHaveTextContent('This model cannot shorten its vectors');
    expect(within(panel).queryByTestId('embeddings-result')).not.toBeInTheDocument();
  });
});
