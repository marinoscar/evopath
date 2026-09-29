/**
 * The `workout_prefill` draft renderers (E4.5): `formatDraftSets` in both
 * display units, and `ExerciseDraftValue` (name, "read as", sets, the new
 * custom exercise chip).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '../../utils/test-utils';
import { ExerciseDraftValue } from '../../../components/train/ExerciseDraftValue';
import { formatDraftSets, prefillApplySummary, prefillResultMeta, contextFor, sourceOf } from '../../../services/workoutPrefill';

const set = (weightKg: number | null, reps: number | null, durationSeconds: number | null = null, distanceMeters: number | null = null) => ({
  weightKg,
  reps,
  durationSeconds,
  distanceMeters,
});

describe('formatDraftSets', () => {
  it('groups consecutive sets of one weight in lb', () => {
    expect(formatDraftSets([set(61.235, 10), set(61.235, 10), set(61.235, 8)], 'lb')).toBe('135 lb × 10, 10, 8');
  });

  it('separates different weights and reads kg without trailing zeros', () => {
    expect(formatDraftSets([set(60, 10), set(62.5, 8)], 'kg')).toBe('60 kg × 10; 62.5 kg × 8');
  });

  it('reads time, distance and reps-only sets', () => {
    expect(formatDraftSets([set(null, null, 60)], 'kg')).toBe('1:00');
    expect(formatDraftSets([set(null, null, null, 400)], 'kg')).toBe('0.4 km');
    expect(formatDraftSets([set(null, 12), set(null, 12)], 'kg')).toBe('12, 12 reps');
    expect(formatDraftSets([], 'kg')).toBe('');
  });
});

describe('prefill helpers', () => {
  it('summarises an apply', () => {
    expect(prefillApplySummary({ exercisesAdded: 3, skipped: 0 })).toBe(
      '3 exercises added. Sets are not marked done; check them off as you train.',
    );
    expect(prefillApplySummary({ exercisesAdded: 1, skipped: 2 })).toBe(
      '1 exercise added. Sets are not marked done; check them off as you train. 2 not added: a workout holds at most 30 exercises.',
    );
  });

  it('maps the source selector to the context and back', () => {
    expect(contextFor('w1', 'unsure')).toEqual({ workoutId: 'w1' });
    expect(contextFor('w1', 'whiteboard')).toEqual({ workoutId: 'w1', sourceHint: 'whiteboard' });
    expect(sourceOf({ workoutId: 'w1', sourceHint: 'notebook' })).toBe('notebook');
    expect(sourceOf(null)).toBe('unsure');
  });

  it('reads resultMeta defensively', () => {
    expect(prefillResultMeta(null)).toEqual({ suggestedName: null, ignoredNotes: [], failedChunks: [] });
    expect(prefillResultMeta({ resultMeta: { suggestedName: '  ', ignoredNotes: ['x', 3], failedChunks: 'no' } })).toMatchObject({
      suggestedName: null,
      ignoredNotes: ['x'],
      failedChunks: [],
    });
  });
});

describe('ExerciseDraftValue', () => {
  it('shows the name, what the AI read and the sets', () => {
    render(
      <ExerciseDraftValue
        unit="lb"
        value={{ exerciseSlug: 'barbell_bench_press', name: 'Barbell bench press', rawText: 'Bench 135 x 10, 10, 8', sets: [set(61.235, 10), set(61.235, 10), set(61.235, 8)] }}
      />,
    );
    expect(screen.getByText('Barbell bench press')).toBeInTheDocument();
    expect(screen.getByText('read as: Bench 135 x 10, 10, 8')).toBeInTheDocument();
    expect(screen.getByTestId('exercise-draft-sets')).toHaveTextContent('3 sets: 135 lb × 10, 10, 8');
    expect(screen.queryByText('New custom exercise')).toBeNull();
  });

  it('marks an exercise that is not in the library and says when there are no sets', () => {
    render(<ExerciseDraftValue unit="kg" value={{ exerciseSlug: null, name: 'Cable row', rawText: null, sets: [] }} />);
    expect(screen.getByText('New custom exercise')).toBeInTheDocument();
    expect(screen.getByText('No sets')).toBeInTheDocument();
    expect(screen.queryByTestId('exercise-draft-raw')).toBeNull();
  });
});
