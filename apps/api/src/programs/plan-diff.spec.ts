import { randomUUID } from 'node:crypto';

import { planTreeSchema, type PlanTree } from './contracts/plan-tree.contract';
import { assignIds, diffTree, isEmptyDiff, liveTreeOf, rowsOf, type ProgramRows } from './plan-diff';

const EX = randomUUID();

/** Stored rows equal to `tree` (ids assigned), everything live. */
function stored(tree: PlanTree): ProgramRows {
  const rows = rowsOf(tree);
  return {
    blocks: rows.blocks.map((row) => ({ ...row, archivedAt: null })),
    weeks: rows.weeks.map((row) => ({ ...row, archivedAt: null })),
    workouts: rows.workouts.map((row) => ({ ...row, archivedAt: null })),
    exercises: rows.exercises,
  };
}

function baseTree(): PlanTree {
  return assignIds(
    planTreeSchema.parse({
      blocks: [
        {
          position: 0,
          name: 'Base',
          weeks: [
            {
              weekNumber: 1,
              workouts: [
                { position: 0, weekday: 1, name: 'A', exercises: [{ exerciseId: EX, position: 0, targetSets: 3, repMin: 5, repMax: 8, restSeconds: 120, targetLoadKg: 60 }] },
                { position: 1, weekday: 3, name: 'B', exercises: [{ exerciseId: EX, position: 0, targetSets: 3, repMin: 8, repMax: 12, restSeconds: 90 }] },
              ],
            },
            { weekNumber: 2, workouts: [{ position: 0, weekday: 1, name: 'C', exercises: [] }] },
          ],
        },
      ],
    }),
  );
}

const none = new Set<string>();

describe('diffTree', () => {
  it('writes nothing when the tree is unchanged, and liveTreeOf round-trips', () => {
    const tree = baseTree();
    const rows = stored(tree);
    expect(liveTreeOf(rows)).toEqual(tree);
    expect(isEmptyDiff(diffTree(rows, tree, none))).toBe(true);
  });

  it('creates new rows, updates only changed rows', () => {
    const tree = baseTree();
    const rows = stored(tree);
    const next = structuredClone(tree);
    next.blocks[0].weeks[0].workouts[0].exercises[0].targetLoadKg = 62.5;
    next.blocks[0].weeks[1].workouts.push({ id: randomUUID(), position: 1, weekday: 4, name: 'D', estimatedMinutes: null, rationale: null, exercises: [] });

    const writes = diffTree(rows, next, none);
    expect(writes.update.exercises.map((row) => row.targetLoadKg)).toEqual([62.5]);
    expect(writes.update.workouts).toEqual([]);
    expect(writes.create.workouts.map((row) => row.name)).toEqual(['D']);
    expect(writes.create.workouts[0].weekId).toBe(tree.blocks[0].weeks[1].id);
  });

  it('deletes a removed workout without history, and deletes its exercises through it', () => {
    const tree = baseTree();
    const next = structuredClone(tree);
    const removed = next.blocks[0].weeks[0].workouts.pop()!;

    const writes = diffTree(stored(tree), next, none);
    expect(writes.delete.workouts).toEqual([removed.id]);
    expect(writes.delete.exercises).toEqual([]);
    expect(writes.archive.workouts).toEqual([]);
  });

  it('deletes an exercise removed from a workout that stays', () => {
    const tree = baseTree();
    const next = structuredClone(tree);
    const removed = next.blocks[0].weeks[0].workouts[0].exercises.pop()!;
    expect(diffTree(stored(tree), next, none).delete.exercises).toEqual([removed.id]);
  });

  it('archives a removed workout that has logged history, never deletes it', () => {
    const tree = baseTree();
    const next = structuredClone(tree);
    const removed = next.blocks[0].weeks[0].workouts.shift()!;

    const writes = diffTree(stored(tree), next, new Set([removed.id!]));
    expect(writes.archive.workouts).toEqual([removed.id]);
    expect(writes.delete.workouts).toEqual([]);
  });

  it('archives a removed week (and block) that still holds an archived workout', () => {
    const tree = baseTree();
    const withHistory = tree.blocks[0].weeks[0].workouts[0].id!;
    const next: PlanTree = {
      blocks: [{ position: 0, name: 'New', focus: null, rationale: null, weeks: [{ id: randomUUID(), weekNumber: 1, isDeload: false, workouts: [] }] }],
    };

    const writes = diffTree(stored(tree), next, new Set([withHistory]));
    expect(writes.archive.workouts).toEqual([withHistory]);
    expect(writes.archive.weeks).toEqual([tree.blocks[0].weeks[0].id]);
    expect(writes.archive.blocks).toEqual([tree.blocks[0].id]);
    // The other week had no history: deleted.
    expect(writes.delete.weeks).toEqual([tree.blocks[0].weeks[1].id]);
    expect(writes.delete.blocks).toEqual([]);
  });

  it('restores an archived row named by id', () => {
    const tree = baseTree();
    const rows = stored(tree);
    const archivedId = tree.blocks[0].weeks[0].workouts[1].id!;
    rows.workouts.find((row) => row.id === archivedId)!.archivedAt = new Date();

    const writes = diffTree(rows, tree, new Set([archivedId]));
    expect(writes.update.workouts.map((row) => row.id)).toEqual([archivedId]);
    expect(writes.create.workouts).toEqual([]);
  });

  it('leaves an archived subtree alone when its parent stays out of the tree', () => {
    const tree = baseTree();
    const rows = stored(tree);
    const oldWeek = tree.blocks[0].weeks[1];
    rows.weeks.find((row) => row.id === oldWeek.id)!.archivedAt = new Date();
    const next = structuredClone(tree);
    next.blocks[0].weeks.pop();

    const writes = diffTree(rows, next, none);
    expect(writes.delete.weeks).toEqual([]);
    expect(writes.delete.workouts).toEqual([]);
    expect(isEmptyDiff(writes)).toBe(true);
  });

  it('moves a workout to another week as an update, so deleting the old week does not cascade it', () => {
    const tree = baseTree();
    const next = structuredClone(tree);
    const moved = next.blocks[0].weeks[1].workouts.pop()!;
    moved.weekday = 5;
    moved.position = 2;
    next.blocks[0].weeks[0].workouts.push(moved);
    next.blocks[0].weeks.pop();

    const writes = diffTree(stored(tree), next, none);
    expect(writes.update.workouts).toEqual([expect.objectContaining({ id: moved.id, weekId: tree.blocks[0].weeks[0].id })]);
    expect(writes.delete.weeks).toEqual([tree.blocks[0].weeks[1].id]);
    expect(writes.delete.workouts).toEqual([]);
  });
});
