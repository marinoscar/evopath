/**
 * `WeeklyReviewCard` (E7.13, #253): the version-1 weekly review renders every
 * section, the no-plan variant, the streak-change labels, Plan my week, and
 * the runtime guard that sends anything else to the defensive rendering.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render } from '../../utils/test-utils';
import {
  WeeklyReviewCard,
  WEEKLY_STREAK_CHANGE_LABELS,
  NO_PLAN_LABEL,
} from '../../../components/coach/WeeklyReviewCard';
import { CoachMessageBubble } from '../../../components/coach/CoachMessageBubble';
import { parseWeeklyReviewData, WEEKLY_STREAK_CHANGES, type WeeklyReviewData } from '../../../services/coach';
import {
  mockCoachPersona,
  mockWeeklyReviewData,
  mockWeeklyReviewMessage,
  WEEKLY_REVIEW_PLAN_PROMPT,
} from '../../mocks/fixtures/coach';

const persona = mockCoachPersona();

function review(overrides: Parameters<typeof mockWeeklyReviewData>[0] = {}): WeeklyReviewData {
  const parsed = parseWeeklyReviewData(mockWeeklyReviewData(overrides));
  if (!parsed) throw new Error('fixture failed the guard');
  return parsed;
}

describe('WeeklyReviewCard', () => {
  it('renders the headline, intro, stat tiles, PRs, wins, focus and next week', () => {
    render(<WeeklyReviewCard review={review()} onPlanWeek={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Three of four, and a squat PR' })).toBeInTheDocument();
    expect(screen.getByText('Strong week. You showed up three times and the squat moved.')).toBeInTheDocument();

    expect(screen.getByTestId('coach-review-sessions')).toHaveTextContent('3 of 4');
    expect(screen.getByTestId('coach-review-sessions')).toHaveTextContent('1 missed');
    expect(screen.getByTestId('coach-review-adherence')).toHaveTextContent('75%');
    const streak = screen.getByTestId('coach-review-streak');
    expect(streak).toHaveTextContent('5 weeks');
    expect(streak).toHaveTextContent('Streak +1');
    expect(streak).toHaveTextContent('1 pass left');
    expect(screen.getByTestId('coach-review-checkins')).toHaveTextContent('3');
    expect(screen.getByTestId('coach-review-photos')).toHaveTextContent('1');

    const prs = screen.getByRole('region', { name: 'Personal records' });
    expect(within(prs).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Back squat: 120 kg × 5',
      'Pull-up: 12 reps',
    ]);
    const wins = screen.getByRole('region', { name: 'Wins' });
    expect(within(wins).getAllByRole('listitem')).toHaveLength(2);
    expect(within(screen.getByRole('region', { name: 'Focus' })).getByText(/Protect Thursday/)).toBeInTheDocument();

    const next = screen.getByRole('region', { name: 'Next week' });
    const items = within(next).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Mon: Upper body A',
      'Tue: Lower body A',
      'Thu: Upper body B',
      'Sat: Lower body B',
    ]);
    expect(next.querySelector('time')).toHaveAttribute('dateTime', '2026-10-05');
  });

  it('says "No plan this week" instead of a percentage when nothing was planned', () => {
    render(
      <WeeklyReviewCard
        review={review({
          stats: { planned: 0, completed: 1, missed: 0, adherencePct: null, noPlan: true, nextWeek: [], nextWeekSessions: 0, prs: [] },
          prose: { wins: [] },
        })}
      />,
    );
    expect(screen.getByTestId('coach-review-adherence')).toHaveTextContent(NO_PLAN_LABEL);
    expect(screen.getByTestId('coach-review-adherence')).not.toHaveTextContent('%');
    expect(screen.getByTestId('coach-review-sessions')).toHaveTextContent('1');
    expect(screen.getByTestId('coach-review-sessions')).not.toHaveTextContent('of');
    expect(screen.queryByRole('region', { name: 'Personal records' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Wins' })).not.toBeInTheDocument();
    expect(screen.getByText('No sessions planned yet.')).toBeInTheDocument();
  });

  it.each(WEEKLY_STREAK_CHANGES.map((c) => [c, WEEKLY_STREAK_CHANGE_LABELS[c]]))(
    'labels streak change %s as "%s"',
    (streakChange, label) => {
      render(<WeeklyReviewCard review={review({ stats: { streakChange, streakPassesLeft: 2 } })} />);
      expect(screen.getByTestId('coach-review-streak')).toHaveTextContent(label);
      expect(screen.getByTestId('coach-review-streak')).toHaveTextContent('2 passes left');
    },
  );

  it('maps every streak change to the agreed text', () => {
    expect(WEEKLY_STREAK_CHANGE_LABELS).toEqual({
      advanced: 'Streak +1',
      pass_used: 'Pass used — streak safe',
      reset: 'Fresh start',
      held: 'Streak held',
    });
  });

  it('Plan my week hands the prompt over, and is absent without a handler or a prompt', async () => {
    const user = userEvent.setup();
    const onPlanWeek = vi.fn();
    const { rerender } = render(<WeeklyReviewCard review={review()} onPlanWeek={onPlanWeek} />);
    await user.click(screen.getByRole('button', { name: 'Plan my week' }));
    expect(onPlanWeek).toHaveBeenCalledWith(WEEKLY_REVIEW_PLAN_PROMPT);

    rerender(<WeeklyReviewCard review={review()} />);
    expect(screen.queryByRole('button', { name: 'Plan my week' })).not.toBeInTheDocument();
    rerender(<WeeklyReviewCard review={review({ prose: { nextWeekPlanPrompt: '  ' } })} onPlanWeek={onPlanWeek} />);
    expect(screen.queryByRole('button', { name: 'Plan my week' })).not.toBeInTheDocument();
  });

  it('shows "and N more" when next week has more sessions than listed', () => {
    render(<WeeklyReviewCard review={review({ stats: { nextWeekSessions: 6 } })} />);
    expect(screen.getByText('and 2 more')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<WeeklyReviewCard review={review()} onPlanWeek={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('parseWeeklyReviewData', () => {
  it('accepts the version-1 contract and ignores extra keys', () => {
    const data = { ...mockWeeklyReviewData(), extra: true };
    expect(parseWeeklyReviewData(data)?.prose.headline).toBe('Three of four, and a squat PR');
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['another version', { ...mockWeeklyReviewData(), version: 2 }],
    ['missing stats', { ...mockWeeklyReviewData(), stats: undefined }],
    ['a string count', mockWeeklyReviewData({ stats: { completed: '3' as unknown as number } })],
    ['an unknown streak change', mockWeeklyReviewData({ stats: { streakChange: 'boom' as never } })],
    ['a bad PR unit', mockWeeklyReviewData({ stats: { prs: [{ exercise: 'X', value: 1, unit: 'lb' as never, reps: null }] } })],
    ['wins not strings', mockWeeklyReviewData({ prose: { wins: [1] as unknown as string[] } })],
    ['the legacy loose shape', { headline: 'x', adherence: { done: 1, planned: 2 } }],
  ])('rejects %s', (_label, data) => {
    expect(parseWeeklyReviewData(data)).toBeNull();
  });
});

describe('CoachMessageBubble with a weekly review', () => {
  it('renders the card for version-1 data, with the headline once and the title in the article label', () => {
    const onPlanWeek = vi.fn();
    render(<CoachMessageBubble message={mockWeeklyReviewMessage()} persona={persona} onPlanWeek={onPlanWeek} />);
    expect(screen.getByRole('article', { name: /^Coach: Three of four, and a squat PR/ })).toBeInTheDocument();
    expect(screen.getByTestId('coach-weekly-review')).toBeInTheDocument();
    expect(screen.getAllByText('Three of four, and a squat PR')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Plan my week' })).toBeInTheDocument();
  });

  it('falls back to the defensive rendering for malformed data', () => {
    const message = mockWeeklyReviewMessage({
      message: { data: { version: 1, stats: { completed: 'lots' }, wins: ['Showed up'] } },
    });
    render(<CoachMessageBubble message={message} persona={persona} onPlanWeek={vi.fn()} />);
    expect(screen.queryByTestId('coach-weekly-review')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Plan my week' })).not.toBeInTheDocument();
    expect(screen.getByText('Showed up')).toBeInTheDocument();
    expect(screen.getByText('Strong week. You showed up three times and the squat moved.')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <CoachMessageBubble message={mockWeeklyReviewMessage()} persona={persona} onPlanWeek={vi.fn()} onFeedback={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
