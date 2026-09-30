/**
 * PlanWizardPage (E5.6): per-step validation, the draft surviving a reload,
 * the review (agents, what will be sent, the token range), Start and its
 * refusals (blocked role, safety stop, run already active, 400 mapped to the
 * field and step, AI switched off), and axe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import PlanWizardPage, { SAFETY_NOTE } from '../../../pages/Train/PlanWizardPage';
import {
  WIZARD_STORAGE_KEY,
  initialWizardForm,
  type WizardForm,
} from '../../../components/training/planWizard';
import { mockTrainingModelsView, mockTrainingRunEstimate } from '../../mocks/fixtures/trainingAgents';
import { RUN_ID } from '../../mocks/fixtures/programs';
import type { SentDataEntry } from '../../../services/trainingAgents';

const user = { ...mockUser, permissions: [...mockUser.permissions, 'programs:read', 'programs:write'] };

const SENT: SentDataEntry[] = [
  {
    role: 'researcher',
    provider: 'openai',
    model: 'frontier-1',
    keySource: 'user',
    sections: [
      { key: 'goal', title: 'Goal', items: ['Build muscle'] },
      { key: 'limitations', title: 'Limitations', items: ['knee'], count: 1 },
    ],
    dropped: [],
    excluded: ['name', 'email'],
  },
  {
    role: 'planner',
    provider: 'openai',
    model: 'frontier-1',
    keySource: 'user',
    sections: [{ key: 'history', title: 'Recent workouts', items: [], count: 12 }],
    dropped: ['Measurements'],
    excluded: [],
  },
];

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

function renderWizard() {
  return render(
    <Routes>
      <Route path="/train/plans/new" element={<PlanWizardPage />} />
      <Route path="*" element={<Where />} />
    </Routes>,
    { wrapperOptions: { route: '/train/plans/new', aiEnabled: true, user } },
  );
}

function validForm(overrides: Partial<WizardForm> = {}): WizardForm {
  return { ...initialWizardForm(), experience: 'intermediate', gymId: 'none', daysPerWeek: 4, ...overrides };
}

function atReview(form: WizardForm = validForm()) {
  window.sessionStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify({ step: 3, form }));
}

beforeEach(() => {
  window.sessionStorage.clear();
  server.use(
    http.post('*/api/ai/training/estimate', () =>
      HttpResponse.json({ data: { ...mockTrainingRunEstimate, sentData: SENT } }),
    ),
  );
});

describe('PlanWizardPage steps', () => {
  it('validates the goal step before Next', async () => {
    renderWizard();
    expect(screen.getByRole('heading', { name: 'Goal', level: 2 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Choose your experience level.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Goal', level: 2 })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('In your words'), 'Build muscle');
    expect(screen.getByText('12/300')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /Intermediate/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Schedule and gym', level: 2 })).toBeInTheDocument();
  });

  it('requires at least as many preferred weekdays as days', async () => {
    window.sessionStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify({ step: 1, form: validForm({ daysPerWeek: 3 }) }));
    renderWizard();
    await userEvent.click(await screen.findByRole('button', { name: 'Monday' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Choose at least 3 weekdays, or none.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Wednesday' }));
    await userEvent.click(screen.getByRole('button', { name: 'Friday' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Limits and preferences', level: 2 })).toBeInTheDocument();
    expect(screen.getByText(SAFETY_NOTE)).toBeInTheDocument();
  });

  it('keeps the answers across a reload of the tab', async () => {
    const first = renderWizard();
    await userEvent.type(screen.getByLabelText('In your words'), 'Get strong');
    await userEvent.click(screen.getByRole('radio', { name: /Advanced/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Schedule and gym', level: 2 });
    first.unmount();

    renderWizard();
    expect(await screen.findByRole('heading', { name: 'Schedule and gym', level: 2 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('In your words')).toHaveValue('Get strong');
    expect(screen.getByRole('radio', { name: /Advanced/ })).toBeChecked();
  });

  it('adds limitations with a description', async () => {
    window.sessionStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify({ step: 2, form: validForm() }));
    renderWizard();
    await userEvent.click(await screen.findByRole('button', { name: 'Knee' }));
    expect(screen.getByRole('button', { name: 'Knee' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.type(screen.getByLabelText('Knee: what to know'), 'mild discomfort');
    expect(screen.getByText('15/200')).toBeInTheDocument();
  });
});

describe('PlanWizardPage review and start', () => {
  it('shows the agents, what will be sent and the token range', async () => {
    atReview();
    renderWizard();
    const agents = await screen.findByRole('list', { name: 'Agents' });
    expect(within(agents).getByTestId('role-row-researcher')).toHaveTextContent('Frontier One, medium effort, your key');
    expect(within(agents).getAllByRole('link', { name: /Change the/ })[0]).toHaveAttribute('href', '/settings/ai/agents');

    const panel = await screen.findByTestId('sent-data-panel');
    expect(within(panel).getByText(/Researcher \(frontier-1\): 2 sections/)).toBeInTheDocument();
    await userEvent.click(within(panel).getByText(/Planner \(frontier-1\)/));
    expect(await within(panel).findByText('Recent workouts (12)')).toBeVisible();
    expect(within(panel).getByText('Left out to fit this model: Measurements.')).toBeInTheDocument();
    expect(within(panel).getByText(/Not sent: your name, email, date of birth/)).toBeInTheDocument();
    expect(screen.getByText(/may appear in search queries sent to openai/)).toBeInTheDocument();
    expect(screen.getByTestId('token-estimate')).toHaveTextContent('Estimated 60,000 to 180,000 tokens, capped at 400,000.');
  });

  it('sends the intake in the estimate and re-estimates when an opt-in changes', async () => {
    const bodies: Array<{ intake?: { includeBio: boolean } }> = [];
    server.use(
      http.post('*/api/ai/training/estimate', async ({ request }) => {
        bodies.push((await request.json()) as { intake?: { includeBio: boolean } });
        return HttpResponse.json({ data: { ...mockTrainingRunEstimate, sentData: SENT } });
      }),
    );
    atReview();
    renderWizard();
    await screen.findByTestId('token-estimate');
    expect(bodies[0]).toMatchObject({ kind: 'create', intake: { includeBio: false, daysPerWeek: 4, gymId: null } });
    await userEvent.click(screen.getByRole('switch', { name: /Include my bio/ }));
    await waitFor(() => expect(bodies.at(-1)?.intake?.includeBio).toBe(true));
  });

  it('starts a create run with the intake and opens the run page', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post('*/api/ai/training/runs', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ data: { runId: RUN_ID, jobId: 'job-1', status: 'queued' } }, { status: 202 });
      }),
    );
    atReview(validForm({ autonomy: 'ask_first', limitations: [{ area: 'knee', description: 'deep squats hurt' }] }));
    renderWizard();
    await screen.findByTestId('token-estimate');
    await userEvent.click(screen.getByRole('radio', { name: 'Ask me before changing my plan' }));
    await userEvent.click(screen.getByTestId('wizard-start'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/train/plans/runs/${RUN_ID}`));
    expect(body).toMatchObject({
      kind: 'create',
      intake: {
        goal: { type: 'hypertrophy', description: '' },
        experience: 'intermediate',
        limitations: [{ area: 'knee', description: 'deep squats hurt' }],
        autonomy: 'ask_first',
      },
    });
    expect(Object.keys(body!)).toEqual(['kind', 'intake']);
    expect(window.sessionStorage.getItem(WIZARD_STORAGE_KEY)).toBeNull();
  });

  it('disables Start with the role state and fix link when a role is blocked', async () => {
    server.use(
      http.get('*/api/ai/training/models', () =>
        HttpResponse.json({
          data: {
            ...mockTrainingModelsView,
            roles: {
              ...mockTrainingModelsView.roles,
              researcher: { ...mockTrainingModelsView.roles.researcher, state: 'web_search_disabled', model: undefined, fix: 'admin' },
            },
            canRun: { create: false, revise: true, evaluate: true, blockers: [{ role: 'researcher', state: 'web_search_disabled' }] },
          },
        }),
      ),
    );
    atReview();
    renderWizard();
    expect(await screen.findByText(/The researcher agent needs web search: an administrator can turn it on/)).toBeInTheDocument();
    expect(screen.getByTestId('wizard-start')).toBeDisabled();
  });

  it('shows the safety guidance and refuses to resubmit the same text', async () => {
    let calls = 0;
    server.use(
      http.post('*/api/ai/training/runs', () => {
        calls += 1;
        return HttpResponse.json({
          data: { runId: RUN_ID, jobId: null, status: 'blocked_safety', guidance: 'Chest pain needs a doctor first.' },
        });
      }),
    );
    atReview(validForm({ limitations: [{ area: 'other', description: 'chest pain and dizzy' }] }));
    renderWizard();
    await screen.findByTestId('token-estimate');
    await userEvent.click(screen.getByTestId('wizard-start'));
    expect(await screen.findByTestId('safety-guidance')).toHaveTextContent('Chest pain needs a doctor first.');
    expect(screen.getByTestId('wizard-start')).toBeDisabled();
    expect(calls).toBe(1);
    expect(screen.queryByText(/Try again/)).not.toBeInTheDocument();
  });

  it('offers to open the run already in progress', async () => {
    server.use(
      http.post('*/api/ai/training/runs', () =>
        HttpResponse.json(
          { message: 'A run is active', details: { reason: 'TRAINING_RUN_ACTIVE', runId: 'other-run' } },
          { status: 409 },
        ),
      ),
    );
    atReview();
    renderWizard();
    await screen.findByTestId('token-estimate');
    await userEvent.click(screen.getByTestId('wizard-start'));
    await userEvent.click(await screen.findByRole('button', { name: 'Open it' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/train/plans/runs/other-run'));
  });

  it('shows the role state on 409 TRAINING_ROLE_UNAVAILABLE', async () => {
    server.use(
      http.post('*/api/ai/training/runs', () =>
        HttpResponse.json(
          { message: 'Role', details: { reason: 'TRAINING_ROLE_UNAVAILABLE', role: 'critic', state: 'no_key' } },
          { status: 409 },
        ),
      ),
    );
    atReview();
    renderWizard();
    await screen.findByTestId('token-estimate');
    await userEvent.click(screen.getByTestId('wizard-start'));
    expect(await screen.findByText('The critic agent needs an AI key.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a key' })).toHaveAttribute('href', '/settings/ai');
  });

  it('maps a 400 to the field on its step', async () => {
    server.use(
      http.post('*/api/ai/training/runs', () =>
        HttpResponse.json(
          { message: 'Validation failed', details: { issues: [{ path: 'intake.minutesPerSession', message: 'Too long for this plan' }] } },
          { status: 400 },
        ),
      ),
    );
    atReview();
    renderWizard();
    await screen.findByTestId('token-estimate');
    await userEvent.click(screen.getByTestId('wizard-start'));
    expect(await screen.findByRole('heading', { name: 'Schedule and gym', level: 2 })).toBeInTheDocument();
    expect(screen.getByText('Too long for this plan')).toBeInTheDocument();
  });

  it('explains when AI was just switched off', async () => {
    server.use(
      http.post('*/api/ai/training/runs', () =>
        HttpResponse.json({ message: 'AI is disabled', details: { reason: 'AI_DISABLED' } }, { status: 403 }),
      ),
    );
    atReview();
    renderWizard();
    await screen.findByTestId('token-estimate');
    await userEvent.click(screen.getByTestId('wizard-start'));
    expect(await screen.findByText('AI is disabled by your administrator')).toBeInTheDocument();
  });

  it('blocks Start when the chosen gym was removed', async () => {
    server.use(http.get('*/api/gyms', () => HttpResponse.json({ data: [] })));
    atReview(validForm({ gymId: '00000000-0000-4000-8000-00000000dead' }));
    renderWizard();
    expect(await screen.findByText('This gym no longer exists. Choose another.')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-start')).toBeDisabled();
  });
});

describe('PlanWizardPage accessibility', () => {
  it('has no axe violations on the first step', async () => {
    const { container } = renderWizard();
    await screen.findByRole('heading', { name: 'Goal', level: 2 });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations on review', async () => {
    atReview();
    const { container } = renderWizard();
    await screen.findByTestId('token-estimate');
    await screen.findByRole('list', { name: 'Agents' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
