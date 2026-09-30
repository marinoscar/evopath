/**
 * `/admin/settings/ai/assignments` (#173): the administrator's model per AI
 * feature. Real hook, real permissions, MSW for the network.
 *
 *   1. Renders the organization default and one row per feature, grouped
 *      into Photo features and Training agents, each select limited to the
 *      feature's eligible models.
 *   2. Empty-state guidance links to AI Models when a feature has none.
 *   3. Save is a full replace with `If-Match: <version>`.
 *   4. A 400 `AI_ASSIGNMENT_INVALID` puts each refusal on its own row.
 *   5. A 409 offers a reload.
 *   6. Without `ai_config:write` every control is disabled.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, mockAdminUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { setViewportWidth } from '../../setup';
import AiAssignmentsPage from '../../../pages/Admin/AiAssignmentsPage';
import type { AiAssignmentsView, AiEligibleModel } from '../../../services/aiAssignments';

const API = '*/api';

const vision: AiEligibleModel = { provider: 'openai', modelId: 'eye-1', displayName: 'Eye One', reasoningEfforts: [] };
const thinker: AiEligibleModel = {
  provider: 'openai',
  modelId: 'think-1',
  displayName: 'Think One',
  reasoningEfforts: ['low', 'medium', 'high'],
};

function photoRow(featureId: 'gym_scan' | 'workout_prefill' | 'body_metric_reading', label: string, eligible: AiEligibleModel[]) {
  return {
    featureId,
    label,
    group: 'photo' as const,
    needs: ['vision_input', 'structured_output'],
    inputModalities: ['image'],
    providers: null,
    requiresWebSearch: false,
    defaultReasoningEffort: null,
    assignment: null,
    eligibleModels: eligible,
    warning: null,
  };
}

function trainingRow(role: 'researcher' | 'planner' | 'critic' | 'evaluator', label: string) {
  return {
    featureId: `training.${role}` as const,
    label,
    group: 'training' as const,
    needs: ['responses', 'structured_output'],
    inputModalities: [],
    providers: role === 'researcher' ? ['openai'] : null,
    requiresWebSearch: role === 'researcher',
    defaultReasoningEffort: 'medium' as const,
    assignment: null,
    eligibleModels: [thinker],
    warning: null,
  };
}

function view(overrides: Partial<AiAssignmentsView> = {}): AiAssignmentsView {
  return {
    assignments: {
      default: null,
      features: {
        gym_scan: null,
        workout_prefill: null,
        body_metric_reading: null,
        'training.researcher': null,
        'training.planner': null,
        'training.critic': null,
        'training.evaluator': null,
      },
    },
    default: { eligibleModels: [vision, thinker], warning: null },
    features: [
      photoRow('gym_scan', 'Gym equipment scan', [vision]),
      photoRow('workout_prefill', 'Workout prefill from a photo', [vision]),
      // The case that started #173: models exist, none enabled for this one.
      photoRow('body_metric_reading', 'Body metric photo reading', []),
      trainingRow('researcher', 'Training plan researcher'),
      trainingRow('planner', 'Training plan planner'),
      trainingRow('critic', 'Training plan critic'),
      trainingRow('evaluator', 'Training plan evaluator'),
    ],
    version: 7,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  };
}

interface Captured {
  body: unknown;
  ifMatch: string | null;
}

function serve(initial: AiAssignmentsView, onPut?: (captured: Captured) => Response | Promise<Response>) {
  const puts: Captured[] = [];
  let current = initial;
  server.use(
    http.get(`${API}/admin/ai/assignments`, () => HttpResponse.json({ data: current })),
    http.put(`${API}/admin/ai/assignments`, async ({ request }) => {
      const captured = { body: await request.json(), ifMatch: request.headers.get('If-Match') };
      puts.push(captured);
      if (onPut) return onPut(captured);
      current = { ...current, version: current.version + 1 };
      return HttpResponse.json({ data: current });
    }),
  );
  return {
    puts,
    set: (next: AiAssignmentsView) => {
      current = next;
    },
  };
}

async function renderPage(user = mockAdminUser) {
  const events = userEvent.setup();
  render(<AiAssignmentsPage />, { wrapperOptions: { user } });
  await screen.findByRole('heading', { level: 2, name: 'Organization default' });
  return events;
}

async function choose(events: ReturnType<typeof userEvent.setup>, rowTestId: string, label: string, option: string) {
  const row = rowTestId === 'default' ? screen.getByRole('region', { name: 'Organization default' }) : screen.getByTestId(rowTestId);
  await events.click(within(row).getByRole('combobox', { name: label }));
  await events.click(await screen.findByRole('option', { name: option }));
}

describe('AiAssignmentsPage', () => {
  beforeEach(() => {
    setViewportWidth(1280);
  });

  it('renders the default and one row per feature, grouped, with eligible models only', async () => {
    serve(view());
    const events = await renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'AI Model Assignments' })).toBeInTheDocument();
    const photo = screen.getByRole('region', { name: 'Photo features' });
    const training = screen.getByRole('region', { name: 'Training agents' });
    expect(within(photo).getByText('Gym equipment scan')).toBeInTheDocument();
    expect(within(training).getByText('Training plan critic')).toBeInTheDocument();
    expect(within(photo).getAllByText('Needs vision, structured output, image input.').length).toBe(3);

    // Photo rows: no effort select. Training rows: one.
    expect(within(screen.getByTestId('assignment-row-gym_scan')).queryByRole('combobox', { name: 'Reasoning effort' })).toBeNull();
    expect(
      within(screen.getByTestId('assignment-row-training.planner')).getByRole('combobox', { name: 'Reasoning effort' }),
    ).toBeInTheDocument();

    await events.click(within(screen.getByTestId('assignment-row-gym_scan')).getByRole('combobox', { name: 'Model' }));
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Not assigned — use organization default', 'Eye One (openai)']);
  });

  it('guides the administrator to AI Models when a feature has no eligible model', async () => {
    serve(view());
    await renderPage();

    const row = screen.getByTestId('assignment-row-body_metric_reading');
    expect(within(row).getByText(/No enabled model can serve this feature yet/)).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /enable models on AI Models/ })).toHaveAttribute(
      'href',
      '/admin/settings/ai/models',
    );
  });

  it('shows a stored assignment’s warning on its row', async () => {
    const base = view();
    serve(
      view({
        features: base.features.map((row) =>
          row.featureId === 'gym_scan'
            ? {
                ...row,
                assignment: { provider: 'openai', modelId: 'old-1' },
                warning: { code: 'AI_ASSIGNMENT_MODEL_DISABLED', message: 'old-1 is no longer enabled.' },
              }
            : row,
        ),
        assignments: { ...base.assignments, features: { ...base.assignments.features, gym_scan: { provider: 'openai', modelId: 'old-1' } } },
      }),
    );
    await renderPage();

    const row = screen.getByTestId('assignment-row-gym_scan');
    expect(within(row).getByText('old-1 is no longer enabled.')).toBeInTheDocument();
    expect(within(row).getByRole('combobox', { name: 'Model' })).toHaveTextContent('old-1 (openai) — no longer eligible');
  });

  it('saves a full replace with If-Match, including the training effort', async () => {
    const api = serve(view());
    const events = await renderPage();

    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    await choose(events, 'default', 'Default model', 'Think One (openai)');
    await choose(events, 'assignment-row-gym_scan', 'Model', 'Eye One (openai)');
    await choose(events, 'assignment-row-training.planner', 'Model', 'Think One (openai)');
    await choose(events, 'assignment-row-training.planner', 'Reasoning effort', 'high');

    await events.click(save);

    await waitFor(() => expect(api.puts).toHaveLength(1));
    expect(api.puts[0].ifMatch).toBe('7');
    expect(api.puts[0].body).toEqual({
      default: { provider: 'openai', modelId: 'think-1' },
      features: {
        gym_scan: { provider: 'openai', modelId: 'eye-1' },
        workout_prefill: null,
        body_metric_reading: null,
        'training.researcher': null,
        'training.planner': { provider: 'openai', modelId: 'think-1', reasoningEffort: 'high' },
        'training.critic': null,
        'training.evaluator': null,
      },
    });
    expect(await screen.findByText('AI model assignments saved')).toBeInTheDocument();
  });

  it('puts each refused assignment on its own row', async () => {
    serve(view(), () =>
      HttpResponse.json(
        {
          statusCode: 400,
          code: 'BAD_REQUEST',
          message: 'The model assignments were not saved',
          details: {
            reason: 'AI_ASSIGNMENT_INVALID',
            errors: [
              {
                field: 'features.gym_scan',
                provider: 'openai',
                modelId: 'eye-1',
                code: 'AI_ASSIGNMENT_MODEL_INCAPABLE',
                message: 'Eye One cannot read images.',
                missing: ['vision_input'],
              },
            ],
          },
        },
        { status: 400 },
      ),
    );
    const events = await renderPage();

    await choose(events, 'assignment-row-gym_scan', 'Model', 'Eye One (openai)');
    await events.click(screen.getByRole('button', { name: 'Save changes' }));

    const row = screen.getByTestId('assignment-row-gym_scan');
    expect(await within(row).findByText(/Eye One cannot read images\. Missing: vision_input\./)).toBeInTheDocument();
    expect(within(screen.getByTestId('assignment-row-workout_prefill')).queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Some assignments were refused/)).toBeInTheDocument();
  });

  it('offers a reload after a 409, and the reload brings in the current assignments', async () => {
    const api = serve(view(), () =>
      HttpResponse.json({ statusCode: 409, code: 'CONFLICT', message: 'Version conflict' }, { status: 409 }),
    );
    const events = await renderPage();

    await choose(events, 'assignment-row-gym_scan', 'Model', 'Eye One (openai)');
    await events.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Someone else changed these assignments')).toBeInTheDocument();
    const base = view();
    api.set(
      view({
        version: 8,
        assignments: { ...base.assignments, default: { provider: 'openai', modelId: 'eye-1' } },
      }),
    );
    await events.click(screen.getByRole('button', { name: 'Reload' }));

    await waitFor(() =>
      expect(within(screen.getByRole('region', { name: 'Organization default' })).getByRole('combobox', { name: 'Default model' })).toHaveTextContent(
        'Eye One (openai)',
      ),
    );
    expect(screen.queryByText('Someone else changed these assignments')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('assignment-row-gym_scan')).getByRole('combobox', { name: 'Model' })).not.toHaveTextContent('Eye One');
  });

  it('is read-only without ai_config:write', async () => {
    serve(view());
    await renderPage({
      ...mockAdminUser,
      permissions: mockAdminUser.permissions.filter((permission) => permission !== 'ai_config:write'),
    });

    expect(screen.getByTestId('ai-assignments-read-only-notice')).toBeInTheDocument();
    for (const combobox of screen.getAllByRole('combobox')) {
      expect(combobox).toHaveAttribute('aria-disabled', 'true');
    }
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('works at phone width', async () => {
    setViewportWidth(360);
    serve(view());
    await renderPage();
    expect(screen.getByRole('region', { name: 'Training agents' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });
});
