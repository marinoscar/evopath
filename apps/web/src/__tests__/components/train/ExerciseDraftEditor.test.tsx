/**
 * `ExerciseDraftEditor` (E4.5): pick a library exercise over `GET /exercises`
 * or keep a new custom one, and edit the sets in the display unit with the
 * logger's parsers (an invalid entry says why and is not sent).
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '../../utils/test-utils';
import { ExerciseDraftEditor } from '../../../components/train/ExerciseDraftEditor';
import type { ExerciseDraftValue } from '../../../services/workoutPrefill';
import { mockExercise, statefulExercisesApi } from '../../mocks/fixtures/exercises';
import type { WeightUnit } from '../../../utils/units';

function Harness({ initial, unit, onChange }: { initial: ExerciseDraftValue; unit: WeightUnit; onChange: (v: ExerciseDraftValue) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <ExerciseDraftEditor
      value={value}
      unit={unit}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

const unreadable: ExerciseDraftValue = {
  exerciseSlug: null,
  name: 'Unreadable cable exercise',
  rawText: 'Cbl r? 25x12',
  sets: [{ weightKg: 11.34, reps: 12, durationSeconds: null, distanceMeters: null }],
};

describe('ExerciseDraftEditor', () => {
  it('keeps an unidentified item as a new custom exercise with its name', () => {
    statefulExercisesApi();
    render(<Harness initial={unreadable} unit="lb" onChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Exercise' })).toHaveValue('New custom exercise (type a name)');
    expect(screen.getByRole('textbox', { name: 'Exercise name' })).toHaveValue('Unreadable cable exercise');
    expect(screen.getByRole('textbox', { name: 'Set 1 weight' })).toHaveValue('25');
    expect(screen.getByRole('textbox', { name: 'Set 1 reps' })).toHaveValue('12');
  });

  it('picks a library exercise, which sets its slug and name', async () => {
    statefulExercisesApi([mockExercise({ slug: 'seated_cable_row', name: 'Seated cable row', primaryMuscles: ['lats'] })]);
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={unreadable} unit="lb" onChange={onChange} />);
    await user.click(screen.getByRole('combobox', { name: 'Exercise' }));
    await user.click(await screen.findByRole('option', { name: 'Seated cable row' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ exerciseSlug: 'seated_cable_row', name: 'Seated cable row' }));
    expect(screen.queryByRole('textbox', { name: 'Exercise name' })).toBeNull();
  });

  it('converts a typed weight to kilograms and refuses what does not parse', async () => {
    statefulExercisesApi();
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={unreadable} unit="lb" onChange={onChange} />);
    const weight = screen.getByRole('textbox', { name: 'Set 1 weight' });
    await user.clear(weight);
    await user.type(weight, '30');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ sets: [{ weightKg: 13.608, reps: 12, durationSeconds: null, distanceMeters: null }] }),
    );
    onChange.mockClear();
    await user.clear(weight);
    await user.type(weight, '12,5');
    expect(screen.getByText('Use a dot for decimals, for example 12.5.')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ sets: [expect.objectContaining({ weightKg: 12.5 })] }));
  });

  it('adds a set repeating the last one and removes a set', async () => {
    statefulExercisesApi();
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={unreadable} unit="lb" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Add set' }));
    const sets = screen.getByRole('list', { name: 'Sets' });
    expect(within(sets).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('textbox', { name: 'Set 2 weight' })).toHaveValue('25');
    await user.click(screen.getByRole('button', { name: 'Remove set 1' }));
    expect(within(sets).getAllByRole('listitem')).toHaveLength(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ sets: [unreadable.sets[0]] }));
  });

  it('shows a time column for a timed set', () => {
    statefulExercisesApi();
    render(
      <Harness
        initial={{ exerciseSlug: 'plank', name: 'Plank', rawText: 'Plank 60s', sets: [{ weightKg: null, reps: null, durationSeconds: 60, distanceMeters: null }] }}
        unit="kg"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Set 1 time' })).toHaveValue('1:00');
    expect(screen.queryByRole('textbox', { name: 'Set 1 weight' })).toBeNull();
  });
});
