/** planEdits: the editor's pure tree transforms and row checks. */
import { describe, it, expect } from 'vitest';
import {
  addBlock,
  addExercises,
  addWeek,
  addWorkout,
  allWeeks,
  copyWeek,
  freeWeekday,
  makeDeload,
  moveExercise,
  planErrors,
  removeExercise,
  removeLastWeek,
  toEditTree,
  toSaveTree,
  updateExercise,
} from '../../../components/training/planEdits';
import { mockProgram } from '../../mocks/fixtures/programs';

const tree = () => toEditTree(mockProgram().tree);

describe('planEdits', () => {
  it('drops view-only fields and keeps ids', () => {
    const edit = tree();
    const exercise = edit.blocks[0].weeks[0].workouts[0].exercises[0] as Record<string, unknown>;
    expect(exercise.exercise).toBeUndefined();
    expect(exercise.exerciseUnavailable).toBeUndefined();
    expect(exercise.id).toBe('pe-bench');
  });

  it('moves, updates and removes exercises with contiguous positions', () => {
    let edit = moveExercise(tree(), 1, 'wo1', 'pe-row', -1);
    expect(edit.blocks[0].weeks[0].workouts[0].exercises.map((e) => [e.id, e.position])).toEqual([
      ['pe-row', 0],
      ['pe-bench', 1],
    ]);
    expect(moveExercise(edit, 1, 'wo1', 'pe-row', -1)).toEqual(edit);
    edit = updateExercise(edit, 1, 'wo1', 'pe-bench', { targetSets: 5 });
    expect(edit.blocks[0].weeks[0].workouts[0].exercises[1].targetSets).toBe(5);
    edit = removeExercise(edit, 1, 'wo1', 'pe-row');
    expect(edit.blocks[0].weeks[0].workouts[0].exercises.map((e) => e.position)).toEqual([0]);
  });

  it('adds workouts on a free weekday and exercises with defaults, then strips temporary ids on save', () => {
    let edit = addWorkout(tree(), 1);
    const added = edit.blocks[0].weeks[0].workouts[2];
    expect(added.weekday).toBe(2);
    expect(added.id).toMatch(/^tmp-/);
    edit = addExercises(edit, 1, added.id!, ['ex-new']);
    const saved = toSaveTree(edit);
    const savedWorkout = saved.blocks[0].weeks[0].workouts[2];
    expect(savedWorkout.id).toBeUndefined();
    expect(savedWorkout.position).toBe(2);
    expect(savedWorkout.exercises[0]).toMatchObject({ exerciseId: 'ex-new', position: 0, targetSets: 3 });
    expect(savedWorkout.exercises[0].id).toBeUndefined();
    expect(saved.blocks[0].weeks[0].workouts[0].id).toBe('wo1');
  });

  it('adds and removes weeks and blocks with contiguous numbers', () => {
    let edit = addWeek(tree());
    expect(allWeeks(edit).map((w) => w.week.weekNumber)).toEqual([1, 2, 3]);
    edit = addBlock(edit);
    expect(edit.blocks).toHaveLength(2);
    expect(allWeeks(edit).map((w) => w.week.weekNumber)).toEqual([1, 2, 3, 4]);
    edit = removeLastWeek(edit);
    expect(edit.blocks).toHaveLength(1);
    expect(allWeeks(edit).map((w) => w.week.weekNumber)).toEqual([1, 2, 3]);
  });

  it('copies a week as new rows and makes a deload', () => {
    let edit = copyWeek(tree(), 1, 2);
    const week2 = allWeeks(edit)[1].week;
    expect(week2.workouts.map((w) => w.name)).toEqual(['Upper A', 'Lower A']);
    expect(week2.workouts[0].id).toMatch(/^tmp-/);
    edit = makeDeload({ blocks: edit.blocks }, 1);
    const week1 = allWeeks(edit)[0].week;
    expect(week1.isDeload).toBe(true);
    expect(week1.workouts[0].exercises[0]).toMatchObject({ targetSets: 2, targetRpe: 7 });
  });

  it('reports row problems and weekday conflicts', () => {
    let edit = updateExercise(tree(), 1, 'wo1', 'pe-bench', { targetSets: 0, repMin: 12, repMax: 8, targetRpe: 7.3 });
    edit = { blocks: edit.blocks.map((b) => ({ ...b, weeks: b.weeks.map((w) => ({ ...w, workouts: w.workouts.map((x) => ({ ...x, weekday: 1 })) })) })) };
    expect(planErrors(edit)).toMatchObject({
      'pe-bench.targetSets': 'Sets: 1 to 20.',
      'pe-bench.repMax': 'Max reps must be at least min reps.',
      'pe-bench.targetRpe': 'RPE: 1 to 10 in steps of 0.5.',
      'wo2.weekday': 'Week 1 already has a workout that day.',
    });
    expect(planErrors(tree())).toEqual({});
    expect(freeWeekday(allWeeks(tree())[0].week)).toBe(2);
  });
});
