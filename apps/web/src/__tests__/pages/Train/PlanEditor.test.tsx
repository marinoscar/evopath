/**
 * The plan editor on PlanViewerPage (E5.6): edit a prescription and save a
 * new version (If-Match), reorder by keyboard, weekday conflicts, the 409
 * dialog that keeps edits, a network failure that keeps edits, the manual
 * builder with AI off (blank plan to activation), Revise with AI visibility,
 * and axe.
 */
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import PlanViewerPage from '../../../pages/Train/PlanViewerPage';
import { STALE_MESSAGE } from '../../../components/training/PlanEditor';
import { mockProgram, PROGRAM_ID, RUN_ID } from '../../mocks/fixtures/programs';
import type { PlanTree, Program } from '../../../services/programs';

const user = { ...mockUser, permissions: [...mockUser.permissions, 'programs:read', 'programs:write'] };

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

function servePlan(program: Program = mockProgram()) {
  let current = program;
  const puts: Array<{ ifMatch: string | null; body: PlanTree }> = [];
  server.use(
    http.get(`*/api/programs/${PROGRAM_ID}`, () => HttpResponse.json({ data: current })),
    http.get('*/api/exercises', () => HttpResponse.json({ data: [] })),
    http.get('*/api/ai/training/runs', () => HttpResponse.json({ data: { items: [], total: 0, page: 1, pageSize: 5, totalPages: 0 } })),
    http.put(`*/api/programs/${PROGRAM_ID}/structure`, async ({ request }) => {
      const body = (await request.json()) as PlanTree;
      puts.push({ ifMatch: request.headers.get('If-Match'), body });
      current = { ...current, currentVersion: current.currentVersion + 1, version: { ...current.version, origin: 'manual_edit' } };
      return HttpResponse.json({ data: current });
    }),
  );
  return { puts, set: (p: Program) => (current = p), get: () => current };
}

function renderEditor(opts: { aiEnabled?: boolean; routeState?: unknown; permissions?: string[] } = {}) {
  return render(
    <Routes>
      <Route path="/train/plans/:programId" element={<PlanViewerPage />} />
      <Route path="*" element={<Where />} />
    </Routes>,
    {
      wrapperOptions: {
        route: `/train/plans/${PROGRAM_ID}`,
        routeState: opts.routeState,
        aiEnabled: opts.aiEnabled ?? true,
        user: { ...user, permissions: opts.permissions ?? user.permissions },
      },
    },
  );
}

async function openEditor() {
  await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  return screen.findAllByTestId('edit-workout');
}

describe('plan editor', () => {
  it('edits a prescription and saves a new version with If-Match', async () => {
    const api = servePlan();
    renderEditor();
    await openEditor();
    const sets = screen.getByRole('spinbutton', { name: 'Sets, Bench press' });
    await userEvent.clear(sets);
    await userEvent.type(sets, '4');
    await userEvent.click(screen.getByTestId('plan-save'));
    expect(await screen.findByText('Saved as version 3 (edited by you).')).toBeInTheDocument();
    expect(api.puts).toHaveLength(1);
    expect(api.puts[0].ifMatch).toBe('2');
    const bench = api.puts[0].body.blocks[0].weeks[0].workouts[0].exercises[0] as Record<string, unknown>;
    expect(bench).toMatchObject({ id: 'pe-bench', targetSets: 4 });
    expect(bench.exercise).toBeUndefined();
    expect(screen.getByText('Edited by you')).toBeInTheDocument();
  });

  it('announces row problems and blocks Save', async () => {
    servePlan();
    renderEditor();
    await openEditor();
    const sets = screen.getByRole('spinbutton', { name: 'Sets, Bench press' });
    await userEvent.clear(sets);
    await userEvent.type(sets, '30');
    expect(screen.getByTestId('editor-problems')).toHaveTextContent('1 problem to fix before saving: Sets: 1 to 20.');
    expect(screen.getByTestId('plan-save')).toBeDisabled();
  });

  it('reorders by keyboard and keeps focus on the moved row', async () => {
    const api = servePlan();
    renderEditor();
    const [upper] = await openEditor();
    const down = within(upper).getByRole('button', { name: 'Move Bench press down' });
    down.focus();
    await userEvent.keyboard('{Enter}');
    const rows = within(upper).getAllByTestId('edit-exercise');
    expect(rows[0]).toHaveTextContent('Cable row');
    expect(rows[1]).toHaveTextContent('Bench press');
    await waitFor(() => expect(within(upper).getByRole('button', { name: 'Move Bench press up' })).toHaveFocus());
    await userEvent.click(screen.getByTestId('plan-save'));
    await waitFor(() => expect(api.puts).toHaveLength(1));
    expect(api.puts[0].body.blocks[0].weeks[0].workouts[0].exercises.map((e) => [e.id, e.position])).toEqual([
      ['pe-row', 0],
      ['pe-bench', 1],
    ]);
  });

  it('disables a weekday another workout of the week uses', async () => {
    servePlan();
    renderEditor();
    const [upper] = await openEditor();
    const days = within(upper).getByRole('group', { name: 'Day for Upper A' });
    expect(within(days).getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(days).getByRole('button', { name: 'Thursday (already used this week)' })).toBeDisabled();
  });

  it('shows the stale dialog on 409 and keeps the edits copyable', async () => {
    servePlan();
    server.use(
      http.put(`*/api/programs/${PROGRAM_ID}/structure`, () =>
        HttpResponse.json({ message: 'Stale', details: { reason: 'TRAINING_STALE_PLAN', currentVersion: 3 } }, { status: 409 }),
      ),
    );
    renderEditor();
    await openEditor();
    const sets = screen.getByRole('spinbutton', { name: 'Sets, Bench press' });
    await userEvent.clear(sets);
    await userEvent.type(sets, '6');
    await userEvent.click(screen.getByTestId('plan-save'));
    const dialog = await screen.findByRole('dialog', { name: 'Plan changed' });
    expect(dialog).toHaveTextContent(STALE_MESSAGE);
    expect((within(dialog).getByLabelText('Your edits') as HTMLTextAreaElement).value).toContain('"targetSets": 6');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('spinbutton', { name: 'Sets, Bench press' })).toHaveValue(6);
  });

  it('keeps the edits on a network failure and retries', async () => {
    const api = servePlan();
    let fail = true;
    server.use(
      http.put(`*/api/programs/${PROGRAM_ID}/structure`, async ({ request }) => {
        if (fail) {
          fail = false;
          return HttpResponse.error();
        }
        api.puts.push({ ifMatch: request.headers.get('If-Match'), body: (await request.json()) as PlanTree });
        return HttpResponse.json({ data: { ...api.get(), currentVersion: 3 } });
      }),
    );
    renderEditor();
    await openEditor();
    const sets = screen.getByRole('spinbutton', { name: 'Sets, Bench press' });
    await userEvent.clear(sets);
    await userEvent.type(sets, '5');
    await userEvent.click(screen.getByTestId('plan-save'));
    expect(await screen.findByText(/Your edits are kept here/)).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Sets, Bench press' })).toHaveValue(5);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Saved as version 3 (edited by you).')).toBeInTheDocument();
  });

  it('explains a prescription that does not fit the tracking mode (400 PRESCRIPTION_SHAPE_MISMATCH)', async () => {
    servePlan();
    server.use(
      http.put(`*/api/programs/${PROGRAM_ID}/structure`, () =>
        HttpResponse.json(
          {
            statusCode: 400,
            code: 'BAD_REQUEST',
            message: "A prescription does not fit its exercise's tracking mode",
            details: {
              reason: 'PRESCRIPTION_SHAPE_MISMATCH',
              issues: [
                {
                  path: 'blocks.0.weeks.0.workouts.0.exercises.1',
                  message: 'This exercise is tracked in time: prescribe a duration (targetDurationSeconds), not reps',
                },
              ],
            },
          },
          { status: 400 },
        ),
      ),
    );
    renderEditor();
    await openEditor();
    const sets = screen.getByRole('spinbutton', { name: 'Sets, Bench press' });
    await userEvent.clear(sets);
    await userEvent.type(sets, '4');
    await userEvent.click(screen.getByTestId('plan-save'));
    expect(await screen.findByText(/don't match how they are tracked/)).toBeInTheDocument();
    expect(
      screen.getByText('Week 1 · Upper A · Cable row: This exercise is tracked in time: prescribe a duration, not reps'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/targetDurationSeconds/)).toBeNull();
    // The edits are kept.
    expect(screen.getByRole('spinbutton', { name: 'Sets, Bench press' })).toHaveValue(4);
  });

  it('asks before discarding unsaved edits', async () => {
    servePlan();
    renderEditor();
    await openEditor();
    const sets = screen.getByRole('spinbutton', { name: 'Sets, Bench press' });
    await userEvent.clear(sets);
    await userEvent.type(sets, '5');
    await userEvent.click(screen.getByRole('link', { name: 'Plans' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard your edits?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/train/plans'));
  });

  it('builds a manual plan from blank with AI off, then activates it', async () => {
    const blank = mockProgram({
      source: 'manual',
      rationale: null,
      gymId: null,
      gym: null,
      currentVersion: 1,
      version: { ...mockProgram().version, versionNumber: 1, origin: 'initial', meta: {}, evidence: [] },
      tree: {
        blocks: [{ id: 'b1', position: 0, name: 'Block 1', focus: null, rationale: null, weeks: [{ id: 'w1', weekNumber: 1, isDeload: false, workouts: [] }] }],
      },
    });
    const api = servePlan(blank);
    server.use(
      http.get('*/api/exercises', () =>
        HttpResponse.json({
          data: [
            {
              id: 'ex-pushup',
              slug: 'push-up',
              name: 'Push-up',
              primaryMuscles: ['chest'],
              secondaryMuscles: [],
              movementPattern: 'push',
              trackingMode: 'reps',
              isCustom: false,
              origin: 'library',
              status: 'active',
              proposedByRunId: null,
              isUnilateral: false,
              isBodyweight: true,
              aliases: [],
              notes: null,
              requirements: [],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      ),
      http.put(`*/api/programs/${PROGRAM_ID}/structure`, async ({ request }) => {
        const body = (await request.json()) as PlanTree;
        api.puts.push({ ifMatch: request.headers.get('If-Match'), body });
        const saved: Program = {
          ...api.get(),
          currentVersion: 2,
          tree: {
            blocks: body.blocks.map((b, bi) => ({
              id: `b${bi}`,
              position: b.position,
              name: b.name,
              focus: b.focus ?? null,
              rationale: b.rationale ?? null,
              weeks: b.weeks.map((w, wi) => ({
                id: `w${bi}${wi}`,
                weekNumber: w.weekNumber,
                isDeload: !!w.isDeload,
                workouts: w.workouts.map((x, xi) => ({
                  id: `x${wi}${xi}`,
                  position: x.position,
                  weekday: x.weekday ?? null,
                  name: x.name,
                  estimatedMinutes: null,
                  rationale: null,
                  exercises: [],
                })),
              })),
            })),
          },
        };
        api.set(saved);
        return HttpResponse.json({ data: saved });
      }),
      http.post(`*/api/programs/${PROGRAM_ID}/activate`, async ({ request }) => {
        const { startDate } = (await request.json()) as { startDate: string };
        const active = { ...api.get(), status: 'active' as const, startDate };
        api.set(active);
        return HttpResponse.json({ data: active });
      }),
    );
    renderEditor({ aiEnabled: false, routeState: { edit: true } });

    // Starts in edit mode for a new blank plan; no AI anywhere.
    await userEvent.click(await screen.findByRole('button', { name: 'Add workout' }));
    const [workout] = await screen.findAllByTestId('edit-workout');
    const name = within(workout).getByLabelText('Workout name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Full body');
    await userEvent.click(within(workout).getByRole('button', { name: 'Wednesday' }));
    await userEvent.click(within(workout).getByRole('button', { name: 'Add exercise' }));
    const picker = await screen.findByRole('dialog');
    await userEvent.click(await within(picker).findByRole('checkbox', { name: /Push-up/ }));
    await userEvent.click(within(picker).getByRole('button', { name: 'Add exercise' }));
    await waitFor(() => expect(within(workout).getAllByTestId('edit-exercise')).toHaveLength(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Add week' }));
    await userEvent.click(screen.getByTestId('plan-save'));

    await screen.findByText('Saved as version 2 (edited by you).');
    const body = api.puts[0].body;
    expect(api.puts[0].ifMatch).toBe('1');
    expect(body.blocks[0].weeks).toHaveLength(2);
    expect(body.blocks[0].weeks[0].workouts[0]).toMatchObject({ name: 'Full body', weekday: 3, position: 0 });
    expect(body.blocks[0].weeks[0].workouts[0].exercises[0]).toMatchObject({ exerciseId: 'ex-pushup', targetSets: 3 });
    expect(body.blocks[0].weeks[0].workouts[0].id).toBeUndefined();
    expect(screen.queryByText('Revise with AI')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Activate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activate this plan' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText('Plan activated.')).toBeInTheDocument();
  });

  it('offers Revise with AI when AI is on and starts a revise run', async () => {
    servePlan();
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post('*/api/ai/training/runs', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ data: { runId: RUN_ID, jobId: 'j', status: 'queued' } }, { status: 202 });
      }),
    );
    renderEditor();
    const box = await screen.findByLabelText('Ask the planner to change this');
    await userEvent.type(box, 'More back work');
    await userEvent.click(screen.getByRole('button', { name: 'Ask the planner' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/train/plans/runs/${RUN_ID}`));
    expect(body).toEqual({ kind: 'revise', programId: PROGRAM_ID, basedOnVersion: 2, instruction: 'More back work' });
  });

  it('disables Revise with AI while a run is active', async () => {
    servePlan();
    server.use(
      http.get('*/api/ai/training/runs', () =>
        HttpResponse.json({ data: { items: [{ id: RUN_ID, status: 'running' }], total: 1, page: 1, pageSize: 5, totalPages: 1 } }),
      ),
    );
    renderEditor();
    expect(await screen.findByText('A plan run is in progress.')).toBeInTheDocument();
    expect(screen.getByLabelText('Ask the planner to change this')).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Open the run' })).toHaveAttribute('href', `/train/plans/runs/${RUN_ID}`);
  });

  it('never shows AI actions with AI off or without ai:use', async () => {
    servePlan();
    const first = renderEditor({ aiEnabled: false });
    await screen.findByRole('button', { name: 'Edit' });
    expect(screen.queryByText('Revise with AI')).not.toBeInTheDocument();
    first.unmount();
    renderEditor({ permissions: user.permissions.filter((p) => p !== 'ai:use') });
    await screen.findByRole('button', { name: 'Edit' });
    expect(screen.queryByText('Revise with AI')).not.toBeInTheDocument();
  });

  it('has no axe violations in edit mode', async () => {
    servePlan();
    const { container } = renderEditor();
    await openEditor();
    expect(await axe(container)).toHaveNoViolations();
  });
});
