/**
 * `/ai` Embeddings mode — the WIRE contract (issue #445 against #440's API).
 *
 * `POST /api/ai/embeddings`'s DTO is `.strict()`; the body is compared with
 * `toEqual` so an extra key fails here rather than as a 400 in production.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import { mockAiEmbeddingsFor, mockPlaygroundAllModeModels } from '../mocks/fixtures/ai';
import AiPlaygroundPage from '../../pages/AiPlaygroundPage';
import { api } from '../../services/api';

interface Captured {
  path: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function capture(): Captured[] {
  const captured: Captured[] = [];
  server.use(
    http.post('*/api/ai/embeddings', async ({ request }) => {
      const body = (await request.json()) as { input: string[]; dimensions?: number };
      captured.push({ path: new URL(request.url).pathname, method: request.method, headers: request.headers, body });
      return HttpResponse.json({ data: mockAiEmbeddingsFor(body.input, body.dimensions) });
    }),
  );
  return captured;
}

async function renderEmbeddingsMode() {
  const user = userEvent.setup();
  render(<AiPlaygroundPage />, { wrapperOptions: { route: '/ai', aiEnabled: true } });
  await user.click(await screen.findByRole('button', { name: 'Embeddings' }));
  const panel = screen.getByTestId('playground-mode-embeddings');
  await waitFor(() =>
    expect(within(panel).getByRole('combobox', { name: 'Model' })).toHaveTextContent('text-embedding-3-small'),
  );
  return { user, panel };
}

beforeEach(() => {
  server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data: mockPlaygroundAllModeModels })));
  api.setAccessToken('access-token-1');
});

afterEach(() => {
  api.setAccessToken(null);
});

describe('AiPlaygroundPage Embeddings mode — wire', () => {
  it('POSTs provider, model and the trimmed non-blank lines as an array, with the bearer token', async () => {
    const captured = capture();
    const { user, panel } = await renderEmbeddingsMode();

    await user.type(within(panel).getByRole('textbox', { name: 'Inputs' }), '  first {Enter}{Enter}second');
    await user.click(within(panel).getByRole('button', { name: 'Embed' }));

    await waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0].method).toBe('POST');
    expect(captured[0].path).toBe('/api/ai/embeddings');
    expect(captured[0].headers.get('authorization')).toBe('Bearer access-token-1');
    expect(captured[0].headers.get('content-type')).toBe('application/json');
    expect(captured[0].body).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
      input: ['first', 'second'],
    });
  });

  it('sends a single line as a one-item array, and dimensions only when set', async () => {
    const captured = capture();
    const { user, panel } = await renderEmbeddingsMode();

    await user.type(within(panel).getByRole('textbox', { name: 'Inputs' }), 'only');
    await user.type(within(panel).getByRole('textbox', { name: 'Dimensions' }), '8');
    await user.click(within(panel).getByRole('button', { name: 'Embed' }));

    await waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0].body).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
      input: ['only'],
      dimensions: 8,
    });
    expect(await within(panel).findByText('8 dimensions')).toBeInTheDocument();
  });
});
