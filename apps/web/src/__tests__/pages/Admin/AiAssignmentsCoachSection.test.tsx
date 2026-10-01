/**
 * The Coach section of `/admin/settings/ai/assignments` (E7.3, #243;
 * docs/specs/ai-coach.md §3.3): `coach.decision`, `coach.chat` and
 * `coach.voice`, each with a model picker limited to the models the API says
 * are eligible (the voice row: `audio_speech` models only).
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
const speechModel: AiEligibleModel = { provider: 'openai', modelId: 'gpt-4o-mini-tts', displayName: 'TTS mini', reasoningEfforts: [] };

function coachRow(
  featureId: 'coach.decision' | 'coach.chat' | 'coach.voice',
  label: string,
  needs: string[],
  eligible: AiEligibleModel[],
): AiAssignmentFeatureRow {
  return {
    featureId,
    label,
    group: 'coach',
    needs,
    inputModalities: [],
    providers: null,
    requiresWebSearch: false,
    defaultReasoningEffort: null,
    assignment: null,
    eligibleModels: eligible,
    warning: null,
  };
}

function view(): AiAssignmentsView {
  return {
    assignments: { default: null, features: { 'coach.decision': null, 'coach.chat': null, 'coach.voice': null } },
    default: { eligibleModels: [textModel], warning: null },
    features: [
      coachRow('coach.decision', 'Coach decisions and weekly review', ['responses', 'structured_output'], [textModel]),
      coachRow('coach.chat', 'Coach chat', ['responses', 'tools', 'streaming'], [textModel]),
      coachRow('coach.voice', 'Coach voice', ['audio_speech'], [speechModel]),
    ],
    version: 3,
    updatedAt: null,
    updatedBy: null,
  };
}

function serve() {
  const puts: unknown[] = [];
  server.use(
    http.get(`${API}/admin/ai/assignments`, () => HttpResponse.json({ data: view() })),
    http.put(`${API}/admin/ai/assignments`, async ({ request }) => {
      puts.push(await request.json());
      return HttpResponse.json({ data: { ...view(), version: 4 } });
    }),
  );
  return puts;
}

async function renderPage(user = mockAdminUser) {
  const events = userEvent.setup();
  render(<AiAssignmentsPage />, { wrapperOptions: { user } });
  await screen.findByRole('heading', { level: 2, name: 'Coach' });
  return events;
}

describe('AiAssignmentsPage: Coach section (E7.3)', () => {
  it('lists the three coach features under a Coach heading', async () => {
    serve();
    await renderPage();
    const section = screen.getByRole('region', { name: 'Coach' });
    for (const label of ['Coach decisions and weekly review', 'Coach chat', 'Coach voice']) {
      expect(within(section).getByRole('heading', { level: 3, name: label })).toBeInTheDocument();
    }
    expect(within(screen.getByTestId('assignment-row-coach.voice')).getByText(/Needs/)).toBeInTheDocument();
  });

  it('offers the voice row only its eligible (speech) models', async () => {
    serve();
    const events = await renderPage();
    const voice = screen.getByTestId('assignment-row-coach.voice');
    await events.click(within(voice).getByRole('combobox', { name: 'Model' }));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByRole('option', { name: 'TTS mini (openai)' })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: 'GPT-5 mini (openai)' })).not.toBeInTheDocument();
  });

  it('saves a coach assignment in the full replace', async () => {
    const puts = serve();
    const events = await renderPage();
    const voice = screen.getByTestId('assignment-row-coach.voice');
    await events.click(within(voice).getByRole('combobox', { name: 'Model' }));
    await events.click(await screen.findByRole('option', { name: 'TTS mini (openai)' }));
    await events.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({
      features: {
        'coach.voice': { provider: 'openai', modelId: 'gpt-4o-mini-tts' },
        'coach.decision': null,
        'coach.chat': null,
      },
    });
  });

  it('disables the coach pickers without ai_config:write', async () => {
    serve();
    await renderPage({
      ...mockAdminUser,
      permissions: mockAdminUser.permissions.filter((permission) => permission !== 'ai_config:write'),
    });
    for (const id of ['coach.decision', 'coach.chat', 'coach.voice']) {
      expect(within(screen.getByTestId(`assignment-row-${id}`)).getByRole('combobox', { name: 'Model' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    }
  });
});
