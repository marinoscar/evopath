/**
 * `/admin/settings/ai` — the provider-specific fields (issue #448, epic #421).
 *
 * Each provider card renders exactly its `settingsFields`: Azure OpenAI gets
 * an Endpoint, API version, API style and a deployments list; an
 * OpenAI-compatible server a Base URL, API style and "Requires an API key";
 * the built-in providers keep their one Base URL. The `PUT` body carries only
 * those fields — for OpenAI it is unchanged from before #448.
 *
 * `useAiAdminConfig` is mocked, as in `AiConfigPage.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import type { AiAdminConfig } from '../../../services/ai';
import { mockAiAdminConfigWithCompatible } from '../../mocks/fixtures/ai';

vi.mock('../../../hooks/useAiAdminConfig', () => ({ useAiAdminConfig: vi.fn() }));
vi.mock('../../../hooks/usePermissions', () => ({ usePermissions: vi.fn() }));

import { useAiAdminConfig } from '../../../hooks/useAiAdminConfig';
import type { UseAiAdminConfigReturn } from '../../../hooks/useAiAdminConfig';
import { usePermissions } from '../../../hooks/usePermissions';
import AiConfigPage from '../../../pages/Admin/AiConfigPage';

const mockUseAiAdminConfig = vi.mocked(useAiAdminConfig);
const mockUsePermissions = vi.mocked(usePermissions);

function setPermissions(granted: string[]) {
  mockUsePermissions.mockReturnValue({
    permissions: new Set(granted),
    roles: new Set(['admin']),
    hasPermission: (permission: string) => granted.includes(permission),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin: true,
  });
}

function setHook(config: AiAdminConfig = mockAiAdminConfigWithCompatible): UseAiAdminConfigReturn {
  const value: UseAiAdminConfigReturn = {
    config,
    isLoading: false,
    loadError: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    isSaving: false,
    saveError: null,
    clearSaveError: vi.fn(),
    save: vi.fn().mockResolvedValue(true),
    keyAction: null,
    keyError: null,
    clearKeyError: vi.fn(),
    keyWarnings: [],
    clearKeyWarnings: vi.fn(),
    setKey: vi.fn().mockResolvedValue(true),
    removeKey: vi.fn().mockResolvedValue(true),
    probingProvider: null,
    probeError: null,
    clearProbeError: vi.fn(),
    testResults: {},
    clearTestResult: vi.fn(),
    test: vi.fn().mockResolvedValue(undefined),
  };
  mockUseAiAdminConfig.mockReturnValue(value);
  return value;
}

function renderPage() {
  const user = userEvent.setup();
  render(<AiConfigPage />, { wrapperOptions: { user: mockAdminUser } });
  return user;
}

const card = (id: string) => screen.getByTestId(`ai-provider-${id}`);
const saveButton = () => screen.getByRole('button', { name: /save changes/i });

describe('AiConfigPage — provider-specific fields (#448)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions(['ai_config:read', 'ai_config:write']);
  });

  describe('renders only each provider’s settingsFields', () => {
    it('OpenAI: a Base URL, nothing else', () => {
      setHook();
      renderPage();
      const openai = within(card('openai'));

      expect(openai.getByLabelText('Base URL')).toBeInTheDocument();
      expect(openai.queryByLabelText('API version')).not.toBeInTheDocument();
      expect(openai.queryByLabelText('API style')).not.toBeInTheDocument();
      expect(openai.queryByText('Deployments')).not.toBeInTheDocument();
      expect(openai.queryByRole('switch', { name: 'Requires an API key' })).not.toBeInTheDocument();
    });

    it('Azure OpenAI: Endpoint, API version, API style and the deployments list', () => {
      setHook();
      renderPage();
      const azure = within(card('azure-openai'));

      expect(azure.getByLabelText('Endpoint')).toHaveValue('https://contoso.openai.azure.com');
      expect(azure.getByText(/my-resource\.openai\.azure\.com/)).toBeInTheDocument();
      expect(azure.queryByLabelText('Base URL')).not.toBeInTheDocument();
      expect(azure.getByLabelText('API version')).toHaveValue('2024-10-21');
      expect(azure.getByLabelText('API version')).toHaveAttribute('placeholder', '2025-04-01-preview');
      expect(azure.getByRole('combobox', { name: 'API style' })).toHaveTextContent('Default (Responses API)');
      expect(azure.getByLabelText('Model id')).toHaveValue('gpt-4o');
      expect(azure.getByLabelText('Deployment name')).toHaveValue('contoso-gpt-4o');
      expect(azure.queryByRole('switch', { name: 'Requires an API key' })).not.toBeInTheDocument();
    });

    it('OpenAI-compatible: Base URL, API style (Chat Completions default) and Requires an API key, on', () => {
      setHook();
      renderPage();
      const compatible = within(card('openai-compatible'));

      expect(compatible.getByLabelText('Base URL')).toHaveValue('');
      expect(compatible.getByText(/http:\/\/ollama:11434\/v1/)).toBeInTheDocument();
      expect(compatible.getByRole('combobox', { name: 'API style' })).toHaveTextContent(
        'Default (Chat Completions)',
      );
      expect(compatible.queryByLabelText('API version')).not.toBeInTheDocument();
      expect(compatible.queryByText('Deployments')).not.toBeInTheDocument();
      expect(compatible.getByRole('switch', { name: 'Requires an API key' })).toBeChecked();
      expect(screen.queryByTestId('ai-provider-openai-compatible-keyless-warning')).not.toBeInTheDocument();
    });

    it('read-only admin: every provider field is disabled', () => {
      setPermissions(['ai_config:read']);
      setHook();
      renderPage();

      expect(within(card('azure-openai')).getByLabelText('Endpoint')).toBeDisabled();
      expect(within(card('azure-openai')).getByLabelText('API version')).toBeDisabled();
      expect(within(card('azure-openai')).getByRole('button', { name: 'Add deployment' })).toBeDisabled();
      expect(within(card('openai-compatible')).getByRole('switch', { name: 'Requires an API key' })).toBeDisabled();
    });
  });

  describe('the PUT body', () => {
    it('OpenAI is unchanged, and Azure / OpenAI-compatible send only their own fields', async () => {
      const hook = setHook();
      const user = renderPage();
      const azure = within(card('azure-openai'));
      const compatible = within(card('openai-compatible'));

      // Azure: a new api-version, Chat Completions, and a second deployment.
      await user.clear(azure.getByLabelText('API version'));
      await user.type(azure.getByLabelText('API version'), '2024-06-01');
      await user.click(azure.getByRole('combobox', { name: 'API style' }));
      await user.click(screen.getByRole('option', { name: 'Chat Completions' }));
      await user.click(azure.getByRole('button', { name: 'Add deployment' }));
      const rows = azure.getAllByLabelText('Model id');
      await user.type(rows[1], 'gpt-4o-mini');
      await user.type(azure.getAllByLabelText('Deployment name')[1], 'contoso-mini');

      // Compatible: an endpoint, enabled, and keyless.
      await user.type(compatible.getByLabelText('Base URL'), 'http://ollama:11434/v1');
      await user.click(compatible.getByRole('switch', { name: 'Enable OpenAI-compatible' }));
      await user.click(compatible.getByRole('switch', { name: 'Requires an API key' }));

      await user.click(saveButton());
      await waitFor(() => expect(hook.save).toHaveBeenCalledTimes(1));
      const body = vi.mocked(hook.save).mock.calls[0][0];
      expect(body.providers).toEqual({
        openai: { enabled: false, baseUrl: null },
        'azure-openai': {
          enabled: true,
          baseUrl: 'https://contoso.openai.azure.com',
          apiVersion: '2024-06-01',
          apiStyle: 'chat_completions',
          deployments: { 'gpt-4o': 'contoso-gpt-4o', 'gpt-4o-mini': 'contoso-mini' },
        },
        'openai-compatible': {
          enabled: true,
          baseUrl: 'http://ollama:11434/v1',
          requiresKey: false,
        },
      });
    });

    it('blank means omitted: a cleared api-version and removed deployments fall back to defaults', async () => {
      const hook = setHook();
      const user = renderPage();
      const azure = within(card('azure-openai'));

      await user.clear(azure.getByLabelText('API version'));
      await user.click(azure.getByRole('button', { name: 'Remove deployment 1' }));
      await user.click(saveButton());

      await waitFor(() => expect(hook.save).toHaveBeenCalledTimes(1));
      expect(vi.mocked(hook.save).mock.calls[0][0].providers['azure-openai']).toEqual({
        enabled: true,
        baseUrl: 'https://contoso.openai.azure.com',
      });
    });
  });

  describe('validation blocks Save', () => {
    it('an http Azure endpoint', async () => {
      setHook();
      const user = renderPage();
      const azure = within(card('azure-openai'));

      await user.clear(azure.getByLabelText('Endpoint'));
      await user.type(azure.getByLabelText('Endpoint'), 'http://contoso.openai.azure.com');
      expect(azure.getByText('Azure OpenAI endpoints must use https.')).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();
    });

    it('an invalid api-version or deployment name', async () => {
      setHook();
      const user = renderPage();
      const azure = within(card('azure-openai'));

      await user.type(azure.getByLabelText('API version'), ' bad');
      expect(azure.getByText(/starting with a letter or digit/i)).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();

      await user.clear(azure.getByLabelText('API version'));
      await user.type(azure.getByLabelText('Deployment name'), '/x');
      expect(azure.getByText(/letters, digits, "\.", "_" and "-" only \(at most 64\)/i)).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();
    });

    it('enabling an OpenAI-compatible server without a base URL, or with credentials in it', async () => {
      setHook();
      const user = renderPage();
      const compatible = within(card('openai-compatible'));

      await user.click(compatible.getByRole('switch', { name: 'Enable OpenAI-compatible' }));
      expect(compatible.getByText(/base url is required/i)).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();

      await user.type(compatible.getByLabelText('Base URL'), 'http://me:secret@ollama:11434/v1');
      expect(compatible.getByText(/remove the user name and password/i)).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();

      await user.clear(compatible.getByLabelText('Base URL'));
      await user.type(compatible.getByLabelText('Base URL'), 'http://ollama:11434/v1');
      expect(saveButton()).toBeEnabled();
    });
  });

  describe('keyless OpenAI-compatible server', () => {
    it('switching Requires an API key off shows the trust / SSRF warning', async () => {
      setHook();
      const user = renderPage();

      await user.click(within(card('openai-compatible')).getByRole('switch', { name: 'Requires an API key' }));
      const warning = screen.getByTestId('ai-provider-openai-compatible-keyless-warning');
      expect(warning).toHaveTextContent(/requests to this server carry no key/i);
      expect(warning).toHaveTextContent(/anyone with the ai:use permission can use it/i);
      expect(warning).toHaveTextContent(/only point this at a server you trust/i);
      expect(warning).toHaveTextContent(/redirects are refused/i);
    });

    it('a saved keyless server says no key is needed, can be tested without one, and is not "keyless" for the org fallback', async () => {
      const config: AiAdminConfig = {
        ...mockAiAdminConfigWithCompatible,
        providers: mockAiAdminConfigWithCompatible.providers.map((provider) =>
          provider.id === 'openai-compatible'
            ? { ...provider, enabled: true, baseUrl: 'http://ollama:11434/v1', requiresKey: false }
            : provider,
        ),
      };
      setHook(config);
      const user = renderPage();
      const compatible = within(card('openai-compatible'));

      expect(compatible.getByRole('switch', { name: 'Requires an API key' })).not.toBeChecked();
      expect(compatible.getByText('No key needed — this server is keyless.')).toBeInTheDocument();
      expect(compatible.getByRole('button', { name: 'Test' })).toBeEnabled();

      await user.click(screen.getByRole('radio', { name: /fall back to the organization key/i }));
      expect(screen.getByTestId('ai-org-fallback-warning')).not.toHaveTextContent(/OpenAI-compatible/);
    });
  });
});
