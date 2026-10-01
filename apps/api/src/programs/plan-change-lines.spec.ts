import { randomUUID } from 'node:crypto';

import { planTreeSchema, type PlanTree } from './contracts/plan-tree.contract';
import { PRESCRIPTION_CHANGE_LINES_MAX, prescriptionChangeLines, prescriptionChangeOperations } from './plan-change-lines';

const WALK = randomUUID();
const SQUAT = randomUUID();
const NAMES = new Map<string, string>([
  [WALK, 'Outdoor walk'],
  [SQUAT, 'Back squat'],
]);
const nameOf = (id: string) => NAMES.get(id);

/** `weeks` weeks of one Monday workout: a squat (3 x 5-8) and a walk (`walkSeconds`). Row ids derive from the week. */
function plan(weeks: number, walk: (week: number) => Record<string, unknown>, squatSets = 3): PlanTree {
  return planTreeSchema.parse({
    blocks: [
      {
        position: 0,
        name: 'Base',
        weeks: Array.from({ length: weeks }, (_, i) => ({
          weekNumber: i + 1,
          workouts: [
            {
              position: 0,
              weekday: 1,
              name: 'Mon',
              exercises: [
                { id: rowId(i + 1, 0), exerciseId: SQUAT, position: 0, targetSets: squatSets, repMin: 5, repMax: 8, restSeconds: 120 },
                { id: rowId(i + 1, 1), exerciseId: WALK, position: 1, restSeconds: 0, ...walk(i + 1) },
              ],
            },
          ],
        })),
      },
    ],
  });
}

function rowId(week: number, slot: number): string {
  return `00000000-0000-4000-8000-${String(week * 10 + slot).padStart(12, '0')}`;
}

describe('prescriptionChangeLines', () => {
  it('renders a duration change in minutes, one line for the weeks it touches', () => {
    const before = plan(4, () => ({ targetDurationSeconds: 1200 }));
    const after = plan(4, (week) => ({ targetDurationSeconds: week <= 2 ? 1800 : 1200 }));
    expect(prescriptionChangeLines(before, after, nameOf)).toEqual(['Weeks 1-2, Outdoor walk: 20 → 30 min']);
  });

  it('renders a distance in km and names a single week', () => {
    const before = plan(3, () => ({ targetDistanceMeters: 5000 }));
    const after = plan(3, (week) => ({ targetDistanceMeters: week === 3 ? 7500 : 5000 }));
    expect(prescriptionChangeLines(before, after, nameOf)).toEqual(['Week 3, Outdoor walk: 5 → 7.5 km']);
  });

  it('lists reps changes too, and separate ranges', () => {
    const before = plan(5, () => ({ targetDurationSeconds: 1800 }));
    const after = plan(5, (week) => ({ targetDurationSeconds: week === 2 || week === 4 || week === 5 ? 2400 : 1800 }), 4);
    expect(prescriptionChangeLines(before, after, nameOf)).toEqual([
      'Weeks 1-5, Back squat: 3 x 5-8 → 4 x 5-8',
      'Weeks 2, 4-5, Outdoor walk: 30 → 40 min',
    ]);
  });

  it('ignores new, removed and swapped rows and untouched prescriptions', () => {
    const before = plan(2, () => ({ targetDurationSeconds: 1800 }));
    const after = plan(2, () => ({ targetDurationSeconds: 1800 }));
    after.blocks[0].weeks[0].workouts[0].exercises[1].exerciseId = SQUAT; // swapped
    after.blocks[0].weeks[1].workouts[0].exercises[1].id = randomUUID(); // a new row
    expect(prescriptionChangeLines(before, after, nameOf)).toEqual([]);
  });

  it('caps the lines and counts the rest', () => {
    const before = plan(30, () => ({ targetDurationSeconds: 600 }));
    const after = plan(30, (week) => ({ targetDurationSeconds: 600 + week * 60 }));
    const lines = prescriptionChangeLines(before, after, nameOf);
    expect(lines).toHaveLength(PRESCRIPTION_CHANGE_LINES_MAX);
    expect(lines[lines.length - 1]).toBe(`…and ${30 - (PRESCRIPTION_CHANGE_LINES_MAX - 1)} more prescription changes`);
  });

  it('wraps each line as a stored operation with a description', () => {
    const before = plan(1, () => ({ targetDurationSeconds: 1200 }));
    const after = plan(1, () => ({ targetDurationSeconds: 1800 }));
    expect(prescriptionChangeOperations(before, after, nameOf)).toEqual([
      { op: 'edit_prescription', description: 'Week 1, Outdoor walk: 20 → 30 min' },
    ]);
  });
});
