/**
 * `/admin/settings/ai` (issue #429, epic #419).
 *
 * `useAiAdminConfig` is mocked, like `StorageConfigPage.test.tsx`: this suite
 * is about the PAGE — what each state renders, what is disabled for a
 * read-only admin, and what the page hands the hook. The hook's own plumbing
 * has its own test; the network round trip is `AiConfigPage.wire.test.tsx`.
 *
 * ⚠ THE NEGATIVE SECURITY INVARIANT. A key typed into the field must never be
 * rendered back after a save — the field is cleared once the server answers,
 * whatever it answered — and no stored key is ever rendered, only the mask.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import type { AiAdminConfig } from '../../../services/ai';
import {
  mockAiAdminConfig,
  mockAiProbeResultFailed,
  mockAiProbeResultPassed,
} from '../../mocks/fixtures/ai';

vi.mock('../../../hooks/useAiAdminConfig', () => ({
  useAiAdminConfig: vi.fn(),
}));

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { useAiAdminConfig } from '../../../hooks/useAiAdminConfig';
import type { UseAiAdminConfigReturn } from '../../../hooks/useAiAdminConfig';
import { usePermissions } from '../../../hooks/usePermissions';
import AiConfigPage from '../../../pages/Admin/AiConfigPage';

const mockUseAiAdminConfig = vi.mocked(useAiAdminConfig);
const mockUsePermissions = vi.mocked(usePermissions);

const WRITE = ['ai_config:read', 'ai_config:write'];
const READ_ONLY = ['ai_config:read'];

const TYPED_KEY = 'sk-THIS-IS-A-TYPED-KEY-DO-NOT-RENDER';

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

const noKeyConfig: AiAdminConfig = {
  ...mockAiAdminConfig,
  enabled: true,
  providers: [
    {
      ...mockAiAdminConfig.providers[0],
      enabled: true,
      keyStatus: { configured: false, hint: null, updatedAt: null, updatedByUserId: null },
    },
  ],
};

function setHook(overrides: Partial<UseAiAdminConfigReturn> = {}): UseAiAdminConfigReturn {
  const value: UseAiAdminConfigReturn = {
    config: mockAiAdminConfig,
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
    ...overrides,
  };
  mockUseAiAdminConfig.mockReturnValue(value);
  return value;
}

function renderPage() {
  return render(<AiConfigPage />, { wrapperOptions: { user: mockAdminUser } });
}

describe('AiConfigPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions(WRITE);
  });

  describe('states', () => {
    it('AI off: explains that AI is completely disabled', () => {
      setHook();
      renderPage();

      expect(screen.getByRole('heading', { level: 1, name: 'AI' })).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Enable AI for this deployment' })).not.toBeChecked();
      expect(screen.getByTestId('ai-disabled-notice')).toHaveTextContent(
        /AI is completely disabled: users see no AI features, and no AI requests are made/,
      );
      // The models page is unreachable while AI is off, so no link is offered.
      expect(screen.queryByRole('link', { name: /manage models/i })).not.toBeInTheDocument();
    });

    it('AI on with no key: no notice, an empty key field, and the models link', () => {
      setHook({ config: noKeyConfig });
      renderPage();

      expect(screen.getByRole('switch', { name: 'Enable AI for this deployment' })).toBeChecked();
      expect(screen.queryByTestId('ai-disabled-notice')).not.toBeInTheDocument();
      expect(screen.getByText(/no organization key is stored/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /remove key/i })).toBeDisabled();
      // Nothing to test with: no typed key, no stored key.
      expect(screen.getByRole('button', { name: /^test$/i })).toBeDisabled();
      expect(screen.getByRole('link', { name: /manage models/i })).toHaveAttribute(
        'href',
        '/admin/settings/ai/models',
      );
    });

    it('key configured: the mask is the placeholder and the helper text, never the key', () => {
      setHook();
      renderPage();

      const field = screen.getByLabelText('OpenAI API key');
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveAttribute('autocomplete', 'new-password');
      expect(field).toHaveValue('');
      expect(field).toHaveAttribute('placeholder', '••••abcd');
      expect(screen.getByText(/a key is saved \(••••abcd\).*leave this blank to keep it/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^test$/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /remove key/i })).toBeEnabled();
    });

    it('probe success renders a success alert with one row per check', () => {
      setHook({ testResults: { openai: mockAiProbeResultPassed } });
      renderPage();

      const result = screen.getByTestId('ai-test-result');
      expect(result).toHaveClass('MuiAlert-colorSuccess');
      expect(within(result).getByTestId('ai-check-credentials')).toBeInTheDocument();
      expect(within(result).getByTestId('ai-check-list_models')).toHaveTextContent('42 models');
      expect(within(result).getByTestId('ai-check-code-responses_smoke')).toHaveTextContent(
        'not_attempted',
      );
    });

    it('probe failure renders an error alert with the code and the verbatim error', () => {
      setHook({ testResults: { openai: mockAiProbeResultFailed } });
      renderPage();

      const result = screen.getByTestId('ai-test-result');
      expect(result).toHaveClass('MuiAlert-colorError');
      expect(within(result).getByTestId('ai-check-code-credentials')).toHaveTextContent(
        'AI_KEY_INVALID',
      );
      expect(within(result).getByTestId('ai-check-error-credentials')).toHaveTextContent(
        'Incorrect API key provided',
      );
      expect(within(result).getByText(/tested with the key typed above/i)).toBeInTheDocument();
    });

    it('read-only admin: every control visible and disabled, with a notice', () => {
      setPermissions(READ_ONLY);
      setHook({ config: noKeyConfig });
      renderPage();

      expect(screen.getByTestId('ai-read-only-notice')).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Enable AI for this deployment' })).toBeDisabled();
      expect(screen.getByRole('radio', { name: /fall back to the organization key/i })).toBeDisabled();
      expect(screen.getByRole('switch', { name: 'Log prompt content' })).toBeDisabled();
      expect(screen.getByRole('switch', { name: 'Enable OpenAI' })).toBeDisabled();
      expect(screen.getByLabelText('OpenAI API key')).toBeDisabled();
      expect(screen.getByRole('button', { name: /save key/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /^test$/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });

    it('redirects without ai_config:read', () => {
      setPermissions([]);
      setHook();
      renderPage();
      expect(screen.queryByRole('heading', { name: 'AI' })).not.toBeInTheDocument();
    });

    it('renders a load error', () => {
      setHook({ config: null, loadError: 'Failed to load the AI configuration' });
      renderPage();
      expect(screen.getByText('Failed to load the AI configuration')).toBeInTheDocument();
    });
  });

  describe('policy form', () => {
    it('saves the edited policy as one PUT body', async () => {
      const user = userEvent.setup();
      const hook = setHook();
      renderPage();

      const save = screen.getByRole('button', { name: /save changes/i });
      expect(save).toBeDisabled(); // clean form

      await user.click(screen.getByRole('switch', { name: 'Enable AI for this deployment' }));
      await user.click(screen.getByRole('switch', { name: 'Enable OpenAI' }));
      await user.clear(screen.getByLabelText('Maximum output tokens per call'));
      await user.click(save);

      await waitFor(() => expect(hook.save).toHaveBeenCalledTimes(1));
      expect(hook.save).toHaveBeenCalledWith({
        enabled: true,
        keyPolicy: 'byok',
        logPromptContent: false,
        // A full replace: a cleared cap and an absent base URL are sent as
        // explicit nulls, never omitted and never '' or 0.
        // `allowRealtime` absent from the stored config reads as off (#449).
        defaults: { maxOutputTokensCap: null, allowBackgroundRuns: true, allowRealtime: false },
        hostedTools: {
          web_search: false,
          file_search: false,
          code_interpreter: false,
          image_generation: false,
          mcp: false,
          mcpAllowedHosts: [],
        },
        // No limits stored and none typed: `{}`, sent explicitly (#450).
        limits: {},
        providers: { openai: { enabled: true, baseUrl: null } },
      });
      expect(await screen.findByText('AI configuration saved')).toBeInTheDocument();
    });

    it('warns when the org-fallback policy is chosen, naming keyless providers', async () => {
      const user = userEvent.setup();
      setHook({ config: noKeyConfig });
      renderPage();

      expect(screen.queryByTestId('ai-org-fallback-warning')).not.toBeInTheDocument();
      await user.click(screen.getByRole('radio', { name: /fall back to the organization key/i }));

      const warning = screen.getByTestId('ai-org-fallback-warning');
      expect(warning).toHaveTextContent(/organization pays for users without a key/i);
      expect(warning).toHaveTextContent(/no organization key is stored yet for OpenAI/i);
    });

    it('warns about prompt logging when it is switched on', async () => {
      const user = userEvent.setup();
      setHook();
      renderPage();

      await user.click(screen.getByRole('switch', { name: 'Log prompt content' }));
      expect(screen.getByTestId('ai-log-prompts-warning')).toHaveTextContent(/personal or confidential/i);
    });

    it('blocks an invalid token cap and an invalid base URL', async () => {
      const user = userEvent.setup();
      setHook();
      renderPage();

      await user.clear(screen.getByLabelText('Maximum output tokens per call'));
      await user.type(screen.getByLabelText('Maximum output tokens per call'), '-5');
      expect(screen.getByText(/whole number greater than zero/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();

      await user.clear(screen.getByLabelText('Maximum output tokens per call'));
      await user.click(screen.getByText('Advanced'));
      await user.type(screen.getByLabelText('Base URL'), 'not a url');
      expect(screen.getByText(/must be a full url/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });

    it('shows a save error', () => {
      setHook({ saveError: 'Someone else changed the AI configuration while you were editing.' });
      renderPage();
      expect(screen.getByText(/someone else changed/i)).toBeInTheDocument();
    });
  });

  describe('hosted tools (#442)', () => {
    const TOOL_LABELS = ['Web search', 'File search', 'Code interpreter', 'Image generation', 'Remote MCP servers'];

    it('renders one switch per hosted tool, all off by default', () => {
      setHook();
      renderPage();

      const section = screen.getByTestId('ai-hosted-tools');
      for (const label of TOOL_LABELS) {
        expect(within(section).getByRole('switch', { name: label })).not.toBeChecked();
      }
      expect(screen.getByLabelText('Allowed MCP hosts')).toHaveValue('');
      expect(screen.queryByTestId('ai-mcp-any-host-warning')).not.toBeInTheDocument();
    });

    it('reflects the stored switches and host list', () => {
      setHook({
        config: {
          ...mockAiAdminConfig,
          hostedTools: {
            web_search: true,
            file_search: false,
            code_interpreter: true,
            image_generation: false,
            mcp: true,
            mcpAllowedHosts: ['mcp.example.com', '*.tools.example.org'],
          },
        },
      });
      renderPage();

      expect(screen.getByRole('switch', { name: 'Web search' })).toBeChecked();
      expect(screen.getByRole('switch', { name: 'File search' })).not.toBeChecked();
      expect(screen.getByRole('switch', { name: 'Code interpreter' })).toBeChecked();
      expect(screen.getByRole('switch', { name: 'Remote MCP servers' })).toBeChecked();
      expect(screen.getByLabelText('Allowed MCP hosts')).toHaveValue('mcp.example.com\n*.tools.example.org');
    });

    it('saves switched tools and the host list in the same PUT body', async () => {
      const user = userEvent.setup();
      const hook = setHook();
      renderPage();

      await user.click(screen.getByRole('switch', { name: 'Web search' }));
      await user.click(screen.getByRole('switch', { name: 'Remote MCP servers' }));
      expect(screen.getByTestId('ai-mcp-any-host-warning')).toBeInTheDocument();

      await user.type(screen.getByLabelText('Allowed MCP hosts'), 'MCP.Example.com{enter}*.tools.example.org{enter}mcp.example.com');
      expect(screen.queryByTestId('ai-mcp-any-host-warning')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(hook.save).toHaveBeenCalledTimes(1));
      expect(vi.mocked(hook.save).mock.calls[0][0].hostedTools).toEqual({
        web_search: true,
        file_search: false,
        code_interpreter: false,
        image_generation: false,
        mcp: true,
        mcpAllowedHosts: ['mcp.example.com', '*.tools.example.org'],
      });
    });

    it('blocks a host entry that is a URL, not a host name', async () => {
      const user = userEvent.setup();
      setHook();
      renderPage();

      await user.type(screen.getByLabelText('Allowed MCP hosts'), 'https://mcp.example.com/sse');

      expect(screen.getByText(/is not a host name/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });

    it('read-only admin: the switches and the host list are disabled', () => {
      setPermissions(READ_ONLY);
      setHook();
      renderPage();

      for (const label of TOOL_LABELS) {
        expect(screen.getByRole('switch', { name: label })).toBeDisabled();
      }
      expect(screen.getByLabelText('Allowed MCP hosts')).toBeDisabled();
    });

    it('an API older than #442 (no hostedTools) reads as every tool off', () => {
      const { hostedTools: _omit, ...legacy } = mockAiAdminConfig;
      setHook({ config: legacy });
      renderPage();

      for (const label of TOOL_LABELS) {
        expect(screen.getByRole('switch', { name: label })).not.toBeChecked();
      }
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });
  });

  describe('limits (#450)', () => {
    const LIMIT_LABELS = [
      'Requests per minute, per user',
      'Requests per day, per user',
      'Organization key: requests per day, per user',
      'Organization key: tokens per day, per user',
    ];

    it('renders the four limit fields inside the page, blank meaning unlimited', () => {
      setHook();
      renderPage();

      expect(screen.getByRole('heading', { level: 2, name: 'Limits' })).toBeInTheDocument();
      const section = screen.getByTestId('ai-limits');
      for (const label of LIMIT_LABELS) {
        expect(within(section).getByLabelText(label)).toHaveValue('');
      }
      // Inside the page, not a tab.
      expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    });

    it('reflects the stored limits', () => {
      setHook({
        config: {
          ...mockAiAdminConfig,
          limits: {
            perUser: { requestsPerMinute: 20 },
            orgKey: { tokensPerDayPerUser: 500000 },
          },
        },
      });
      renderPage();

      expect(screen.getByLabelText('Requests per minute, per user')).toHaveValue('20');
      expect(screen.getByLabelText('Requests per day, per user')).toHaveValue('');
      expect(screen.getByLabelText('Organization key: tokens per day, per user')).toHaveValue('500000');
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled(); // clean
    });

    it.each([
      ['0', /whole number greater than zero/i],
      ['-3', /whole number greater than zero/i],
      ['2.5', /whole number greater than zero/i],
      ['ten', /whole number greater than zero/i],
      ['1000000001', /at most 1,000,000,000/i],
    ])('blocks %s', async (value, message) => {
      const user = userEvent.setup();
      const hook = setHook();
      renderPage();

      await user.type(screen.getByLabelText('Requests per day, per user'), value);
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
      expect(hook.save).not.toHaveBeenCalled();
    });

    it('sends the typed limits in the same PUT, blank fields omitted, per-model entries kept', async () => {
      const user = userEvent.setup();
      const perModel = { 'openai:gpt-5-mini': { maxOutputTokens: 2048 } };
      const hook = setHook({
        config: {
          ...mockAiAdminConfig,
          limits: { orgKey: { requestsPerDayPerUser: 50 }, perModel },
        },
      });
      renderPage();

      await user.type(screen.getByLabelText('Requests per minute, per user'), ' 30 ');
      await user.type(screen.getByLabelText('Requests per day, per user'), '1000');
      // Clearing the stored org-key limit lifts it: the whole `orgKey` goes.
      await user.clear(screen.getByLabelText('Organization key: requests per day, per user'));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(hook.save).toHaveBeenCalledTimes(1));
      expect(vi.mocked(hook.save).mock.calls[0][0].limits).toEqual({
        perUser: { requestsPerMinute: 30, requestsPerDay: 1000 },
        perModel,
      });
    });

    it('clearing every limit sends {} — which lifts them all', async () => {
      const user = userEvent.setup();
      const hook = setHook({
        config: { ...mockAiAdminConfig, limits: { perUser: { requestsPerDay: 5 } } },
      });
      renderPage();

      await user.clear(screen.getByLabelText('Requests per day, per user'));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(hook.save).toHaveBeenCalledTimes(1));
      expect(vi.mocked(hook.save).mock.calls[0][0].limits).toEqual({});
    });

    it('an API older than #450 (no limits) reads as unlimited and saves {}', async () => {
      const user = userEvent.setup();
      const { limits: _omit, ...legacy } = mockAiAdminConfig;
      const hook = setHook({ config: legacy });
      renderPage();

      for (const label of LIMIT_LABELS) {
        expect(screen.getByLabelText(label)).toHaveValue('');
      }
      await user.click(screen.getByRole('switch', { name: 'Log prompt content' }));
      await user.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(hook.save).toHaveBeenCalledTimes(1));
      expect(vi.mocked(hook.save).mock.calls[0][0].limits).toEqual({});
    });

    it('read-only admin: the limit fields are disabled', () => {
      setPermissions(READ_ONLY);
      setHook();
      renderPage();

      for (const label of LIMIT_LABELS) {
        expect(screen.getByLabelText(label)).toBeDisabled();
      }
    });
  });

  describe('provider key', () => {
    it('saves the typed key and clears it from the field', async () => {
      const user = userEvent.setup();
      const hook = setHook();
      renderPage();

      const field = screen.getByLabelText('OpenAI API key');
      await user.type(field, TYPED_KEY);
      await user.click(screen.getByRole('button', { name: /save key/i }));

      await waitFor(() => expect(hook.setKey).toHaveBeenCalledWith('openai', TYPED_KEY));
      await waitFor(() => expect(field).toHaveValue(''));
      expect(document.body.innerHTML).not.toContain(TYPED_KEY);
    });

    it('clears the typed key even when the provider refused it', async () => {
      const user = userEvent.setup();
      setHook({ setKey: vi.fn().mockResolvedValue(false) });
      renderPage();

      const field = screen.getByLabelText('OpenAI API key');
      await user.type(field, TYPED_KEY);
      await user.click(screen.getByRole('button', { name: /save key/i }));

      await waitFor(() => expect(field).toHaveValue(''));
    });

    it('rejects a too-short key before sending anything', async () => {
      const user = userEvent.setup();
      const hook = setHook();
      renderPage();

      await user.type(screen.getByLabelText('OpenAI API key'), 'short');
      expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save key/i })).toBeDisabled();
      expect(hook.setKey).not.toHaveBeenCalled();
    });

    it('tests with the typed key, or with the stored one when blank', async () => {
      const user = userEvent.setup();
      const hook = setHook();
      renderPage();

      await user.click(screen.getByRole('button', { name: /^test$/i }));
      expect(hook.test).toHaveBeenLastCalledWith('openai', { apiKey: '', baseUrl: undefined });

      await user.type(screen.getByLabelText('OpenAI API key'), TYPED_KEY);
      await user.click(screen.getByRole('button', { name: /^test$/i }));
      expect(hook.test).toHaveBeenLastCalledWith('openai', { apiKey: TYPED_KEY, baseUrl: undefined });
    });

    it('shows a key error on the card', () => {
      setHook({ keyError: { provider: 'openai', message: 'The provider rejected this key' } });
      renderPage();
      expect(screen.getByText('The provider rejected this key')).toBeInTheDocument();
    });

    it('removes the key only after REMOVE is typed', async () => {
      const user = userEvent.setup();
      const hook = setHook();
      renderPage();

      await user.click(screen.getByRole('button', { name: /remove key/i }));
      const dialog = await screen.findByRole('dialog');
      const confirm = within(dialog).getByRole('button', { name: /remove key/i });
      expect(confirm).toBeDisabled();

      await user.type(within(dialog).getByLabelText(/type remove to confirm/i), 'remove');
      expect(confirm).toBeDisabled(); // capitals required

      await user.clear(within(dialog).getByLabelText(/type remove to confirm/i));
      await user.type(within(dialog).getByLabelText(/type remove to confirm/i), 'REMOVE');
      await user.click(confirm);

      await waitFor(() => expect(hook.removeKey).toHaveBeenCalledWith('openai'));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('surfaces the ORG_FALLBACK_WITHOUT_KEY warning after a removal', () => {
      setHook({ keyWarnings: ['ORG_FALLBACK_WITHOUT_KEY'] });
      renderPage();
      expect(screen.getByTestId('ai-org-fallback-without-key')).toBeInTheDocument();
    });
  });
  describe('realtime voice sessions (#449)', () => {
    it('sends defaults.allowRealtime in the PUT when switched on', async () => {
      const user = userEvent.setup();
      const hook = setHook();
      renderPage();

      const realtime = screen.getByRole('switch', { name: 'Allow realtime voice sessions' });
      expect(realtime).not.toBeChecked();
      expect(screen.getByText(/connects directly to the provider/i)).toHaveTextContent(
        /API key never leaves the server/,
      );

      await user.click(realtime);
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(hook.save).toHaveBeenCalledTimes(1));
      expect(hook.save).toHaveBeenCalledWith(
        expect.objectContaining({
          defaults: { maxOutputTokensCap: 4096, allowBackgroundRuns: true, allowRealtime: true },
        }),
      );
    });

    it('reflects a stored allowRealtime and can switch it back off', async () => {
      const user = userEvent.setup();
      const hook = setHook({
        config: { ...mockAiAdminConfig, defaults: { ...mockAiAdminConfig.defaults, allowRealtime: true } },
      });
      renderPage();

      const realtime = screen.getByRole('switch', { name: 'Allow realtime voice sessions' });
      expect(realtime).toBeChecked();
      await user.click(realtime);
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(hook.save).toHaveBeenCalledTimes(1));
      const body = vi.mocked(hook.save).mock.calls[0][0] as { defaults: { allowRealtime?: boolean } };
      expect(body.defaults.allowRealtime).toBe(false);
    });

    it('is disabled without ai_config:write', () => {
      setPermissions(READ_ONLY);
      setHook();
      renderPage();
      expect(screen.getByRole('switch', { name: 'Allow realtime voice sessions' })).toBeDisabled();
    });
  });
});
