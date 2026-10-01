import { localDateInZone } from '../check-ins/local-date';
import {
  entryMatchesGoal,
  evaluateDay,
  evaluateGoal,
  goalHistory,
  periodOf,
  type ProgressEntry,
  type ProgressGoal,
} from './goal-progress';

// Week of Monday 2026-09-28 .. Sunday 2026-10-04.
const MON = '2026-09-28';
const TUE = '2026-09-29';
const WED = '2026-09-30';
const THU = '2026-10-01';
const SAT = '2026-10-03';
const SUN = '2026-10-04';
const NEXT_MON = '2026-10-05';

let seq = 0;
function entry(overrides: Partial<ProgressEntry> = {}): ProgressEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    occurredOn: MON,
    activityKind: 'walk',
    completed: true,
    durationSeconds: null,
    steps: null,
    distanceMeters: null,
    source: 'manual',
    workoutId: null,
    ...overrides,
  };
}

function goal(overrides: Partial<ProgressGoal> = {}): ProgressGoal {
  return {
    id: 'g1',
    activityKind: 'walk',
    metric: 'sessions',
    target: 4,
    period: 'week',
    startsOn: '2026-01-01',
    ...overrides,
  };
}

/** The four days of `week` (a Monday) holding a walk each, as manual entries. */
function walksIn(monday: string, days: number): ProgressEntry[] {
  const start = Date.parse(`${monday}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) =>
    entry({ occurredOn: new Date(start + i * 86_400_000).toISOString().slice(0, 10) }),
  );
}

describe('goal progress rules', () => {
  describe('periods', () => {
    it('weeks run Monday..Sunday; a day period is the day', () => {
      expect(periodOf('week', WED)).toEqual({ start: MON, end: SUN });
      expect(periodOf('week', SUN)).toEqual({ start: MON, end: SUN });
      expect(periodOf('week', NEXT_MON)).toEqual({ start: NEXT_MON, end: '2026-10-11' });
      expect(periodOf('day', WED)).toEqual({ start: WED, end: WED });
    });

    it('puts Sunday 23:30 local in a non-UTC zone in that week, though UTC is already Monday', () => {
      // 2026-10-05T06:30Z is Sunday 23:30 in Los Angeles (PDT, UTC-7).
      const instant = new Date('2026-10-05T06:30:00Z');
      const local = localDateInZone(instant, 'America/Los_Angeles');
      expect(local).toBe(SUN);
      expect(localDateInZone(instant, 'UTC')).toBe(NEXT_MON);

      const g = goal({ target: 1 });
      const result = evaluateGoal(g, [entry({ occurredOn: local })], local);
      expect(result).toMatchObject({ periodStart: MON, periodEnd: SUN, done: 1, hit: true, daysLeft: 1 });
      // The next local Monday starts a fresh week.
      expect(evaluateGoal(g, [entry({ occurredOn: local })], NEXT_MON)).toMatchObject({ done: 0, periodStart: NEXT_MON });
    });
  });

  describe('on track (sessions)', () => {
    it('Wednesday with 2 of 4 sessions is on track (2 left, 5 days left)', () => {
      const result = evaluateGoal(goal(), walksIn(MON, 2), WED);
      expect(result).toMatchObject({ done: 2, remaining: 2, daysLeft: 5, onTrack: true, hit: false });
    });

    it('Saturday with 1 of 4 sessions is not on track (3 left, 2 days left)', () => {
      const result = evaluateGoal(goal(), walksIn(MON, 1), SAT);
      expect(result).toMatchObject({ done: 1, remaining: 3, daysLeft: 2, onTrack: false });
    });

    it('a hit goal is on track with nothing remaining', () => {
      const result = evaluateGoal(goal(), walksIn(MON, 5), THU);
      expect(result).toMatchObject({ done: 5, remaining: 0, hit: true, onTrack: true });
    });

    it('uncompleted entries do not count as sessions', () => {
      expect(evaluateGoal(goal(), [entry({ completed: false })], MON).done).toBe(0);
    });
  });

  describe('on track (volume)', () => {
    const minutes = goal({ activityKind: 'cardio_any', metric: 'minutes', target: 140 });

    it('compares against the share of the week fully before the date', () => {
      // Thursday: Mon..Wed elapsed = 3/7 of 140 = 60 minutes expected.
      const at60 = [entry({ occurredOn: MON, durationSeconds: 3600 })];
      const at59 = [entry({ occurredOn: MON, durationSeconds: 59 * 60 })];
      expect(evaluateGoal(minutes, at60, THU)).toMatchObject({ done: 60, onTrack: true, elapsedFraction: 3 / 7 });
      expect(evaluateGoal(minutes, at59, THU)).toMatchObject({ done: 59, onTrack: false });
    });

    it('is on track at zero on Monday and on a day goal\'s own day', () => {
      expect(evaluateGoal(minutes, [], MON).onTrack).toBe(true);
      expect(evaluateGoal(goal({ metric: 'steps', period: 'day', target: 8000 }), [], WED).onTrack).toBe(true);
    });

    it('floors minutes over the whole period, not per entry', () => {
      const result = evaluateGoal(
        minutes,
        [entry({ occurredOn: MON, durationSeconds: 90 }), entry({ occurredOn: TUE, durationSeconds: 90 })],
        WED,
      );
      expect(result.done).toBe(3);
    });
  });

  describe('precedence and counting', () => {
    it('steps: manual 6000 + integration 8200 on one day counts 8200, manual superseded', () => {
      const manual = entry({ activityKind: 'steps', steps: 6000, source: 'manual' });
      const imported = entry({ activityKind: 'steps', steps: 8200, source: 'integration' });
      const result = evaluateGoal(goal({ metric: 'steps', period: 'day', target: 8000 }), [manual, imported], MON);

      expect(result.done).toBe(8200);
      expect(result.hit).toBe(true);
      expect(result.entries.find((e) => e.id === manual.id)?.superseded).toBe(true);
      expect(result.entries.find((e) => e.id === imported.id)?.superseded).toBe(false);
    });

    it('steps: the MAX of a day within one source, summed over a week', () => {
      const week = goal({ metric: 'steps', period: 'week', target: 20000 });
      const result = evaluateGoal(
        week,
        [
          entry({ occurredOn: MON, activityKind: 'steps', steps: 5000 }),
          entry({ occurredOn: MON, activityKind: 'steps', steps: 7000 }),
          entry({ occurredOn: TUE, activityKind: 'steps', steps: 9000 }),
        ],
        WED,
      );
      expect(result.done).toBe(16000);
    });

    it('steps goals read the steps value of any entry, whatever its kind', () => {
      const g = goal({ metric: 'steps', period: 'day', target: 1 });
      expect(entryMatchesGoal(g, entry({ activityKind: 'run', steps: 100 }))).toBe(true);
      expect(entryMatchesGoal(g, entry({ activityKind: 'steps', steps: null }))).toBe(false);
    });

    it('a manual "I did it" walk and a walk workout on the same day are one session', () => {
      const manual = entry({ occurredOn: TUE });
      const derived = entry({ occurredOn: TUE, source: 'workout', workoutId: 'w1' });
      const result = evaluateGoal(goal(), [manual, derived], WED);

      expect(result.done).toBe(1);
      expect(result.entries.map((e) => [e.id, e.superseded])).toEqual([
        [manual.id, true],
        [derived.id, false],
      ]);
    });

    it('cardio_any counts one workout once though it derived walk and cardio_any entries', () => {
      const cardio = goal({ activityKind: 'cardio_any' });
      const walk = entry({ source: 'workout', workoutId: 'w1', activityKind: 'walk', durationSeconds: 1200 });
      const any = entry({ source: 'workout', workoutId: 'w1', activityKind: 'cardio_any', durationSeconds: 1800 });
      const other = entry({ source: 'workout', workoutId: 'w2', activityKind: 'cardio_any', durationSeconds: 600 });

      expect(evaluateGoal(cardio, [walk, any, other], TUE).done).toBe(2);
      // Minutes: per workout the largest matching value (its cardio_any includes the walk).
      expect(evaluateGoal({ ...cardio, metric: 'minutes', target: 100 }, [walk, any, other], TUE).done).toBe(40);
    });

    it('lower sources on OTHER days still count', () => {
      const result = evaluateGoal(
        goal(),
        [entry({ occurredOn: MON }), entry({ occurredOn: TUE, source: 'workout', workoutId: 'w1' })],
        WED,
      );
      expect(result.done).toBe(2);
      expect(result.entries.every((e) => !e.superseded)).toBe(true);
    });

    it('evaluateDay keeps only the highest source present', () => {
      const day = evaluateDay('sessions', [
        entry({ id: 'm' }),
        entry({ id: 'w', source: 'workout', workoutId: 'w1' }),
        entry({ id: 'i', source: 'integration' }),
      ]);
      expect(day.value).toBe(1);
      expect([...day.superseded].sort()).toEqual(['m', 'w']);
    });

    it('matches kinds per goal', () => {
      const kinds = (g: ProgressGoal) =>
        (['walk', 'run', 'cardio_any', 'workout_any', 'custom', 'steps'] as const).filter((activityKind) =>
          entryMatchesGoal(g, entry({ activityKind })),
        );
      expect(kinds(goal({ activityKind: 'walk' }))).toEqual(['walk']);
      expect(kinds(goal({ activityKind: 'run' }))).toEqual(['run']);
      expect(kinds(goal({ activityKind: 'cardio_any' }))).toEqual(['walk', 'run', 'cardio_any']);
      expect(kinds(goal({ activityKind: 'workout_any' }))).toEqual(['workout_any']);
      expect(kinds(goal({ activityKind: 'custom' }))).toEqual(['custom']);
    });

    it('ignores entries before the goal starts', () => {
      const result = evaluateGoal(goal({ startsOn: WED }), walksIn(MON, 4), THU);
      expect(result.done).toBe(2);
    });
  });

  describe('streaks and history', () => {
    const PREV = ['2026-09-21', '2026-09-14', '2026-09-07', '2026-08-31'];

    it('counts consecutive hit weeks before the current one', () => {
      const entries = [...walksIn(PREV[0], 4), ...walksIn(PREV[1], 5), ...walksIn(PREV[2], 4), ...walksIn(MON, 1)];
      expect(evaluateGoal(goal(), entries, WED).streakPeriods).toBe(3);
    });

    it('resets on a missed week', () => {
      const entries = [...walksIn(PREV[0], 4), ...walksIn(PREV[1], 3), ...walksIn(PREV[2], 4)];
      expect(evaluateGoal(goal(), entries, WED).streakPeriods).toBe(1);
      expect(evaluateGoal(goal(), [...walksIn(PREV[1], 4)], WED).streakPeriods).toBe(0);
    });

    it('does not count the current week, and stops at the period holding startsOn', () => {
      const entries = [...walksIn(PREV[0], 4), ...walksIn(PREV[1], 4), ...walksIn(PREV[2], 4), ...walksIn(MON, 4)];
      expect(evaluateGoal(goal({ startsOn: PREV[1] }), entries, WED).streakPeriods).toBe(2);
      expect(evaluateGoal(goal({ startsOn: PREV[1] }), entries, WED).hit).toBe(true);
    });

    it('stops at the loaded data', () => {
      const entries = [...walksIn(PREV[0], 4), ...walksIn(PREV[1], 4)];
      expect(evaluateGoal(goal(), entries, WED, { dataFrom: PREV[0] }).streakPeriods).toBe(1);
    });

    it('lists periods newest first, the current one included, back to startsOn', () => {
      const entries = [...walksIn(PREV[0], 4), ...walksIn(MON, 2)];
      const history = goalHistory(goal({ startsOn: PREV[1] }), entries, WED, 12);
      expect(history).toEqual([
        { start: MON, end: SUN, done: 2, target: 4, hit: false },
        { start: PREV[0], end: '2026-09-27', done: 4, target: 4, hit: true },
        { start: PREV[1], end: '2026-09-20', done: 0, target: 4, hit: false },
      ]);
      expect(goalHistory(goal(), entries, WED, 2)).toHaveLength(2);
    });

    it('counts day streaks', () => {
      const daily = goal({ metric: 'steps', period: 'day', target: 5000 });
      const entries = [
        entry({ occurredOn: MON, activityKind: 'steps', steps: 6000 }),
        entry({ occurredOn: TUE, activityKind: 'steps', steps: 5000 }),
      ];
      expect(evaluateGoal(daily, entries, WED).streakPeriods).toBe(2);
    });
  });
});
