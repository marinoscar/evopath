import {
  buildHealthDigest,
  digestHasData,
  digestHash,
  flaggedAnalytes,
  type DigestMeasurement,
  type HealthDigestSource,
} from './health-digest';

const DAY = 24 * 60 * 60 * 1000;
const END = new Date('2026-09-30T08:00:00.000Z');
const at = (daysAgo: number) => new Date(END.getTime() - daysAgo * DAY);
const day = (daysAgo: number) => at(daysAgo).toISOString().slice(0, 10);

function row(metricKey: string, value: number, daysAgo: number, extra: Partial<DigestMeasurement> = {}): DigestMeasurement {
  return { metricKey, value, measuredAt: at(daysAgo), localDate: null, flag: null, referenceLow: null, referenceHigh: null, ...extra };
}

function score(metricKey: string, value: number, daysAgo: number): DigestMeasurement {
  return row(metricKey, value, daysAgo, { localDate: day(daysAgo) });
}

function source(measurements: DigestMeasurement[], profile: HealthDigestSource['profile'] = null): HealthDigestSource {
  return { profile, measurements };
}

describe('buildHealthDigest (H8, #192)', () => {
  it('is empty (asOf null, no sections) without data', () => {
    const digest = buildHealthDigest(source([]));

    expect(digest).toEqual({ version: 1, asOf: null });
    expect(digestHasData(digest)).toBe(false);
  });

  it('labs: latest and previous per analyte with flag and numeric range, grouped by panel in catalog order', () => {
    const digest = buildHealthDigest(
      source([
        row('ferritin', 12.345, 10, { flag: 'low', referenceLow: 30, referenceHigh: 400 }),
        row('ferritin', 25, 200, { flag: 'low' }),
        row('ferritin', 40, 400, { flag: 'normal' }),
        row('ldl_cholesterol', 162, 10, { flag: 'high', referenceHigh: 100 }),
        row('hba1c', 5.4, 10),
      ]),
    );

    expect(digest.labs?.map((p) => p.panel)).toEqual(['lipids', 'glycemic', 'iron']);
    const ferritin = digest.labs!.find((p) => p.panel === 'iron')!.analytes[0];
    expect(ferritin).toEqual({
      key: 'ferritin',
      label: expect.any(String),
      unit: 'ng/mL',
      latest: { value: expect.any(Number), date: day(10), flag: 'low' },
      previous: { value: 25, date: day(200), flag: 'low' },
      range: { low: 30, high: 400 },
    });
    expect(digest.labs!.find((p) => p.panel === 'glycemic')!.analytes[0]).toMatchObject({ previous: null, range: null });
    expect(flaggedAnalytes(digest).sort()).toEqual(['ferritin', 'ldl_cholesterol']);
  });

  it('vitals: latest blood pressure pair, 30-day and prior 60-day averages, anchored on the newest vital', () => {
    const digest = buildHealthDigest(
      source([
        row('bp_systolic', 150, 1),
        row('bp_diastolic', 95, 1),
        row('bp_systolic', 140, 10),
        row('bp_diastolic', 90, 10),
        row('bp_systolic', 120, 50),
        row('bp_diastolic', 80, 50),
        row('bp_systolic', 200, 200),
        row('resting_hr', 62, 3),
        row('resting_hr', 70, 40),
      ]),
    );

    expect(digest.vitals).toEqual({
      asOf: day(1),
      bloodPressure: {
        latest: { systolic: 150, diastolic: 95, date: day(1) },
        recent30d: { systolic: { value: 145, readings: 2 }, diastolic: { value: 93, readings: 2 } },
        prior60d: { systolic: { value: 120, readings: 1 }, diastolic: { value: 80, readings: 1 } },
      },
      restingHeartRate: {
        latest: { value: 62, date: day(3) },
        recent30d: { value: 62, readings: 1 },
        prior60d: { value: 70, readings: 1 },
      },
    });
  });

  it('body: weight latest and 8-week trend, body fat and waist latest and previous', () => {
    const digest = buildHealthDigest(
      source([
        row('weight', 80, 0),
        row('weight', 81, 7),
        row('weight', 82, 14),
        row('weight', 90, 100),
        row('body_fat_pct', 20, 5),
        row('body_fat_pct', 22, 60),
        row('waist_circumference', 85, 5),
      ]),
    );

    expect(digest.body).toEqual({
      weightKg: { latest: 80, date: day(0), trendKgPerWeek: -1, readings8w: 3 },
      bodyFatPercent: { latest: 20, date: day(5), previous: 22 },
      waistCm: { latest: 85, date: day(5), previous: null },
    });
  });

  it('wellness: 28-day averages, low days, the streak ending at the newest check-in and the longest one', () => {
    const rows = [
      // Newest three days low (energy 1), then a normal day, then two low days, then normal.
      ...[0, 1, 2].map((d) => score('energy', 1, d)),
      score('energy', 4, 3),
      ...[4, 5].map((d) => score('stress', 5, d)),
      ...[4, 5].map((d) => score('energy', 3, d)),
      score('energy', 4, 6),
      // Outside the 28 days: ignored.
      score('energy', 1, 40),
    ];

    const digest = buildHealthDigest(source(rows));

    expect(digest.wellness).toEqual({
      asOf: day(0),
      days: 7,
      averages: { energy: 2.4, sleepQuality: null, soreness: null, stress: 5 },
      lowDays: 5,
      lowDayStreak: 3,
      longestLowDayStreak: 3,
    });
  });

  it('profile: whole-year age at the newest input and sex; never the birth date', () => {
    const digest = buildHealthDigest(source([row('weight', 80, 0)], { dateOfBirth: '1987-06-05', sexAtBirth: 'female' }));

    expect(digest.profile).toEqual({ ageYears: 39, sexAtBirth: 'female' });
    expect(JSON.stringify(digest)).not.toContain('1987');
  });

  it('copies no field outside the allow-list, whatever the source rows carry', () => {
    const leaky = {
      ...row('ferritin', 12, 1, { flag: 'low' }),
      notes: 'CANARY-NOTE',
      referenceText: 'CANARY-REF-TEXT',
      nameAsPrinted: 'CANARY-PRINTED',
      sourceRef: { documentId: 'CANARY-DOC', originalName: 'CANARY-FILE.pdf', labName: 'CANARY-LAB' },
      id: 'CANARY-ID',
      userId: 'CANARY-USER',
    } as DigestMeasurement;

    const text = JSON.stringify(buildHealthDigest(source([leaky])));

    expect(text).not.toMatch(/CANARY/);
  });

  it('the hash depends on the data only: same rows, same hash; a new reading changes it', () => {
    const rows = [row('weight', 80, 0), row('ferritin', 12, 1)];

    const a = digestHash(buildHealthDigest(source(rows)));
    const b = digestHash(buildHealthDigest(source([...rows].reverse())));
    const c = digestHash(buildHealthDigest(source([...rows, row('weight', 79, -1)])));

    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });
});
