/**
 * `/settings/ai` — the AI Keys page's STATES (issue #430, epic #419).
 *
 * Every state comes from the shared MSW fixtures (`mocks/fixtures/ai.ts`):
 * no key, a verified key, an invalid key on save, the org fallback, a default
 * model that is no longer usable, and no provider enabled. The request
 * bodies themselves are pinned in `UserAiKeysPage.wire.test.tsx`.
 *
 * Also the #425 regression the issue asks for: while `GET /api/ai/config`
 * says disabled, the hub hides the `AI Keys` card and the route guard
 * redirects.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { render, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import UserAiKeysPage from '../../pages/UserAiKeysPage';
import UserSettingsHubPage from '../../pages/UserSettingsHubPage';
import { RequireAiEnabled } from '../../components/common/RequireAiEnabled';
import { mockUserSettings } from '../mocks/data';
import {
  mockAiKeyInvalidErrorBody,
  mockAiProbeResultFailed,
  mockAiPublicConfigByok,
  mockAiPublicConfigKeyless,
  mockAiPublicConfigNoProviders,
  mockUserAiKeys,
  mockUserAiKeysErrored,
  mockUserAiKeysNone,
  mockUsableAiModelsMixed,
} from '../mocks/fixtures/ai';
import type { AiPublicConfig, UserAiKey } from '../../services/ai';

function useConfig(config: AiPublicConfig) {
  server.use(http.get('*/api/ai/config', () => HttpResponse.json({ data: config })));
}

function useKeys(keys: UserAiKey[]) {
  server.use(http.get('*/api/ai/keys', () => HttpResponse.json({ data: keys })));
}

/** Renders with AI enabled (org fallback policy, OpenAI has an org key) unless a config was mocked. */
async function renderPage(options: { fetchConfig?: boolean } = {}) {
  const user = userEvent.setup();
  render(<UserAiKeysPage />, {
    wrapperOptions: options.fetchConfig ? {} : { aiEnabled: true },
  });
  await waitFor(() =>
    expect(screen.queryByLabelText('Loading AI keys')).not.toBeInTheDocument(),
  );
  return user;
}

function keyField() {
  return screen.getByLabelText(/API key/i, { selector: 'input' }) as HTMLInputElement;
}

describe('UserAiKeysPage', () => {
  it('renders the header and the description', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'AI Keys' })).toBeInTheDocument();
    expect(
      screen.getByText(/Your key is encrypted, never shown again, and only used for requests you make/),
    ).toBeInTheDocument();
  });

  describe('keyless provider (#448)', () => {
    it('says no key is needed instead of offering key entry', async () => {
      useConfig(mockAiPublicConfigKeyless);
      useKeys(mockUserAiKeysNone);
      await renderPage({ fetchConfig: true });

      const keyless = screen.getByRole('region', { name: 'Local Ollama key' });
      expect(within(keyless).getByText(/No key needed — this server is keyless/)).toBeInTheDocument();
      expect(within(keyless).queryByLabelText(/API key/i, { selector: 'input' })).not.toBeInTheDocument();
      expect(within(keyless).queryByRole('button', { name: /Save & verify/ })).not.toBeInTheDocument();

      // A provider that does need a key keeps its key field.
      const openai = screen.getByRole('region', { name: 'OpenAI key' });
      expect(within(openai).getByLabelText(/API key/i, { selector: 'input' })).toBeInTheDocument();
    });
  });

  describe('no key', () => {
    it('shows Not configured, and neither Remove nor Test can act yet', async () => {
      useConfig(mockAiPublicConfigByok);
      useKeys(mockUserAiKeysNone);
      await renderPage({ fetchConfig: true });

      const card = screen.getByRole('region', { name: 'OpenAI key' });
      expect(within(card).getByText('Not configured')).toBeInTheDocument();
      expect(within(card).getByRole('button', { name: 'Remove' })).toBeDisabled();
      expect(within(card).getByRole('button', { name: 'Test' })).toBeDisabled();
      expect(within(card).getByRole('button', { name: /Save & verify/ })).toBeDisabled();
      expect(within(card).queryByText(/models available with this key/)).not.toBeInTheDocument();
    });

    it('uses a password field that password managers do not fill', async () => {
      useKeys(mockUserAiKeysNone);
      await renderPage();
      expect(keyField()).toHaveAttribute('type', 'password');
      expect(keyField()).toHaveAttribute('autocomplete', 'new-password');
    });
  });

  describe('verified key', () => {
    it('shows Verified, the masked hint and the reachable-model count', async () => {
      await renderPage();

      const card = screen.getByRole('region', { name: 'OpenAI key' });
      expect(within(card).getByText('Verified')).toBeInTheDocument();
      expect(within(card).getByText('••••wxyz')).toBeInTheDocument();
      expect(within(card).getByText('12 models available with this key')).toBeInTheDocument();
      expect(within(card).getByRole('button', { name: 'Re-check' })).toBeEnabled();
    });

    it('maps a recorded lastErrorCode to friendly text', async () => {
      useKeys(mockUserAiKeysErrored);
      await renderPage();

      const card = screen.getByRole('region', { name: 'OpenAI key' });
      expect(within(card).getByText('Error')).toBeInTheDocument();
      expect(within(card).getByText('The provider rejected this key')).toBeInTheDocument();
    });
  });

  describe('invalid key on save', () => {
    it('shows the reason inline, keeps the typed value, and stores nothing', async () => {
      useKeys(mockUserAiKeysNone);
      server.use(
        http.put('*/api/ai/keys/:provider', () =>
          HttpResponse.json(mockAiKeyInvalidErrorBody, { status: 400 }),
        ),
      );
      const user = await renderPage();

      await user.type(keyField(), 'sk-bad-key-0000');
      await user.click(screen.getByRole('button', { name: /Save & verify/ }));

      expect(await screen.findByText('The provider rejected this key')).toBeInTheDocument();
      expect(keyField()).toHaveValue('sk-bad-key-0000');
      expect(keyField()).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText('Not configured')).toBeInTheDocument();
      expect(screen.queryByText('Key verified and saved.')).not.toBeInTheDocument();
    });
  });

  describe('successful save', () => {
    it('clears the field and never renders the typed key again', async () => {
      useKeys(mockUserAiKeysNone);
      const user = await renderPage();

      await user.type(keyField(), 'sk-live-secret-4242');
      await user.click(screen.getByRole('button', { name: /Save & verify/ }));

      expect(await screen.findByText('Key verified and saved.')).toBeInTheDocument();
      expect(keyField()).toHaveValue('');
      expect(screen.getByText('Verified')).toBeInTheDocument();
      expect(document.body.innerHTML).not.toContain('sk-live-secret-4242');
    });
  });

  describe('test, re-check and remove', () => {
    it('shows the probe result for a failed test', async () => {
      server.use(
        http.post('*/api/ai/keys/:provider/test', () =>
          HttpResponse.json({ data: mockAiProbeResultFailed }),
        ),
      );
      const user = await renderPage();

      await user.click(screen.getByRole('button', { name: 'Test' }));

      const result = await screen.findByRole('status');
      expect(within(result).getByText('The key check failed')).toBeInTheDocument();
      expect(within(result).getByText(/Credentials: failed — The provider rejected this key/)).toBeInTheDocument();
    });

    it('Re-check shows the passing probe result', async () => {
      const user = await renderPage();
      await user.click(screen.getByRole('button', { name: 'Re-check' }));
      const result = await screen.findByRole('status');
      expect(within(result).getByText('The key works')).toBeInTheDocument();
    });

    it('Remove asks for confirmation, and Cancel keeps the key', async () => {
      let deletes = 0;
      server.use(
        http.delete('*/api/ai/keys/:provider', () => {
          deletes += 1;
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const user = await renderPage();

      await user.click(screen.getByRole('button', { name: 'Remove' }));
      const dialog = await screen.findByRole('dialog', { name: 'Remove your OpenAI key?' });
      expect(within(dialog).getByText(/fall back to your organization's key/)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(deletes).toBe(0);
    });

    it('Remove, confirmed, deletes the key and shows Not configured', async () => {
      server.use(
        http.delete('*/api/ai/keys/:provider', () => {
          useKeys(mockUserAiKeysNone);
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const user = await renderPage();

      await user.click(screen.getByRole('button', { name: 'Remove' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

      expect(await screen.findByText('Not configured')).toBeInTheDocument();
    });
  });

  describe('org fallback', () => {
    it('explains the shared key under byok_with_org_fallback when the provider has an org key', async () => {
      await renderPage();
      expect(
        screen.getByText(/Your organization provides a shared key\. Adding your own key is optional/),
      ).toBeInTheDocument();
    });

    it('says nothing about a shared key under strict byok', async () => {
      useConfig(mockAiPublicConfigByok);
      await renderPage({ fetchConfig: true });
      expect(screen.getByRole('region', { name: 'OpenAI key' })).toBeInTheDocument();
      expect(screen.queryByText(/Your organization provides a shared key/)).not.toBeInTheDocument();
    });
  });

  describe('usable models', () => {
    it('groups models by provider with id, capabilities and the org-key badge', async () => {
      server.use(
        http.get('*/api/ai/models', () => HttpResponse.json({ data: mockUsableAiModelsMixed })),
      );
      await renderPage();

      const list = await screen.findByRole('region', { name: 'Models you can use' });
      await waitFor(() => expect(within(list).getByText('GPT-5 mini')).toBeInTheDocument());
      const group = within(list).getByRole('region', { name: 'OpenAI models' });
      expect(within(group).getByText('gpt-5-mini')).toBeInTheDocument();
      expect(within(group).getAllByText('via organization key')).toHaveLength(1);
      // The shared AiCapabilityChips labels, not the raw capability strings.
      expect(within(group).getAllByText('Text').length).toBeGreaterThan(0);
      expect(within(group).getByText('Structured output')).toBeInTheDocument();
      // No display name: the id stands in for it, and is listed as the id too.
      expect(within(group).getAllByText('text-embedding-3-small')).toHaveLength(2);
    });
  });

  describe('default model', () => {
    it('offers only responses-capable models', async () => {
      server.use(
        http.get('*/api/ai/models', () => HttpResponse.json({ data: mockUsableAiModelsMixed })),
      );
      const user = await renderPage();

      const select = await screen.findByRole('combobox', { name: 'Default model' });
      await waitFor(() => expect(select).not.toHaveAttribute('aria-disabled', 'true'));
      await user.click(select);

      const listbox = await screen.findByRole('listbox');
      expect(within(listbox).getByRole('option', { name: 'OpenAI · GPT-5 mini' })).toBeInTheDocument();
      expect(within(listbox).getByRole('option', { name: 'OpenAI · GPT-5' })).toBeInTheDocument();
      expect(within(listbox).queryByRole('option', { name: /text-embedding/ })).not.toBeInTheDocument();
    });

    it('warns when the saved default is no longer available', async () => {
      server.use(
        http.get('*/api/user-settings', () =>
          HttpResponse.json({
            data: {
              ...mockUserSettings,
              ai: { defaultModel: { provider: 'openai', modelId: 'gpt-4-retired' } },
            },
          }),
        ),
      );
      await renderPage();

      expect(
        await screen.findByText(/Your default model is no longer available \(gpt-4-retired\)/),
      ).toBeInTheDocument();
    });

    it('does not warn when the saved default is usable', async () => {
      server.use(
        http.get('*/api/ai/models', () => HttpResponse.json({ data: mockUsableAiModelsMixed })),
        http.get('*/api/user-settings', () =>
          HttpResponse.json({
            data: { ...mockUserSettings, ai: { defaultModel: { provider: 'openai', modelId: 'gpt-5' } } },
          }),
        ),
      );
      await renderPage();

      const select = await screen.findByRole('combobox', { name: 'Default model' });
      await waitFor(() => expect(select).toHaveTextContent('OpenAI · GPT-5'));
      expect(screen.queryByText(/no longer available/)).not.toBeInTheDocument();
    });
  });

  describe('no provider enabled', () => {
    it('shows the empty state and no key cards', async () => {
      useConfig(mockAiPublicConfigNoProviders);
      await renderPage({ fetchConfig: true });

      expect(
        screen.getByText("Your administrator hasn't enabled any AI provider yet."),
      ).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'OpenAI key' })).not.toBeInTheDocument();
    });
  });

  it('redirects a user without ai:use', async () => {
    render(
      <Routes>
        <Route path="/" element={<div>home page</div>} />
        <Route path="/settings/ai" element={<UserAiKeysPage />} />
      </Routes>,
      {
        wrapperOptions: {
          route: '/settings/ai',
          aiEnabled: true,
          user: { ...mockUser, permissions: ['user_settings:read'] },
        },
      },
    );
    expect(await screen.findByText('home page')).toBeInTheDocument();
  });
});

/**
 * Regression for #425's gating, which this page relies on rather than
 * re-implementing: `GET /api/ai/config` saying disabled hides the card and
 * sends the route away.
 */
describe('AI Keys gating while AI is disabled (#425 regression)', () => {
  it('hides the AI Keys card on the /settings hub', async () => {
    render(<UserSettingsHubPage />, { wrapperOptions: { route: '/settings' } });
    // The hub's own cards render; AI Keys is not one of them.
    expect(await screen.findByText('Access Tokens')).toBeInTheDocument();
    expect(screen.queryByText('AI Keys')).not.toBeInTheDocument();
  });

  it('shows the AI Keys card once AI is enabled', async () => {
    render(<UserSettingsHubPage />, { wrapperOptions: { route: '/settings', aiEnabled: true } });
    expect(await screen.findByText('AI Keys')).toBeInTheDocument();
  });

  it('redirects /settings/ai to / behind RequireAiEnabled', async () => {
    render(
      <Routes>
        <Route path="/" element={<div>home page</div>} />
        <Route
          path="/settings/ai"
          element={
            <RequireAiEnabled>
              <UserAiKeysPage />
            </RequireAiEnabled>
          }
        />
      </Routes>,
      { wrapperOptions: { route: '/settings/ai' } },
    );
    expect(await screen.findByText('home page')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'AI Keys' })).not.toBeInTheDocument();
  });
});
