import type { PlanTree, PlanWeek, PlanWorkout } from '../contracts/plan-tree.contract';
import { isoWeekday, occurrenceDate, resolveToday, resolveWeek, type ResolverProgram, type TodayResult, type WeekSession } from './resolve-today';

// Calendar anchors (verified): 2026-09-28 is a Monday, 2026-09-30 a Wednesday,
// 2026-10-04 a Sunday, 2026-10-05 a Monday.

function workout(id: string, weekday: number | null, position = 0): PlanWorkout {
  return { id, position, weekday, name: id, estimatedMinutes: 45, rationale: null, exercises: [] };
}

/** `weeks` weeks of Mon/Wed/Fri workouts named `w<week>-<weekday>`; deload weeks listed. */
function mwfTree(weeks: number, deload: number[] = []): PlanTree {
  const list: PlanWeek[] = [];
  for (let n = 1; n <= weeks; n += 1) {
    list.push({
      id: `week-${n}`,
      weekNumber: n,
      isDeload: deload.includes(n),
      workouts: [workout(`w${n}-1`, 1, 0), workout(`w${n}-3`, 3, 1), workout(`w${n}-5`, 5, 2)],
    });
  }
  return { blocks: [{ id: 'block', position: 0, name: 'Block', focus: null, rationale: null, weeks: list }] };
}

function program(startDate: string | null, tree: PlanTree, status = 'active'): ResolverProgram {
  return { id: 'program', startDate, status, tree };
}

/** A compact view of a result for table comparison. */
function summarize(result: TodayResult): string {
  switch (result.kind) {
    case 'no_program':
    case 'program_complete':
      return result.kind;
    case 'not_started':
      return `not_started ${result.startsOn}`;
    case 'workout':
      return `workout ${result.programWorkout.id} week ${result.weekNumber}/${result.totalWeeks}${result.isDeload ? ' deload' : ''}${result.done ? ' done' : ''}`;
    case 'rest_day':
      return result.next
        ? `rest week ${result.weekNumber} next ${result.next.programWorkout.id} on ${result.next.date} (week ${result.next.weekNumber})`
        : `rest week ${result.weekNumber} next none`;
  }
}

describe('resolveToday', () => {
  const START_WED = '2026-09-30';
  const START_MON = '2026-09-28';

  const table: Array<{ name: string; program: ResolverProgram | null; today: string; done?: string[]; expected: string }> = [
    { name: 'no active program', program: null, today: '2026-09-30', expected: 'no_program' },
    { name: 'a paused program is not surfaced', program: program(START_MON, mwfTree(2), 'paused'), today: '2026-09-30', expected: 'no_program' },
    { name: 'an active program without a start date', program: program(null, mwfTree(2)), today: '2026-09-30', expected: 'no_program' },
    { name: 'before the start date', program: program('2026-10-05', mwfTree(2)), today: '2026-10-04', expected: 'not_started 2026-10-05' },
    { name: 'start-date edge: Sunday before a Monday start', program: program(START_MON, mwfTree(2)), today: '2026-09-27', expected: 'not_started 2026-09-28' },
    { name: 'start-date edge: the Monday start itself', program: program(START_MON, mwfTree(2)), today: '2026-09-28', expected: 'workout w1-1 week 1/2' },
    { name: 'scheduled day', program: program(START_MON, mwfTree(2)), today: '2026-09-30', expected: 'workout w1-3 week 1/2' },
    { name: 'scheduled day already done', program: program(START_MON, mwfTree(2)), today: '2026-09-30', done: ['w1-3'], expected: 'workout w1-3 week 1/2 done' },
    { name: 'rest day inside the week', program: program(START_MON, mwfTree(2)), today: '2026-09-29', expected: 'rest week 1 next w1-3 on 2026-09-30 (week 1)' },
    { name: 'rest day across the week boundary (Sunday to Monday)', program: program(START_MON, mwfTree(2)), today: '2026-10-04', expected: 'rest week 1 next w2-1 on 2026-10-05 (week 2)' },
    { name: 'week rollover: the Monday of week 2', program: program(START_MON, mwfTree(2)), today: '2026-10-05', expected: 'workout w2-1 week 2/2' },
    {
      name: 'a missed earlier-week workout is not surfaced',
      program: program(START_MON, mwfTree(2)),
      today: '2026-10-06',
      done: [],
      expected: 'rest week 2 next w2-3 on 2026-10-07 (week 2)',
    },
    { name: 'last rest day of the plan has no next', program: program(START_MON, mwfTree(2)), today: '2026-10-10', expected: 'rest week 2 next none' },
    { name: 'the day after the last week', program: program(START_MON, mwfTree(2)), today: '2026-10-12', expected: 'program_complete' },
    { name: 'a very old plan', program: program('2020-01-06', mwfTree(4)), today: '2026-09-30', expected: 'program_complete' },
    // Mid-week start: Wednesday 2026-09-30. Week 1 = 09-30 .. 10-06, week 2 = 10-07 .. 10-13.
    { name: 'mid-week start: the Wednesday start', program: program(START_WED, mwfTree(2)), today: '2026-09-30', expected: 'workout w1-3 week 1/2' },
    { name: 'mid-week start: Friday of week 1', program: program(START_WED, mwfTree(2)), today: '2026-10-02', expected: 'workout w1-5 week 1/2' },
    { name: 'mid-week start: Monday inside week 1', program: program(START_WED, mwfTree(2)), today: '2026-10-05', expected: 'workout w1-1 week 1/2' },
    { name: 'mid-week start: Monday of week 2', program: program(START_WED, mwfTree(2)), today: '2026-10-12', expected: 'workout w2-1 week 2/2' },
    { name: 'mid-week start: Tuesday rolls into week 2', program: program(START_WED, mwfTree(2)), today: '2026-10-06', expected: 'rest week 1 next w2-3 on 2026-10-07 (week 2)' },
    { name: 'mid-week start: after the last window', program: program(START_WED, mwfTree(2)), today: '2026-10-14', expected: 'program_complete' },
    { name: 'deload week', program: program(START_MON, mwfTree(3, [3])), today: '2026-10-12', expected: 'workout w3-1 week 3/3 deload' },
    { name: '24-week plan: last scheduled day', program: program(START_MON, mwfTree(24)), today: '2027-03-12', expected: 'workout w24-5 week 24/24' },
    { name: '24-week plan: first day after', program: program(START_MON, mwfTree(24)), today: '2027-03-15', expected: 'program_complete' },
    { name: 'month and year end', program: program('2026-12-28', mwfTree(2)), today: '2027-01-01', expected: 'workout w1-5 week 1/2' },
  ];

  it.each(table)('$name', ({ program: input, today, done, expected }) => {
    const result = resolveToday({ program: input, today, completedProgramWorkoutIds: new Set(done ?? []) });
    expect(summarize(result)).toBe(expected);
  });

  it('a sparse plan with nothing within 14 days answers next: null', () => {
    const tree = mwfTree(4);
    tree.blocks[0].weeks[1].workouts = [];
    tree.blocks[0].weeks[2].workouts = [];
    tree.blocks[0].weeks[0].workouts = [workout('only', 1)];
    const result = resolveToday({ program: program(START_MON, tree), today: '2026-09-29', completedProgramWorkoutIds: new Set() });
    expect(summarize(result)).toBe('rest week 1 next none');
  });

  it('counts a workout done once however many sessions were logged', () => {
    const result = resolveToday({
      program: program(START_MON, mwfTree(1)),
      today: '2026-09-28',
      completedProgramWorkoutIds: new Set(['w1-1', 'w1-1']),
    });
    expect(result).toMatchObject({ kind: 'workout', done: true });
  });

  it('ignores unscheduled workouts', () => {
    const tree = mwfTree(1);
    tree.blocks[0].weeks[0].workouts.push(workout('floating', null, 3));
    const result = resolveToday({ program: program(START_MON, tree), today: '2026-09-29', completedProgramWorkoutIds: new Set() });
    expect(summarize(result)).toBe('rest week 1 next w1-3 on 2026-09-30 (week 1)');
  });

  it('two workouts on one date: the lower position wins and a warning is raised', () => {
    const tree = mwfTree(1);
    tree.blocks[0].weeks[0].workouts = [workout('late', 1, 5), workout('early', 1, 2)];
    const warnings: string[] = [];
    const result = resolveToday({
      program: program(START_MON, tree),
      today: '2026-09-28',
      completedProgramWorkoutIds: new Set(),
      onWarning: (message) => warnings.push(message),
    });
    expect(summarize(result)).toBe('workout early week 1/1');
    expect(warnings).toHaveLength(1);
  });

  it('weeks spread over several blocks resolve by program-wide week number', () => {
    const tree = mwfTree(2);
    const [first, second] = tree.blocks[0].weeks;
    tree.blocks = [
      { id: 'b1', position: 0, name: 'A', focus: null, rationale: null, weeks: [first] },
      { id: 'b2', position: 1, name: 'B', focus: null, rationale: null, weeks: [second] },
    ];
    const result = resolveToday({ program: program(START_MON, tree), today: '2026-10-07', completedProgramWorkoutIds: new Set() });
    expect(summarize(result)).toBe('workout w2-3 week 2/2');
  });

  it('refuses a malformed day', () => {
    expect(() => resolveToday({ program: null, today: '2026-02-30', completedProgramWorkoutIds: new Set() })).toThrow(RangeError);
  });

  it('never reads the clock', () => {
    const spy = jest.spyOn(Date, 'now');
    resolveToday({ program: program(START_MON, mwfTree(2)), today: '2026-10-04', completedProgramWorkoutIds: new Set() });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  describe('week', () => {
    const view = (week: WeekSession[]) =>
      week.map((entry) => `${entry.programWorkout.id} ${entry.date} ${entry.status}${entry.suggested ? ' *' : ''}`);

    it('a workout day lists the week with statuses and suggests today\'s workout', () => {
      const result = resolveToday({
        program: program(START_MON, mwfTree(2)),
        today: '2026-09-30',
        completedProgramWorkoutIds: new Set(),
      });
      expect(result.kind).toBe('workout');
      if (result.kind !== 'workout') return;
      expect(view(result.week)).toEqual(['w1-1 2026-09-28 missed', 'w1-3 2026-09-30 today *', 'w1-5 2026-10-02 upcoming']);
    });

    it('done wins over in_progress, in_progress over the date status', () => {
      const result = resolveToday({
        program: program(START_MON, mwfTree(2)),
        today: '2026-09-30',
        completedProgramWorkoutIds: new Set(['w1-1', 'w1-5']),
        inProgressProgramWorkoutIds: new Set(['w1-5', 'w1-3']),
      });
      if (result.kind !== 'workout') throw new Error(result.kind);
      expect(view(result.week)).toEqual(['w1-1 2026-09-28 done', 'w1-3 2026-09-30 in_progress *', 'w1-5 2026-10-02 done']);
    });

    it('a rest day suggests next when it falls in the current week', () => {
      const result = resolveToday({ program: program(START_MON, mwfTree(2)), today: '2026-09-29', completedProgramWorkoutIds: new Set() });
      if (result.kind !== 'rest_day') throw new Error(result.kind);
      expect(view(result.week)).toEqual(['w1-1 2026-09-28 missed', 'w1-3 2026-09-30 upcoming *', 'w1-5 2026-10-02 upcoming']);
    });

    it('a rest day whose next is in the following week suggests nothing in this week', () => {
      const result = resolveToday({ program: program(START_MON, mwfTree(2)), today: '2026-10-04', completedProgramWorkoutIds: new Set() });
      if (result.kind !== 'rest_day') throw new Error(result.kind);
      expect(result.next?.programWorkout.id).toBe('w2-1');
      expect(result.week.every((entry) => !entry.suggested)).toBe(true);
      expect(result.week.map((entry) => entry.status)).toEqual(['missed', 'missed', 'missed']);
    });

    it('mid-week start: the week window follows the plan week, not the calendar week', () => {
      const result = resolveToday({ program: program(START_WED, mwfTree(2)), today: '2026-10-02', completedProgramWorkoutIds: new Set(['w1-3']) });
      if (result.kind !== 'workout') throw new Error(result.kind);
      expect(view(result.week)).toEqual(['w1-3 2026-09-30 done', 'w1-5 2026-10-02 today *', 'w1-1 2026-10-05 upcoming']);
    });

    it('excludes unscheduled workouts and orders same-date sessions by position', () => {
      const tree = mwfTree(1);
      tree.blocks[0].weeks[0].workouts = [workout('late', 2, 5), workout('floating', null, 0), workout('early', 2, 1), workout('mon', 1, 9)];
      const week = resolveWeek({
        startDate: START_MON,
        weekNumber: 1,
        tree,
        today: '2026-09-28',
        completedProgramWorkoutIds: new Set(),
        suggestedProgramWorkoutId: 'mon',
      });
      expect(view(week)).toEqual(['mon 2026-09-28 today *', 'early 2026-09-29 upcoming', 'late 2026-09-29 upcoming']);
    });

    it('a week without workouts is empty', () => {
      const tree = mwfTree(2);
      tree.blocks[0].weeks[1].workouts = [];
      const week = resolveWeek({
        startDate: START_MON,
        weekNumber: 2,
        tree,
        today: '2026-10-06',
        completedProgramWorkoutIds: new Set(),
        suggestedProgramWorkoutId: null,
      });
      expect(week).toEqual([]);
      expect(resolveWeek({ startDate: START_MON, weekNumber: 9, tree, today: '2026-10-06', completedProgramWorkoutIds: new Set(), suggestedProgramWorkoutId: null })).toEqual([]);
    });
  });

  describe('helpers', () => {
    it.each([
      ['2026-09-28', 1],
      ['2026-10-04', 7],
      ['2027-01-01', 5],
    ])('isoWeekday(%s) = %d', (date, expected) => expect(isoWeekday(date)).toBe(expected));

    it.each([
      // start, week, weekday, expected
      ['2026-09-30', 1, 1, '2026-10-05'],
      ['2026-09-30', 1, 3, '2026-09-30'],
      ['2026-09-30', 2, 2, '2026-10-13'],
      ['2026-09-28', 1, 7, '2026-10-04'],
    ] as const)('occurrenceDate(%s, week %d, weekday %d) = %s', (start, week, weekday, expected) =>
      expect(occurrenceDate(start, week, weekday)).toBe(expected),
    );
  });
});
