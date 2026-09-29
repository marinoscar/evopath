// =============================================================================
// Unit: GET /api/workouts/summary rules (E4.6)
// =============================================================================
//
// The ISO week start (a Sunday belongs to the week that began the previous
// Monday), calendar-day distances, and the top-lift pick (heaviest completed
// working set per exercise, at most three).
// =============================================================================

import { Prisma } from '@prisma/client';

import { daysBetween, isoWeekStart, topLifts, type TopLiftEntry } from '../../src/workouts/workout-summary';
import { workoutSummaryQuerySchema } from '../../src/workouts/dto/workout-summary.dto';

function set(overrides: Partial<TopLiftEntry['sets'][number]> = {}): TopLiftEntry['sets'][number] {
  return { setNumber: 1, weightKg: new Prisma.Decimal(100), reps: 5, completed: true, isWarmup: false, ...overrides };
}

const entry = (name: string, sets: TopLiftEntry['sets']): TopLiftEntry => ({ exercise: { name }, sets });

describe('isoWeekStart', () => {
  it.each([
    ['2026-09-28', '2026-09-28'], // Monday
    ['2026-09-29', '2026-09-28'], // Tuesday
    ['2026-10-03', '2026-09-28'], // Saturday
    ['2026-10-04', '2026-09-28'], // Sunday belongs to the week that began the previous Monday
    ['2026-10-05', '2026-10-05'], // next Monday
    ['2027-01-01', '2026-12-28'], // across a year boundary
    ['2028-03-01', '2028-02-28'], // across a leap day
  ])('%s -> %s', (date, monday) => {
    expect(isoWeekStart(date)).toBe(monday);
  });
});

describe('daysBetween', () => {
  it('counts calendar days, negative when from is later', () => {
    expect(daysBetween('2026-09-26', '2026-09-29')).toBe(3);
    expect(daysBetween('2026-09-29', '2026-09-29')).toBe(0);
    expect(daysBetween('2026-09-30', '2026-09-29')).toBe(-1);
    expect(daysBetween('2026-06-29', '2026-09-29')).toBe(92);
  });
});

describe('topLifts', () => {
  it('returns nothing for a workout without exercises or qualifying sets', () => {
    expect(topLifts([])).toEqual([]);
    expect(
      topLifts([
        entry('Plank', [set({ weightKg: null, reps: null })]),
        entry('Push-up', [set({ weightKg: 0, reps: 20 })]),
        entry('Failed', [set({ reps: 0 })]),
      ]),
    ).toEqual([]);
  });

  it('picks the heaviest completed working set per exercise, ignoring warm-ups and uncompleted sets', () => {
    const result = topLifts([
      entry('Bench', [
        set({ setNumber: 1, weightKg: new Prisma.Decimal(140), isWarmup: true }),
        set({ setNumber: 2, weightKg: new Prisma.Decimal(150), completed: false }),
        set({ setNumber: 3, weightKg: new Prisma.Decimal('82.5'), reps: 5 }),
        set({ setNumber: 4, weightKg: new Prisma.Decimal(80), reps: 8 }),
      ]),
    ]);

    expect(result).toEqual([{ exerciseName: 'Bench', weightKg: 82.5, reps: 5 }]);
  });

  it('breaks a weight tie by more reps, then the earlier set', () => {
    expect(
      topLifts([entry('Row', [set({ setNumber: 1, reps: 5 }), set({ setNumber: 2, reps: 7 }), set({ setNumber: 3, reps: 7 })])]),
    ).toEqual([{ exerciseName: 'Row', weightKg: 100, reps: 7 }]);
  });

  it('keeps at most three, heaviest first, the earlier exercise on a tie', () => {
    const result = topLifts([
      entry('Curl', [set({ weightKg: 20 })]),
      entry('Squat', [set({ weightKg: 140 })]),
      entry('Press', [set({ weightKg: 60 })]),
      entry('Deadlift', [set({ weightKg: 180 })]),
      entry('Lunge', [set({ weightKg: 60 })]),
    ]);

    expect(result.map((lift) => lift.exerciseName)).toEqual(['Deadlift', 'Squat', 'Press']);
    expect(result).toHaveLength(3);
  });

  it('accepts plain numbers as well as decimals', () => {
    expect(topLifts([entry('Bench', [set({ weightKg: 31.751 })])])).toEqual([{ exerciseName: 'Bench', weightKg: 31.751, reps: 5 }]);
  });
});

describe('workoutSummaryQuerySchema', () => {
  it('accepts no today and a real date; refuses anything else', () => {
    expect(workoutSummaryQuerySchema.parse({})).toEqual({});
    expect(workoutSummaryQuerySchema.parse({ today: '2026-09-29' })).toEqual({ today: '2026-09-29' });
    expect(workoutSummaryQuerySchema.safeParse({ today: '2026-02-30' }).success).toBe(false);
    expect(workoutSummaryQuerySchema.safeParse({ today: '29/09/2026' }).success).toBe(false);
  });
});
