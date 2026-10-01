/**
 * The logger and a planned time or distance exercise (#263): the plan's
 * target is found through the active plan (`usePlannedTargets`, against
 * MSW), pre-fills an uncompleted set's empty fields (saved with the set on
 * completion), and the card shows progress toward it.
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { renderHook } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { SetRow } from '../../../components/train/SetRow';
import { PlannedTargetProgress, cardioProgress } from '../../../components/train/PlannedTargetProgress';
import { targetsFromTree, usePlannedTargets } from '../../../hooks/usePlannedTargets';
import type { SetInput, SetLogView } from '../../../services/workouts';
import type { TrackingMode } from '../../../services/exercises';
import { mockEntry, mockSet, mockWorkout } from '../../mocks/fixtures/workouts';
import { mockExercise } from '../../mocks/fixtures/exercises';
import { mockProgram, mockProgramListItem, planExercise, PROGRAM_ID } from '../../mocks/fixtures/programs';

type SaveFn = (id: string, input: SetInput) => Promise<SetLogView>;

const RUN_TARGET = { durationSeconds: 1800, distanceMeters: 5000 };

function Row({
  initial,
  mode = 'distance_time',
  target = RUN_TARGET,
  onSave,
}: {
  initial: SetLogView;
  mode?: TrackingMode;
  target?: { durationSeconds: number | null; distanceMeters: number | null } | null;
  onSave: SaveFn;
}) {
  const [set, setSet] = useState(initial);
  return (
    <SetRow
      set={set}
      trackingMode={mode}
      unit="kg"
      canWrite
      target={target}
      onSave={async (id, input) => {
        const saved = await onSave(id, input);
        setSet(saved);
        return saved;
      }}
      onDelete={vi.fn()}
    />
  );
}

function saveFrom(initial: SetLogView) {
  let current = initial;
  return vi.fn<SaveFn>(async (_id, input) => {
    const { completed, ...rest } = input;
    current = { ...current, ...rest, ...(completed !== undefined ? { completed } : {}) };
    return current;
  });
}

describe('SetRow target pre-fill', () => {
  it('fills empty distance and time with the target and saves them on completion', async () => {
    const user = userEvent.setup();
    const set = mockSet();
    const onSave = saveFrom(set);
    render(<Row initial={set} onSave={onSave} />);
    expect(screen.getByRole('textbox', { name: 'Set 1 distance in km' })).toHaveValue('5');
    expect(screen.getByRole('textbox', { name: 'Set 1 time (minutes:seconds)' })).toHaveValue('30:00');
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Complete set 1' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(set.id, { distanceMeters: 5000, durationSeconds: 1800, completed: true }),
    );
  });

  it('keeps a logged value and only fills the empty field', () => {
    const set = mockSet({ durationSeconds: 1200 });
    render(<Row initial={set} onSave={saveFrom(set)} />);
    expect(screen.getByRole('textbox', { name: 'Set 1 time (minutes:seconds)' })).toHaveValue('20:00');
    expect(screen.getByRole('textbox', { name: 'Set 1 distance in km' })).toHaveValue('5');
  });

  it('leaves a completed set alone, and a time exercise gets only the time', () => {
    const done = mockSet({ completed: true });
    const { unmount } = render(<Row initial={done} onSave={saveFrom(done)} />);
    expect(screen.getByRole('textbox', { name: 'Set 1 distance in km' })).toHaveValue('');
    unmount();
    const set = mockSet();
    render(<Row initial={set} mode="time" target={{ durationSeconds: 600, distanceMeters: null }} onSave={saveFrom(set)} />);
    expect(screen.getByRole('textbox', { name: 'Set 1 time (minutes:seconds)' })).toHaveValue('10:00');
  });

  it('does not refill a field the user cleared', async () => {
    const user = userEvent.setup();
    const set = mockSet();
    render(<Row initial={set} onSave={saveFrom(set)} />);
    const distance = screen.getByRole('textbox', { name: 'Set 1 distance in km' });
    await user.clear(distance);
    expect(distance).toHaveValue('');
  });
});

describe('PlannedTargetProgress', () => {
  it('sums completed working sets against the target; the better metric counts', () => {
    const sets = [
      mockSet({ completed: true, distanceMeters: 2500, durationSeconds: 900 }),
      mockSet({ completed: true, isWarmup: true, distanceMeters: 1000, durationSeconds: 300 }),
      mockSet({ completed: false, distanceMeters: 2500, durationSeconds: 900 }),
    ];
    expect(cardioProgress({ ...RUN_TARGET, sets: null }, sets)).toMatchObject({
      loggedMeters: 2500,
      loggedSeconds: 900,
      percent: 50,
    });
    const fast = [mockSet({ completed: true, distanceMeters: 5000, durationSeconds: 1500 })];
    expect(cardioProgress({ ...RUN_TARGET, sets: null }, fast).percent).toBe(100);
    // Intervals: the target is the session total (the API's rule), not multiplied by the sets.
    expect(cardioProgress({ durationSeconds: null, distanceMeters: 1600, sets: 4 }, [mockSet({ completed: true, distanceMeters: 400 })]).percent).toBe(25);
    expect(cardioProgress({ durationSeconds: null, distanceMeters: 400, sets: 4 }, [mockSet({ completed: true, distanceMeters: 400 })]).percent).toBe(100);
  });

  it('shows the target, what was logged and the bar', () => {
    render(
      <PlannedTargetProgress
        target={{ ...RUN_TARGET, sets: null }}
        sets={[mockSet({ completed: true, distanceMeters: 2500, durationSeconds: 900 })]}
        unit="kg"
        exerciseName="Outdoor run"
      />,
    );
    expect(screen.getByText('Target: 5 km · 30 min')).toBeInTheDocument();
    expect(screen.getByText('2.5 km · 15:00 · 50%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Outdoor run progress toward the target' })).toHaveAttribute('aria-valuenow', '50');
  });
});

describe('usePlannedTargets', () => {
  const run = mockExercise({ name: 'Outdoor run', trackingMode: 'distance_time' });
  const program = mockProgram();
  const plannedWorkoutId = program.tree.blocks[0].weeks[0].workouts[0].id;
  program.tree.blocks[0].weeks[0].workouts[0].exercises.push(
    planExercise({
      id: 'pe-run',
      exerciseId: run.id,
      position: 2,
      targetSets: null,
      repMin: null,
      repMax: null,
      targetDurationSeconds: 1800,
      targetDistanceMeters: 5000,
      exercise: { id: run.id, name: 'Outdoor run', slug: run.slug, trackingMode: 'distance_time' },
    }),
  );

  function servePlans() {
    const calls: string[] = [];
    server.use(
      http.get('*/api/programs', ({ request }) => {
        calls.push(new URL(request.url).search);
        return HttpResponse.json({ data: [mockProgramListItem({ status: 'active' })] });
      }),
      http.get(`*/api/programs/${PROGRAM_ID}`, () => HttpResponse.json({ data: program })),
    );
    return calls;
  }

  it('reads the planned target of a linked workout with a cardio exercise', async () => {
    const calls = servePlans();
    const workout = mockWorkout({ programWorkoutId: plannedWorkoutId, exercises: [mockEntry(run)] });
    const { result } = renderHook(() => usePlannedTargets(workout));
    await waitFor(() => expect(result.current[run.id]).toEqual({ durationSeconds: 1800, distanceMeters: 5000, sets: null }));
    expect(calls).toEqual(['?status=active']);
  });

  it('asks nothing for an unplanned workout, a lift-only one, or without permission', async () => {
    const calls = servePlans();
    const bench = mockExercise({ name: 'Bench press' });
    renderHook(() => usePlannedTargets(mockWorkout({ exercises: [mockEntry(run)] })));
    renderHook(() => usePlannedTargets(mockWorkout({ programWorkoutId: plannedWorkoutId, exercises: [mockEntry(bench)] })));
    renderHook(() =>
      usePlannedTargets(mockWorkout({ programWorkoutId: plannedWorkoutId, exercises: [mockEntry(run)] }), { enabled: false }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
  });

  it('finds targets in a plan tree by planned workout id', () => {
    expect(targetsFromTree(program.tree, plannedWorkoutId)).toEqual({
      [run.id]: { durationSeconds: 1800, distanceMeters: 5000, sets: null },
    });
    expect(targetsFromTree(program.tree, 'nope')).toBeNull();
  });
});
