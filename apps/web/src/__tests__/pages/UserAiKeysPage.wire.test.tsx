/**
 * `/settings/ai` — the WIRE contract (issue #430, epic #419).
 *
 * No hook is mocked: `useUserAiKeys` and `useUsableAiModels`
 * run for real and only the network is faked, with MSW —
 * the same approach as `StorageConfigPage.wire.test.tsx`. What is pinned:
 *
 *   1. SAVE sends `{ apiKey }` to `PUT /api/ai/keys/:provider` exactly once,
 *      then re-reads the usable models (a new key changes what is reachable).
 *   2. TEST sends the typed key when there is one, and `{}` (the stored key)
 *      for Re-check.
 *   3. NO MODEL CHOICE (#173): the page never writes the user settings
 *      document; every model is an administrator's assignment.
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

async function renderPage() {
  const user = userEvent.setup();
  const view = render(<UserAiKeysPage />, { wrapperOptions: { aiEnabled: true } });
  await waitFor(() =>
    expect(screen.queryByLabelText('Loading AI keys')).not.toBeInTheDocument(),
  );
  return { user, ...view };
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

  it('never writes the user settings document: models are not a user choice (#173)', async () => {
    const patches: unknown[] = [];
    server.use(
      http.get('*/api/ai/models', () => HttpResponse.json({ data: mockUsableAiModelsMixed })),
      http.patch('*/api/user-settings', async ({ request }) => {
        patches.push(await request.json());
        return HttpResponse.json({ data: mockUserSettings });
      }),
      http.put('*/api/user-settings', async ({ request }) => {
        patches.push(await request.json());
        return HttpResponse.json({ data: mockUserSettings });
      }),
    );
    await renderPage();

    await screen.findByRole('region', { name: 'OpenAI key' });
    expect(screen.queryByRole('combobox', { name: 'Default model' })).not.toBeInTheDocument();
    expect(patches).toEqual([]);
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
