/**
 * The plan editor's prescription picker (#263): each exercise row edits the
 * fields its `trackingMode` takes. Lifts keep sets, reps, rest and load;
 * `time` edits minutes; `distance_time` edits a distance (km or mi) and/or
 * minutes. Plus the pure pieces: new rows shaped by mode, and the shape
 * checks mirroring the API contract.
 */
import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '../../utils/test-utils';
import { WeekEditor, minutesToSeconds } from '../../../components/training/WeekEditor';
import {
  addExercises,
  DEFAULT_CARDIO_SECONDS,
  distanceBoundsText,
  newExercise,
  planErrors,
  updateExercise,
  type TrackingModes,
} from '../../../components/training/planEdits';
import type { PlanExercise, PlanTree, PlanWeek } from '../../../services/programs';
import type { WeightUnit } from '../../../utils/units';

const MODES: TrackingModes = {
  'ex-bench': 'weight_reps',
  'ex-plank': 'time',
  'ex-run': 'distance_time',
};

const NAMES = { 'ex-bench': 'Bench press', 'ex-plank': 'Plank', 'ex-run': 'Outdoor run' };

function row(id: string, exerciseId: string, position: number): PlanExercise {
  return { ...newExercise(exerciseId, position, MODES[exerciseId]), id };
}

function treeOf(exercises: PlanExercise[]): PlanTree {
  return {
    blocks: [
      {
        id: 'b1',
        position: 0,
        name: 'Base',
        weeks: [
          {
            id: 'w1',
            weekNumber: 1,
            workouts: [{ id: 'wo1', position: 0, weekday: 1, name: 'Mixed', exercises }],
          },
        ],
      },
    ],
  };
}

/** WeekEditor with the page's state handling, so typed values flow back in. */
function Harness({ initial, unit = 'kg' }: { initial: PlanTree; unit?: WeightUnit }) {
  const [tree, setTree] = useState(initial);
  const errors = planErrors(tree, { modes: MODES, distanceUnit: unit === 'lb' ? 'mi' : 'km' });
  const week = tree.blocks[0].weeks[0] as PlanWeek;
  return (
    <>
      <WeekEditor
        week={week}
        names={NAMES}
        unit={unit}
        errors={errors}
        modes={MODES}
        onExerciseChange={(wid, eid, patch) => setTree((t) => updateExercise(t, 1, wid, eid, patch))}
        onMoveExercise={() => {}}
        onRemoveExercise={() => {}}
        onAddExercise={() => {}}
        onWorkoutChange={() => {}}
        onRemoveWorkout={() => {}}
        onAddWorkout={() => {}}
      />
      <pre data-testid="tree">{JSON.stringify(tree.blocks[0].weeks[0].workouts[0].exercises)}</pre>
    </>
  );
}

const exercisesOf = () => JSON.parse(screen.getByTestId('tree').textContent ?? '[]') as PlanExercise[];

function rowFor(name: string) {
  const rows = screen.getAllByTestId('edit-exercise');
  const match = rows.find((r) => within(r).queryByText(name));
  if (!match) throw new Error(`no row for ${name}`);
  return match;
}

describe('WeekEditor prescription picker', () => {
  const initial = () => treeOf([row('pe-bench', 'ex-bench', 0), row('pe-plank', 'ex-plank', 1), row('pe-run', 'ex-run', 2)]);

  it('shows sets and reps for a lift, and no cardio fields', () => {
    render(<Harness initial={initial()} />);
    const bench = rowFor('Bench press');
    expect(within(bench).getByLabelText('Sets, Bench press')).toHaveValue(3);
    expect(within(bench).getByLabelText('Min reps, Bench press')).toHaveValue(8);
    expect(within(bench).getByLabelText('Max reps, Bench press')).toHaveValue(12);
    expect(within(bench).getByLabelText('Rest (s), Bench press')).toBeInTheDocument();
    expect(within(bench).queryByLabelText('Minutes, Bench press')).toBeNull();
    expect(within(bench).queryByLabelText(/Distance/)).toBeNull();
  });

  it('shows only minutes for a time exercise', () => {
    render(<Harness initial={initial()} />);
    const plank = rowFor('Plank');
    expect(within(plank).getByLabelText('Minutes, Plank')).toHaveValue(30);
    expect(within(plank).queryByLabelText('Sets, Plank')).toBeNull();
    expect(within(plank).queryByLabelText('Min reps, Plank')).toBeNull();
    expect(within(plank).queryByLabelText(/Distance/)).toBeNull();
    expect(within(plank).queryByLabelText('Rest (s), Plank')).toBeNull();
    expect(within(plank).queryByLabelText('Load guidance, Plank')).toBeNull();
  });

  it('shows distance and minutes for a distance exercise, and writes metres and seconds', async () => {
    const user = userEvent.setup();
    render(<Harness initial={initial()} />);
    const run = rowFor('Outdoor run');
    const distance = within(run).getByLabelText('Distance in km, Outdoor run');
    const minutes = within(run).getByLabelText('Minutes, Outdoor run');
    expect(within(run).queryByLabelText('Sets, Outdoor run')).toBeNull();

    await user.type(distance, '5');
    await user.clear(minutes);
    await user.type(minutes, '25');
    const saved = exercisesOf().find((e) => e.id === 'pe-run')!;
    expect(saved.targetDistanceMeters).toBe(5000);
    expect(saved.targetDurationSeconds).toBe(1500);
    expect(saved.repMin).toBeNull();
  });

  it('accepts distance alone, and refuses neither', async () => {
    const user = userEvent.setup();
    render(<Harness initial={initial()} />);
    const run = rowFor('Outdoor run');
    await user.clear(within(run).getByLabelText('Minutes, Outdoor run'));
    expect(within(run).getByText('Set the minutes or a distance.')).toBeInTheDocument();
    await user.type(within(run).getByLabelText('Distance in km, Outdoor run'), '3');
    expect(within(run).queryByText('Set the minutes or a distance.')).toBeNull();
    expect(exercisesOf().find((e) => e.id === 'pe-run')!.targetDurationSeconds).toBeNull();
  });

  it('says why a value is out of range', async () => {
    const user = userEvent.setup();
    render(<Harness initial={initial()} />);
    const plank = rowFor('Plank');
    await user.clear(within(plank).getByLabelText('Minutes, Plank'));
    expect(within(plank).getByText('Set the minutes.')).toBeInTheDocument();
    await user.type(within(plank).getByLabelText('Minutes, Plank'), '700');
    expect(within(plank).getByText('Minutes: 1 to 600.')).toBeInTheDocument();
    const run = rowFor('Outdoor run');
    await user.type(within(run).getByLabelText('Distance in km, Outdoor run'), '0.05');
    expect(within(run).getByText('Distance: 0.1 to 100 km.')).toBeInTheDocument();
  });

  it('edits distance in miles for an imperial user', async () => {
    const user = userEvent.setup();
    render(<Harness initial={initial()} unit="lb" />);
    const run = rowFor('Outdoor run');
    await user.type(within(run).getByLabelText('Distance in mi, Outdoor run'), '2');
    expect(exercisesOf().find((e) => e.id === 'pe-run')!.targetDistanceMeters).toBe(3218.69);
  });
});

describe('planEdits cardio shape', () => {
  it('shapes a new row by trackingMode', () => {
    expect(newExercise('ex-bench', 0, 'weight_reps')).toMatchObject({ targetSets: 3, repMin: 8, repMax: 12, restSeconds: 90 });
    expect(newExercise('ex-bench', 0)).toMatchObject({ targetSets: 3, targetDurationSeconds: null });
    for (const mode of ['time', 'distance_time']) {
      expect(newExercise('ex-x', 0, mode)).toMatchObject({
        targetSets: null,
        repMin: null,
        repMax: null,
        targetDurationSeconds: DEFAULT_CARDIO_SECONDS,
        targetDistanceMeters: null,
        restSeconds: 0,
      });
    }
    const added = addExercises(treeOf([]), 1, 'wo1', ['ex-run', 'ex-bench'], MODES);
    expect(added.blocks[0].weeks[0].workouts[0].exercises.map((e) => e.targetDurationSeconds)).toEqual([1800, null]);
  });

  it('mirrors the contract shape checks', () => {
    const plank = row('pe-plank', 'ex-plank', 0);
    const run = row('pe-run', 'ex-run', 1);
    expect(planErrors(treeOf([plank, run]), { modes: MODES })).toEqual({});
    // Distance alone is a valid `distance_time` prescription.
    expect(planErrors(treeOf([{ ...run, targetDurationSeconds: null, targetDistanceMeters: 5000 }]), { modes: MODES })).toEqual({});
    expect(
      planErrors(treeOf([{ ...run, targetDurationSeconds: 30, targetDistanceMeters: 50, targetSets: 21 }]), { modes: MODES }),
    ).toEqual({
      'pe-run.targetDurationSeconds': 'Minutes: 1 to 600.',
      'pe-run.targetDistanceMeters': 'Distance: 0.1 to 100 km.',
      'pe-run.targetSets': 'Sets: 1 to 20.',
    });
    // Without modes, a row carrying a cardio target is checked as cardio.
    expect(planErrors(treeOf([run]))).toEqual({});
  });

  it('helpers', () => {
    expect(minutesToSeconds('')).toBeNull();
    expect(minutesToSeconds('2.5')).toBe(150);
    expect(Number.isNaN(minutesToSeconds('x'))).toBe(true);
    expect(distanceBoundsText('mi')).toBe('0.06 to 62.14 mi');
  });
});
