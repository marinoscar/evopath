/**
 * `WorkoutSummaryDialog` / `PrSummaryList` (E4.4): the workout's PRs grouped
 * by exercise in the user's unit, first-time exercises listed apart, and
 * nothing when there are none.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '../../utils/test-utils';
import { PrSummaryList, WorkoutSummaryDialog } from '../../../components/train/WorkoutSummaryDialog';
import type { WorkoutPrSummary } from '../../../services/workouts';
import { mockWorkout } from '../../mocks/fixtures/workouts';

const base = {
  exerciseId: 'ex-bench',
  exerciseName: 'Dumbbell bench press',
  workoutExerciseId: 'we-bench',
  setId: 's',
};
const PRS: WorkoutPrSummary[] = [
  { ...base, setNumber: 2, type: 'weight', value: 67.5, previous: 65 },
  { ...base, setNumber: 1, type: 'reps', value: 7, previous: 6 },
  { ...base, setNumber: 1, type: 'e1rm', value: 80.2, previous: 80 },
  {
    exerciseId: 'ex-curl',
    exerciseName: 'Dumbbell curl',
    workoutExerciseId: 'we-curl',
    setId: 's2',
    setNumber: 1,
    type: 'first_time',
    value: 10,
    previous: null,
  },
];

describe('WorkoutSummaryDialog PRs', () => {
  it('lists the PRs of the workout with set numbers and previous bests', () => {
    const workout = mockWorkout({ status: 'completed', durationSeconds: 3600 });
    render(
      <WorkoutSummaryDialog
        open
        workout={{ ...workout, summary: { ...workout.summary, prs: PRS } }}
        unit="kg"
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Workout finished' });
    const section = within(dialog).getByRole('region', { name: 'Personal records' });
    const items = within(section).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Weight PR 67.5 kg (set 2). Previous best 65 kg.',
      'Rep PR 7 reps (set 1). Previous best 6 reps at this weight or heavier.',
      'Est. 1RM PR 80.2 kg (set 1). Previous best est. 1RM 80 kg.',
    ]);
    expect(section).toHaveTextContent('Dumbbell bench press');
    expect(section).toHaveTextContent('First time logged: Dumbbell curl');
  });

  it('shows pounds for an imperial user', () => {
    render(<PrSummaryList prs={[{ ...PRS[0], value: 34.019, previous: 31.751 }]} unit="lb" headingId="h" />);
    expect(screen.getByRole('listitem')).toHaveTextContent('Weight PR 75.0 lb (set 2). Previous best 70.0 lb.');
  });

  it('says so when only first-time entries exist, and renders nothing without PRs', () => {
    const { unmount } = render(<PrSummaryList prs={[PRS[3]]} unit="kg" headingId="h" />);
    expect(screen.getByText('No new records this time.')).toBeInTheDocument();
    unmount();
    const { container } = render(<PrSummaryList prs={[]} unit="kg" headingId="h" />);
    expect(container).toBeEmptyDOMElement();
  });
});
