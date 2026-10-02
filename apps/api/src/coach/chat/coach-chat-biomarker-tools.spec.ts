import { toDisplayUnit } from '../../measurements/metric-registry';
import { createCoachChatTools, type CoachChatToolDeps } from './tools';
import {
  COACH_BIOMARKER_LIST_MAX,
  COACH_BIOMARKER_READINGS_MAX,
  outOfRangeOf,
} from './tools/biomarker.tools';

// =============================================================================
// list_biomarkers and get_biomarker_values (#327): consent-gated, minimised
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-01T12:00:00.000Z');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MEASUREMENT_ID = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function item(key: string, label: string, panel: string, value: number, extra: Record<string, unknown> = {}) {
  return {
    analyteKey: key,
    label,
    panel,
    unit: 'mg/dL',
    latest: {
      measurementId: MEASUREMENT_ID,
      value,
      measuredAt: '2026-09-15T08:00:00.000Z',
      flag: null,
      referenceLow: null,
      referenceHigh: null,
      referenceText: 'PRINTED-REFERENCE-TEXT',
      ...extra,
    },
    previous: null,
    delta: null,
    count: 3,
  };
}

function makeDeps() {
  return {
    prisma: {
      measurement: { findMany: jest.fn().mockResolvedValue([]) },
    },
    signals: { forUser: jest.fn() },
    today: { today: jest.fn() },
    checkIns: { today: jest.fn(), list: jest.fn() },
    photos: { summarize: jest.fn() },
    now: () => NOW,
    profile: {
      healthProfile: { get: jest.fn().mockResolvedValue({ unitSystem: 'metric', labUnits: 'conventional' }) },
      userSettings: { getSettings: jest.fn().mockResolvedValue({}), patchSettings: jest.fn() },
    },
    healthSummary: { consentOn: jest.fn().mockResolvedValue(true), forTraining: jest.fn() },
    labs: {
      summary: jest.fn().mockResolvedValue({
        items: [
          item('tsh', 'TSH', 'thyroid', 2.1),
          item('ldl_cholesterol', 'LDL cholesterol', 'lipids', 162, { flag: 'high', referenceHigh: 100 }),
          item('hdl_cholesterol', 'HDL cholesterol', 'lipids', 55, { referenceLow: 40 }),
          item('fasting_glucose', 'Fasting glucose', 'glycemic', 88, { flag: 'normal', referenceLow: 70, referenceHigh: 99 }),
        ],
      }),
    },
  };
}

async function run(deps: unknown, name: string, args: unknown = {}) {
  const tool = createCoachChatTools(deps as CoachChatToolDeps, { pausedUntil: null }).find((t) => t.tool.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const parsed = tool.parseArguments(JSON.stringify(args));
  if (!parsed.success) throw new Error(parsed.error);
  return tool.execute(parsed.data, { userId: USER }) as Promise<any>;
}

describe('outOfRangeOf', () => {
  it('prefers the lab flag, then the numeric range, else unknown', () => {
    expect(outOfRangeOf(5, 'high', null, null)).toBe(true);
    expect(outOfRangeOf(5, 'critical', null, null)).toBe(true);
    expect(outOfRangeOf(500, 'normal', 1, 10)).toBe(false);
    expect(outOfRangeOf(12, null, 1, 10)).toBe(true);
    expect(outOfRangeOf(0.5, null, 1, null)).toBe(true);
    expect(outOfRangeOf(5, null, 1, 10)).toBe(false);
    expect(outOfRangeOf(5, 'unknown', null, null)).toBeNull();
    expect(outOfRangeOf(5, null, null, null)).toBeNull();
  });
});

describe('list_biomarkers (#327)', () => {
  it('answers consent_off (and reads nothing) while the health consent is off', async () => {
    const deps = makeDeps();
    deps.healthSummary.consentOn.mockResolvedValue(false);
    expect(await run(deps, 'list_biomarkers')).toEqual({ available: false, reason: 'consent_off' });
    expect(deps.healthSummary.consentOn).toHaveBeenCalledWith(USER);
    expect(deps.labs.summary).not.toHaveBeenCalled();
  });

  it('lists every analyte for the caller, sorted by panel then label, with flags; no ids or printed text', async () => {
    const deps = makeDeps();
    const result = await run(deps, 'list_biomarkers');

    expect(deps.labs.summary).toHaveBeenCalledWith(USER, { outOfRange: false });
    expect(result.available).toBe(true);
    expect(result.labUnits).toBe('conventional');
    expect(result.biomarkers.map((b: any) => b.key)).toEqual(['hdl_cholesterol', 'ldl_cholesterol', 'fasting_glucose', 'tsh']);
    const ldl = result.biomarkers.find((b: any) => b.key === 'ldl_cholesterol');
    expect(ldl).toEqual({
      key: 'ldl_cholesterol',
      label: 'LDL cholesterol',
      panel: 'lipids',
      unit: 'mg/dL',
      latest: { date: '2026-09-15', value: 162, referenceLow: null, referenceHigh: 100, flag: 'high', outOfRange: true },
      readings: 3,
    });
    expect(result.biomarkers.find((b: any) => b.key === 'hdl_cholesterol').latest.outOfRange).toBe(false);
    expect(result.biomarkers.find((b: any) => b.key === 'tsh').latest.outOfRange).toBeNull();
    const sent = JSON.stringify(result);
    expect(sent).not.toMatch(UUID);
    expect(sent).not.toContain('PRINTED-REFERENCE-TEXT');
    expect(sent).not.toMatch(/measurementId|referenceText/);
  });

  it('shows values in the SI preference', async () => {
    const deps = makeDeps();
    deps.profile.healthProfile.get.mockResolvedValue({ unitSystem: 'metric', labUnits: 'si' });
    const result = await run(deps, 'list_biomarkers');
    const ldl = result.biomarkers.find((b: any) => b.key === 'ldl_cholesterol');
    expect(result.labUnits).toBe('si');
    expect(ldl.unit).toBe('mmol/L');
    expect(ldl.latest.value).toBe(toDisplayUnit('ldl_cholesterol', 162, 'mmol/L'));
    expect(ldl.latest.referenceHigh).toBe(toDisplayUnit('ldl_cholesterol', 100, 'mmol/L'));
  });

  it(`caps the list at ${COACH_BIOMARKER_LIST_MAX} and says it was truncated`, async () => {
    const deps = makeDeps();
    deps.labs.summary.mockResolvedValue({
      items: Array.from({ length: COACH_BIOMARKER_LIST_MAX + 5 }, (_, i) => item(`x_${String(i).padStart(3, '0')}`, `X ${i}`, 'other', i)),
    });
    const result = await run(deps, 'list_biomarkers');
    expect(result.biomarkers).toHaveLength(COACH_BIOMARKER_LIST_MAX);
    expect(result).toMatchObject({ truncated: true, total: COACH_BIOMARKER_LIST_MAX + 5 });
  });

  it('answers unavailable without its deps or on a failed read', async () => {
    const deps = makeDeps();
    expect(await run({ ...deps, labs: undefined }, 'list_biomarkers')).toMatchObject({ error: 'unavailable' });
    deps.labs.summary.mockRejectedValue(new Error('db 10.0.0.5'));
    const result = await run(deps, 'list_biomarkers');
    expect(result).toMatchObject({ error: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('10.0.0.5');
  });
});

describe('get_biomarker_values (#327)', () => {
  const row = (date: string, value: number, extra: Record<string, unknown> = {}) => ({
    value,
    measuredAt: new Date(`${date}T08:00:00.000Z`),
    flag: null,
    referenceLow: 0,
    referenceHigh: 100,
    ...extra,
  });

  it('answers consent_off (and reads nothing) while the health consent is off', async () => {
    const deps = makeDeps();
    deps.healthSummary.consentOn.mockResolvedValue(false);
    expect(await run(deps, 'get_biomarker_values', { keys: ['ldl_cholesterol'], sinceDays: null })).toEqual({
      available: false,
      reason: 'consent_off',
    });
    expect(deps.prisma.measurement.findMany).not.toHaveBeenCalled();
  });

  it('reads active rows of the caller per key, newest first, capped; unknown keys listed, not thrown', async () => {
    const deps = makeDeps();
    deps.prisma.measurement.findMany.mockResolvedValue([
      row('2026-09-15', 162, { flag: 'high' }),
      row('2026-03-02', 98),
    ]);
    const result = await run(deps, 'get_biomarker_values', { keys: ['ldl_cholesterol', 'not_a_lab', 'weight'], sinceDays: null });

    expect(deps.prisma.measurement.findMany).toHaveBeenCalledTimes(1);
    const query = deps.prisma.measurement.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ userId: USER, supersededAt: null, deletedAt: null, metricKey: 'ldl_cholesterol' });
    expect(query.take).toBe(COACH_BIOMARKER_READINGS_MAX);
    expect(query.orderBy).toEqual([{ measuredAt: 'desc' }, { createdAt: 'desc' }]);
    expect(Object.keys(query.select).sort()).toEqual(['flag', 'measuredAt', 'referenceHigh', 'referenceLow', 'value']);

    expect(result).toEqual({
      available: true,
      labUnits: 'conventional',
      biomarkers: [
        {
          key: 'ldl_cholesterol',
          label: 'LDL cholesterol',
          panel: 'lipids',
          unit: 'mg/dL',
          readings: [
            { date: '2026-09-15', value: 162, referenceLow: 0, referenceHigh: 100, flag: 'high', outOfRange: true },
            { date: '2026-03-02', value: 98, referenceLow: 0, referenceHigh: 100, flag: null, outOfRange: false },
          ],
        },
      ],
      // `weight` is a metric but not a lab analyte: never readable here.
      unknown: ['not_a_lab', 'weight'],
    });
  });

  it('limits to sinceDays', async () => {
    const deps = makeDeps();
    await run(deps, 'get_biomarker_values', { keys: ['ldl_cholesterol'], sinceDays: 30 });
    const query = deps.prisma.measurement.findMany.mock.calls[0][0];
    expect(query.where.measuredAt).toEqual({ gte: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000) });
  });

  it.each([
    [{ keys: [], sinceDays: null }, 'INVALID_KEYS'],
    [{ keys: Array.from({ length: 11 }, (_, i) => `k${i}`), sinceDays: null }, 'INVALID_KEYS'],
    [{ keys: ['ldl_cholesterol'], sinceDays: 0 }, 'INVALID_SINCE_DAYS'],
    [{ keys: ['ldl_cholesterol'], sinceDays: 3651 }, 'INVALID_SINCE_DAYS'],
    [{ keys: ['ldl_cholesterol'], sinceDays: 2.5 }, 'INVALID_SINCE_DAYS'],
  ])('refuses %j with %s and reads nothing', async (args, error) => {
    const deps = makeDeps();
    expect(await run(deps, 'get_biomarker_values', args)).toMatchObject({ ok: false, error });
    expect(deps.prisma.measurement.findMany).not.toHaveBeenCalled();
  });

  it('a known key with no readings answers an empty list', async () => {
    const deps = makeDeps();
    const result = await run(deps, 'get_biomarker_values', { keys: ['tsh'], sinceDays: null });
    expect(result.biomarkers).toEqual([{ key: 'tsh', label: expect.any(String), panel: 'thyroid', unit: expect.any(String), readings: [] }]);
    expect(result.unknown).toEqual([]);
  });
});
