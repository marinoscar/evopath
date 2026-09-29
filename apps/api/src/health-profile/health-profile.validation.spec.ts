import {
  checkDateOfBirth,
  earliestDateOfBirth,
  formatDateOnly,
  isValidTimeZone,
  latestTodayOnEarth,
  parseDateOnly,
} from './health-profile.validation';

describe('health-profile.validation', () => {
  describe('parseDateOnly / formatDateOnly', () => {
    it('parses a real date to UTC midnight', () => {
      const date = parseDateOnly('1990-06-15');

      expect(date?.toISOString()).toBe('1990-06-15T00:00:00.000Z');
    });

    it('accepts a leap day in a leap year and round-trips it', () => {
      const date = parseDateOnly('2000-02-29');

      expect(date).not.toBeNull();
      expect(formatDateOnly(date as Date)).toBe('2000-02-29');
    });

    it.each(['2026-02-30', '2025-02-29', '1900-02-29', '2024-13-01', '2024-00-10', '2024-04-31'])(
      'refuses the impossible date %s',
      (value) => {
        expect(parseDateOnly(value)).toBeNull();
      },
    );

    it.each(['1990-6-15', '15/06/1990', '1990-06-15T00:00:00Z', '', 'yesterday'])(
      'refuses the malformed value %j',
      (value) => {
        expect(parseDateOnly(value)).toBeNull();
      },
    );
  });

  describe('latestTodayOnEarth', () => {
    it('is the UTC+14 calendar date', () => {
      expect(latestTodayOnEarth(new Date('2026-09-29T09:59:59.000Z'))).toBe('2026-09-29');
      expect(latestTodayOnEarth(new Date('2026-09-29T10:00:00.000Z'))).toBe('2026-09-30');
    });
  });

  describe('earliestDateOfBirth', () => {
    it('is 120 years before the UTC date', () => {
      expect(earliestDateOfBirth(new Date('2026-09-29T12:00:00.000Z'))).toBe('1906-09-29');
    });

    it('falls back to 28 February when today is a leap day', () => {
      // 2020 is a leap year; 1900 is not (divisible by 100, not by 400).
      expect(earliestDateOfBirth(new Date('2020-02-29T12:00:00.000Z'))).toBe('1900-02-28');
    });
  });

  describe('checkDateOfBirth', () => {
    const now = new Date('2026-09-29T12:00:00.000Z');

    it('accepts an ordinary date', () => {
      expect(checkDateOfBirth('1990-06-15', now)).toBeNull();
    });

    it('accepts today and the oldest boundary', () => {
      expect(checkDateOfBirth('2026-09-29', now)).toBeNull();
      expect(checkDateOfBirth('1906-09-29', now)).toBeNull();
    });

    it('accepts tomorrow-in-UTC when it is already today in UTC+14', () => {
      expect(checkDateOfBirth('2026-09-30', now)).toBeNull();
    });

    it('refuses a future date', () => {
      expect(checkDateOfBirth('2026-10-01', now)).toBe('future');
      expect(checkDateOfBirth('2100-01-01', now)).toBe('future');
    });

    it('refuses a date more than 120 years ago', () => {
      expect(checkDateOfBirth('1906-09-28', now)).toBe('too_old');
    });

    it('refuses an impossible date', () => {
      expect(checkDateOfBirth('2026-02-30', now)).toBe('invalid');
    });
  });

  describe('isValidTimeZone', () => {
    it.each(['UTC', 'Europe/Madrid', 'America/Costa_Rica', 'Asia/Kolkata'])('accepts %s', (zone) => {
      expect(isValidTimeZone(zone)).toBe(true);
    });

    it.each(['', 'Mars/Base', 'Not a zone'])('refuses %j', (zone) => {
      expect(isValidTimeZone(zone)).toBe(false);
    });
  });
});
