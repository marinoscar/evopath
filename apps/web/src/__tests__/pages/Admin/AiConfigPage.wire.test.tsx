/**
 * `/admin/settings/ai` — the WIRE contract (issue #429, epic #419).
 *
 * Nothing mocked but the network (MSW, against the #425 fixtures and the #428
 * contract). `usePermissions` is real, read from the signed-in fixture user.
 * Proved here and nowhere else:
 *
 *   1. `If-Match` carries the loaded version, and a stale version (409)
 *      reloads the form and says so.
 *   2. The AI code is read from `details.reason` (top-level `code` is the
 *      generic HTTP one).
 *   3. The typed key goes out exactly once, in the `PUT …/key` body, and is
 *      never on screen afterwards; removal sends the `REMOVE` literal.
 *   4. The probe's verdict is the body, not the status — a 200 carrying
 *      `success: false` renders as a failure.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, mockAdminUser } from '../../utils/test-utils';
import type { MockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import AiConfigPage from '../../../pages/Admin/AiConfigPage';
import type { AiAdminConfig } from '../../../services/ai';
import { mockAiAdminConfig, mockAiProbeResultFailed } from '../../mocks/fixtures/ai';

const TYPED_KEY = 'sk-wire-test-key-NEVER-RENDERED-0001';

interface Captured {
  method: string;
  path: string;
  body: unknown;
  ifMatch: string | null;
}

function capture(list: Captured[]) {
  server.events.on('request:start', async ({ request }) => {
    const url = new URL(request.url);
    if (!url.pathname.includes('/admin/ai/')) return;
    let body: unknown = null;
    try {
      body = await request.clone().json();
    } catch {
      body = null;
    }
    list.push({ method: request.method, path: url.pathname, body, ifMatch: request.headers.get('If-Match') });
  });
}

async function renderLoaded(user: MockUser = mockAdminUser) {
  const ue = userEvent.setup();
  render(<AiConfigPage />, { wrapperOptions: { user } });
  await screen.findByRole('switch', { name: 'Enable AI for this deployment' });
  return ue;
}

describe('AiConfigPage — wire contract', () => {
  let captured: Captured[];

  beforeEach(() => {
    server.resetHandlers();
    server.events.removeAllListeners();
    captured = [];
    capture(captured);
  });

  afterEach(() => {
    server.events.removeAllListeners();
  });

  it('saves with If-Match: the loaded version, and adopts the response', async () => {
    const user = await renderLoaded();

    await user.click(screen.getByRole('switch', { name: 'Enable AI for this deployment' }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('AI configuration saved')).toBeInTheDocument();
    const put = captured.find((c) => c.method === 'PUT' && c.path.endsWith('/admin/ai/config'));
    expect(put?.ifMatch).toBe(String(mockAiAdminConfig.version));
    expect(put?.body).toMatchObject({ enabled: true, keyPolicy: 'byok' });
    // Adopted: AI is on, so the disabled notice is gone and the form is clean.
    expect(screen.queryByTestId('ai-disabled-notice')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
  });

  it('sends the realtime switch as defaults.allowRealtime (#449)', async () => {
    const user = await renderLoaded();

    await user.click(screen.getByRole('switch', { name: 'Allow realtime voice sessions' }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await screen.findByText('AI configuration saved');
    const put = captured.find((c) => c.method === 'PUT' && c.path.endsWith('/admin/ai/config'));
    expect(put?.body).toMatchObject({
      defaults: { maxOutputTokensCap: 4096, allowBackgroundRuns: true, allowRealtime: true },
    });
  });

  it('a full replace: re-sends the stored base URL and cap it did not touch', async () => {
    server.use(
      http.get('*/api/admin/ai/config', () =>
        HttpResponse.json({
          data: {
            ...mockAiAdminConfig,
            providers: [
              { ...mockAiAdminConfig.providers[0], baseUrl: 'https://gateway.example.com/v1' },
            ],
          } satisfies AiAdminConfig,
        }),
      ),
    );
    const user = await renderLoaded();

    await user.click(screen.getByRole('switch', { name: 'Log prompt content' }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await screen.findByText('AI configuration saved');
    const put = captured.find((c) => c.method === 'PUT' && c.path.endsWith('/admin/ai/config'));
    // Omitting either would CLEAR it on the server.
    expect(put?.body).toMatchObject({
      defaults: { maxOutputTokensCap: 4096, allowBackgroundRuns: true },
      providers: { openai: { enabled: false, baseUrl: 'https://gateway.example.com/v1' } },
    });
  });

  it('sends limits in the config PUT and adopts the stored answer (#450)', async () => {
    const user = await renderLoaded();

    await user.type(screen.getByLabelText('Requests per minute, per user'), '20');
    await user.type(screen.getByLabelText('Organization key: tokens per day, per user'), '100000');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await screen.findByText('AI configuration saved');
    const put = captured.find((c) => c.method === 'PUT' && c.path.endsWith('/admin/ai/config'));
    expect(put?.ifMatch).toBe(String(mockAiAdminConfig.version));
    expect((put?.body as { limits: unknown }).limits).toEqual({
      perUser: { requestsPerMinute: 20 },
      orgKey: { tokensPerDayPerUser: 100000 },
    });
    // Adopted: the fields keep the stored values and the form is clean.
    expect(screen.getByLabelText('Requests per minute, per user')).toHaveValue('20');
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
  });

  it('clearing the base URL and the cap sends explicit nulls', async () => {
    const user = await renderLoaded();

    await user.clear(screen.getByLabelText('Maximum output tokens per call'));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await screen.findByText('AI configuration saved');
    const put = captured.find((c) => c.method === 'PUT' && c.path.endsWith('/admin/ai/config'));
    expect(put?.body).toMatchObject({
      defaults: { maxOutputTokensCap: null },
      providers: { openai: { baseUrl: null } },
    });
    // The response is adopted: the field stays blank because the cap is now null.
    expect(screen.getByLabelText('Maximum output tokens per call')).toHaveValue('');
  });

  it('a provider this build does not have can be seen but not switched on or keyed', async () => {
    server.use(
      http.get('*/api/admin/ai/config', () =>
        HttpResponse.json({
          data: {
            ...mockAiAdminConfig,
            providers: [
              ...mockAiAdminConfig.providers,
              {
                id: 'legacy',
                displayName: 'Legacy',
                registered: false,
                enabled: false,
                baseUrl: null,
                keyStatus: { configured: false, hint: null, updatedAt: null, updatedByUserId: null },
                supportedCapabilities: [],
              },
            ],
          } satisfies AiAdminConfig,
        }),
      ),
    );
    const user = await renderLoaded();

    const card = screen.getByTestId('ai-provider-legacy');
    expect(within(card).getByText('Not available in this build')).toBeInTheDocument();
    expect(within(card).getByRole('switch', { name: 'Enable Legacy' })).toBeDisabled();
    await user.type(within(card).getByLabelText('Legacy API key'), TYPED_KEY);
    expect(within(card).getByRole('button', { name: /save key/i })).toBeDisabled();
    expect(within(card).getByRole('button', { name: /^test$/i })).toBeDisabled();
  });

  it('a 503 while verifying the key says nothing was stored', async () => {
    server.use(
      http.put('*/api/admin/ai/providers/:provider/key', () =>
        HttpResponse.json(
          { code: 'SERVICE_UNAVAILABLE', message: 'Provider unavailable' },
          { status: 503 },
        ),
      ),
    );
    const user = await renderLoaded();

    await user.type(screen.getByLabelText('OpenAI API key'), TYPED_KEY);
    await user.click(screen.getByRole('button', { name: /save key/i }));

    expect(await screen.findByText(/could not be reached to verify the key/i)).toBeInTheDocument();
  });

  it('a stale version 409s, reloads the form and says why', async () => {
    let gets = 0;
    server.use(
      http.get('*/api/admin/ai/config', () => {
        gets += 1;
        // First load is stale (version 2); the reload returns the current row.
        const config: AiAdminConfig =
          gets === 1 ? { ...mockAiAdminConfig, version: 2 } : mockAiAdminConfig;
        return HttpResponse.json({ data: config });
      }),
    );
    const user = await renderLoaded();

    await user.click(screen.getByRole('switch', { name: 'Log prompt content' }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/someone else changed the AI configuration/i)).toBeInTheDocument();
    expect(gets).toBe(2);
    // The edit was replaced by the current row.
    expect(screen.getByRole('switch', { name: 'Log prompt content' })).not.toBeChecked();
  });

  it('reads AI_KEY_REQUIRED from details.reason', async () => {
    server.use(
      http.put('*/api/admin/ai/config', () =>
        HttpResponse.json(
          {
            code: 'BAD_REQUEST',
            message: 'The organization-key fallback needs a key for openai',
            details: { reason: 'AI_KEY_REQUIRED' },
          },
          { status: 400 },
        ),
      ),
    );
    const user = await renderLoaded();

    await user.click(screen.getByRole('radio', { name: /fall back to the organization key/i }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(
      await screen.findByText('The organization-key fallback needs a key for openai'),
    ).toBeInTheDocument();
  });

  it('sends the typed key once, clears it, and never renders it', async () => {
    const user = await renderLoaded();

    const field = screen.getByLabelText('OpenAI API key');
    await user.type(field, TYPED_KEY);
    await user.click(screen.getByRole('button', { name: /save key/i }));

    expect(await screen.findByText('OpenAI key verified and saved')).toBeInTheDocument();
    const puts = captured.filter((c) => c.method === 'PUT' && c.path.endsWith('/providers/openai/key'));
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({ apiKey: TYPED_KEY });
    expect(field).toHaveValue('');
    expect(document.body.innerHTML).not.toContain(TYPED_KEY);
  });

  it('an invalid key (400 AI_KEY_INVALID) says nothing was stored', async () => {
    server.use(
      http.put('*/api/admin/ai/providers/:provider/key', () =>
        HttpResponse.json(
          { code: 'BAD_REQUEST', message: 'Invalid key', details: { reason: 'AI_KEY_INVALID' } },
          { status: 400 },
        ),
      ),
    );
    const user = await renderLoaded();

    await user.type(screen.getByLabelText('OpenAI API key'), TYPED_KEY);
    await user.click(screen.getByRole('button', { name: /save key/i }));

    expect(await screen.findByText(/nothing was stored/i)).toBeInTheDocument();
    expect(screen.getByLabelText('OpenAI API key')).toHaveValue('');
    expect(document.body.innerHTML).not.toContain(TYPED_KEY);
  });

  it('probe success: tests the STORED key when the field is blank', async () => {
    const user = await renderLoaded();

    await user.click(screen.getByRole('button', { name: /^test$/i }));

    const result = await screen.findByTestId('ai-test-result');
    expect(result).toHaveTextContent('The provider accepted this key');
    expect(result).toHaveTextContent('42 models visible');
    const post = captured.find((c) => c.method === 'POST' && c.path.endsWith('/providers/openai/test'));
    // Blank means "use the stored key" — expressed by absence.
    expect(post?.body).toEqual({});
  });

  it('probe failure: a 200 with success:false renders as a failure', async () => {
    server.use(
      http.post('*/api/admin/ai/providers/:provider/test', () =>
        HttpResponse.json({ data: mockAiProbeResultFailed }),
      ),
    );
    const user = await renderLoaded();

    await user.type(screen.getByLabelText('OpenAI API key'), TYPED_KEY);
    await user.click(screen.getByRole('button', { name: /^test$/i }));

    const result = await screen.findByTestId('ai-test-result');
    expect(result).toHaveTextContent('The provider test did not pass');
    expect(within(result).getByTestId('ai-check-code-credentials')).toHaveTextContent('AI_KEY_INVALID');
    const post = captured.find((c) => c.method === 'POST' && c.path.endsWith('/providers/openai/test'));
    expect(post?.body).toEqual({ apiKey: TYPED_KEY });
  });

  it('surfaces ORG_FALLBACK_WITHOUT_KEY from the DELETE response', async () => {
    server.use(
      http.delete('*/api/admin/ai/providers/:provider/key', () =>
        HttpResponse.json({
          data: {
            ...mockAiAdminConfig,
            keyPolicy: 'byok_with_org_fallback',
            warnings: ['ORG_FALLBACK_WITHOUT_KEY'],
          },
        }),
      ),
    );
    const user = await renderLoaded();

    await user.click(screen.getByRole('button', { name: /remove key/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/type remove to confirm/i), 'REMOVE');
    await user.click(within(dialog).getByRole('button', { name: /remove key/i }));

    expect(await screen.findByTestId('ai-org-fallback-without-key')).toBeInTheDocument();
  });

  it('removes the key with the REMOVE literal and shows the key as gone', async () => {
    const user = await renderLoaded();

    await user.click(screen.getByRole('button', { name: /remove key/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/type remove to confirm/i), 'REMOVE');
    await user.click(within(dialog).getByRole('button', { name: /remove key/i }));

    expect(await screen.findByText('OpenAI key removed')).toBeInTheDocument();
    const del = captured.find((c) => c.method === 'DELETE' && c.path.endsWith('/providers/openai/key'));
    expect(del?.body).toEqual({ confirmation: 'REMOVE' });
    expect(screen.getByText(/no organization key is stored/i)).toBeInTheDocument();
  });

  it('read-only admin: loads, shows the notice, and sends nothing', async () => {
    const readOnly: MockUser = {
      ...mockAdminUser,
      permissions: mockAdminUser.permissions.filter((p) => p !== 'ai_config:write'),
    };
    await renderLoaded(readOnly);

    expect(screen.getByTestId('ai-read-only-notice')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save key/i })).toBeDisabled();
    await waitFor(() =>
      expect(captured.filter((c) => c.method !== 'GET')).toHaveLength(0),
    );
  });
});
