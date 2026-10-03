/**
 * PlanViewerPage (E5.6), read side: provenance labels, rationale and "How
 * it was made", verified-only evidence and the evidence popover, the week
 * selector, the load line, gym availability, lifecycle actions, not found,
 * permission gating, and axe.
 */
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import PlanViewerPage, { HAS_HISTORY_MESSAGE } from '../../../pages/Train/PlanViewerPage';
import { mockProgram, PROGRAM_ID } from '../../mocks/fixtures/programs';
import { nextScheduledDay } from '../../../components/training/ActivatePlanDialog';
import type { Program } from '../../../services/programs';

export const planUser = { ...mockUser, permissions: [...mockUser.permissions, 'programs:read', 'programs:write'] };

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

export function servePlan(program: Program = mockProgram()) {
  let current = program;
  server.use(
    http.get(`*/api/programs/${PROGRAM_ID}`, () => HttpResponse.json({ data: current })),
    http.get('*/api/exercises', () =>
      HttpResponse.json({ data: [{ id: 'ex-row', available: false }, { id: 'ex-bench', available: true }] }),
    ),
  );
  return { set: (next: Program) => (current = next), get: () => current };
}

function renderViewer(opts: { aiEnabled?: boolean; permissions?: string[] } = {}) {
  return render(
    <Routes>
      <Route path="/train/plans/:programId" element={<PlanViewerPage />} />
      <Route path="*" element={<Where />} />
    </Routes>,
    {
      wrapperOptions: {
        route: `/train/plans/${PROGRAM_ID}`,
        aiEnabled: opts.aiEnabled ?? true,
        user: { ...planUser, permissions: opts.permissions ?? planUser.permissions },
      },
    },
  );
}

describe('PlanViewerPage', () => {
  it('labels an AI plan and shows the rationale and how it was made', async () => {
    servePlan();
    renderViewer();
    expect(await screen.findByRole('heading', { name: 'Muscle gain', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('plan-source')).toHaveTextContent('AI-generated plan');
    expect(screen.getByText('Version 2')).toBeInTheDocument();
    expect(screen.getByText(/protecting the knee/)).toBeInTheDocument();
    expect(screen.getByText('How it was made')).toBeInTheDocument();
    expect(screen.getByText('Planner: frontier-1 (openai), high effort')).toBeInTheDocument();
    expect(screen.getByText('2 critic rounds')).toBeInTheDocument();
    expect(screen.getByText('49,000 tokens')).toBeInTheDocument();
    expect(screen.getByText(/The critic still had notes/)).toBeInTheDocument();
  });

  it('labels a manual plan and omits how it was made', async () => {
    servePlan(mockProgram({ source: 'manual', rationale: null, version: { ...mockProgram().version, origin: 'initial', meta: {}, evidence: [] } }));
    renderViewer();
    expect(await screen.findByTestId('plan-source')).toHaveTextContent('Manual plan');
    expect(screen.queryByText('How it was made')).not.toBeInTheDocument();
    expect(screen.queryByText('Why this plan')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Evidence' })).not.toBeInTheDocument();
  });

  it('lists only verified sources', async () => {
    const program = mockProgram();
    program.version.evidence.push({
      type: 'source',
      id: 'S2',
      url: 'https://unverified.example/x',
      title: 'Unverified blog',
      publisher: 'x',
      kind: 'other',
      year: null,
      verified: false,
      domain: 'unverified.example',
    });
    servePlan(program);
    renderViewer();
    const sources = await screen.findAllByTestId('evidence-source');
    expect(sources).toHaveLength(1);
    expect(within(sources[0]).getByRole('link', { name: 'ACSM position stand' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByText('Unverified blog')).not.toBeInTheDocument();
  });

  it('opens an evidence chip with the claim, applicability, confidence and sources', async () => {
    servePlan();
    renderViewer();
    await userEvent.click(await screen.findByTestId('evidence-chip-E1'));
    const dialog = await screen.findByRole('dialog', { name: 'Evidence E1' });
    expect(dialog).toHaveTextContent('10 to 20 hard sets per muscle per week support growth.');
    expect(dialog).toHaveTextContent('Applies to an intermediate lifter.');
    expect(dialog).toHaveTextContent('High confidence');
    expect(within(dialog).getByRole('link', { name: 'ACSM position stand' })).toHaveAttribute('target', '_blank');
  });

  it('handles a plan built from training principles: no sources, source-less claims, the basis note', async () => {
    const program = mockProgram();
    program.version.evidence = [
      { type: 'brief', summary: 'Brief', basis: 'model_knowledge', cautions: ['Built from established training principles.'], searchQueries: [], researchMode: 'single', droppedClaims: 0, droppedSources: 0 },
      { type: 'claim', id: 'E1', topic: 'volume', claim: '10 to 20 hard sets per muscle per week support growth.', applicability: 'Applies to an intermediate lifter.', confidence: 'moderate', sourceIds: [] },
    ];
    servePlan(program);
    renderViewer();
    expect(await screen.findByRole('heading', { name: 'Evidence' })).toBeInTheDocument();
    expect(screen.getByTestId('evidence-basis-note')).toHaveTextContent(
      'No web sources could be verified for this plan, so it was built from established training principles.',
    );
    expect(screen.queryAllByTestId('evidence-source')).toHaveLength(0);

    await userEvent.click(screen.getByTestId('evidence-chip-E1'));
    const dialog = await screen.findByRole('dialog', { name: 'Evidence E1' });
    expect(dialog).toHaveTextContent('10 to 20 hard sets per muscle per week support growth.');
    expect(within(dialog).getByTestId('evidence-principle-E1')).toHaveTextContent('Training principle');
    expect(within(dialog).queryByRole('list')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows the partial note with the sources and labels only the source-less claim', async () => {
    const program = mockProgram();
    program.version.evidence = program.version.evidence.map((item) => (item.type === 'brief' ? { ...item, basis: 'web_partial' } : item));
    program.version.evidence.push({ type: 'claim', id: 'E2', topic: 'rest', claim: 'Rest two minutes between heavy sets.', applicability: '', confidence: 'low', sourceIds: [] });
    servePlan(program);
    renderViewer();
    expect(await screen.findAllByTestId('evidence-source')).toHaveLength(1);
    expect(screen.getByTestId('evidence-basis-note')).toHaveTextContent(
      'Some guidance comes from established training principles rather than a verified source.',
    );
    await userEvent.click(screen.getByTestId('evidence-chip-E1'));
    const dialog = await screen.findByRole('dialog', { name: 'Evidence E1' });
    expect(within(dialog).queryByTestId('evidence-principle-E1')).not.toBeInTheDocument();
  });

  it('shows no basis note for a verified (or older) brief', async () => {
    servePlan();
    renderViewer();
    expect(await screen.findAllByTestId('evidence-source')).toHaveLength(1);
    expect(screen.queryByTestId('evidence-basis-note')).not.toBeInTheDocument();
  });

  it('renders the week with workouts in weekday order, prescriptions, loads and availability', async () => {
    servePlan();
    renderViewer();
    const workouts = await screen.findAllByTestId('plan-workout');
    expect(workouts.map((w) => within(w).getByRole('heading').textContent)).toEqual(['Upper A', 'Lower A']);
    const upper = workouts[0];
    expect(upper).toHaveTextContent('Monday · about 45 min');
    expect(upper).toHaveTextContent('3 x 8-10 @ RPE 8 · 2 min rest · Choose a starting load');
    expect(upper).toHaveTextContent('3 x 10-12 · 1m 30s rest · 50 kg');
    expect(await within(upper).findByText('Not available at Home Gym')).toBeInTheDocument();
    expect(workouts[1]).toHaveTextContent('From your last session');
  });

  it('moves between weeks with the selector and buttons', async () => {
    servePlan();
    renderViewer();
    await screen.findAllByTestId('plan-workout');
    expect(screen.getByRole('button', { name: 'Previous week' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(await screen.findByText('Deload week')).toBeInTheDocument();
    expect(screen.getByText('No workouts this week.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next week' })).toBeDisabled();
  });

  it('activates with a start date on the next scheduled weekday', async () => {
    const plan = servePlan();
    let startDate: string | null = null;
    server.use(
      http.post(`*/api/programs/${PROGRAM_ID}/activate`, async ({ request }) => {
        startDate = ((await request.json()) as { startDate: string }).startDate;
        plan.set(mockProgram({ status: 'active', startDate }));
        return HttpResponse.json({ data: plan.get() });
      }),
    );
    renderViewer();
    await userEvent.click(await screen.findByRole('button', { name: 'Activate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activate this plan' });
    const input = within(dialog).getByLabelText('Start date') as HTMLInputElement;
    expect(new Date(`${input.value}T00:00:00Z`).getUTCDay()).toSatisfy((d: number) => d === 1 || d === 4);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(startDate).toBe(input.value));
    expect(await screen.findByText('Plan activated.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('disables Activate with the reason when nothing is scheduled', async () => {
    const program = mockProgram();
    program.tree.blocks[0].weeks[0].workouts.forEach((w) => (w.weekday = null));
    servePlan(program);
    renderViewer();
    expect(await screen.findByRole('button', { name: 'Activate' })).toBeDisabled();
    expect(screen.getByText(/Schedule at least one week 1 workout/)).toBeInTheDocument();
  });

  it('says archive instead when delete is refused for history', async () => {
    servePlan();
    server.use(
      http.delete(`*/api/programs/${PROGRAM_ID}`, () =>
        HttpResponse.json({ message: 'Has history', details: { reason: 'PROGRAM_HAS_HISTORY' } }, { status: 409 }),
      ),
    );
    renderViewer();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByText(HAS_HISTORY_MESSAGE)).toBeInTheDocument();
  });

  it('hides write actions without programs:write', async () => {
    servePlan();
    renderViewer({ permissions: planUser.permissions.filter((p) => p !== 'programs:write') });
    await screen.findByRole('heading', { name: 'Muscle gain', level: 1 });
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'History' })).toBeInTheDocument();
  });

  it('shows not found with a link back', async () => {
    server.use(http.get(`*/api/programs/${PROGRAM_ID}`, () => HttpResponse.json({ message: 'nope' }, { status: 404 })));
    renderViewer();
    expect(await screen.findByText(/This plan does not exist any more/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to your plans' })).toHaveAttribute('href', '/train/plans');
  });

  it('has no axe violations', async () => {
    servePlan();
    const { container } = renderViewer();
    await screen.findAllByTestId('plan-workout');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('nextScheduledDay picks the first matching weekday from today', () => {
    // 2026-09-30 is a Wednesday.
    expect(nextScheduledDay('2026-09-30', [1, 4])).toBe('2026-10-01');
    expect(nextScheduledDay('2026-09-30', [3])).toBe('2026-09-30');
    expect(nextScheduledDay('2026-09-30', [])).toBeNull();
  });
});
