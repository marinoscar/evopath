/** planDiff: added, removed, changed, moved and deload changes between two snapshot trees. */
import { describe, it, expect } from 'vitest';
import { diffSnapshots, prescription, snapshotTree } from '../../utils/planDiff';
import type { PlanTree } from '../../services/programs';

function tree(): PlanTree {
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
            isDeload: false,
            workouts: [
              {
                id: 'wo1',
                position: 0,
                weekday: 1,
                name: 'Upper A',
                exercises: [
                  { id: 'e1', exerciseId: 'bench', position: 0, targetSets: 3, repMin: 8, repMax: 10, targetRpe: 8, restSeconds: 120 },
                  { id: 'e2', exerciseId: 'row', position: 1, targetSets: 3, repMin: 10, repMax: 12, targetRpe: null, restSeconds: 90 },
                ],
              },
            ],
          },
          { id: 'w2', weekNumber: 2, isDeload: false, workouts: [] },
        ],
      },
    ],
  };
}

const names: Record<string, string> = { bench: 'Bench press', row: 'Cable row', squat: 'Goblet squat' };
const nameOf = (id: string) => names[id] ?? null;

describe('diffSnapshots', () => {
  it('reports nothing for identical trees', () => {
    const diff = diffSnapshots(tree(), tree(), nameOf);
    expect(diff.changes).toEqual([]);
    expect(diff.summary).toBe('No changes to the plan content.');
  });

  it('reports an added and a removed exercise', () => {
    const after = tree();
    const workout = after.blocks[0].weeks[0].workouts[0];
    workout.exercises = [
      workout.exercises[0],
      { id: 'e3', exerciseId: 'squat', position: 1, targetSets: 3, repMin: 10, repMax: 10, restSeconds: 90 },
    ];
    const diff = diffSnapshots(tree(), after, nameOf);
    expect(diff.changes.map((c) => c.kind).sort()).toEqual(['exercise_added', 'exercise_removed']);
    expect(diff.changes.find((c) => c.kind === 'exercise_added')?.text).toBe('Week 1, Upper A: added Goblet squat (3 x 10)');
    expect(diff.changes.find((c) => c.kind === 'exercise_removed')?.text).toBe('Week 1, Upper A: removed Cable row');
    expect(diff.summary).toBe('1 exercise added, 1 exercise removed.');
  });

  it('reports a changed prescription and load', () => {
    const after = tree();
    const bench = after.blocks[0].weeks[0].workouts[0].exercises[0];
    bench.targetSets = 4;
    bench.targetLoadKg = 72.5;
    const diff = diffSnapshots(tree(), after, nameOf);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].text).toBe('Week 1, Upper A: Bench press 3 x 8-10 @ RPE 8 to 4 x 8-10 @ RPE 8, load open load to 72.5 kg');
    expect(diff.summary).toBe('1 prescription changed.');
  });

  it('reports a workout moved to another weekday', () => {
    const after = tree();
    after.blocks[0].weeks[0].workouts[0].weekday = 3;
    const diff = diffSnapshots(tree(), after, nameOf);
    expect(diff.changes[0]).toMatchObject({ kind: 'workout_moved' });
    expect(diff.changes[0].text).toBe('Moved "Upper A" from week 1 Monday to week 1 Wednesday');
  });

  it('reports deload changes and added or removed weeks', () => {
    const after = tree();
    after.blocks[0].weeks[1].isDeload = true;
    after.blocks[0].weeks.push({ id: 'w3', weekNumber: 3, isDeload: false, workouts: [] });
    const diff = diffSnapshots(tree(), after, nameOf);
    expect(diff.changes.map((c) => c.text)).toEqual(['Week 2 is now a deload week', 'Added week 3']);

    const removed = diffSnapshots(after, tree(), nameOf);
    expect(removed.changes.map((c) => c.text)).toEqual(['Week 2 is no longer a deload week', 'Removed week 3']);
  });

  it('matches rows by position when ids are missing and falls back to "an exercise"', () => {
    const strip = (t: PlanTree): PlanTree => JSON.parse(JSON.stringify(t).replace(/"id":"[^"]+",/g, ''));
    const after = strip(tree());
    after.blocks[0].weeks[0].workouts[0].exercises[1].targetSets = 5;
    const diff = diffSnapshots(strip(tree()), after);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].text).toContain('an exercise 3 x 10-12 to 5 x 10-12');
  });

  it('treats a missing tree as empty', () => {
    const diff = diffSnapshots(null, tree(), nameOf);
    expect(diff.changes.some((c) => c.kind === 'block_added')).toBe(true);
    expect(snapshotTree({ schemaVersion: 1, tree: tree() })).not.toBeNull();
    expect(snapshotTree({})).toBeNull();
  });

  it('formats a prescription', () => {
    expect(prescription({ targetSets: 3, repMin: 5, repMax: 5, targetRpe: 7.5 })).toBe('3 x 5 @ RPE 7.5');
  });
});
