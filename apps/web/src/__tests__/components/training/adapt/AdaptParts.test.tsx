/**
 * E6.1 building blocks: the chips (toggle buttons with names, suggestions
 * never auto-selected), the request mapping, the role model banner's states
 * and fix links, and the "What will be sent" summary.
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, within, mockAdminUser } from '../../../utils/test-utils';
import { AdaptChips } from '../../../../components/training/adapt/AdaptChips';
import { RoleModelBanner } from '../../../../components/training/adapt/RoleModelBanner';
import { SentDataSummary } from '../../../../components/training/adapt/SentDataSummary';
import {
  buildRequest,
  draftFromRequest,
  EMPTY_DRAFT,
  type AdaptDraft,
} from '../../../../components/training/adapt/adaptDraft';
import { adaptationRequestProblem, NOTHING_TO_CHANGE_MESSAGE } from '../../../../services/trainingAdaptation';
import { mockPreview, roleModel } from '../../../mocks/fixtures/adaptations';

function Chips({ onDraft, suggestions }: { onDraft?: (d: AdaptDraft) => void; suggestions?: { sore?: string; lowEnergy?: string } }) {
  const [draft, setDraft] = useState<AdaptDraft>(EMPTY_DRAFT);
  return (
    <AdaptChips
      draft={draft}
      onChange={(patch) => {
        const next = { ...draft, ...patch };
        setDraft(next);
        onDraft?.(next);
      }}
      equipmentOptions={[
        { id: 'db', name: 'Dumbbells' },
        { id: 'bench', name: 'Adjustable bench' },
      ]}
      suggestions={suggestions}
    />
  );
}

describe('AdaptChips', () => {
  it('renders every chip as a named toggle button', async () => {
    const onDraft = vi.fn();
    const user = userEvent.setup();
    render(<Chips onDraft={onDraft} />);
    const thirty = screen.getByRole('button', { name: '30 minutes' });
    expect(thirty).toHaveAttribute('aria-pressed', 'false');
    await user.click(thirty);
    expect(screen.getByRole('button', { name: '30 minutes' })).toHaveAttribute('aria-pressed', 'true');
    expect(onDraft).toHaveBeenLastCalledWith(expect.objectContaining({ minutes: 30 }));
    // Tapping again clears it.
    await user.click(screen.getByRole('button', { name: '30 minutes' }));
    expect(screen.getByRole('button', { name: '30 minutes' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the muscles and levels once Sore is on, and the gym equipment for Only these', async () => {
    const user = userEvent.setup();
    const onDraft = vi.fn();
    render(<Chips onDraft={onDraft} />);
    expect(screen.queryByRole('button', { name: 'Chest' })).toBeNull();
    await user.click(screen.getByRole('button', { name: "I'm sore" }));
    await user.click(screen.getByRole('button', { name: 'Chest' }));
    await user.click(screen.getByRole('button', { name: 'Moderate' }));
    expect(onDraft).toHaveBeenLastCalledWith(expect.objectContaining({ sore: true, soreMuscles: ['chest'], soreLevel: 'moderate' }));

    await user.click(screen.getByRole('button', { name: 'Only these' }));
    await user.click(screen.getByRole('button', { name: 'Dumbbells' }));
    expect(screen.getByRole('button', { name: 'Dumbbells' })).toHaveAttribute('aria-pressed', 'true');
    expect(onDraft).toHaveBeenLastCalledWith(expect.objectContaining({ equipment: 'only', equipmentTypeIds: ['db'] }));
  });

  it('shows check-in suggestions without selecting anything', () => {
    render(<Chips suggestions={{ sore: "Your check-in says you're sore (4/5).", lowEnergy: 'Your check-in says your energy is low (2/5).' }} />);
    expect(screen.getByTestId('adapt-sore-hint')).toHaveTextContent("you're sore (4/5)");
    expect(screen.getByTestId('adapt-energy-hint')).toHaveTextContent('energy is low');
    expect(screen.getByRole('button', { name: "I'm sore" })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Low energy' })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('adaptation request mapping', () => {
  it('asks for a change before anything can be sent', () => {
    expect(adaptationRequestProblem(buildRequest(EMPTY_DRAFT))).toBe(NOTHING_TO_CHANGE_MESSAGE);
    expect(adaptationRequestProblem(buildRequest({ ...EMPTY_DRAFT, freeText: '   ' }))).toBe(NOTHING_TO_CHANGE_MESSAGE);
    expect(adaptationRequestProblem(buildRequest({ ...EMPTY_DRAFT, minutes: 30 }))).toBeNull();
  });

  it('checks custom minutes, sore areas and the equipment subset', () => {
    expect(adaptationRequestProblem(buildRequest({ ...EMPTY_DRAFT, minutes: 'custom', customMinutes: '5' }))).toMatch(/10 to 240/);
    expect(adaptationRequestProblem(buildRequest({ ...EMPTY_DRAFT, sore: true }))).toBe('Choose where you are sore.');
    expect(adaptationRequestProblem(buildRequest({ ...EMPTY_DRAFT, equipment: 'only' }))).toBe('Choose the equipment you have.');
  });

  it('builds the request, sending the listed gym with an equipment subset', () => {
    const request = buildRequest(
      { ...EMPTY_DRAFT, minutes: 'custom', customMinutes: '35', sore: true, soreMuscles: ['chest'], equipment: 'only', equipmentTypeIds: ['db'], lowEnergy: true, freeText: '  tight hips ' },
      'gym-1',
    );
    expect(request).toEqual({
      useReadiness: true,
      minutes: 35,
      soreness: { muscles: ['chest'], level: 'mild' },
      lowEnergy: true,
      equipment: { mode: 'only', equipmentTypeIds: ['db'] },
      gymId: 'gym-1',
      freeText: 'tight hips',
    });
    expect(buildRequest({ ...EMPTY_DRAFT, equipment: 'bodyweight' }, 'gym-1')).toEqual({ useReadiness: true, equipment: { mode: 'bodyweight' } });
  });

  it('restores a draft from a stored request (Adjust again)', () => {
    const draft = draftFromRequest({ minutes: 35, lowEnergy: true, useReadiness: false });
    expect(draft).toMatchObject({ minutes: 'custom', customMinutes: '35', lowEnergy: true, useReadiness: false });
    expect(draftFromRequest({ minutes: 30 }).minutes).toBe(30);
  });
});

describe('RoleModelBanner', () => {
  it('shows both models when they can run', () => {
    render(<RoleModelBanner models={{ planner: roleModel('planner'), critic: roleModel('critic') }} />);
    expect(screen.getByTestId('role-model-banner')).toHaveTextContent('Planner: Frontier One · Critic: Frontier One');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('explains each blocking state with the link that fixes it', () => {
    render(
      <RoleModelBanner
        models={{
          planner: roleModel('planner', { state: 'no_key', runnable: false, model: null, fix: 'keys' }),
          critic: roleModel('critic', { state: 'missing_capability', runnable: false, model: null, fix: 'keys' }),
        }}
      />,
    );
    const planner = screen.getByTestId('role-problem-planner');
    expect(planner).toHaveTextContent('The planner agent needs an AI key.');
    expect(within(planner).getByRole('link', { name: 'Add a key' })).toHaveAttribute('href', '/settings/ai');
    const critic = screen.getByTestId('role-problem-critic');
    expect(critic).toHaveTextContent('needs a model with structured output');
    expect(within(critic).getByRole('link', { name: 'Add a key' })).toHaveAttribute('href', '/settings/ai');
  });

  it('never offers the user a model choice (#173)', () => {
    render(
      <RoleModelBanner
        models={{
          planner: roleModel('planner'),
          critic: roleModel('critic', { state: 'missing_capability', runnable: false, model: null, fix: 'admin' }),
        }}
      />,
    );
    const banner = screen.getByTestId('role-model-banner');
    expect(within(banner).queryByRole('link', { name: /change|choose/i })).toBeNull();
    expect(banner).not.toHaveTextContent(/choose a model|saved model/i);
    expect(screen.queryByRole('link', { name: /agents/i })).toBeNull();
  });

  it('says an administrator must assign a model, with no link for a user who cannot', () => {
    render(
      <RoleModelBanner
        models={{ planner: roleModel('planner', { state: 'no_models', runnable: false, model: null, fix: 'admin' }), critic: roleModel('critic') }}
      />,
    );
    const planner = screen.getByTestId('role-problem-planner');
    expect(planner).toHaveTextContent("Your administrator hasn't assigned or enabled one yet.");
    expect(within(planner).queryByRole('link')).toBeNull();
  });

  it('links an AI administrator to the assignments page', () => {
    render(
      <RoleModelBanner
        models={{
          planner: roleModel('planner'),
          critic: roleModel('critic', { state: 'missing_capability', runnable: false, model: null, fix: 'admin' }),
        }}
      />,
      { wrapperOptions: { user: mockAdminUser } },
    );
    const critic = screen.getByTestId('role-problem-critic');
    expect(critic).toHaveTextContent("Your administrator hasn't assigned one yet.");
    expect(within(critic).getByRole('link', { name: 'Assign a model' })).toHaveAttribute(
      'href',
      '/admin/settings/ai/assignments',
    );
  });

  it('shows a placeholder while loading', () => {
    render(<RoleModelBanner models={null} />);
    expect(screen.getByTestId('role-model-banner-loading')).toBeInTheDocument();
  });
});

describe('SentDataSummary', () => {
  it('lists the sections and what is never sent when expanded', async () => {
    const user = userEvent.setup();
    render(<SentDataSummary sentData={mockPreview().sentData} />);
    await user.click(screen.getByRole('button', { name: 'What will be sent' }));
    expect(screen.getByText("Today's planned exercises (2)")).toBeInTheDocument();
    expect(screen.getByText('Barbell bench press, Barbell row')).toBeInTheDocument();
    expect(screen.getByText('Never sent: Your name, Gym name.')).toBeInTheDocument();
  });

  it('asks for a change while there is nothing to preview', () => {
    render(<SentDataSummary sentData={null} defaultExpanded />);
    expect(screen.getByText('Choose what to change to see what will be sent.')).toBeInTheDocument();
  });
});
