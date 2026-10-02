/**
 * `/settings/ai/agents`: the "Use my health data in training plans and coach chat" section
 * (H8, #192). Off by default; turning it on needs the confirmation dialog
 * (what is shared, never shared, who processes it); turning it off sends
 * `false` at once; the summary, its state and the refresh refusals; gating on
 * `health_data:read` / `health_data:write` and the model state; axe.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import UserAgentModelsPage from '../../pages/UserAgentModelsPage';
import {
  HEALTH_SUMMARY_DIALOG_TITLE,
  HEALTH_SUMMARY_NOT_MEDICAL_ADVICE,
  HEALTH_SUMMARY_DATA_SCOPE,
  HEALTH_SUMMARY_SECTION_TITLE,
  HEALTH_SUMMARY_SWITCH_HELPER,
  HEALTH_SUMMARY_SWITCH_LABEL,
} from '../../components/training/HealthSummarySection';
import { SentDataPanel } from '../../components/training/SentDataPanel';
import {
  mockHealthSummaryEnabled,
  mockHealthSummaryNeverShared,
  mockHealthSummaryShared,
  mockHealthSummaryText,
  mockHealthSummaryView,
} from '../mocks/fixtures/healthSummary';
import type { HealthSummaryView } from '../../services/healthSummary';

function serveView(view: HealthSummaryView) {
  server.use(http.get('*/api/ai/training/health-summary', () => HttpResponse.json({ data: view })));
}

function captureConsent() {
  const bodies: unknown[] = [];
  server.use(
    http.put('*/api/ai/training/health-summary/consent', async ({ request }) => {
      const body = (await request.json()) as { enabled: boolean };
      bodies.push(body);
      return HttpResponse.json({
        data: body.enabled
          ? mockHealthSummaryView({ enabled: true, consentedAt: '2026-10-01T00:00:00.000Z', pending: true })
          : mockHealthSummaryView(),
      });
    }),
  );
  return bodies;
}

function refuseRefresh(reason: string, message: string) {
  server.use(
    http.post('*/api/ai/training/health-summary/refresh', () =>
      HttpResponse.json({ code: 'CONFLICT', message, details: { reason } }, { status: 409 }),
    ),
  );
}

async function renderPage(permissions: string[] = mockUser.permissions) {
  const user = userEvent.setup();
  const result = render(<UserAgentModelsPage />, {
    wrapperOptions: { aiEnabled: true, user: { ...mockUser, permissions } },
  });
  await waitFor(() =>
    expect(screen.queryByLabelText('Loading training agents')).not.toBeInTheDocument(),
  );
  return { user, ...result };
}

async function findSection() {
  const section = await screen.findByRole('region', { name: HEALTH_SUMMARY_SECTION_TITLE });
  await waitFor(() =>
    expect(within(section).queryByLabelText('Loading your health summary')).not.toBeInTheDocument(),
  );
  return section;
}

describe('UserAgentModelsPage: health summary opt-in', () => {
  it('is off by default and says it is not medical advice and sends no raw values', async () => {
    await renderPage();
    const section = await findSection();
    const toggle = within(section).getByLabelText(HEALTH_SUMMARY_SWITCH_LABEL);
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    expect(within(section).getByText(HEALTH_SUMMARY_NOT_MEDICAL_ADVICE)).toBeInTheDocument();
    expect(within(section).getByText(new RegExp(HEALTH_SUMMARY_DATA_SCOPE.slice(0, 40)))).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Refresh summary' })).not.toBeInTheDocument();
  });

  it('says the one consent covers training plans and coach chat, and that the coach can read biomarker values (#327)', async () => {
    await renderPage();
    const section = await findSection();
    expect(
      within(section).getByLabelText('Use my health data in training plans and coach chat'),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(
        'Training plans use your AI health summary. Your coach can also read your summary and look up your biomarker values when you ask.',
      ),
    ).toBeInTheDocument();
    expect(within(section).getByText(HEALTH_SUMMARY_SWITCH_HELPER)).toBeInTheDocument();
    // Raw values are withheld from the training agents only, never claimed for the coach.
    expect(HEALTH_SUMMARY_DATA_SCOPE).toMatch(/^The training agents receive only the written summary/);
    expect(HEALTH_SUMMARY_DATA_SCOPE).toMatch(/coach can read the summary and, when you ask, look up your biomarker values/);
    expect(within(section).queryByText(/your coach receive only/i)).not.toBeInTheDocument();
  });

  it('turns on only after the confirmation dialog, showing what is shared and who processes it', async () => {
    const bodies = captureConsent();
    const { user } = await renderPage();
    const section = await findSection();

    await user.click(within(section).getByLabelText(HEALTH_SUMMARY_SWITCH_LABEL));
    const dialog = await screen.findByRole('dialog', { name: HEALTH_SUMMARY_DIALOG_TITLE });
    expect(bodies).toHaveLength(0);

    const shared = within(dialog).getByRole('list', { name: 'What is shared' });
    for (const line of mockHealthSummaryShared) expect(within(shared).getByText(line)).toBeInTheDocument();
    const never = within(dialog).getByRole('list', { name: 'Never shared' });
    for (const line of mockHealthSummaryNeverShared) expect(within(never).getByText(line)).toBeInTheDocument();
    expect(within(dialog).getByText(/Frontier One \(OpenAI\) will process the data below/)).toBeInTheDocument();
    expect(within(dialog).getByText(/This is not medical advice/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(bodies).toEqual([{ enabled: true }]));
    expect(await within(section).findByText('Writing your summary…')).toBeInTheDocument();
    expect(within(section).getByLabelText(HEALTH_SUMMARY_SWITCH_LABEL)).toBeChecked();
  });

  it('cancelling the dialog sends nothing and leaves it off', async () => {
    const bodies = captureConsent();
    const { user } = await renderPage();
    const section = await findSection();

    await user.click(within(section).getByLabelText(HEALTH_SUMMARY_SWITCH_LABEL));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bodies).toHaveLength(0);
    expect(within(section).getByLabelText(HEALTH_SUMMARY_SWITCH_LABEL)).not.toBeChecked();
  });

  it('names a generic provider when the API reports no processor', async () => {
    serveView(
      mockHealthSummaryView({
        sharing: { ...mockHealthSummaryView().sharing, modelState: 'auto', processor: null },
      }),
    );
    const { user } = await renderPage();
    const section = await findSection();
    await user.click(within(section).getByLabelText(HEALTH_SUMMARY_SWITCH_LABEL));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/The AI model provider your administrator chose will process/)).toBeInTheDocument();
  });

  it('turns off directly with PUT false and says the summary leaves future runs', async () => {
    serveView(mockHealthSummaryEnabled());
    const bodies = captureConsent();
    const { user } = await renderPage();
    const section = await findSection();

    expect(within(section).getByText(/stops your coach reading your summary or biomarker values/)).toBeInTheDocument();
    await user.click(within(section).getByLabelText(HEALTH_SUMMARY_SWITCH_LABEL));
    await waitFor(() => expect(bodies).toEqual([{ enabled: false }]));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      await within(section).findByText('Turned off. Future training runs and coach chats no longer use your summary or biomarker values.'),
    ).toBeInTheDocument();
    expect(within(section).getByLabelText(HEALTH_SUMMARY_SWITCH_LABEL)).not.toBeChecked();
  });

  it('shows the summary verbatim with severity chips, the conservative marker, data as of and model', async () => {
    serveView(mockHealthSummaryEnabled());
    await renderPage();
    const section = await findSection();

    expect(within(section).getByText(mockHealthSummaryText.narrative)).toBeInTheDocument();
    const list = within(section).getByRole('list', { name: 'Training considerations' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('Caution')).toBeInTheDocument();
    expect(within(items[0]).getByText('Turns on conservative mode')).toBeInTheDocument();
    expect(within(items[0]).getByText(mockHealthSummaryText.trainingConsiderations[0].text)).toBeInTheDocument();
    expect(within(items[1]).getByText('Info')).toBeInTheDocument();
    expect(within(items[1]).queryByText('Turns on conservative mode')).not.toBeInTheDocument();
    expect(within(section).getByText(/Data as of Sep 28, 2026\./)).toBeInTheDocument();
    expect(within(section).getByText(/by frontier-1 \(OpenAI\)/)).toBeInTheDocument();
    expect(within(section).queryByText('Out of date')).not.toBeInTheDocument();
  });

  it('marks a stale summary and a failed last attempt', async () => {
    serveView(
      mockHealthSummaryEnabled({
        stale: true,
        lastAttempt: {
          version: 3,
          status: 'failed',
          errorCode: 'HEALTH_SUMMARY_POST_CHECK_REJECTED',
          createdAt: '2026-09-30T10:00:00.000Z',
        },
      }),
    );
    await renderPage();
    const section = await findSection();
    expect(within(section).getByText('Out of date')).toBeInTheDocument();
    expect(within(section).getByText(/did not pass the safety check/)).toBeInTheDocument();
    expect(within(section).getByText(/keep using the previous summary/)).toBeInTheDocument();
  });

  it('shows an empty state without health data and disables refresh', async () => {
    serveView(mockHealthSummaryEnabled({ summary: null, lastAttempt: null, hasData: false }));
    await renderPage();
    const section = await findSection();
    expect(within(section).getByText(/You have no health data to summarise yet/)).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'Health page' })).toHaveAttribute('href', '/health');
    expect(within(section).getByRole('button', { name: 'Refresh summary' })).toBeDisabled();
  });

  it('refreshes and shows the pending state', async () => {
    serveView(mockHealthSummaryEnabled());
    let calls = 0;
    server.use(
      http.post('*/api/ai/training/health-summary/refresh', () => {
        calls += 1;
        return HttpResponse.json({ data: mockHealthSummaryEnabled({ pending: true }) }, { status: 202 });
      }),
    );
    const { user } = await renderPage();
    const section = await findSection();
    await user.click(within(section).getByRole('button', { name: 'Refresh summary' }));
    await waitFor(() => expect(calls).toBe(1));
    expect(await within(section).findByText('Writing your summary…')).toBeInTheDocument();
    expect(within(section).getByText('A new summary is being written.')).toBeInTheDocument();
  });

  it.each([
    ['HEALTH_SUMMARY_CONSENT_OFF', `Turn on "${HEALTH_SUMMARY_SWITCH_LABEL}" first.`],
    ['HEALTH_SUMMARY_NO_DATA', 'There is no health data to summarise yet. Add some on the Health page first.'],
  ])('words the 409 %s refusal', async (reason, text) => {
    serveView(mockHealthSummaryEnabled());
    refuseRefresh(reason, 'Conflict');
    const { user } = await renderPage();
    const section = await findSection();
    await user.click(within(section).getByRole('button', { name: 'Refresh summary' }));
    expect(await within(section).findByText(text)).toBeInTheDocument();
  });

  it('is hidden without health_data:read and makes no request', async () => {
    let requested = false;
    server.use(
      http.get('*/api/ai/training/health-summary', () => {
        requested = true;
        return HttpResponse.json({ data: mockHealthSummaryView() });
      }),
    );
    await renderPage(mockUser.permissions.filter((p) => !p.startsWith('health_data:')));
    expect(screen.getByRole('region', { name: 'Run limits' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: HEALTH_SUMMARY_SECTION_TITLE })).not.toBeInTheDocument();
    expect(requested).toBe(false);
  });

  it('disables the controls without health_data:write', async () => {
    serveView(mockHealthSummaryEnabled());
    await renderPage(mockUser.permissions.filter((p) => p !== 'health_data:write'));
    const section = await findSection();
    expect(within(section).getByLabelText(HEALTH_SUMMARY_SWITCH_LABEL)).toBeDisabled();
    expect(within(section).getByRole('button', { name: 'Refresh summary' })).toBeDisabled();
    expect(within(section).getByText('You do not have permission to change this setting.')).toBeInTheDocument();
  });

  it('cannot be turned on while no model can write the summary, and explains why', async () => {
    serveView(
      mockHealthSummaryView({
        sharing: { ...mockHealthSummaryView().sharing, modelState: 'no_models', processor: null },
      }),
    );
    await renderPage();
    const section = await findSection();
    expect(within(section).getByLabelText(HEALTH_SUMMARY_SWITCH_LABEL)).toBeDisabled();
    expect(within(section).getByText(/has not made a model available for health summaries/)).toBeInTheDocument();
  });

  it('can still be turned off while no model can write the summary', async () => {
    serveView(
      mockHealthSummaryEnabled({
        sharing: { ...mockHealthSummaryView().sharing, modelState: 'no_key', processor: null },
      }),
    );
    await renderPage();
    const section = await findSection();
    expect(within(section).getByLabelText(HEALTH_SUMMARY_SWITCH_LABEL)).toBeEnabled();
    expect(within(section).getByRole('button', { name: 'Refresh summary' })).toBeDisabled();
    expect(within(section).getByText(/no new one can be written/)).toBeInTheDocument();
  });

  it('has no axe violations, off and on, and with the dialog open', async () => {
    const { container, user } = await renderPage();
    const section = await findSection();
    const rules = { rules: { 'color-contrast': { enabled: false } } };
    expect(await axe(container, rules)).toHaveNoViolations();

    await user.click(within(section).getByLabelText(HEALTH_SUMMARY_SWITCH_LABEL));
    const dialog = await screen.findByRole('dialog');
    expect(await axe(dialog, rules)).toHaveNoViolations();
  });

  it('has no axe violations with a summary shown', async () => {
    serveView(mockHealthSummaryEnabled({ stale: true }));
    const { container } = await renderPage();
    await findSection();
    expect(await axe(container, { rules: { 'color-contrast': { enabled: false } } })).toHaveNoViolations();
  });
});

describe('SentDataPanel: the health summary section', () => {
  it('renders the planner healthSummary section verbatim like any other section', async () => {
    render(
      <SentDataPanel
        entries={[
          {
            role: 'planner',
            provider: 'openai',
            model: 'frontier-1',
            keySource: 'org',
            sections: [
              { key: 'goal', title: 'Your goal', items: ['strength'] },
              { key: 'healthSummary', title: 'Health summary (opt-in)', items: [mockHealthSummaryText.narrative] },
            ],
            dropped: [],
            excluded: [],
          },
        ]}
      />,
    );
    await userEvent.click(screen.getByText(/Planner \(frontier-1\): 2 sections/));
    expect(await screen.findByText('Health summary (opt-in)')).toBeVisible();
    expect(screen.getByText(mockHealthSummaryText.narrative)).toBeVisible();
  });
});
