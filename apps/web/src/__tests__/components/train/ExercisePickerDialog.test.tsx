/**
 * `ExercisePickerDialog` (E4.3): with a gym only what the gym can do; "Show
 * all" reveals the rest dimmed with "Needs: …"; unavailable ones can still
 * be added; multi-select adds in the order picked; Recent from history.
 */
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { act, render, screen, waitFor, within } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { setViewportWidth, resetViewportWidth } from '../../setup';
import { ExercisePickerDialog } from '../../../components/train/ExercisePickerDialog';
import type { Exercise } from '../../../services/exercises';
import { mockExercise } from '../../mocks/fixtures/exercises';
import { mockEntry, mockWorkout, statefulWorkoutsApi } from '../../mocks/fixtures/workouts';

const GYM = { id: '00000000-0000-4000-8000-a00000000001', name: 'Home Gym' };

const bench = mockExercise({ name: 'Dumbbell bench press' });
const pullUp = mockExercise({ name: 'Pull-up', primaryMuscles: ['lats'], trackingMode: 'bodyweight_reps' });
const legPress = mockExercise({ name: 'Leg press', primaryMuscles: ['quads'] });

/** The API's answer: availability computed for the gym; `availableOnly` filters. */
function serveExercises() {
  const calls: string[] = [];
  server.use(
    http.get('*/api/exercises', ({ request }) => {
      const url = new URL(request.url);
      calls.push(url.search);
      const gymId = url.searchParams.get('gymId');
      const availableOnly = url.searchParams.get('availableOnly') === 'true';
      const q = url.searchParams.get('q')?.toLowerCase();
      let data: Exercise[] = [bench, pullUp, legPress].map((e) =>
        gymId
          ? { ...e, available: e.id !== legPress.id, missing: e.id === legPress.id ? ['Leg press'] : [] }
          : e,
      );
      if (availableOnly) data = data.filter((e) => e.available);
      if (q) data = data.filter((e) => e.name.toLowerCase().includes(q));
      return HttpResponse.json({ data });
    }),
  );
  return calls;
}

async function options() {
  const list = await screen.findByRole('list', { name: 'Exercises to add' });
  return within(list).getAllByRole('checkbox');
}

function renderPicker(props: Partial<Parameters<typeof ExercisePickerDialog>[0]> = {}) {
  const onAdd = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(<ExercisePickerDialog open gym={GYM} onAdd={onAdd} onClose={onClose} canCreate {...props} />);
  return { onAdd, onClose };
}

describe('ExercisePickerDialog', () => {
  it('with a gym, lists only what the gym can do by default', async () => {
    const calls = serveExercises();
    renderPicker();
    await waitFor(async () => expect(await options()).toHaveLength(2));
    expect(screen.queryByText('Leg press')).toBeNull();
    expect(screen.getByRole('switch', { name: 'At Home Gym' })).toBeChecked();
    expect(calls.at(-1)).toContain('availableOnly=true');
    expect(calls.at(-1)).toContain(`gymId=${GYM.id}`);
  });

  it('Show all reveals the rest with "Needs: …", and an unavailable exercise can be added', async () => {
    serveExercises();
    const user = userEvent.setup();
    const { onAdd } = renderPicker();
    await waitFor(async () => expect(await options()).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(async () => expect(await options()).toHaveLength(3));
    expect(screen.getByText(/Needs: Leg press/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Leg press' }));
    await user.click(screen.getByRole('button', { name: 'Add exercise' }));
    expect(onAdd).toHaveBeenCalledWith([legPress.id], { [legPress.id]: legPress.name }, { [legPress.id]: legPress.trackingMode });
  });

  it('without a gym, offers everything and no gym toggle', async () => {
    const calls = serveExercises();
    renderPicker({ gym: null });
    await waitFor(async () => expect(await options()).toHaveLength(3));
    expect(screen.queryByRole('switch')).toBeNull();
    expect(calls.at(-1)).not.toContain('gymId');
  });

  it('multi-select adds several, in the order picked', async () => {
    serveExercises();
    const user = userEvent.setup();
    const { onAdd, onClose } = renderPicker();
    await waitFor(async () => expect(await options()).toHaveLength(2));
    await user.click(screen.getByRole('checkbox', { name: 'Pull-up' }));
    await user.click(screen.getByRole('checkbox', { name: 'Dumbbell bench press' }));
    await user.click(screen.getByRole('button', { name: 'Add 2 exercises' }));
    expect(onAdd).toHaveBeenCalledWith(
      [pullUp.id, bench.id],
      { [pullUp.id]: pullUp.name, [bench.id]: bench.name },
      { [pullUp.id]: pullUp.trackingMode, [bench.id]: bench.trackingMode },
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows a Recent section from the last workouts', async () => {
    serveExercises();
    statefulWorkoutsApi([mockWorkout({ status: 'completed', exercises: [mockEntry(pullUp)] })]);
    renderPicker();
    expect(await screen.findByText('Recent')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox', { name: 'Pull-up' })).toHaveLength(2);
  });

  it('keeps the dialog open and shows the error when adding fails', async () => {
    serveExercises();
    const user = userEvent.setup();
    const { onClose } = renderPicker({ onAdd: vi.fn().mockRejectedValue(new Error('Limit reached')) });
    await waitFor(async () => expect(await options()).toHaveLength(2));
    await user.click(screen.getByRole('checkbox', { name: 'Pull-up' }));
    await user.click(screen.getByRole('button', { name: 'Add exercise' }));
    expect(await screen.findByText('Limit reached')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('is full screen below sm', async () => {
    serveExercises();
    act(() => setViewportWidth(375));
    try {
      renderPicker();
      const dialog = await screen.findByRole('dialog');
      expect(dialog.className).toMatch(/fullScreen/i);
    } finally {
      act(() => resetViewportWidth());
    }
  });

  it('has no axe violations', async () => {
    serveExercises();
    renderPicker();
    await waitFor(async () => expect(await options()).toHaveLength(2));
    const results = await axe(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
