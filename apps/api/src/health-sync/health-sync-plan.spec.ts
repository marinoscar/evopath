import { BadRequestException } from '@nestjs/common';

import { syncSchema, type SyncInput } from './dto/health-sync.dto';
import { assignEntryIds, allowedDays, lastWins, planSync, reconcileScope, syncedTypesOf } from './health-sync-plan';
import { SYNCED_TYPE_NAMES, SYNCED_TYPE_SCOPES } from './health-sync.constants';

const TODAY = '2026-10-01';

function input(overrides: Partial<SyncInput> = {}, run: Partial<SyncInput['run']> = {}): SyncInput {
  return syncSchema.parse({
    run: {
      trigger: 'periodic',
      status: 'ok',
      startedAt: '2026-10-01T10:00:00Z',
      finishedAt: '2026-10-01T10:00:05Z',
      ...run,
    },
    entries: [],
    ...overrides,
  });
}

function refusal(fn: () => unknown): { reason?: string; path?: string } {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return ((error as BadRequestException).getResponse() as { details: { reason: string; path: string } }).details;
  }
  throw new Error('expected a refusal');
}

const steps = (externalId: string, occurredOn: string, value = 1000) => ({
  externalId,
  occurredOn,
  activityKind: 'steps' as const,
  steps: value,
});

describe('health sync plan', () => {
  describe('allowed days', () => {
    it('is [today - 30, today + 1]', () => {
      expect(allowedDays(TODAY)).toEqual({ from: '2026-09-01', to: '2026-10-02' });
    });

    it('accepts both edges and refuses one day beyond each, naming the path', () => {
      expect(planSync(input({ entries: [steps('a', '2026-09-01'), steps('b', '2026-10-02')] }), TODAY, null).entries).toHaveLength(2);
      expect(refusal(() => planSync(input({ entries: [steps('a', '2026-08-31')] }), TODAY, null))).toMatchObject({
        reason: 'ENTRY_DATE_OUT_OF_RANGE',
        path: 'entries.0.occurredOn',
      });
      expect(
        refusal(() => planSync(input({ entries: [steps('a', TODAY), steps('b', '2026-10-03')] }), TODAY, null)),
      ).toMatchObject({ path: 'entries.1.occurredOn' });
    });
  });

  describe('window', () => {
    it('refuses a window over 31 days with WINDOW_TOO_LARGE', () => {
      expect(
        refusal(() => planSync(input({ window: { from: '2026-09-01', to: '2026-10-02' } }), TODAY, null)),
      ).toMatchObject({ reason: 'WINDOW_TOO_LARGE' });
      expect(planSync(input({ window: { from: '2026-09-02', to: '2026-10-02' } }), TODAY, null).reconcile).not.toBeNull();
    });

    it('refuses a window outside the allowed days', () => {
      expect(refusal(() => planSync(input({ window: { from: '2026-08-31', to: '2026-09-05' } }), TODAY, null))).toMatchObject({
        reason: 'ENTRY_DATE_OUT_OF_RANGE',
        path: 'window.from',
      });
    });

    it('refuses an entry or a sleep session outside the window', () => {
      const window = { from: '2026-09-25', to: TODAY };
      expect(refusal(() => planSync(input({ window, entries: [steps('a', '2026-09-24')] }), TODAY, null))).toMatchObject({
        path: 'entries.0.occurredOn',
      });
      const sleep = {
        externalId: 's',
        startAt: '2026-09-23T22:00:00Z',
        endAt: '2026-09-24T06:00:00Z',
        localDate: '2026-09-24',
        durationMinutes: 480,
      };
      expect(refusal(() => planSync(input({ window, sleepSessions: [sleep] }), TODAY, null))).toMatchObject({
        path: 'sleepSessions.0.localDate',
      });
    });

    it("computes a reading's local day in the user's zone and allows one day of slack around the window", () => {
      const window = { from: '2026-09-25', to: TODAY };
      const reading = (measuredAt: string) => ({
        externalId: measuredAt,
        metricKey: 'resting_hr' as const,
        value: 58,
        unit: 'bpm',
        measuredAt,
      });
      // 2026-09-25T03:00Z is 2026-09-24 in Costa Rica (UTC-6): one day of slack.
      const plan = planSync(input({ window, measurements: [reading('2026-09-25T03:00:00Z')] }), TODAY, 'America/Costa_Rica');
      expect(plan.measurements[0].localDate).toBe('2026-09-24');
      expect(
        refusal(() => planSync(input({ window, measurements: [reading('2026-09-23T03:00:00Z')] }), TODAY, 'America/Costa_Rica')),
      ).toMatchObject({ path: 'measurements.0.measuredAt' });
    });
  });

  describe('de-duplication and entry grouping', () => {
    it('keeps the last occurrence of a repeated external id', () => {
      const plan = planSync(input({ entries: [steps('a', TODAY, 1), steps('b', TODAY, 2), steps('a', TODAY, 3)] }), TODAY, null);
      expect(plan.entries.map((entry) => [entry.externalId, entry.steps])).toEqual([
        ['b', 2],
        ['a', 3],
      ]);
      expect(lastWins([{ externalId: 'x', n: 1 }, { externalId: 'x', n: 2 }])).toEqual([{ externalId: 'x', n: 2 }]);
    });

    it('gives readings sharing an entryKey one entry id and every other reading its own', () => {
      let next = 0;
      const ids = assignEntryIds(
        [{ entryKey: 'bp1' }, { entryKey: 'bp1' }, {}, { entryKey: 'bp2' }, {}],
        () => `id-${++next}`,
      ).map((reading) => reading.entryId);
      expect(ids).toEqual(['id-1', 'id-1', 'id-2', 'id-3', 'id-4']);
    });

    it('rounds a reading to the canonical precision', () => {
      const plan = planSync(
        input({ measurements: [{ externalId: 'w', metricKey: 'weight', value: 80.123456, unit: 'kg', measuredAt: '2026-10-01T07:00:00Z' }] }),
        TODAY,
        null,
      );
      expect(plan.measurements[0].value).toBe(80.1235);
    });
  });

  describe('reconciliation scope', () => {
    const window = { from: '2026-09-25', to: TODAY };

    it('maps every synced type name onto its rows', () => {
      expect(SYNCED_TYPE_NAMES.sort()).toEqual(
        ['blood_pressure', 'body_fat', 'exercise', 'heart_rate', 'hrv', 'resting_heart_rate', 'sleep', 'steps', 'weight'].sort(),
      );
      expect(reconcileScope(window, ['steps'])).toEqual({ window, activityKinds: ['steps'], metricKeys: [], sleep: false });
      expect(reconcileScope(window, ['exercise']).activityKinds).toEqual(['walk', 'run', 'cardio_any']);
      expect(reconcileScope(window, ['weight', 'body_fat', 'resting_heart_rate', 'heart_rate', 'hrv', 'blood_pressure'])).toEqual({
        window,
        activityKinds: [],
        metricKeys: ['weight', 'body_fat_pct', 'resting_hr', 'heart_rate_avg', 'hrv_rmssd', 'bp_systolic', 'bp_diastolic'],
        sleep: false,
      });
      expect(reconcileScope(window, ['sleep'])).toMatchObject({ activityKinds: [], metricKeys: [], sleep: true });
      expect(SYNCED_TYPE_SCOPES.sleep.table).toBe('sleep_sessions');
    });

    it('ignores unknown names and reconciles nothing without syncedTypes', () => {
      expect(reconcileScope(window, ['toString', 'nope'])).toEqual({ window, activityKinds: [], metricKeys: [], sleep: false });
      expect(syncedTypesOf(undefined)).toEqual([]);
      expect(syncedTypesOf({ syncedTypes: 'steps' })).toEqual([]);
      expect(syncedTypesOf({ syncedTypes: ['steps', 3, 'sleep'] })).toEqual(['steps', 'sleep']);
    });

    it('reconciles only with a window and run.status ok', () => {
      const details = { syncedTypes: ['steps'] };
      expect(planSync(input({ window }, { details }), TODAY, null).reconcile).toMatchObject({ activityKinds: ['steps'] });
      expect(planSync(input({ window }, { details, status: 'partial' }), TODAY, null).reconcile).toBeNull();
      expect(planSync(input({}, { details }), TODAY, null).reconcile).toBeNull();
    });
  });

  describe('payload schema', () => {
    const base = { run: { trigger: 'manual', status: 'ok', startedAt: '2026-10-01T10:00:00Z', finishedAt: '2026-10-01T10:00:01Z' }, entries: [] };

    it('requires steps on a steps entry and refuses non-sync kinds', () => {
      expect(syncSchema.safeParse({ ...base, entries: [{ externalId: 'a', occurredOn: TODAY, activityKind: 'steps' }] }).success).toBe(false);
      expect(syncSchema.safeParse({ ...base, entries: [{ externalId: 'a', occurredOn: TODAY, activityKind: 'custom' }] }).success).toBe(false);
    });

    it("validates a reading against the registry: canonical unit, bounds, method", () => {
      const reading = { externalId: 'r', metricKey: 'hrv_rmssd', value: 45, unit: 'ms', measuredAt: '2026-10-01T07:00:00Z' };
      expect(syncSchema.safeParse({ ...base, measurements: [reading] }).success).toBe(true);
      expect(syncSchema.safeParse({ ...base, measurements: [{ ...reading, unit: 's' }] }).success).toBe(false);
      expect(syncSchema.safeParse({ ...base, measurements: [{ ...reading, value: 0 }] }).success).toBe(false);
      expect(syncSchema.safeParse({ ...base, measurements: [{ ...reading, method: 'dexa' }] }).success).toBe(false);
      expect(syncSchema.safeParse({ ...base, measurements: [{ ...reading, metricKey: 'ldl_cholesterol', unit: 'mg/dL' }] }).success).toBe(false);
    });

    it('caps run.details at 32 KB serialized', () => {
      const details = { blob: 'x'.repeat(33 * 1024) };
      expect(syncSchema.safeParse({ ...base, run: { ...base.run, details } }).success).toBe(false);
    });
  });
});
