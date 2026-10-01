import { OnboardingMetricsService } from './onboarding-metrics.service';

// =============================================================================
// OnboardingMetricsService (#212): raw aggregate row -> response DTO
// =============================================================================
// The SQL itself is proved against a real Postgres in
// test/onboarding/onboarding-metrics.db.spec.ts; this covers the mapping.
// =============================================================================

const row = (over: Record<string, unknown> = {}) => ({
  cohort_size: 10,
  eligible: 8,
  activated: 2,
  median_hours: 5.25,
  health_profile: 5,
  gym: 4,
  first_workout: 3,
  ai_plan: 1,
  ...over,
});

describe('OnboardingMetricsService', () => {
  let queryRaw: jest.Mock;
  let service: OnboardingMetricsService;

  beforeEach(() => {
    queryRaw = jest.fn();
    service = new OnboardingMetricsService({ $queryRaw: queryRaw } as never);
  });

  const run = (r: unknown, days = 30) => {
    queryRaw.mockResolvedValue(r === undefined ? [] : [r]);
    return service.metrics(days, new Date('2030-01-01T00:00:00Z'));
  };

  it('maps a row to the DTO with rates and step order', async () => {
    const out = await run(row(), 90);

    expect(out).toEqual({
      windowDays: 90,
      activationWindowDays: 7,
      cohortSize: 10,
      eligible: 8,
      activated: 2,
      activationRate: 0.25,
      medianHoursToFirstWorkout: 5.3,
      steps: [
        { id: 'health_profile', completed: 5, rate: 0.5 },
        { id: 'gym', completed: 4, rate: 0.4 },
        { id: 'first_workout', completed: 3, rate: 0.3 },
        { id: 'ai_plan', completed: 1, rate: 0.1 },
      ],
    });
  });

  describe('ai_plan reflects the "Meet your coach" done rule (E7.12)', () => {
    const sqlOf = () => {
      const sql = queryRaw.mock.calls[0][0] as { sql: string; values: unknown[] };
      return { text: sql.sql, values: sql.values };
    };

    it('requires a saved coach namespace while the system coach is on (the default without a settings service)', async () => {
      await run(row());
      const { text, values } = sqlOf();
      expect(text).toContain("jsonb_typeof(us.value -> 'coach') = 'object'");
      expect(values).toContain(true);
    });

    it('passes the switch through when the coach is off', async () => {
      service = new OnboardingMetricsService(
        { $queryRaw: queryRaw } as never,
        { getCoachPolicy: jest.fn().mockResolvedValue({ enabled: false }) } as never,
      );
      await run(row());
      expect(sqlOf().values).toContain(false);
      expect(sqlOf().values).not.toContain(true);
    });

    it('a failed policy read falls back to the plain program rule', async () => {
      service = new OnboardingMetricsService(
        { $queryRaw: queryRaw } as never,
        { getCoachPolicy: jest.fn().mockRejectedValue(new Error('db')) } as never,
      );
      await run(row());
      expect(sqlOf().values).toContain(false);
    });
  });

  it('issues exactly one query', async () => {
    await run(row());

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('gives null activationRate when nobody is eligible yet', async () => {
    const out = await run(row({ eligible: 0, activated: 0 }));

    expect(out.activationRate).toBeNull();
    expect(out.cohortSize).toBe(10);
  });

  it('gives null step rates and all zeros for an empty cohort', async () => {
    const out = await run(
      row({ cohort_size: 0, eligible: 0, activated: 0, median_hours: null, health_profile: 0, gym: 0, first_workout: 0, ai_plan: 0 }),
    );

    expect(out.activationRate).toBeNull();
    expect(out.medianHoursToFirstWorkout).toBeNull();
    expect(out.steps.every((s) => s.completed === 0 && s.rate === null)).toBe(true);
  });

  it('treats a missing row like an empty cohort', async () => {
    const out = await run(undefined);

    expect(out.cohortSize).toBe(0);
    expect(out.medianHoursToFirstWorkout).toBeNull();
    expect(out.steps).toHaveLength(4);
  });

  it.each([
    [1.04, 1],
    [1.05, 1.1],
    [2.25, 2.3],
    [0, 0],
    [47.96, 48],
  ])('rounds median %p to one decimal (%p)', async (raw, expected) => {
    const out = await run(row({ median_hours: raw }));

    expect(out.medianHoursToFirstWorkout).toBe(expected);
  });

  it('keeps a zero median as 0, not null', async () => {
    const out = await run(row({ median_hours: 0 }));

    expect(out.medianHoursToFirstWorkout).toBe(0);
  });

  it('coerces bigint and numeric-string values to numbers', async () => {
    const out = await run(
      row({
        cohort_size: BigInt(4),
        eligible: BigInt(2),
        activated: BigInt(1),
        median_hours: '3.14159',
        health_profile: BigInt(2),
        gym: BigInt(0),
        first_workout: BigInt(1),
        ai_plan: BigInt(4),
      }),
    );

    expect(out.cohortSize).toBe(4);
    expect(out.activationRate).toBe(0.5);
    expect(out.medianHoursToFirstWorkout).toBe(3.1);
    expect(out.steps.map((s) => s.completed)).toEqual([2, 0, 1, 4]);
    expect(out.steps.map((s) => s.rate)).toEqual([0.5, 0, 0.25, 1]);
    for (const v of [out.cohortSize, out.eligible, out.activated]) expect(typeof v).toBe('number');
  });

  it('passes the cohort and eligibility cutoffs derived from `now`', async () => {
    await run(row(), 30);

    const sql = queryRaw.mock.calls[0][0] as { values: unknown[] };
    const dates = sql.values.filter((v): v is Date => v instanceof Date).map((d) => d.toISOString());

    expect(dates).toContain('2029-12-02T00:00:00.000Z'); // now - 30d
    expect(dates).toContain('2029-12-25T00:00:00.000Z'); // now - 7d
  });
});
