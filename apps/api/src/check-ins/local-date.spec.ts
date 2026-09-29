import {
  addDays,
  fromDbDate,
  isRealDate,
  isWithinWindow,
  localDateInZone,
  toDbDate,
} from './local-date';

describe('local-date', () => {
  describe('localDateInZone', () => {
    it.each([
      // Ahead of UTC: already tomorrow.
      ['2026-09-29T12:30:00Z', 'Pacific/Auckland', '2026-09-30'],
      ['2026-09-29T10:59:59Z', 'Pacific/Auckland', '2026-09-29'],
      ['2026-09-29T11:00:00Z', 'Pacific/Auckland', '2026-09-30'],
      // UTC+14: the earliest day on Earth.
      ['2026-09-29T09:59:59Z', 'Pacific/Kiritimati', '2026-09-29'],
      ['2026-09-29T10:00:00Z', 'Pacific/Kiritimati', '2026-09-30'],
      // Behind UTC: still yesterday.
      ['2026-09-30T03:59:59Z', 'America/New_York', '2026-09-29'],
      ['2026-09-30T04:00:00Z', 'America/New_York', '2026-09-30'],
      ['2026-09-30T06:59:59Z', 'America/Los_Angeles', '2026-09-29'],
      ['2026-09-30T00:30:00Z', 'Pacific/Pago_Pago', '2026-09-29'],
      // Half-hour zone.
      ['2026-09-29T18:29:59Z', 'Asia/Kolkata', '2026-09-29'],
      ['2026-09-29T18:30:00Z', 'Asia/Kolkata', '2026-09-30'],
    ])('%s in %s is %s', (instant, zone, expected) => {
      expect(localDateInZone(new Date(instant), zone)).toBe(expected);
    });

    describe('DST transitions in America/New_York', () => {
      // 2026-03-08: clocks jump from 02:00 EST to 03:00 EDT; the day has 23 hours.
      it.each([
        ['2026-03-08T04:59:59Z', '2026-03-07'], // 23:59:59 EST on the 7th
        ['2026-03-08T05:00:00Z', '2026-03-08'], // 00:00 EST
        ['2026-03-08T06:59:59Z', '2026-03-08'], // 01:59:59 EST
        ['2026-03-08T07:00:00Z', '2026-03-08'], // 03:00 EDT
        ['2026-03-09T03:59:59Z', '2026-03-08'], // 23:59:59 EDT
        ['2026-03-09T04:00:00Z', '2026-03-09'], // midnight EDT
      ])('spring forward: %s is %s', (instant, expected) => {
        expect(localDateInZone(new Date(instant), 'America/New_York')).toBe(expected);
      });

      // 2026-11-01: clocks fall back from 02:00 EDT to 01:00 EST; the day has 25 hours.
      it.each([
        ['2026-11-01T03:59:59Z', '2026-10-31'], // 23:59:59 EDT on the 31st
        ['2026-11-01T04:00:00Z', '2026-11-01'], // midnight EDT
        ['2026-11-01T05:30:00Z', '2026-11-01'], // 01:30 EDT (first)
        ['2026-11-01T06:30:00Z', '2026-11-01'], // 01:30 EST (second)
        ['2026-11-02T04:59:59Z', '2026-11-01'], // 23:59:59 EST
        ['2026-11-02T05:00:00Z', '2026-11-02'], // midnight EST
      ])('fall back: %s is %s', (instant, expected) => {
        expect(localDateInZone(new Date(instant), 'America/New_York')).toBe(expected);
      });
    });

    it.each([null, undefined, '', 'Not/A_Zone', 'garbage'])('falls back to UTC for %p', (zone) => {
      expect(localDateInZone(new Date('2026-09-29T23:59:59Z'), zone)).toBe('2026-09-29');
      expect(localDateInZone(new Date('2026-09-30T00:00:00Z'), zone)).toBe('2026-09-30');
    });

    it('accepts UTC and Etc zones', () => {
      expect(localDateInZone(new Date('2026-12-31T23:00:00Z'), 'UTC')).toBe('2026-12-31');
      expect(localDateInZone(new Date('2026-12-31T23:00:00Z'), 'Etc/GMT-2')).toBe('2027-01-01');
    });
  });

  describe('isRealDate', () => {
    it.each(['2026-09-29', '2024-02-29', '2000-02-29', '2026-12-31', '2026-01-01'])('accepts %s', (value) => {
      expect(isRealDate(value)).toBe(true);
    });

    it.each([
      '2026-02-30',
      '2026-02-29', // not a leap year
      '1900-02-29', // not a leap year
      '2026-13-01',
      '2026-00-10',
      '2026-09-00',
      '2026-09-31',
      '2026-9-29',
      '20260929',
      '2026-09-29T00:00:00Z',
      ' 2026-09-29',
      '0099-01-01',
      '',
    ])('refuses %p', (value) => {
      expect(isRealDate(value)).toBe(false);
    });
  });

  describe('addDays', () => {
    it.each([
      ['2026-09-29', 1, '2026-09-30'],
      ['2026-09-30', 1, '2026-10-01'],
      ['2026-12-31', 1, '2027-01-01'],
      ['2026-03-01', -1, '2026-02-28'],
      ['2024-03-01', -1, '2024-02-29'],
      ['2026-09-29', -7, '2026-09-22'],
      ['2026-03-08', 1, '2026-03-09'], // across a DST change: calendar arithmetic only
      ['2026-11-01', -1, '2026-10-31'],
      ['2026-09-29', 0, '2026-09-29'],
    ])('%s %+d is %s', (date, n, expected) => {
      expect(addDays(date, n)).toBe(expected);
    });

    it('throws on an invalid date', () => {
      expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    });
  });

  describe('isWithinWindow', () => {
    const today = '2026-09-29';

    it.each([
      ['2026-09-29', true],
      ['2026-09-28', true],
      ['2026-09-22', true], // exactly 7 days back
      ['2026-09-21', false], // 8 days back
      ['2026-09-30', false], // tomorrow
      ['2026-02-30', false],
      ['not-a-date', false],
    ])('%s -> %s', (date, expected) => {
      expect(isWithinWindow(date, today)).toBe(expected);
    });

    it('honours a custom window', () => {
      expect(isWithinWindow('2026-09-28', today, 0)).toBe(false);
      expect(isWithinWindow('2026-09-29', today, 0)).toBe(true);
      expect(isWithinWindow('2026-08-30', today, 30)).toBe(true);
    });

    it('works across a year boundary', () => {
      expect(isWithinWindow('2026-12-26', '2027-01-02')).toBe(true);
      expect(isWithinWindow('2026-12-25', '2027-01-02')).toBe(false);
    });
  });

  describe('toDbDate / fromDbDate', () => {
    it('round-trips through UTC midnight', () => {
      const date = toDbDate('2026-09-29');
      expect(date.toISOString()).toBe('2026-09-29T00:00:00.000Z');
      expect(fromDbDate(date)).toBe('2026-09-29');
    });

    it('refuses an invalid date', () => {
      expect(() => toDbDate('2026-02-30')).toThrow(RangeError);
    });
  });
});
