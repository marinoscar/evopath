import {
  isLastWeekOfBlock,
  isMissedSessionsCandidate,
  isMissedSessionsDue,
  isWeeklyDue,
  localWallTime,
  weeklyAnchorKey,
} from './evaluation-due';

const at = (iso: string) => new Date(iso);
// 2026-10-04 is a Sunday; the plan started on Monday 2026-09-21.
const START = '2026-09-21';

describe('localWallTime', () => {
  it.each([
    ['2026-10-04T17:30:00Z', 'UTC', { date: '2026-10-04', weekday: 7, hour: 17 }],
    ['2026-10-05T00:30:00Z', 'America/Los_Angeles', { date: '2026-10-04', weekday: 7, hour: 17 }],
    ['2026-10-04T15:00:00Z', 'Asia/Tokyo', { date: '2026-10-05', weekday: 1, hour: 0 }],
    ['2026-10-04T12:00:00Z', 'Not/AZone', { date: '2026-10-04', weekday: 7, hour: 12 }],
    ['2026-10-04T12:00:00Z', null, { date: '2026-10-04', weekday: 7, hour: 12 }],
  ])('%s in %s', (instant, zone, expected) => {
    expect(localWallTime(at(instant), zone)).toMatchObject(expected);
  });
});

describe('isWeeklyDue', () => {
  const due = (now: string, timeZone: string | null, last: string | null = null, startDate: string | null = START) =>
    isWeeklyDue({ now: at(now), timeZone, startDate, lastWeeklyEvaluationAt: last ? at(last) : null });

  // A plan started on Wednesday 2026-09-23: Sunday 09-27 is only 4 days in, so
  // Sunday 10-04 18:00 local is its first review.
  const WED = '2026-09-23';

  it.each<[string, string, string, boolean, string | null]>([
    // [label, now (UTC), zone, expected, last weekly review]
    ['UTC: Sunday 17:59 is not yet due', '2026-10-04T17:59:00Z', 'UTC', false, null],
    ['UTC: Sunday 18:00 is due', '2026-10-04T18:00:00Z', 'UTC', true, null],
    ['Los Angeles: Sunday 11:30 local (18:30 UTC) is not due', '2026-10-04T18:30:00Z', 'America/Los_Angeles', false, null],
    ['Los Angeles: Sunday 17:59 local is not due', '2026-10-05T00:59:00Z', 'America/Los_Angeles', false, null],
    ['Los Angeles: Sunday 18:00 local (Monday 01:00 UTC) is due', '2026-10-05T01:00:00Z', 'America/Los_Angeles', true, null],
    ['Tokyo: Sunday 17:59 local is not due', '2026-10-04T08:59:00Z', 'Asia/Tokyo', false, null],
    ['Tokyo: Sunday 18:00 local (09:00 UTC) is due', '2026-10-04T09:00:00Z', 'Asia/Tokyo', true, null],
    // Last review Sunday 10-18 18:05 CEST (16:05 UTC); DST ends on 10-25.
    ['Berlin, the day DST ends: 17:59 CET is not due', '2026-10-25T16:59:00Z', 'Europe/Berlin', false, '2026-10-18T16:05:00Z'],
    ['Berlin, the day DST ends: 18:00 CET is due', '2026-10-25T17:00:00Z', 'Europe/Berlin', true, '2026-10-18T16:05:00Z'],
    ['an unknown zone falls back to UTC', '2026-10-04T18:00:00Z', 'Mars/Olympus', true, null],
    ['an unknown zone falls back to UTC (not yet)', '2026-10-04T17:00:00Z', 'Mars/Olympus', false, null],
  ])('%s', (_label, now, zone, expected, last) => {
    expect(due(now, zone, last, WED)).toBe(expected);
  });

  it('fires once per week: not again the same week, again from the next Sunday 18:00', () => {
    const last = '2026-10-04T18:07:00Z';
    expect(due('2026-10-04T19:07:00Z', 'UTC', last)).toBe(false);
    expect(due('2026-10-07T12:00:00Z', 'UTC', last)).toBe(false);
    expect(due('2026-10-11T17:59:00Z', 'UTC', last)).toBe(false);
    expect(due('2026-10-11T18:07:00Z', 'UTC', last)).toBe(true);
  });

  it('catches up a missed Sunday on a later day of that week', () => {
    expect(due('2026-10-06T09:00:00Z', 'UTC', '2026-09-27T18:10:00Z')).toBe(true);
  });

  it('keeps at least 6 days between two reviews (a Tuesday catch-up moves the next one to Monday)', () => {
    const tuesday = '2026-10-06T10:00:00Z';
    expect(due('2026-10-11T18:00:00Z', 'UTC', tuesday)).toBe(false);
    expect(due('2026-10-12T10:00:00Z', 'UTC', tuesday)).toBe(true);
  });

  it('compares the last review with the anchor in local time', () => {
    // Reviewed at Sunday 18:30 Los Angeles time (Monday 01:30 UTC); a week later it is due again.
    expect(due('2026-10-12T00:59:00Z', 'America/Los_Angeles', '2026-10-05T01:30:00Z')).toBe(false);
    expect(due('2026-10-12T01:30:00Z', 'America/Los_Angeles', '2026-10-05T01:30:00Z')).toBe(true);
  });

  it('needs the plan to have been active at least 5 days on the Sunday', () => {
    expect(due('2026-10-04T18:00:00Z', 'UTC', null, '2026-09-30')).toBe(false); // 4 days
    expect(due('2026-10-04T18:00:00Z', 'UTC', null, '2026-09-29')).toBe(true); // 5 days
    expect(due('2026-10-07T12:00:00Z', 'UTC', null, '2026-09-30')).toBe(false); // mid-week, still the 4-day Sunday
    expect(due('2026-10-11T18:00:00Z', 'UTC', null, '2026-09-30')).toBe(true);
    expect(due('2026-10-04T18:00:00Z', 'UTC', null, null)).toBe(false); // never activated
  });

  it('anchors a Sunday before 18:00 on the previous Sunday', () => {
    expect(weeklyAnchorKey(at('2026-10-04T17:00:00Z'), 'UTC')).toBe('2026-09-27T18:00');
    expect(weeklyAnchorKey(at('2026-10-04T18:00:00Z'), 'UTC')).toBe('2026-10-04T18:00');
    expect(weeklyAnchorKey(at('2026-10-05T00:00:00Z'), 'UTC')).toBe('2026-10-04T18:00');
  });
});

describe('the missed-sessions rule', () => {
  it('is checked once a day per plan: in the local 06:00 hour, when the last evaluation is 3+ days old', () => {
    const now = at('2026-10-06T06:15:00Z');
    expect(isMissedSessionsCandidate({ now, timeZone: 'UTC', lastEvaluatedAt: null })).toBe(true);
    expect(isMissedSessionsCandidate({ now, timeZone: 'UTC', lastEvaluatedAt: at('2026-10-03T06:15:00Z') })).toBe(true);
    expect(isMissedSessionsCandidate({ now, timeZone: 'UTC', lastEvaluatedAt: at('2026-10-03T06:16:00Z') })).toBe(false);
    expect(isMissedSessionsCandidate({ now: at('2026-10-06T07:15:00Z'), timeZone: 'UTC', lastEvaluatedAt: null })).toBe(false);
    // 06:15 UTC is 15:15 in Tokyo; 06:xx in Tokyo is 21:xx UTC the day before.
    expect(isMissedSessionsCandidate({ now, timeZone: 'Asia/Tokyo', lastEvaluatedAt: null })).toBe(false);
    expect(isMissedSessionsCandidate({ now: at('2026-10-05T21:15:00Z'), timeZone: 'Asia/Tokyo', lastEvaluatedAt: null })).toBe(true);
  });

  it('needs a missed streak of 2', () => {
    expect(isMissedSessionsDue(0)).toBe(false);
    expect(isMissedSessionsDue(1)).toBe(false);
    expect(isMissedSessionsDue(2)).toBe(true);
    expect(isMissedSessionsDue(5)).toBe(true);
  });
});

describe('isLastWeekOfBlock', () => {
  const weeks = [
    { weekNumber: 1, blockId: 'a' },
    { weekNumber: 2, blockId: 'a' },
    { weekNumber: 3, blockId: 'a' },
    { weekNumber: 4, blockId: 'b' },
  ];

  it.each([
    ['2026-09-21', false], // week 1
    ['2026-10-04', false], // week 2 (day 13)
    ['2026-10-05', true], // week 3, the last of block a
    ['2026-10-12', true], // week 4, the only week of block b
    ['2026-10-19', false], // past the plan
    ['2026-09-20', false], // before the start
  ])('%s -> %s', (today, expected) => {
    expect(isLastWeekOfBlock(START, today, weeks)).toBe(expected);
  });

  it('is false for a plan that never started', () => {
    expect(isLastWeekOfBlock(null, '2026-10-05', weeks)).toBe(false);
  });
});
