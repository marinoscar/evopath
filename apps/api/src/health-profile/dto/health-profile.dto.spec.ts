import {
  HEALTH_PROFILE_BIO_MAX,
  healthProfileInputSchema,
  healthProfileSchema,
} from './health-profile.dto';

// The schema checks the date of birth against the real clock; fixed dates far
// from either boundary keep these cases independent of when they run.
const VALID = {
  dateOfBirth: '1990-06-15',
  sexAtBirth: 'female',
  heightMm: 1778,
  unitSystem: 'imperial',
  timeZone: 'Europe/Madrid',
  bio: 'Runner, vegetarian.',
} as const;

function yearsFromToday(years: number, dayOffset = 0): string {
  const now = new Date();
  const date = new Date(
    Date.UTC(now.getUTCFullYear() + years, now.getUTCMonth(), now.getUTCDate() + dayOffset),
  );
  return date.toISOString().slice(0, 10);
}

describe('healthProfileInputSchema', () => {
  it('accepts a full valid profile unchanged', () => {
    expect(healthProfileInputSchema.parse(VALID)).toEqual(VALID);
  });

  it('requires unitSystem', () => {
    const { unitSystem: _omit, ...rest } = VALID;

    expect(healthProfileInputSchema.safeParse(rest).success).toBe(false);
  });

  it('stores every omitted nullable field as null (full replace)', () => {
    expect(healthProfileInputSchema.parse({ unitSystem: 'metric' })).toEqual({
      dateOfBirth: null,
      sexAtBirth: null,
      heightMm: null,
      unitSystem: 'metric',
      timeZone: null,
      bio: null,
    });
  });

  it('accepts explicit nulls', () => {
    const parsed = healthProfileInputSchema.parse({
      dateOfBirth: null,
      sexAtBirth: null,
      heightMm: null,
      unitSystem: 'metric',
      timeZone: null,
      bio: null,
    });

    expect(parsed.dateOfBirth).toBeNull();
    expect(parsed.bio).toBeNull();
  });

  describe('dateOfBirth', () => {
    it('refuses a date in the future', () => {
      expect(
        healthProfileInputSchema.safeParse({ ...VALID, dateOfBirth: yearsFromToday(0, 2) }).success,
      ).toBe(false);
    });

    it('refuses a date more than 120 years ago', () => {
      expect(
        healthProfileInputSchema.safeParse({ ...VALID, dateOfBirth: yearsFromToday(-120, -2) })
          .success,
      ).toBe(false);
    });

    it('refuses a date that does not exist (2026-02-30)', () => {
      expect(healthProfileInputSchema.safeParse({ ...VALID, dateOfBirth: '2026-02-30' }).success).toBe(
        false,
      );
    });

    it('refuses a non YYYY-MM-DD value', () => {
      expect(
        healthProfileInputSchema.safeParse({ ...VALID, dateOfBirth: '1990-06-15T00:00:00Z' }).success,
      ).toBe(false);
    });

    it('accepts a leap-day birthday', () => {
      expect(healthProfileInputSchema.parse({ ...VALID, dateOfBirth: '2000-02-29' }).dateOfBirth).toBe(
        '2000-02-29',
      );
    });
  });

  describe('sexAtBirth', () => {
    it.each(['female', 'male', 'prefer_not_to_say'])('accepts %s', (value) => {
      expect(healthProfileInputSchema.parse({ ...VALID, sexAtBirth: value }).sexAtBirth).toBe(value);
    });

    it('refuses an unknown value', () => {
      expect(healthProfileInputSchema.safeParse({ ...VALID, sexAtBirth: 'x' }).success).toBe(false);
    });
  });

  describe('heightMm', () => {
    it.each([500, 2500])('accepts the boundary %d', (value) => {
      expect(healthProfileInputSchema.parse({ ...VALID, heightMm: value }).heightMm).toBe(value);
    });

    it.each([100, 499, 2501, 3000, 1778.5])('refuses %d', (value) => {
      expect(healthProfileInputSchema.safeParse({ ...VALID, heightMm: value }).success).toBe(false);
    });

    it('refuses a numeric string', () => {
      expect(healthProfileInputSchema.safeParse({ ...VALID, heightMm: '1778' }).success).toBe(false);
    });
  });

  describe('unitSystem', () => {
    it('refuses an unknown value', () => {
      expect(healthProfileInputSchema.safeParse({ ...VALID, unitSystem: 'si' }).success).toBe(false);
    });
  });

  describe('timeZone', () => {
    it('accepts UTC', () => {
      expect(healthProfileInputSchema.parse({ ...VALID, timeZone: 'UTC' }).timeZone).toBe('UTC');
    });

    it('trims before validating', () => {
      expect(
        healthProfileInputSchema.parse({ ...VALID, timeZone: '  America/Costa_Rica ' }).timeZone,
      ).toBe('America/Costa_Rica');
    });

    it.each(['Mars/Base', '', '   '])('refuses %j', (value) => {
      expect(healthProfileInputSchema.safeParse({ ...VALID, timeZone: value }).success).toBe(false);
    });
  });

  describe('bio', () => {
    it('trims', () => {
      expect(healthProfileInputSchema.parse({ ...VALID, bio: '  hello  ' }).bio).toBe('hello');
    });

    it.each(['', '    '])('stores %j as null', (value) => {
      expect(healthProfileInputSchema.parse({ ...VALID, bio: value }).bio).toBeNull();
    });

    it('accepts exactly the maximum length after trimming', () => {
      const bio = `  ${'a'.repeat(HEALTH_PROFILE_BIO_MAX)}  `;

      expect(healthProfileInputSchema.parse({ ...VALID, bio }).bio).toHaveLength(HEALTH_PROFILE_BIO_MAX);
    });

    it('refuses more than the maximum, without echoing the bio in the error', () => {
      const bio = `secret-${'a'.repeat(HEALTH_PROFILE_BIO_MAX)}`;
      const result = healthProfileInputSchema.safeParse({ ...VALID, bio });

      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).not.toContain('secret-');
    });
  });

  it('refuses unknown properties', () => {
    expect(healthProfileInputSchema.safeParse({ ...VALID, weightKg: 70 }).success).toBe(false);
  });
});

describe('healthProfileSchema (response)', () => {
  it('accepts the empty profile', () => {
    expect(
      healthProfileSchema.safeParse({
        dateOfBirth: null,
        sexAtBirth: null,
        heightMm: null,
        unitSystem: 'metric',
        timeZone: null,
        bio: null,
        version: 0,
        updatedAt: null,
      }).success,
    ).toBe(true);
  });
});
