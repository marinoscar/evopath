/**
 * "Last time" (E4.4): the line in the display unit (weights shared by
 * consecutive sets, warm-ups counted not listed, time and distance modes),
 * "First time logging this exercise", the Copy sets plan, and Copy sets end
 * to end against the stateful MSW workouts API (values pre-filled, nothing
 * marked done).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../../utils/test-utils';
import {
  ExerciseLastTime,
  FIRST_TIME_TEXT,
  LastTimeLine,
  formatLastTimeSets,
  planCopy,
} from '../../../components/train/LastTimeLine';
import { clearExerciseHistoryCache } from '../../../hooks/useExerciseHistory';
import type { ExerciseHistory, LastTimeSet } from '../../../services/exercises';
import { MAX_SETS_PER_EXERCISE, addSet, updateSet } from '../../../services/workouts';
import { mockExercise } from '../../mocks/fixtures/exercises';
import { mockEntry, mockSet, mockWorkout, statefulWorkoutsApi } from '../../mocks/fixtures/workouts';

const GYM = { id: '00000000-0000-4000-8000-a00000000001', name: 'Home Gym' };
const bench = mockExercise({ name: 'Dumbbell bench press', slug: 'dumbbell_bench_press' });

function lt(overrides: Partial<LastTimeSet> = {}): LastTimeSet {
  return {
    setNumber: 1,
    weightKg: null,
    reps: null,
    durationSeconds: null,
    distanceMeters: null,
    rpe: null,
    isWarmup: false,
    ...overrides,
  };
}

function history(overrides: Partial<ExerciseHistory> = {}): ExerciseHistory {
  return {
    exerciseId: bench.id,
    lastTime: null,
    recent: [],
    records: { maxWeightKg: null, maxReps: null, bestE1rmKg: null },
    ...overrides,
  };
}

beforeEach(() => clearExerciseHistoryCache());

describe('formatLastTimeSets', () => {
  it('writes the weight once per run of equal weights, in lb', () => {
    const sets = [lt({ weightKg: 31.751, reps: 10 }), lt({ weightKg: 31.751, reps: 10 }), lt({ weightKg: 31.751, reps: 9 })];
    expect(formatLastTimeSets(sets, 'weight_reps', 'lb')).toBe('70.0 lb × 10, 10, 9');
  });

  it('writes a changed weight again, and counts warm-ups', () => {
    const sets = [
      lt({ weightKg: 20, reps: 10, isWarmup: true }),
      lt({ weightKg: 60, reps: 10 }),
      lt({ weightKg: 62.5, reps: 8 }),
    ];
    expect(formatLastTimeSets(sets, 'weight_reps', 'kg')).toBe('60 kg × 10, 62.5 kg × 8 (+1 warm-up)');
  });

  it('bodyweight reps without and with added weight', () => {
    expect(formatLastTimeSets([lt({ reps: 10 }), lt({ reps: 8 })], 'bodyweight_reps', 'kg')).toBe('10, 8 reps');
    expect(formatLastTimeSets([lt({ weightKg: 10, reps: 6 })], 'bodyweight_reps', 'kg')).toBe('+10 kg × 6');
  });

  it('time and distance exercises show duration and distance', () => {
    expect(formatLastTimeSets([lt({ durationSeconds: 90 }), lt({ durationSeconds: 60 })], 'time', 'kg')).toBe(
      '1:30, 1:00',
    );
    expect(
      formatLastTimeSets([lt({ distanceMeters: 5000, durationSeconds: 1500 })], 'distance_time', 'kg'),
    ).toBe('5 km in 25:00');
  });
});

describe('planCopy', () => {
  const last = [lt({ weightKg: 60, reps: 10 }), lt({ weightKg: 60, reps: 8 }), lt({ weightKg: 20, reps: 5, isWarmup: true })];

  it('fills an empty row in place and adds the rest, not done', () => {
    const empty = mockSet();
    const plan = planCopy([empty], last);
    expect(plan.updates).toEqual([
      { setId: empty.id, input: { weightKg: 60, reps: 10, durationSeconds: null, distanceMeters: null, isWarmup: false } },
    ]);
    expect(plan.adds).toHaveLength(2);
    expect(plan.adds[1]).toMatchObject({ weightKg: 20, reps: 5, isWarmup: true, completed: false });
  });

  it('keeps rows the user typed into or completed', () => {
    const plan = planCopy([mockSet({ reps: 5 }), mockSet({ completed: true })], last);
    expect(plan.updates).toEqual([]);
    expect(plan.adds).toHaveLength(1);
  });

  it('stops at the per-exercise set limit', () => {
    const full = Array.from({ length: MAX_SETS_PER_EXERCISE }, () => mockSet({ reps: 1 }));
    expect(planCopy(full, last)).toEqual({ updates: [], adds: [] });
  });
});

describe('LastTimeLine', () => {
  it('says so the first time', () => {
    render(<LastTimeLine history={history()} trackingMode="weight_reps" unit="kg" exerciseName="Bench" />);
    expect(screen.getByText(FIRST_TIME_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull();
  });

  it('shows the day, the gym, the sets and the best estimated 1RM', () => {
    render(
      <LastTimeLine
        history={history({
          lastTime: {
            workoutId: 'w1',
            date: '2026-09-28',
            gym: GYM,
            sets: [lt({ weightKg: 31.751, reps: 10 }), lt({ weightKg: 31.751, reps: 9 })],
          },
          records: {
            maxWeightKg: null,
            maxReps: null,
            bestE1rmKg: { value: 42.3, weightKg: 31.751, reps: 10, date: '2026-09-28' },
          },
        })}
        trackingMode="weight_reps"
        unit="lb"
        today="2026-09-29"
        exerciseName="Bench"
        onCopy={vi.fn()}
      />,
    );
    expect(screen.getByTestId('last-time')).toHaveTextContent(
      'Last time (Yesterday, Home Gym): 70.0 lb × 10, 9Best est. 1RM 93.3 lb',
    );
    expect(screen.getByRole('button', { name: "Copy last time's sets into Bench" })).toBeInTheDocument();
  });

  it('offers Retry when the history cannot be read', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <LastTimeLine history={null} error="boom" onRetry={onRetry} trackingMode="weight_reps" unit="kg" exerciseName="Bench" />,
    );
    await user.click(screen.getByRole('button', { name: 'Retry loading last time for Bench' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('ExerciseLastTime Copy sets', () => {
  function seeded() {
    const previous = mockWorkout({
      name: 'Last week',
      status: 'completed',
      date: '2026-09-22',
      startedAt: '2026-09-22T12:00:00.000Z',
      gym: GYM,
      exercises: [
        mockEntry(bench, {
          sets: [
            mockSet({ weightKg: 31.751, reps: 10, completed: true }),
            mockSet({ weightKg: 31.751, reps: 10, completed: true }),
            mockSet({ weightKg: 31.751, reps: 9, completed: true }),
          ],
        }),
      ],
    });
    const current = mockWorkout({ gym: GYM, exercises: [mockEntry(bench, { sets: [mockSet()] })] });
    const api = statefulWorkoutsApi([previous, current], { exercises: [bench], gyms: [GYM] });
    return { api, current };
  }

  it('pre-fills the empty row and adds the others with last time\'s values, not done', async () => {
    const { api, current } = seeded();
    const entry = current.exercises[0];
    const onSaveSet = vi.fn((setId: string, input: Parameters<typeof updateSet>[2]) => updateSet(current.id, setId, input));
    const onAddSet = vi.fn((weId: string, input?: Parameters<typeof addSet>[2]) => addSet(current.id, weId, input));
    const user = userEvent.setup();
    render(
      <ExerciseLastTime entry={entry} workout={current} unit="lb" canWrite onAddSet={onAddSet} onSaveSet={onSaveSet} />,
    );

    expect(await screen.findByTestId('last-time')).toHaveTextContent('Last time (Tue, Sep 22, Home Gym): 70.0 lb × 10, 10, 9');
    expect(api.historyCalls[0].query).toContain(`workoutId=${current.id}`);

    await user.click(screen.getByRole('button', { name: "Copy last time's sets into Dumbbell bench press" }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Copied 3 sets from last time. Not marked done.'));

    expect(onSaveSet).toHaveBeenCalledWith(entry.sets[0].id, expect.objectContaining({ weightKg: 31.751, reps: 10 }));
    expect(onAddSet).toHaveBeenCalledTimes(2);
    const posts = api.calls.filter((c) => c.method === 'POST').map((c) => c.body);
    expect(posts).toEqual([
      expect.objectContaining({ weightKg: 31.751, reps: 10, completed: false }),
      expect.objectContaining({ weightKg: 31.751, reps: 9, completed: false }),
    ]);
    const stored = api.workouts.find((w) => w.id === current.id)!.exercises[0].sets;
    expect(stored.map((s) => [s.weightKg, s.reps, s.completed])).toEqual([
      [31.751, 10, false],
      [31.751, 10, false],
      [31.751, 9, false],
    ]);
  });

  it('is not offered on a completed workout or without workouts:write', async () => {
    const { current } = seeded();
    const props = { entry: current.exercises[0], unit: 'kg' as const, onAddSet: vi.fn(), onSaveSet: vi.fn() };
    const { unmount } = render(<ExerciseLastTime {...props} workout={current} canWrite={false} />);
    expect(await screen.findByTestId('last-time')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy last time/ })).toBeNull();
    unmount();
    render(<ExerciseLastTime {...props} workout={{ ...current, status: 'completed' }} canWrite />);
    expect(await screen.findByTestId('last-time')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy last time/ })).toBeNull();
  });
});
