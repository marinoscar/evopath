/**
 * The Memory section of `/admin/settings/ai/assignments` (#325):
 * `memory.extract`, the feature in the API's `memory` group.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, mockAdminUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import AiAssignmentsPage from '../../../pages/Admin/AiAssignmentsPage';
import type { AiAssignmentFeatureRow, AiAssignmentsView, AiEligibleModel } from '../../../services/aiAssignments';

const API = '*/api';

const textModel: AiEligibleModel = { provider: 'openai', modelId: 'gpt-5-mini', displayName: 'GPT-5 mini', reasoningEfforts: [] };

const memoryRow: AiAssignmentFeatureRow = {
  featureId: 'memory.extract',
  label: 'Memory extraction',
  group: 'memory',
  needs: ['responses', 'structured_output'],
  inputModalities: [],
  providers: null,
  requiresWebSearch: false,
  defaultReasoningEffort: null,
  assignment: null,
  eligibleModels: [textModel],
  warning: null,
};

function view(features: AiAssignmentFeatureRow[] = [memoryRow]): AiAssignmentsView {
  return {
    assignments: { default: null, features: Object.fromEntries(features.map((row) => [row.featureId, null])) },
    default: { eligibleModels: [textModel], warning: null },
    features,
    version: 3,
    updatedAt: null,
    updatedBy: null,
  };
}

function serve(current = view()) {
  const puts: unknown[] = [];
  server.use(
    http.get(`${API}/admin/ai/assignments`, () => HttpResponse.json({ data: current })),
    http.put(`${API}/admin/ai/assignments`, async ({ request }) => {
      puts.push(await request.json());
      return HttpResponse.json({ data: { ...current, version: 4 } });
    }),
  );
  return puts;
}

describe('AiAssignmentsPage: Memory section (#325)', () => {
  it('lists memory.extract under a Memory heading and saves it in the full replace', async () => {
    const puts = serve();
    const user = userEvent.setup();
    render(<AiAssignmentsPage />, { wrapperOptions: { user: mockAdminUser } });
    const section = await screen.findByRole('region', { name: 'Memory' });
    expect(within(section).getByRole('heading', { level: 3, name: 'Memory extraction' })).toBeInTheDocument();

    const row = screen.getByTestId('assignment-row-memory.extract');
    await user.click(within(row).getByRole('combobox', { name: 'Model' }));
    await user.click(await screen.findByRole('option', { name: 'GPT-5 mini (openai)' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ features: { 'memory.extract': { provider: 'openai', modelId: 'gpt-5-mini' } } });
  });

  it('disables the memory picker without ai_config:write', async () => {
    serve();
    render(<AiAssignmentsPage />, {
      wrapperOptions: {
        user: { ...mockAdminUser, permissions: mockAdminUser.permissions.filter((p) => p !== 'ai_config:write') },
      },
    });
    await screen.findByRole('region', { name: 'Memory' });
    expect(
      within(screen.getByTestId('assignment-row-memory.extract')).getByRole('combobox', { name: 'Model' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('renders no Memory section when the API lists no memory feature', async () => {
    serve(view([{ ...memoryRow, featureId: 'coach.chat', label: 'Coach chat', group: 'coach' }]));
    render(<AiAssignmentsPage />, { wrapperOptions: { user: mockAdminUser } });
    await screen.findByRole('region', { name: 'Coach' });
    expect(screen.queryByRole('region', { name: 'Memory' })).not.toBeInTheDocument();
  });
});
