/**
 * `PersonaGallery` (E7.3, #243): persona cards from the API, the active and
 * selected markers, sample lines per moment at the page's intensity, and the
 * locked adult level with its reason. Lines render as text, never HTML.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render } from '../../utils/test-utils';
import { PersonaGallery, fillPlaceholders, sampleLineAt } from '../../../components/coach/PersonaGallery';
import {
  UNCENSORED_SARGE_LINE,
  mockCoachPersona,
  mockCoachPersonas,
  mockSargePersona,
} from '../../mocks/fixtures/coach';
import { COACH_MOMENTS, PROFANITY_REASON_TEXT, type CoachRegister } from '../../../services/coach';

const LOCKED: CoachRegister = { profane: false, reason: 'persona_or_intensity' };

function renderGallery(props: Partial<Parameters<typeof PersonaGallery>[0]> = {}) {
  const onSelect = vi.fn();
  const result = render(
    <PersonaGallery
      personas={mockCoachPersonas()}
      selectedId="coach"
      activeId="coach"
      level={2}
      register={LOCKED}
      onSelect={onSelect}
      {...props}
    />,
  );
  return { onSelect, ...result };
}

describe('PersonaGallery', () => {
  it('renders a card per persona with name, tagline and vibe', () => {
    renderGallery();
    const sarge = screen.getByRole('region', { name: 'Sarge' });
    expect(within(sarge).getByText('Military cadence, no excuses.')).toBeInTheDocument();
    expect(within(sarge).getByText('Military cadence, no excuses')).toBeInTheDocument();
    expect(screen.getAllByRole('region')).toHaveLength(3);
  });

  it('marks the saved persona Active and a different chosen one as not saved', () => {
    renderGallery({ selectedId: 'stoic', activeId: 'coach' });
    expect(within(screen.getByRole('region', { name: 'Coach' })).getByText('Active')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'The Stoic' })).getByText('Selected, not saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'The Stoic selected' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Choose Coach' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls onSelect with the persona id', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderGallery();
    await user.click(screen.getByRole('button', { name: 'Choose Sarge' }));
    expect(onSelect).toHaveBeenCalledWith('drill_sergeant');
  });

  it('shows a line for every moment when expanded, at the given level', async () => {
    const user = userEvent.setup();
    renderGallery({ selectedId: 'drill_sergeant', level: 1 });
    const sarge = screen.getByRole('region', { name: 'Sarge' });
    const toggle = within(sarge).getByRole('button', { name: /Sample lines/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(within(sarge).getByRole('button', { name: /Hide sample lines/ })).toHaveAttribute('aria-expanded', 'true');
    expect(within(sarge).getAllByText('Recruit. Be at the bar tonight.')).toHaveLength(COACH_MOMENTS.length);
    // The activity-goal moments (#269) are labelled like the rest.
    expect(within(sarge).getByText('Goal at risk')).toBeInTheDocument();
    expect(within(sarge).getByText('Goal reached')).toBeInTheDocument();
  });

  it('skips a moment an older API sends no sample lines for', async () => {
    const user = userEvent.setup();
    const persona = mockCoachPersona();
    const { goal_at_risk: _risk, goal_hit: _hit, ...older } = persona.sampleLines;
    renderGallery({ personas: [{ ...persona, sampleLines: older as typeof persona.sampleLines }], selectedId: persona.id, level: 1 });
    const card = screen.getByRole('region', { name: persona.name });
    await user.click(within(card).getByRole('button', { name: /Sample lines/ }));
    expect(within(card).getByText('Streak at risk')).toBeInTheDocument();
    expect(within(card).queryByText('Goal at risk')).toBeNull();
  });

  it('shows the adult level locked with the reason, and the censored note instead of adult lines', async () => {
    const user = userEvent.setup();
    renderGallery({ selectedId: 'drill_sergeant', level: 3, register: { profane: false, reason: 'toggle_off' } });
    const sarge = screen.getByRole('region', { name: 'Sarge' });
    expect(within(sarge).getByText(/Unhinged · 18\+ · locked/)).toBeInTheDocument();
    expect(within(sarge).getByTestId('persona-drill_sergeant-lock-reason')).toHaveTextContent(
      PROFANITY_REASON_TEXT.toggle_off,
    );
    await user.click(within(sarge).getByRole('button', { name: /Sample lines/ }));
    expect(within(sarge).getByText(/Adult lines are hidden/)).toBeInTheDocument();
    expect(screen.queryByText(UNCENSORED_SARGE_LINE)).not.toBeInTheDocument();
  });

  it('shows the adult level unlocked when the register is profane', () => {
    renderGallery({
      personas: [mockSargePersona(false)],
      selectedId: 'drill_sergeant',
      activeId: 'drill_sergeant',
      level: 3,
      register: { profane: true, reason: null },
    });
    expect(screen.getByText('Unhinged · 18+')).toBeInTheDocument();
    expect(screen.queryByTestId('persona-drill_sergeant-lock-reason')).not.toBeInTheDocument();
  });

  it('renders a line containing markup as text', async () => {
    const user = userEvent.setup();
    const persona = mockCoachPersona({
      sampleLines: Object.fromEntries(
        COACH_MOMENTS.map((moment) => [moment, { 1: '<img src=x onerror=alert(1)>', 2: '<b>bold</b>', 3: 'x' }]),
      ) as ReturnType<typeof mockCoachPersona>['sampleLines'],
    });
    const { container } = renderGallery({ personas: [persona] });
    await user.click(screen.getByRole('button', { name: /Sample lines/ }));
    expect(screen.getAllByText('<b>bold</b>').length).toBeGreaterThan(0);
    expect(container.querySelector('b')).toBeNull();
  });

  it('fills placeholders and falls back to a lower level', () => {
    expect(fillPlaceholders('{streak} weeks at {time}: {lift} x{n}')).toBe('4 weeks at 18:30: Squat x3');
    const persona = mockCoachPersona({
      sampleLines: Object.fromEntries(COACH_MOMENTS.map((m) => [m, { 1: 'one' }])) as ReturnType<
        typeof mockCoachPersona
      >['sampleLines'],
    });
    expect(sampleLineAt(persona, 'pr', 3)).toBe('one');
  });

  it('has no axe violations', async () => {
    const { container } = renderGallery();
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
