/**
 * `/admin/settings/ai/models` — the WIRE contract (issue #429, epic #419).
 *
 * Real hooks, real permissions, MSW for the network. Proved here:
 *
 *   1. The toolbar's filters reach `GET /admin/ai/models` as query params.
 *   2. Enabling is OPTIMISTIC — the switch flips before the server answers —
 *      and ROLLS BACK when the API refuses (4xx).
 *   3. An override `PATCH`es `{ capabilities }` and the row adopts the
 *      server's `admin_override` source.
 *   4. Refresh posts `{ provider }` and reports the queued job.
 *   5. Per-model limits (#450) go out as a `PUT /admin/ai/config` with
 *      `If-Match`, carrying the loaded config with only that entry changed.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { render, mockAdminUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import AiModelsPage from '../../../pages/Admin/AiModelsPage';
import { mockAiAdminConfig, mockAiModelList } from '../../mocks/fixtures/ai';

interface Captured {
  method: string;
  url: URL;
  body: unknown;
  ifMatch: string | null;
}

async function renderLoaded() {
  const user = userEvent.setup();
  render(<AiModelsPage />, { wrapperOptions: { user: mockAdminUser } });
  await screen.findByText('gpt-5-mini');
  return user;
}

describe('AiModelsPage — wire contract', () => {
  let captured: Captured[];

  beforeEach(() => {
    server.resetHandlers();
    server.events.removeAllListeners();
    captured = [];
    server.events.on('request:start', async ({ request }) => {
      const url = new URL(request.url);
      if (!url.pathname.includes('/admin/ai/models') && !url.pathname.endsWith('/admin/ai/config')) {
        return;
      }
      let body: unknown = null;
      try {
        body = await request.clone().json();
      } catch {
        body = null;
      }
      captured.push({ method: request.method, url, body, ifMatch: request.headers.get('If-Match') });
    });
  });

  afterEach(() => {
    server.events.removeAllListeners();
  });

  it('sends the toolbar filters as query parameters', async () => {
    const user = await renderLoaded();

    await user.click(screen.getByRole('switch', { name: 'Show deprecated models' }));
    await user.click(screen.getByRole('combobox', { name: 'Provider' }));
    await user.click(await screen.findByRole('option', { name: 'OpenAI' }));

    await waitFor(() => {
      const last = captured.filter((c) => c.method === 'GET').at(-1);
      expect(last?.url.searchParams.get('provider')).toBe('openai');
      expect(last?.url.searchParams.get('includeDeprecated')).toBe('true');
      expect(last?.url.searchParams.get('page')).toBe('1');
    });
  });

  it('enables optimistically, before the server answers', async () => {
    server.use(
      http.patch('*/api/admin/ai/models/:id', async ({ request, params }) => {
        await delay(150);
        const body = (await request.json()) as Record<string, unknown>;
        const model = mockAiModelList.items.find((m) => m.id === params.id)!;
        return HttpResponse.json({ data: { ...model, ...body } });
      }),
    );
    const user = await renderLoaded();

    const toggle = screen.getByRole('switch', { name: 'Enable text-embedding-3-small' });
    await user.click(toggle);

    // Flipped already, while the PATCH is still in flight (and so disabled).
    expect(screen.getByRole('switch', { name: 'Enable text-embedding-3-small' })).toBeChecked();
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Enable text-embedding-3-small' })).toBeEnabled(),
    );
    expect(screen.getByRole('switch', { name: 'Enable text-embedding-3-small' })).toBeChecked();
    const patch = captured.find((c) => c.method === 'PATCH');
    expect(patch?.url.pathname).toMatch(/\/admin\/ai\/models\/model-2$/);
    expect(patch?.body).toEqual({ enabled: true });
  });

  it('rolls back when the API refuses', async () => {
    server.use(
      http.patch('*/api/admin/ai/models/:id', () =>
        HttpResponse.json(
          { code: 'CONFLICT', message: 'Model is deprecated', details: { reason: 'AI_MODEL_DEPRECATED' } },
          { status: 409 },
        ),
      ),
    );
    const user = await renderLoaded();

    await user.click(screen.getByRole('switch', { name: 'Enable text-embedding-3-small' }));

    expect(await screen.findByTestId('ai-models-update-error')).toHaveTextContent(
      /withdrawn by the provider/i,
    );
    expect(screen.getByRole('switch', { name: 'Enable text-embedding-3-small' })).not.toBeChecked();
  });

  it('rolls back a DISABLE too', async () => {
    server.use(
      http.patch('*/api/admin/ai/models/:id', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'Forbidden' }, { status: 403 }),
      ),
    );
    const user = await renderLoaded();

    await user.click(screen.getByRole('switch', { name: 'Enable gpt-5-mini' }));

    expect(await screen.findByTestId('ai-models-update-error')).toHaveTextContent(
      /do not have permission/i,
    );
    expect(screen.getByRole('switch', { name: 'Enable gpt-5-mini' })).toBeChecked();
  });

  it('classifies a model with an override PATCH and adopts the new source', async () => {
    const user = await renderLoaded();

    await user.click(screen.getByRole('button', { name: 'Edit capabilities for ft:custom-model' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Text' }));
    await user.click(within(dialog).getAllByRole('checkbox', { name: 'text' })[0]);
    await user.click(within(dialog).getAllByRole('checkbox', { name: 'text' })[1]);
    await user.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const patch = captured.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({
      capabilities: {
        capabilities: ['responses'],
        inputModalities: ['text'],
        outputModalities: ['text'],
      },
    });
    expect(await screen.findByText('admin override')).toBeInTheDocument();
    // Classified now, so the switch is live.
    expect(screen.getByRole('switch', { name: 'Enable ft:custom-model' })).toBeEnabled();
  });

  it('saves per-model limits with a PATCH and an If-Match config PUT (#450)', async () => {
    const user = await renderLoaded();

    await user.click(screen.getByRole('button', { name: 'Edit capabilities for gpt-5-mini' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Max output tokens per call'), '2048');
    await user.type(within(dialog).getByLabelText('Requests per minute per user'), '6');
    await user.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(captured.find((c) => c.method === 'PATCH')?.url.pathname).toMatch(/\/admin\/ai\/models\/model-1$/);
    const put = captured.find((c) => c.method === 'PUT');
    expect(put?.url.pathname).toMatch(/\/admin\/ai\/config$/);
    expect(put?.ifMatch).toBe(String(mockAiAdminConfig.version));
    expect(put?.body).toMatchObject({
      enabled: mockAiAdminConfig.enabled,
      defaults: mockAiAdminConfig.defaults,
      providers: { openai: { enabled: false, baseUrl: null } },
      limits: { perModel: { 'openai:gpt-5-mini': { maxOutputTokens: 2048, requestsPerMinutePerUser: 6 } } },
    });

    // The saved configuration is the new baseline: reopening shows the limits.
    await user.click(screen.getByRole('button', { name: 'Edit capabilities for gpt-5-mini' }));
    const reopened = await screen.findByRole('dialog');
    expect(within(reopened).getByLabelText('Max output tokens per call')).toHaveValue('2048');
  });

  it('queues a refresh for the provider with a key', async () => {
    const user = await renderLoaded();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /refresh from provider/i })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: /refresh from provider/i }));

    expect(await screen.findByText('Refresh queued (job job-ai-refresh-1)')).toBeInTheDocument();
    const post = captured.find((c) => c.method === 'POST');
    expect(post?.url.pathname).toMatch(/\/admin\/ai\/models\/refresh$/);
    expect(post?.body).toEqual({ provider: 'openai' });
  });

  it('a refresh refused with AI_KEY_REQUIRED explains the missing key', async () => {
    server.use(
      http.post('*/api/admin/ai/models/refresh', () =>
        HttpResponse.json(
          { code: 'CONFLICT', message: 'No key', details: { reason: 'AI_KEY_REQUIRED' } },
          { status: 409 },
        ),
      ),
    );
    const user = await renderLoaded();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /refresh from provider/i })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: /refresh from provider/i }));

    expect(await screen.findByText(/has no organization key/i)).toBeInTheDocument();
  });

  it('explains an empty catalogue', async () => {
    server.use(
      http.get('*/api/admin/ai/models', () =>
        HttpResponse.json({
          data: { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 },
        }),
      ),
    );
    render(<AiModelsPage />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByTestId('ai-models-empty')).toHaveTextContent(
      'Save an admin key and refresh to discover models.',
    );
  });
});
