import { derivedEntriesFor, type CreditWorkout } from './workout-activity';

const ENDED = new Date('2026-09-29T08:00:00Z');

function workout(overrides: Partial<CreditWorkout> = {}): CreditWorkout {
  return {
    id: 'w1',
    date: '2026-09-29',
    status: 'completed',
    durationSeconds: 3000,
    endedAt: ENDED,
    exercises: [],
    ...overrides,
  };
}

const set = (durationSeconds: number | null, distanceMeters: number | null, completed = true) => ({
  completed,
  durationSeconds,
  distanceMeters,
});

describe('derivedEntriesFor', () => {
  it('credits nothing for a workout that is not completed', () => {
    expect(derivedEntriesFor(workout({ status: 'in_progress' }))).toEqual([]);
  });

  it('always credits workout_any with the workout duration, on the workout local date', () => {
    expect(derivedEntriesFor(workout())).toEqual([
      { activityKind: 'workout_any', occurredOn: '2026-09-29', occurredAt: ENDED, durationSeconds: 3000, distanceMeters: null },
    ]);
  });

  it('credits walk for outdoor_walk and hike, run for outdoor_run, cardio_any for any cardio pattern', () => {
    const entries = derivedEntriesFor(
      workout({
        exercises: [
          { slug: 'outdoor_walk', movementPattern: 'cardio', sets: [set(1200, 1500.5)] },
          { slug: 'hike', movementPattern: 'cardio', sets: [set(600, null)] },
          { slug: 'outdoor_run', movementPattern: 'cardio', sets: [set(900, 2500)] },
          { slug: 'rower', movementPattern: 'cardio', sets: [set(300, 1000)] },
          { slug: 'bench', movementPattern: 'horizontal_push', sets: [set(null, null)] },
        ],
      }),
    );
    const byKind = Object.fromEntries(entries.map((entry) => [entry.activityKind, entry]));

    expect(Object.keys(byKind).sort()).toEqual(['cardio_any', 'run', 'walk', 'workout_any']);
    expect(byKind.walk).toMatchObject({ durationSeconds: 1800, distanceMeters: 1500.5 });
    expect(byKind.run).toMatchObject({ durationSeconds: 900, distanceMeters: 2500 });
    expect(byKind.cardio_any).toMatchObject({ durationSeconds: 3000, distanceMeters: 5000.5 });
  });

  it('ignores uncompleted sets, and an exercise with no completed set credits no kind', () => {
    const entries = derivedEntriesFor(
      workout({
        exercises: [
          { slug: 'outdoor_walk', movementPattern: 'cardio', sets: [set(1200, null), set(999, 999, false)] },
          { slug: 'outdoor_run', movementPattern: 'cardio', sets: [set(900, 2500, false)] },
        ],
      }),
    );
    expect(entries.map((entry) => entry.activityKind)).toEqual(['workout_any', 'walk', 'cardio_any']);
    expect(entries.find((entry) => entry.activityKind === 'walk')).toMatchObject({ durationSeconds: 1200, distanceMeters: null });
  });

  it('clamps values to the table CHECK ranges', () => {
    const entries = derivedEntriesFor(
      workout({
        durationSeconds: 100_000,
        exercises: [{ slug: 'outdoor_walk', movementPattern: 'cardio', sets: [set(50_000, null), set(50_000, null)] }],
      }),
    );
    expect(entries.every((entry) => entry.durationSeconds === 86_400)).toBe(true);
  });
});
