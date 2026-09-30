/**
 * `/settings/ai/agents`: one read-only card per role (#173: models are an
 * administrator's choice), the run limits saved through the user settings
 * PATCH (`ai.training`), the estimate sentence, and the hub card's gating.
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
    expect(within(researcher).getByText(/Admin, AI, Hosted tools, Web search/)).toBeInTheDocument();
  });

  it('shows each role read-only: model, effort, who chose it; no model or effort picker', async () => {
    server.use(
      http.get('*/api/ai/training/models', () =>
        HttpResponse.json({
          data: {
            ...mockTrainingModelsView,
            roles: {
              ...mockTrainingModelsView.roles,
              critic: mockRoleResolution({
                role: 'critic',
                state: 'ready',
                source: 'admin_feature',
                requestedEffort: 'high',
                effectiveEffort: 'high',
              }),
              planner: mockRoleResolution({ role: 'planner', state: 'auto', source: 'auto' }),
            },
          },
        }),
      ),
    );
    await renderPage();

    const critic = screen.getByRole('region', { name: 'Critic' });
    expect(within(critic).getByText(/Chosen by your administrator/)).toBeInTheDocument();
    expect(within(critic).getByText(/^Model: Frontier One/)).toBeInTheDocument();
    expect(within(critic).getByText('Reasoning effort: high')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Planner' })).getByText(/Chosen automatically/)).toBeInTheDocument();

    for (const role of ['Researcher', 'Planner', 'Critic', 'Evaluator']) {
      const region = screen.getByRole('region', { name: role });
      expect(within(region).queryByRole('combobox')).not.toBeInTheDocument();
    }
  });

  it('never reads a legacy saved model, and never writes model choices', async () => {
    const calls = captureSettingsPatch();
    useSettings({
      ...mockUserSettings,
      // A legacy document may still carry these; the page ignores them.
      ai: { taskModels: { critic: { provider: 'anthropic', modelId: 'medium-1', reasoningEffort: 'low' } } } as UserSettings['ai'],
    });
    const { user } = await renderPage();
    const critic = screen.getByRole('region', { name: 'Critic' });
    expect(within(critic).queryByText(/Medium One/)).not.toBeInTheDocument();

    const limits = screen.getByRole('region', { name: 'Run limits' });
    await user.type(within(limits).getByLabelText('Max tokens per run'), '50000');
    await user.click(within(limits).getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.stringify(calls[0].body)).not.toMatch(/taskModels|defaultModel/);
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
