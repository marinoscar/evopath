/**
 * `SetRow` (E4.3): the fields per tracking mode, unit conversion on save
 * (never re-converting unchanged text), the 400 ms autosave debounce, a
 * failed save that keeps the typed value with Retry, and the one-tap
 * evaluator inputs (effort chips, discomfort flag).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor } from '../../utils/test-utils';
import { SetRow, SET_AUTOSAVE_DELAY_MS } from '../../../components/train/SetRow';
import type { SetInput, SetLogView } from '../../../services/workouts';
import type { TrackingMode } from '../../../services/exercises';
import type { WeightUnit } from '../../../utils/units';
import { mockSet } from '../../mocks/fixtures/workouts';

type SaveFn = (id: string, input: SetInput) => Promise<SetLogView>;

function Harness({
  initial,
  mode = 'weight_reps',
  unit = 'kg',
  onSave,
  onCompleted,
}: {
  initial: SetLogView;
  mode?: TrackingMode;
  unit?: WeightUnit;
  onSave: SaveFn;
  onCompleted?: (s: SetLogView) => void;
}) {
  const [set, setSet] = useState(initial);
  return (
    <SetRow
      set={set}
      trackingMode={mode}
      unit={unit}
      canWrite
      onSave={async (id, input) => {
        const saved = await onSave(id, input);
        setSet(saved);
        return saved;
      }}
      onCompleted={onCompleted}
      onDelete={vi.fn()}
    />
  );
}

function saveFrom(initial: SetLogView) {
  let current = initial;
  return vi.fn<SaveFn>(async (_id, input) => {
    const { completed, ...rest } = input;
    current = { ...current, ...rest, ...(completed !== undefined ? { completed, completedAt: completed ? 'now' : null } : {}) };
    return current;
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SetRow', () => {
  it('weight_reps shows weight and reps with numeric keypads', () => {
    const set = mockSet();
    render(<Harness initial={set} onSave={saveFrom(set)} unit="lb" />);
    const weight = screen.getByRole('textbox', { name: 'Set 1 weight in lb' });
    expect(weight).toHaveAttribute('inputmode', 'decimal');
    expect(weight).toHaveAttribute('enterkeyhint', 'next');
    expect(screen.getByRole('textbox', { name: 'Set 1 reps' })).toHaveAttribute('inputmode', 'numeric');
  });

  it('time shows a duration field and no weight; distance_time shows distance and time', () => {
    const set = mockSet();
    const { unmount } = render(<Harness initial={set} mode="time" onSave={saveFrom(set)} />);
    expect(screen.getByRole('textbox', { name: 'Set 1 time (minutes:seconds)' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /weight/ })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /reps/ })).toBeNull();
    unmount();
    render(<Harness initial={set} mode="distance_time" onSave={saveFrom(set)} />);
    expect(screen.getByRole('textbox', { name: 'Set 1 distance in km' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Set 1 time (minutes:seconds)' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /weight/ })).toBeNull();
  });

  it('bodyweight_reps shows only reps until "Added weight" is turned on', async () => {
    const set = mockSet();
    const user = userEvent.setup();
    render(<Harness initial={set} mode="bodyweight_reps" onSave={saveFrom(set)} />);
    expect(screen.getByRole('textbox', { name: 'Set 1 reps' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /weight/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More for set 1' }));
    await user.click(screen.getByRole('switch', { name: 'Added weight' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('textbox', { name: 'Set 1 added weight in kg' })).toBeInTheDocument();
  });

  it('saves "70" typed in lb as 31.751 kg', async () => {
    const set = mockSet();
    const onSave = saveFrom(set);
    const user = userEvent.setup();
    render(<Harness initial={set} unit="lb" onSave={onSave} />);
    await user.type(screen.getByRole('textbox', { name: 'Set 1 weight in lb' }), '70');
    await user.tab();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(set.id, { weightKg: 31.751 }));
    expect(screen.getByRole('textbox', { name: 'Set 1 weight in lb' })).toHaveValue('70');
  });

  it('shows 31.751 kg as 31.75 kg, and retyping 31.75 sends nothing', async () => {
    const set = mockSet({ weightKg: 31.751 });
    const onSave = saveFrom(set);
    const user = userEvent.setup();
    render(<Harness initial={set} unit="kg" onSave={onSave} />);
    const weight = screen.getByRole('textbox', { name: 'Set 1 weight in kg' });
    expect(weight).toHaveValue('31.75');
    await user.clear(weight);
    await user.type(weight, '31.75');
    await user.tab();
    await act(async () => {
      await new Promise((r) => setTimeout(r, SET_AUTOSAVE_DELAY_MS + 50));
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('debounces autosave by 400 ms after the last keystroke', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const set = mockSet();
    const onSave = saveFrom(set);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness initial={set} onSave={onSave} />);
    await user.type(screen.getByRole('textbox', { name: 'Set 1 reps' }), '12');
    act(() => {
      vi.advanceTimersByTime(SET_AUTOSAVE_DELAY_MS - 50);
    });
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(set.id, { reps: 12 });
  });

  it('a failed save keeps the typed value and offers Retry', async () => {
    const set = mockSet();
    const onSave = vi
      .fn<SaveFn>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async (_id, input) => ({ ...set, ...input }) as SetLogView);
    const user = userEvent.setup();
    render(<Harness initial={set} onSave={onSave} />);
    const reps = screen.getByRole('textbox', { name: 'Set 1 reps' });
    await user.type(reps, '8');
    await user.tab();
    expect(await screen.findByText('Set 1 not saved.')).toBeInTheDocument();
    expect(reps).toHaveValue('8');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('Set 1 not saved.')).toBeNull());
    expect(onSave).toHaveBeenLastCalledWith(set.id, { reps: 8 });
    expect(reps).toHaveValue('8');
  });

  it('refuses invalid text in place without saving', async () => {
    const set = mockSet();
    const onSave = saveFrom(set);
    const user = userEvent.setup();
    render(<Harness initial={set} onSave={onSave} />);
    await user.type(screen.getByRole('textbox', { name: 'Set 1 weight in kg' }), '12,5');
    await user.tab();
    expect(await screen.findByText('Use a dot for decimals, for example 12.5.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('the check button saves what is typed and marks the set done', async () => {
    const set = mockSet();
    const onSave = saveFrom(set);
    const onCompleted = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={set} onSave={onSave} onCompleted={onCompleted} />);
    await user.type(screen.getByRole('textbox', { name: 'Set 1 weight in kg' }), '60');
    await user.type(screen.getByRole('textbox', { name: 'Set 1 reps' }), '5');
    await user.click(screen.getByRole('button', { name: 'Complete set 1' }));
    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
    // Weight went on blur; reps and completion go together.
    expect(onSave).toHaveBeenCalledWith(set.id, { weightKg: 60 });
    expect(onSave).toHaveBeenLastCalledWith(set.id, { reps: 5, completed: true });
    expect(screen.getByRole('button', { name: 'Complete set 1' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Enter moves from weight to reps, and Enter on reps completes the set', async () => {
    const set = mockSet();
    const onSave = saveFrom(set);
    const user = userEvent.setup();
    render(<Harness initial={set} onSave={onSave} />);
    await user.click(screen.getByRole('textbox', { name: 'Set 1 weight in kg' }));
    await user.keyboard('50{Enter}');
    expect(screen.getByRole('textbox', { name: 'Set 1 reps' })).toHaveFocus();
    await user.keyboard('8{Enter}');
    await waitFor(() =>
      expect(onSave).toHaveBeenLastCalledWith(set.id, expect.objectContaining({ reps: 8, completed: true })),
    );
  });

  it('an untouched set has no effort; one tap on a chip stores its RIR', async () => {
    const set = mockSet({ completed: true });
    const onSave = saveFrom(set);
    const user = userEvent.setup();
    render(<Harness initial={set} onSave={onSave} />);
    const group = screen.getByRole('group', { name: 'Effort for set 1' });
    for (const name of ['Easy', 'Right', 'Hard']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
    expect(group).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hard' }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(set.id, { rir: 0 }));
    expect(screen.getByRole('button', { name: 'Hard' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Easy' }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(set.id, { rir: 3 }));
    // Tapping the chosen chip again clears it back to null.
    await user.click(screen.getByRole('button', { name: 'Easy' }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(set.id, { rir: null, rpe: null }));
  });

  it('the chip follows an exact RPE set in More', async () => {
    const set = mockSet({ rpe: 8 });
    render(<Harness initial={set} onSave={saveFrom(set)} />);
    expect(screen.getByRole('button', { name: 'Right' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('flags discomfort in one tap and shows it on the row', async () => {
    const set = mockSet();
    const onSave = saveFrom(set);
    const user = userEvent.setup();
    render(<Harness initial={set} onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Flag discomfort on set 1' }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(set.id, { painFlag: true }));
    expect(screen.getByText('Discomfort flagged')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Flag discomfort on set 1' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('More sets RPE and warm-up', async () => {
    const set = mockSet();
    const onSave = saveFrom(set);
    const user = userEvent.setup();
    render(<Harness initial={set} onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'More for set 1' }));
    await user.click(screen.getByRole('switch', { name: 'Warm-up' }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(set.id, { isWarmup: true }));
    await user.click(screen.getByRole('combobox', { name: 'RPE' }));
    await user.click(screen.getByRole('option', { name: '8.5' }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(set.id, { rpe: 8.5 }));
  });
  describe('PR chips (E4.4)', () => {
    it('shows the chips a completed set earns, with the previous best, and announces them once', async () => {
      const initial = mockSet({ weightKg: 65, reps: 7 });
      const onSave = vi.fn<SaveFn>(async (_id, input) => ({
        ...initial,
        completed: Boolean(input.completed),
        prs: input.completed
          ? [
              { type: 'reps', value: 7, previous: 6 },
              { type: 'e1rm', value: 80.2, previous: 80 },
            ]
          : [],
      }));
      const user = userEvent.setup();
      render(<Harness initial={initial} onSave={onSave} />);
      expect(screen.queryByRole('list', { name: 'Personal records' })).toBeNull();
      expect(screen.getByRole('status')).toBeEmptyDOMElement();

      await user.click(screen.getByRole('button', { name: 'Complete set 1' }));
      const list = await screen.findByRole('list', { name: 'Personal records' });
      expect(list).toHaveTextContent('Rep PR: 7 reps. Previous best 6 reps at this weight or heavier');
      expect(list).toHaveTextContent('Est. 1RM PR: 80.2 kg. Previous best est. 1RM 80 kg');
      expect(list).not.toHaveTextContent('Weight PR');
      expect(screen.getByRole('status')).toHaveTextContent('Set 1: Rep PR, Est. 1RM PR');

      // Un-completing clears them; the region is emptied, not re-announced.
      await user.click(screen.getByRole('button', { name: 'Complete set 1' }));
      await waitFor(() => expect(screen.queryByRole('list', { name: 'Personal records' })).toBeNull());
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    });

    it('shows PRs a set already had (a reload) without announcing them', () => {
      const set = mockSet({
        weightKg: 67.5,
        reps: 5,
        completed: true,
        prs: [{ type: 'weight', value: 67.5, previous: 65 }],
      });
      render(<Harness initial={set} onSave={saveFrom(set)} />);
      expect(screen.getByRole('list', { name: 'Personal records' })).toHaveTextContent(
        'Weight PR: 67.5 kg. Previous best 65 kg',
      );
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    });

    it('a first set reads "First time logged"', () => {
      const set = mockSet({ weightKg: 60, reps: 10, completed: true, prs: [{ type: 'first_time', value: 60, previous: null }] });
      render(<Harness initial={set} onSave={saveFrom(set)} />);
      expect(screen.getByText('First time logged')).toBeInTheDocument();
    });

    it('shows chips in the user unit', () => {
      const set = mockSet({
        weightKg: 34.019,
        reps: 8,
        completed: true,
        prs: [{ type: 'weight', value: 34.019, previous: 31.751 }],
      });
      render(<Harness initial={set} unit="lb" onSave={saveFrom(set)} />);
      expect(screen.getByRole('list', { name: 'Personal records' })).toHaveTextContent(
        'Weight PR: 75.0 lb. Previous best 70.0 lb',
      );
    });
  });
});
