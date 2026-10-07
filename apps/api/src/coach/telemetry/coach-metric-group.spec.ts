import {
  DEFAULT_VERDICT_THRESHOLDS,
  TELEMETRY_VERDICT_THRESHOLDS,
  TelemetryModule,
  metricGroupRegistry,
  type CounterFamily,
} from '@marinoscar/platform-api/telemetry';

import { EVOPATH_METRIC_NAMES } from '../../app-metrics/domain-metric-names';
import { platformHost } from '../../platform/platform-host';
import { TelemetryHostModule } from '../../platform/telemetry/telemetry-host.module';
import { APP_METRIC_GROUPS, telemetryModule } from '../../platform/telemetry/telemetry.config';
import {
  COACH_FAILURE_VERDICT,
  COACH_METRIC_FILTERS,
  COACH_METRIC_GROUP,
  COACH_METRIC_GROUP_ID,
} from './coach-metric-group';

// =============================================================================
// The `coach` Telemetry Dashboard metric group (marinoscar/EnterpriseAppBase#719)
// =============================================================================
//
// The group is pure data handed to `TelemetryModule.forRoot({ metricGroups })`
// by `platform/telemetry/telemetry.config.ts`. These cases pin what the
// dashboard will read: the eight families, their tables (each one the counter
// `EvoPathMetricsService` emits, as GreptimeDB names it), the label each one
// is split by, and that the group is registered exactly once.
// =============================================================================

/** The table GreptimeDB stores an OTLP counter in: dots as underscores, plus `_total`. */
function counterTable(metricName: string): string {
  return `${metricName.replace(/\./g, '_')}_total`;
}

const EXPECTED: ReadonlyArray<{
  key: string;
  label: string;
  metric: keyof typeof EVOPATH_METRIC_NAMES;
  groupBy: string;
  failure: boolean;
}> = [
  { key: 'coachNudgesSent', label: 'Nudges sent', metric: 'coachNudgeSent', groupBy: 'moment', failure: false },
  { key: 'coachNudgesSuppressed', label: 'Nudges suppressed', metric: 'coachNudgeSuppressed', groupBy: 'reason', failure: false },
  { key: 'coachNudgesOpened', label: 'Nudges opened', metric: 'coachNudgeOpened', groupBy: 'moment', failure: false },
  { key: 'coachNudgesConverted', label: 'Nudges converted', metric: 'coachNudgeConverted', groupBy: 'target', failure: false },
  { key: 'coachNudgeFallbacks', label: 'Static fallbacks', metric: 'coachNudgeFallback', groupBy: 'moment', failure: false },
  { key: 'coachGuardRejections', label: 'Content-guard rejections', metric: 'coachGuardRejected', groupBy: 'reason', failure: true },
  { key: 'coachAudioFailures', label: 'Voice fallbacks to text', metric: 'coachAudioFailed', groupBy: 'reason', failure: true },
  { key: 'coachFeedback', label: 'Feedback', metric: 'coachFeedback', groupBy: 'value', failure: false },
];

describe('COACH_METRIC_GROUP', () => {
  it('is the `coach` group, ordered after the six platform groups', () => {
    expect(COACH_METRIC_GROUP).toMatchObject({ id: 'coach', label: 'Coach', title: 'AI Coach', order: 70 });
    expect(COACH_METRIC_GROUP_ID).toBe('coach');
    expect(COACH_METRIC_GROUP.description.length).toBeGreaterThan(20);
    expect(COACH_METRIC_GROUP.ratios ?? []).toEqual([]);
    expect(COACH_METRIC_GROUP.tables ?? []).toEqual([]);
  });

  it('declares exactly the eight families, in dashboard order', () => {
    expect(COACH_METRIC_GROUP.families.map((family) => family.key)).toEqual(EXPECTED.map((e) => e.key));
    expect(COACH_METRIC_GROUP.families.map((family) => family.label)).toEqual(EXPECTED.map((e) => e.label));
  });

  it.each(EXPECTED)('$key reads the counter table of $metric, split by $groupBy', ({ key, metric, groupBy }) => {
    const family = COACH_METRIC_GROUP.families.find((f) => f.key === key) as CounterFamily;

    expect(family.table).toBe(counterTable(EVOPATH_METRIC_NAMES[metric]));
    expect(family).toMatchObject({
      group: 'coach',
      kind: 'counter',
      groupBy,
      requiredColumns: [groupBy],
      filters: ['service', 'instance'],
    });
  });

  it('counts the informational families and rates the two failure families per minute', () => {
    for (const { key, failure } of EXPECTED) {
      const family = COACH_METRIC_GROUP.families.find((f) => f.key === key) as CounterFamily;
      if (failure) {
        expect(family).toMatchObject({ unit: 'per_min', rate: 'per_min', verdict: { degraded: 5, critical: 20, direction: 'above' } });
      } else {
        expect(family).toMatchObject({ unit: 'count', rate: 'count' });
        expect(family.verdict).toBeUndefined();
      }
    }
    expect(COACH_FAILURE_VERDICT).toEqual({ degraded: 5, critical: 20, direction: 'above' });
  });

  it("filters by the platform's app-metric pair (service, instance)", () => {
    expect(COACH_METRIC_FILTERS).toEqual(['service', 'instance']);
  });
});

describe('coach group registration', () => {
  it('is the only app group the binding passes to TelemetryModule.forRoot', () => {
    expect(APP_METRIC_GROUPS).toEqual([COACH_METRIC_GROUP]);
    expect(telemetryModule.module).toBe(TelemetryModule);
  });

  it('is registered exactly once, as the very definition, after the six platform groups', () => {
    const ids = metricGroupRegistry.list().map((group) => group.id);

    expect(ids).toEqual(['host', 'database', 'queue', 'nodes', 'uptime', 'pipeline', 'coach']);
    expect(metricGroupRegistry.get('coach')).toBe(COACH_METRIC_GROUP);
  });

  it('a second forRoot with the same definition registers nothing more', () => {
    expect(() =>
      TelemetryModule.forRoot({ host: platformHost, imports: [TelemetryHostModule], metricGroups: APP_METRIC_GROUPS }),
    ).not.toThrow();
    expect(metricGroupRegistry.list().filter((group) => group.id === 'coach')).toHaveLength(1);
  });

  it('a different definition under the same id fails, as a duplicate group id must', () => {
    const impostor = { ...COACH_METRIC_GROUP, families: [...COACH_METRIC_GROUP.families] };

    expect(() =>
      TelemetryModule.forRoot({ host: platformHost, imports: [TelemetryHostModule], metricGroups: [impostor] }),
    ).toThrow(/coach/);
    expect(metricGroupRegistry.get('coach')).toBe(COACH_METRIC_GROUP);
  });

  it('passes no verdict override: the resolved thresholds are the platform defaults', () => {
    const provider = (telemetryModule.providers ?? []).find(
      (p): p is { provide: symbol; useValue: unknown } =>
        typeof p === 'object' && p !== null && 'provide' in p && p.provide === TELEMETRY_VERDICT_THRESHOLDS,
    );

    expect(provider?.useValue).toEqual(DEFAULT_VERDICT_THRESHOLDS);
  });
});
