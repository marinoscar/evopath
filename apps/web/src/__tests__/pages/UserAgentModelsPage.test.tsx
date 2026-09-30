/**
 * `/settings/ai/agents`: one card per role, saves through the user settings
 * PATCH (`ai.taskModels` / `ai.training`, with `If-Match`), the run limits and
 * the estimate sentence, and the hub card's gating.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import { mockUserSettings } from '../mocks/data';
import UserAgentModelsPage from '../../pages/UserAgentModelsPage';
import UserSettingsHubPage from '../../pages/UserSettingsHubPage';
import {
  mockRoleResolution,
  mockTrainingModelsView,
  mockTrainingRunEstimate,
  mockTrainingUsableModels,
} from '../mocks/fixtures/trainingAgents';
import type { UserSettings } from '../../types';

function useSettings(settings: UserSettings) {
  server.use(http.get('*/api/user-settings', () => HttpResponse.json({ data: settings })));
}

function captureSettingsPatch() {
  const calls: Array<{ body: unknown; ifMatch: string | null }> = [];
  server.use(
    http.patch('*/api/user-settings', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ body, ifMatch: request.headers.get('If-Match') });
      return HttpResponse.json({
        data: { ...mockUserSettings, ...body, version: mockUserSettings.version + 1 },
      });
    }),
  );
  return calls;
}

async function renderPage() {
  server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data: mockTrainingUsableModels })));
  const user = userEvent.setup();
  const result = render(<UserAgentModelsPage />, { wrapperOptions: { aiEnabled: true } });
  await waitFor(() =>
    expect(screen.queryByLabelText('Loading training agents')).not.toBeInTheDocument(),
  );
  return { user, ...result };
}

describe('UserAgentModelsPage', () => {
  it('renders one card per role and the run limits', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Training agents' })).toBeInTheDocument();
    for (const title of ['Researcher', 'Planner', 'Critic', 'Evaluator', 'Run limits']) {
      expect(screen.getByRole('region', { name: title })).toBeInTheDocument();
    }
  });

  it('shows the estimate sentence from the API', async () => {
    await renderPage();
    expect(
      screen.getByText('Estimated tokens for a typical plan: 60,000 to 180,000'),
    ).toBeInTheDocument();
  });

  it('says when the cap binds', async () => {
    server.use(
      http.post('*/api/ai/training/estimate', () =>
        HttpResponse.json({ data: { ...mockTrainingRunEstimate, cap: 50_000, capBinding: true } }),
      ),
    );
    await renderPage();
    expect(screen.getByText(/A run may stop at your cap of 50,000 tokens/)).toBeInTheDocument();
  });

  it('shows the web-search-disabled state on the researcher', async () => {
    server.use(
      http.get('*/api/ai/training/models', () =>
        HttpResponse.json({
          data: {
            ...mockTrainingModelsView,
            roles: {
              ...mockTrainingModelsView.roles,
              researcher: mockRoleResolution({
                role: 'researcher',
                state: 'web_search_disabled',
                model: undefined,
                fix: 'admin',
              }),
            },
          },
        }),
      ),
    );
    await renderPage();
    const researcher = screen.getByRole('region', { name: 'Researcher' });
    expect(within(researcher).getByText(/Web search is switched off/)).toBeInTheDocument();
  });

  it('saves one role as ai.taskModels.<role> with If-Match and reloads the choice', async () => {
    const calls = captureSettingsPatch();
    const { user } = await renderPage();
    const planner = screen.getByRole('region', { name: 'Planner' });

    await user.click(within(planner).getByRole('combobox', { name: 'Model' }));
    await user.click(screen.getByRole('option', { name: /Medium One/ }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({
      ai: { taskModels: { planner: { provider: 'anthropic', modelId: 'medium-1', reasoningEffort: null } } },
    });
    expect(calls[0].ifMatch).toBe(String(mockUserSettings.version));
    // The saved model is now the selection, and its efforts are offered.
    await waitFor(() =>
      expect(within(planner).getByRole('combobox', { name: 'Reasoning effort' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
  });

  it('shows a saved choice on load', async () => {
    useSettings({
      ...mockUserSettings,
      ai: { taskModels: { critic: { provider: 'openai', modelId: 'frontier-1', reasoningEffort: 'high' } } },
    });
    await renderPage();
    const critic = screen.getByRole('region', { name: 'Critic' });
    expect(within(critic).getByRole('combobox', { name: 'Model' })).toHaveTextContent('Frontier One');
    expect(within(critic).getByRole('combobox', { name: 'Reasoning effort' })).toHaveTextContent('high');
  });

  it('saves the run limits as ai.training', async () => {
    const calls = captureSettingsPatch();
    const { user } = await renderPage();
    const limits = screen.getByRole('region', { name: 'Run limits' });

    await user.type(within(limits).getByLabelText('Max tokens per run'), '50000');
    await user.click(within(limits).getByRole('button', { name: 'Save limits' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ ai: { training: { maxRunTokens: 50000, maxCriticRounds: 2 } } });
  });

  it('rejects an out-of-range cap before saving', async () => {
    const calls = captureSettingsPatch();
    const { user } = await renderPage();
    const limits = screen.getByRole('region', { name: 'Run limits' });

    await user.type(within(limits).getByLabelText('Max tokens per run'), '5');
    expect(within(limits).getByText(/Enter a whole number from 10,000 to 2,000,000/)).toBeInTheDocument();
    expect(within(limits).getByRole('button', { name: 'Save limits' })).toBeDisabled();
    expect(calls).toHaveLength(0);
  });

  it('has no axe violations', async () => {
    const { container } = await renderPage();
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});

describe('the Training agents card on /settings', () => {
  it('appears when AI is on and the user holds ai:use', async () => {
    render(<UserSettingsHubPage />, { wrapperOptions: { aiEnabled: true } });
    expect(await screen.findByText('Training agents')).toBeInTheDocument();
  });

  it('is hidden while AI is off', async () => {
    render(<UserSettingsHubPage />, { wrapperOptions: { aiEnabled: false } });
    await screen.findByText('Profile');
    expect(screen.queryByText('Training agents')).not.toBeInTheDocument();
  });

  it('is hidden without ai:use', async () => {
    render(<UserSettingsHubPage />, {
      wrapperOptions: {
        aiEnabled: true,
        user: { ...mockUser, permissions: mockUser.permissions.filter((p) => p !== 'ai:use') },
      },
    });
    await screen.findByText('Profile');
    expect(screen.queryByText('Training agents')).not.toBeInTheDocument();
  });
});
