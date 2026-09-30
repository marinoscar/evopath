/**
 * PlansPage (E5.6): the list, the empty state, Create with AI gating (AI off,
 * no ai:use, a blocked role), Build manually, errors with retry, and axe.
 */
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import PlansPage from '../../../pages/Train/PlansPage';
import { mockProgram, mockProgramListItem, PROGRAM_ID } from '../../mocks/fixtures/programs';
import { mockTrainingModelsView } from '../../mocks/fixtures/trainingAgents';

const user = { ...mockUser, permissions: [...mockUser.permissions, 'programs:read', 'programs:write'] };

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

function renderPage(opts: { aiEnabled?: boolean; permissions?: string[] } = {}) {
  return render(
    <Routes>
      <Route path="/train/plans" element={<PlansPage />} />
      <Route path="*" element={<Where />} />
    </Routes>,
    {
      wrapperOptions: {
        route: '/train/plans',
        aiEnabled: opts.aiEnabled ?? true,
        user: { ...user, permissions: opts.permissions ?? user.permissions },
      },
    },
  );
}

function listPlans(items = [mockProgramListItem()]) {
  server.use(http.get('*/api/programs', () => HttpResponse.json({ data: items })));
}

describe('PlansPage', () => {
  it('lists plans with status, provenance and the Plan adjusted chip', async () => {
    listPlans([
      mockProgramListItem({ unseenChangeCount: 2 }),
      mockProgramListItem({ id: 'p2', name: 'Strength base', source: 'manual', status: 'archived' }),
    ]);
    renderPage();
    expect(await screen.findByText('Muscle gain')).toBeInTheDocument();
    expect(screen.getByText('Strength base')).toBeInTheDocument();
    expect(screen.getByText('AI-generated')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.getAllByTestId('plan-adjusted-chip')).toHaveLength(1);
    expect(screen.getByText('Plan adjusted (2)')).toBeInTheDocument();
  });

  it('shows Week X of Y for the active plan', async () => {
    listPlans([mockProgramListItem({ status: 'active' })]);
    server.use(
      http.get('*/api/training/today', () =>
        HttpResponse.json({
          data: { kind: 'rest_day', date: '2026-09-30', program: { id: PROGRAM_ID, name: 'Muscle gain' }, weekNumber: 3, totalWeeks: 8, next: null },
        }),
      ),
    );
    renderPage();
    expect(await screen.findByText(/Week 3 of 8/)).toBeInTheDocument();
  });

  it('explains both paths when there is no plan', async () => {
    listPlans([]);
    renderPage();
    expect(await screen.findByText('No plans yet')).toBeInTheDocument();
    expect(screen.getByText(/Create with AI: answer a few questions/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Create with AI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build manually' })).toBeInTheDocument();
  });

  it('hides Create with AI when AI is off; Build manually stays', async () => {
    listPlans([]);
    renderPage({ aiEnabled: false });
    expect(await screen.findByText('No plans yet')).toBeInTheDocument();
    expect(screen.queryByText('Create with AI')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build manually' })).toBeInTheDocument();
  });

  it('hides Create with AI without ai:use', async () => {
    listPlans([]);
    renderPage({ permissions: user.permissions.filter((p) => p !== 'ai:use') });
    expect(await screen.findByText('No plans yet')).toBeInTheDocument();
    expect(screen.queryByText('Create with AI')).not.toBeInTheDocument();
  });

  it('disables Create with AI with the reason and fix when a role is blocked', async () => {
    listPlans([]);
    server.use(
      http.get('*/api/ai/training/models', () =>
        HttpResponse.json({
          data: {
            ...mockTrainingModelsView,
            roles: {
              ...mockTrainingModelsView.roles,
              researcher: { ...mockTrainingModelsView.roles.researcher, state: 'missing_capability', model: undefined, fix: 'keys' },
            },
            canRun: { create: false, revise: true, evaluate: true, blockers: [{ role: 'researcher', state: 'missing_capability' }] },
          },
        }),
      ),
    );
    renderPage();
    expect(await screen.findByText(/The researcher agent needs a model with web search/)).toBeInTheDocument();
    // A key is the only fix a user makes; they are never sent to pick a model (#173).
    expect(screen.getByRole('link', { name: 'Add a key' })).toHaveAttribute('href', '/settings/ai');
    expect(screen.queryByRole('link', { name: 'Choose a model' })).not.toBeInTheDocument();
    const create = screen.getByText('Create with AI').closest('a,button')!;
    expect(create).toHaveAttribute('aria-disabled', 'true');
  });

  it('hides the create actions without programs:write', async () => {
    listPlans([mockProgramListItem()]);
    renderPage({ permissions: user.permissions.filter((p) => p !== 'programs:write') });
    expect(await screen.findByText('Muscle gain')).toBeInTheDocument();
    expect(screen.queryByText('Build manually')).not.toBeInTheDocument();
    expect(screen.queryByText('Create with AI')).not.toBeInTheDocument();
  });

  it('Build manually creates a blank plan and opens it', async () => {
    listPlans([]);
    let body: unknown = null;
    server.use(
      http.post('*/api/programs', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: mockProgram({ id: 'new-plan', source: 'manual' }) }, { status: 201 });
      }),
    );
    renderPage({ aiEnabled: false });
    await userEvent.click(await screen.findByRole('button', { name: 'Build manually' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/train/plans/new-plan'));
    expect(body).toEqual({ name: 'My plan', goal: 'general' });
  });

  it('shows a load error with retry', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/programs', () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ message: 'Boom' }, { status: 500 })
          : HttpResponse.json({ data: [mockProgramListItem()] });
      }),
    );
    renderPage();
    expect(await screen.findByText('Boom')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Muscle gain')).toBeInTheDocument();
  });

  it('shows the redirect notice', async () => {
    listPlans([]);
    render(<PlansPage />, {
      wrapperOptions: { route: '/train/plans', routeState: { notice: 'AI is off.' }, aiEnabled: false, user },
    });
    expect(await screen.findByText('AI is off.')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    listPlans([mockProgramListItem({ unseenChangeCount: 1 })]);
    const { container } = renderPage();
    await screen.findByText('Muscle gain');
    expect(await axe(container)).toHaveNoViolations();
  });
});
