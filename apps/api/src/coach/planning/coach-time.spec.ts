import { coachNow, isoWeekKey, isWithinQuietHours, parseTimeOfDay } from './coach-time';

describe('coach-time', () => {
  it.each([
    ['2026-10-01', '2026-W40'],
    ['2026-10-04', '2026-W40'],
    ['2026-10-05', '2026-W41'],
    ['2026-01-01', '2026-W01'],
    ['2027-01-01', '2026-W53'],
    ['2027-01-04', '2027-W01'],
    ['2024-12-30', '2025-W01'],
  ])('isoWeekKey(%s) = %s', (date, key) => {
    expect(isoWeekKey(date)).toBe(key);
  });

  it.each([
    ['00:00', 0],
    ['07:30', 450],
    ['23:59', 1439],
    ['24:00', null],
    ['7:30', null],
    [null, null],
  ])('parseTimeOfDay(%p) = %p', (value, minutes) => {
    expect(parseTimeOfDay(value)).toBe(minutes);
  });

  it('a quiet window whose start equals its end is empty', () => {
    expect(isWithinQuietHours(0, 600, 600)).toBe(false);
    expect(isWithinQuietHours(600, 600, 600)).toBe(false);
  });

  it('reads the wall clock, weekday and day of month in the zone', () => {
    // 2026-10-04T23:30Z is Monday 2026-10-05 05:00 in Kolkata.
    expect(coachNow(new Date('2026-10-04T23:30:00Z'), 'Asia/Kolkata')).toMatchObject({
      date: '2026-10-05',
      weekday: 1,
      dayOfMonth: 5,
      minuteOfDay: 5 * 60,
      timeZone: 'Asia/Kolkata',
      zoneFallback: false,
    });
  });

  it('an empty or unknown zone is UTC; only an unknown one is a fallback', () => {
    const instant = new Date('2026-10-01T00:30:00Z');
    expect(coachNow(instant, '')).toMatchObject({ timeZone: 'UTC', zoneFallback: false, minuteOfDay: 30 });
    expect(coachNow(instant, 'Bogus/Zone')).toMatchObject({ timeZone: 'UTC', zoneFallback: true, dayOfMonth: 1 });
  });
});
