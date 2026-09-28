/**
 * `/settings/ai` — the WIRE contract (issue #430, epic #419).
 *
 * No hook is mocked: `useUserAiKeys`, `useUsableAiModels` and
 * `useUserSettings` run for real and only the network is faked, with MSW —
 * the same approach as `StorageConfigPage.wire.test.tsx`. What is pinned:
 *
 *   1. SAVE sends `{ apiKey }` to `PUT /api/ai/keys/:provider` exactly once,
 *      then re-reads the usable models (a new key changes what is reachable).
 *   2. TEST sends the typed key when there is one, and `{}` (the stored key)
 *      for Re-check.
 *   3. THE DEFAULT MODEL ROUND-TRIPS through user settings:
 *      `PATCH /api/user-settings` with `{ ai: { defaultModel } }` and the
 *      loaded version as `If-Match`, and a reload reads it back selected.
 *      "No default" sends `defaultModel: null`.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import UserAiKeysPage from '../../pages/UserAiKeysPage';
import { mockUserSettings } from '../mocks/data';
import {
  mockAiProbeResultPassed,
  mockUserAiKeys,
  mockUserAiKeysNone,
  mockUsableAiModelsMixed,
  mockAiUsageReport,
} from '../mocks/fixtures/ai';
import type { UserSettings } from '../../types';

async function renderPage() {
  const user = userEvent.setup();
  const view = render(<UserAiKeysPage />, { wrapperOptions: { aiEnabled: true } });
  await waitFor(() =>
    expect(screen.queryByLabelText('Loading AI keys')).not.toBeInTheDocument(),
  );
  return { user, ...view };
}

async function openDefaultPicker(user: ReturnType<typeof userEvent.setup>) {
  const select = await screen.findByRole('combobox', { name: 'Default model' });
  await waitFor(() => expect(select).not.toHaveAttribute('aria-disabled', 'true'));
  await user.click(select);
  return screen.findByRole('listbox');
}

describe('UserAiKeysPage — wire', () => {
  it('PUTs the typed key once, then refreshes the usable models', async () => {
    const puts: { provider: string; body: unknown }[] = [];
    let modelReads = 0;
    let keys = mockUserAiKeysNone;
    server.use(
      http.get('*/api/ai/keys', () => HttpResponse.json({ data: keys })),
      http.put('*/api/ai/keys/:provider', async ({ params, request }) => {
        puts.push({ provider: String(params.provider), body: await request.json() });
        keys = mockUserAiKeys;
        return HttpResponse.json({ data: mockUserAiKeys[0] });
      }),
      http.get('*/api/ai/models', () => {
        modelReads += 1;
        return HttpResponse.json({ data: mockUsableAiModelsMixed });
      }),
    );
    const { user } = await renderPage();
    await waitFor(() => expect(modelReads).toBe(1));

    await user.type(screen.getByLabelText(/API key/i, { selector: 'input' }), '  sk-wire-1234  ');
    await user.click(screen.getByRole('button', { name: /Save & verify/ }));

    await screen.findByText('Key verified and saved.');
    expect(puts).toEqual([{ provider: 'openai', body: { apiKey: 'sk-wire-1234' } }]);
    await waitFor(() => expect(modelReads).toBe(2));
  });

  it('Test sends the typed key; Re-check sends none', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post('*/api/ai/keys/:provider/test', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ data: mockAiProbeResultPassed });
      }),
    );
    const { user } = await renderPage();

    await user.type(screen.getByLabelText(/API key/i, { selector: 'input' }), 'sk-typed-5555');
    await user.click(screen.getByRole('button', { name: 'Test' }));
    await screen.findByRole('status');

    await user.click(screen.getByRole('button', { name: 'Re-check' }));
    await waitFor(() => expect(bodies).toHaveLength(2));

    expect(bodies).toEqual([{ apiKey: 'sk-typed-5555' }, {}]);
  });

  it('round-trips the default model through PATCH /api/user-settings', async () => {
    let stored: UserSettings = { ...mockUserSettings, version: 7 };
    const patches: { body: unknown; ifMatch: string | null }[] = [];
    server.use(
      http.get('*/api/ai/models', () => HttpResponse.json({ data: mockUsableAiModelsMixed })),
      http.get('*/api/user-settings', () => HttpResponse.json({ data: stored })),
      http.patch('*/api/user-settings', async ({ request }) => {
        const body = (await request.json()) as Partial<UserSettings>;
        patches.push({ body, ifMatch: request.headers.get('If-Match') });
        stored = { ...stored, ...body, version: stored.version + 1 };
        return HttpResponse.json({ data: stored });
      }),
    );
    const { user, unmount } = await renderPage();

    const listbox = await openDefaultPicker(user);
    await user.click(within(listbox).getByRole('option', { name: 'OpenAI · GPT-5' }));

    await screen.findByText('Default model saved.');
    expect(patches).toEqual([
      { body: { ai: { defaultModel: { provider: 'openai', modelId: 'gpt-5' } } }, ifMatch: '7' },
    ]);

    // A fresh visit reads the saved default back, selected.
    unmount();
    await renderPage();
    const select = await screen.findByRole('combobox', { name: 'Default model' });
    await waitFor(() => expect(select).toHaveTextContent('OpenAI · GPT-5'));
    expect(stored.ai).toEqual({ defaultModel: { provider: 'openai', modelId: 'gpt-5' } });
  });

  it('"No default" clears the saved default with null', async () => {
    let stored: UserSettings = {
      ...mockUserSettings,
      ai: { defaultModel: { provider: 'openai', modelId: 'gpt-5-mini' } },
    };
    const patches: unknown[] = [];
    server.use(
      http.get('*/api/ai/models', () => HttpResponse.json({ data: mockUsableAiModelsMixed })),
      http.get('*/api/user-settings', () => HttpResponse.json({ data: stored })),
      http.patch('*/api/user-settings', async ({ request }) => {
        const body = (await request.json()) as Partial<UserSettings>;
        patches.push(body);
        stored = { ...stored, ...body, version: stored.version + 1 };
        return HttpResponse.json({ data: stored });
      }),
    );
    const { user } = await renderPage();

    const listbox = await openDefaultPicker(user);
    await user.click(within(listbox).getByRole('option', { name: 'No default' }));

    await screen.findByText('Default model saved.');
    expect(patches).toEqual([{ ai: { defaultModel: null } }]);
  });

  it('shows the error when saving the default fails', async () => {
    server.use(
      http.get('*/api/ai/models', () => HttpResponse.json({ data: mockUsableAiModelsMixed })),
      http.patch('*/api/user-settings', () =>
        HttpResponse.json({ code: 'BAD_REQUEST', message: 'Invalid settings' }, { status: 400 }),
      ),
    );
    const { user } = await renderPage();

    const listbox = await openDefaultPicker(user);
    await user.click(within(listbox).getByRole('option', { name: 'OpenAI · GPT-5 mini' }));

    expect(await screen.findByText('Invalid settings')).toBeInTheDocument();
    expect(screen.queryByText('Default model saved.')).not.toBeInTheDocument();
  });

  it('shows the caller\'s own last-30-days usage at the foot of the page (#444)', async () => {
    const reads: string[] = [];
    server.use(
      http.get('*/api/ai/usage/me', ({ request }) => {
        reads.push(new URL(request.url).searchParams.get('groupBy') ?? '');
        return HttpResponse.json({ data: mockAiUsageReport('model') });
      }),
    );
    await renderPage();

    const section = await screen.findByRole('region', { name: 'Usage' });
    expect(await within(section).findByText('gpt-5-mini')).toBeInTheDocument();
    expect(reads).toEqual(['model']);
    // A section of this page, not a tab strip (Settings UI Pattern rule 2).
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });
});
