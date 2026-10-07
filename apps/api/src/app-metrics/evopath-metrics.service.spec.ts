import { metrics } from '@opentelemetry/api';
import {
  DataPointType,
  MeterProvider,
  MetricReader,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { RegistryError } from '@marinoscar/platform-api/core';
import {
  appMetricRegistry,
  MetricsHostService,
  OTHER_LABEL,
  registerAppMetrics,
  type MetricsHostOptions,
} from '@marinoscar/platform-api/otel-core';

// Registers the 26 EvoPath metrics, exactly as `app.module.ts` does at import.
import { EvoPathMetricsModule } from './evopath-metrics.module';
import { EVOPATH_APP_METRICS, EVOPATH_METRIC_NAMES } from './evopath-metric-names';
import {
  COACH_AUDIO_FAILURE_REASONS,
  COACH_AUDIO_REQUEST_OUTCOMES,
  COACH_NUDGE_SUPPRESSION_REASONS,
  EvoPathMetricsService,
  fallbackEvoPathMetrics,
} from './evopath-metrics.service';

// =============================================================================
// EvoPathMetricsService (marinoscar/EnterpriseAppBase#718)
// =============================================================================
//
// Proven against a REAL in-memory SDK MeterProvider, collected on demand: the
// names, units and attribute sets asserted here are exactly what the OTLP
// exporter sends to the collector, and so the GreptimeDB tables every saved
// query reads. The health cases moved here unchanged from the platform's
// `common/otel/app-metrics.service.spec.ts`.
// =============================================================================

class TestReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

async function collect(reader: TestReader): Promise<MetricData[]> {
  const { resourceMetrics, errors } = await reader.collect();
  expect(errors).toEqual([]);
  return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
}

function metric(all: MetricData[], name: string): MetricData {
  const found = all.find((m) => m.descriptor.name === name);
  if (!found) throw new Error(`metric ${name} not collected; got ${all.map((m) => m.descriptor.name).join(', ')}`);
  return found;
}

function points(all: MetricData[], name: string): Array<{ attributes: Record<string, unknown>; value: unknown }> {
  return metric(all, name).dataPoints.map((dp) => ({
    attributes: { ...dp.attributes },
    value: dp.value,
  }));
}

function setup(options: MetricsHostOptions = {}) {
  const reader = new TestReader();
  const provider = new MeterProvider({ readers: [reader] });
  const service = new EvoPathMetricsService(undefined, { meter: provider.getMeter('app'), ...options });
  return { service, reader };
}

/** The 26 names, as the API exported them before the registry. Never rename one. */
const BASELINE_EVOPATH_METRIC_NAMES = {
  healthDocumentPurges: 'app.health.documents.purges',
  healthSummaryGenerations: 'app.health.summary.generations',
  healthSummaryDuration: 'app.health.summary.duration',
  healthSummaryRegenerations: 'app.health.summary.regenerations',
  healthSummaryPostCheckRejections: 'app.health.summary.post_check_rejections',
  healthSummaryTokens: 'app.health.summary.tokens',
  healthExports: 'app.health.exports',
  healthExportDuration: 'app.health.export.duration',
  healthExportSize: 'app.health.export.size',
  healthDocumentDownloads: 'app.health.documents.downloads',
  healthDocumentDeletes: 'app.health.documents.deletes',
  coachGuardRejected: 'app.coach.guard.rejected',
  coachSettingsUpdated: 'app.coach.settings.updated',
  coachPhotoAdded: 'app.coach.photo.added',
  coachPhotoDeleted: 'app.coach.photo.deleted',
  coachNudgeSent: 'app.coach.nudge.sent',
  coachNudgeSuppressed: 'app.coach.nudge.suppressed',
  coachNudgeFallback: 'app.coach.nudge.fallback',
  coachNudgeOpened: 'app.coach.nudge.opened',
  coachNudgeConverted: 'app.coach.nudge.converted',
  coachFeedback: 'app.coach.feedback',
  coachAnglePicked: 'app.coach.angle.picked',
  coachAudioGenerated: 'app.coach.audio.generated',
  coachAudioFailed: 'app.coach.audio.failed',
  coachAudioPurged: 'app.coach.audio.purged',
  coachAudioRequested: 'app.coach.audio.requested',
};

describe('EvoPath metric names and their registration', () => {
  it('declares exactly the 26 baseline names, same keys', () => {
    expect(EVOPATH_METRIC_NAMES).toEqual(BASELINE_EVOPATH_METRIC_NAMES);
    expect(Object.keys(EVOPATH_METRIC_NAMES)).toHaveLength(26);
    expect(EVOPATH_APP_METRICS.map((def) => [def.key, def.name])).toEqual(Object.entries(BASELINE_EVOPATH_METRIC_NAMES));
  });

  it('registers every name in the otel-core app-metric registry (EvoPathMetricsModule, at import)', () => {
    expect(EvoPathMetricsModule).toBeDefined();
    for (const [key, name] of Object.entries(BASELINE_EVOPATH_METRIC_NAMES)) {
      expect(appMetricRegistry.require(key)).toMatchObject({ key, name });
    }
  });

  it('fails fast on a duplicate registration', () => {
    expect(() => registerAppMetrics(EVOPATH_APP_METRICS)).toThrow(RegistryError);
    expect(() => registerAppMetrics(EVOPATH_APP_METRICS)).toThrow(/Duplicate app metric key "healthDocumentPurges"/);
    // A new key that reuses an EvoPath NAME is refused too.
    expect(() =>
      registerAppMetrics([
        { key: 'coachNudgeSentAgain', name: 'app.coach.nudge.sent', kind: 'counter', unit: '{message}', description: 'x' },
      ]),
    ).toThrow(/already declared by "coachNudgeSent"/);
    expect(appMetricRegistry.has('coachNudgeSentAgain')).toBe(false);
  });
});

// =============================================================================
// Descriptors: name, kind, unit, description and buckets, exactly as before
// =============================================================================

interface CreatedInstrument {
  kind: 'counter' | 'histogram';
  name: string;
  options: unknown;
}

function recordingMeter(): { meter: MetricsHostOptions['meter']; created: CreatedInstrument[] } {
  const inner = new MeterProvider({ readers: [new TestReader()] }).getMeter('app');
  const created: CreatedInstrument[] = [];
  const meter = {
    createCounter: (name: string, options?: unknown) => {
      created.push({ kind: 'counter', name, options });
      return inner.createCounter(name, options as never);
    },
    createHistogram: (name: string, options?: unknown) => {
      created.push({ kind: 'histogram', name, options });
      return inner.createHistogram(name, options as never);
    },
  };
  return { meter: meter as unknown as MetricsHostOptions['meter'], created };
}

describe('EvoPath metric descriptors (baseline before the registry)', () => {
  it('creates every counter and histogram with its exact name, unit, description and buckets', () => {
    const { meter, created } = recordingMeter();
    new EvoPathMetricsService(undefined, { meter });

    const c = (name: string, unit: string, description: string): CreatedInstrument => ({
      kind: 'counter',
      name,
      options: { description, unit },
    });
    const h = (name: string, unit: string, description: string, buckets: number[]): CreatedInstrument => ({
      kind: 'histogram',
      name,
      options: { description, unit, advice: { explicitBucketBoundaries: buckets } },
    });

    expect(created).toEqual([
      c('app.health.documents.purges', '{document}', 'Health document file purges (delete after processing), by outcome.'),
      c('app.health.summary.generations', '{summary}', 'AI health summary jobs, by outcome.'),
      h('app.health.summary.duration', 's', 'Wall time of one AI health summary job, by outcome.', [
        0.05, 0.25, 1, 2.5, 5, 10, 20, 30, 60, 120, 240,
      ]),
      c('app.health.summary.regenerations', '{regeneration}', 'AI health summary answers asked for again after a post-check rejection.'),
      c('app.health.summary.post_check_rejections', '{answer}', 'AI health summary answers rejected by the post-check.'),
      c('app.health.summary.tokens', '{token}', 'Tokens the AI health summary used, by token_type (input|output).'),
      c('app.health.exports', '{export}', 'Health data export attempts settled, by format and outcome.'),
      h('app.health.export.duration', 's', 'Wall time of one health data export attempt, by format and outcome.', [
        0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600,
      ]),
      h('app.health.export.size', 'By', 'Size of a completed health data export file, by format.', [
        1e3, 1e4, 1e5, 5e5, 1e6, 5e6, 1e7, 5e7, 1e8,
      ]),
      c('app.health.documents.downloads', '{download}', 'Signed download links issued for health documents, by disposition.'),
      c('app.health.documents.deletes', '{document}', 'Health documents deleted by their owner, by scope and whether the values went too.'),
      c('app.coach.guard.rejected', '{rejection}', 'Coach-written text refused by the content guard, by rule. Never the text.'),
      c('app.coach.settings.updated', '{update}', 'Coach settings saved through PUT /api/coach/settings, by persona.'),
      c('app.coach.photo.added', '{photo}', 'Progress photos added by their owner.'),
      c('app.coach.photo.deleted', '{photo}', 'Progress photos deleted by their owner.'),
      c('app.coach.nudge.sent', '{message}', 'Coach messages delivered by coach.message.deliver, by moment.'),
      c('app.coach.nudge.suppressed', '{nudge}', 'ai.coach.nudge jobs that ended without a message, by reason.'),
      c(
        'app.coach.nudge.fallback',
        '{message}',
        'Coach messages that fell back to a static persona line after two guard rejections, by moment.',
      ),
      c('app.coach.nudge.opened', '{message}', 'Coach messages opened for the first time, by moment.'),
      c(
        'app.coach.nudge.converted',
        '{message}',
        'Delivered coach messages followed by their target action within the window, by moment and target.',
      ),
      c('app.coach.feedback', '{feedback}', 'Thumbs feedback on coach messages, by value (`cleared` when removed).'),
      c('app.coach.angle.picked', '{angle}', 'Angles chosen by the coach learning loop for a nudge, by angle.'),
      c('app.coach.audio.generated', '{message}', 'Coach messages whose spoken version became ready.'),
      c('app.coach.audio.failed', '{message}', 'Coach messages delivered as text only after their audio failed, by reason.'),
      c('app.coach.audio.purged', '{object}', 'Coach voice notes deleted by coach.audio.purge after the retention window.'),
      c(
        'app.coach.audio.requested',
        '{request}',
        'On-demand coach audio requests (Listen), by outcome: started, ready, pending, failed, disabled, rate_limited, no_voice_model.',
      ),
    ]);
  });
});

// =============================================================================
// Recorders
// =============================================================================

describe('EvoPathMetricsService', () => {
  describe('health', () => {
    it('counts health document purges by outcome (H1, #185)', async () => {
      const { service, reader } = setup();

      service.healthDocumentPurge('purged');
      service.healthDocumentPurge('purged');
      service.healthDocumentPurge('failed');

      const all = await collect(reader);

      expect(metric(all, 'app.health.documents.purges').descriptor.unit).toBe('{document}');
      expect(points(all, 'app.health.documents.purges')).toEqual(
        expect.arrayContaining([
          { attributes: { outcome: 'purged' }, value: 2 },
          { attributes: { outcome: 'failed' }, value: 1 },
        ]),
      );
    });

    it('records AI health summary outcomes, duration, regenerations, rejections and tokens (H8, #192)', async () => {
      const { service, reader } = setup();

      service.healthSummaryGenerated('ready', 2_000, { regenerations: 1, rejections: 1, inputTokens: 900, outputTokens: 300 });
      service.healthSummaryGenerated('rejected', 3_000, { regenerations: 1, rejections: 2, inputTokens: 1_000, outputTokens: 400 });
      service.healthSummaryGenerated('skipped', 5);
      service.healthSummaryGenerated('bogus' as never, null);

      const all = await collect(reader);

      expect(points(all, 'app.health.summary.generations')).toEqual(
        expect.arrayContaining([
          { attributes: { outcome: 'ready' }, value: 1 },
          { attributes: { outcome: 'rejected' }, value: 1 },
          { attributes: { outcome: 'skipped' }, value: 1 },
          { attributes: { outcome: OTHER_LABEL }, value: 1 },
        ]),
      );
      expect(metric(all, 'app.health.summary.duration').descriptor.unit).toBe('s');
      expect(metric(all, 'app.health.summary.duration').dataPointType).toBe(DataPointType.HISTOGRAM);
      expect(points(all, 'app.health.summary.regenerations')).toEqual([{ attributes: {}, value: 2 }]);
      expect(points(all, 'app.health.summary.post_check_rejections')).toEqual([{ attributes: {}, value: 3 }]);
      expect(points(all, 'app.health.summary.tokens')).toEqual(
        expect.arrayContaining([
          { attributes: { token_type: 'input' }, value: 1_900 },
          { attributes: { token_type: 'output' }, value: 700 },
        ]),
      );
    });

    it('records health exports by format and outcome, with duration and size (H7, #191)', async () => {
      const { service, reader } = setup();

      service.healthExportSettled('pdf', 'completed', 2500, 48_000);
      service.healthExportSettled('csv', 'failed', 100, 999);
      service.healthExportSettled('docx', 'completed', 10, 10);

      const all = await collect(reader);

      expect(metric(all, 'app.health.exports').descriptor.unit).toBe('{export}');
      expect(points(all, 'app.health.exports')).toEqual(
        expect.arrayContaining([
          { attributes: { format: 'pdf', outcome: 'completed' }, value: 1 },
          { attributes: { format: 'csv', outcome: 'failed' }, value: 1 },
          { attributes: { format: OTHER_LABEL, outcome: 'completed' }, value: 1 },
        ]),
      );
      expect(metric(all, 'app.health.export.duration').descriptor.unit).toBe('s');
      expect(metric(all, 'app.health.export.size').descriptor.unit).toBe('By');
      // A failed attempt records no size.
      const sizes = metric(all, 'app.health.export.size').dataPoints.map((p: { attributes: object }) => p.attributes);
      expect(sizes).toEqual(expect.arrayContaining([{ format: 'pdf' }]));
      expect(sizes).not.toEqual(expect.arrayContaining([{ format: 'csv' }]));
    });

    it('counts health document downloads and deletes (H6, #190)', async () => {
      const { service, reader } = setup();

      service.healthDocumentDownload('inline');
      service.healthDocumentDownload('attachment');
      service.healthDocumentDownload('attachment');
      service.healthDocumentDelete('file', false);
      service.healthDocumentDelete('file', true);
      service.healthDocumentDelete('record', false);

      const all = await collect(reader);

      expect(metric(all, 'app.health.documents.downloads').descriptor.unit).toBe('{download}');
      expect(points(all, 'app.health.documents.downloads')).toEqual(
        expect.arrayContaining([
          { attributes: { disposition: 'inline' }, value: 1 },
          { attributes: { disposition: 'attachment' }, value: 2 },
        ]),
      );
      expect(points(all, 'app.health.documents.deletes')).toEqual(
        expect.arrayContaining([
          { attributes: { scope: 'file', values: 'kept' }, value: 1 },
          { attributes: { scope: 'file', values: 'deleted' }, value: 1 },
          { attributes: { scope: 'record', values: 'kept' }, value: 1 },
        ]),
      );
    });

    it('counts progress photos added and deleted, with no attribute (E7.9, #249)', async () => {
      const { service, reader } = setup();

      service.progressPhotoChanged('added');
      service.progressPhotoChanged('added');
      service.progressPhotoChanged('deleted');

      const all = await collect(reader);

      expect(points(all, 'app.coach.photo.added')).toEqual([{ attributes: {}, value: 2 }]);
      expect(points(all, 'app.coach.photo.deleted')).toEqual([{ attributes: {}, value: 1 }]);
    });
  });

  describe('coach', () => {
    it('counts guard rejections by rule and settings updates by persona', async () => {
      const { service, reader } = setup();

      service.coachGuardRejection('profanity');
      service.coachGuardRejection('the model said something rude');
      service.coachSettingsUpdate('drill_sergeant');
      service.coachSettingsUpdate('someone@example.com');

      const all = await collect(reader);

      expect(points(all, 'app.coach.guard.rejected')).toEqual(
        expect.arrayContaining([
          { attributes: { reason: 'profanity' }, value: 1 },
          { attributes: { reason: OTHER_LABEL }, value: 1 },
        ]),
      );
      expect(points(all, 'app.coach.settings.updated')).toEqual(
        expect.arrayContaining([
          { attributes: { persona: 'drill_sergeant' }, value: 1 },
          { attributes: { persona: OTHER_LABEL }, value: 1 },
        ]),
      );
    });

    it('records the nudge funnel by moment, reason, target and angle', async () => {
      const { service, reader } = setup();

      service.coachNudgeDelivered('comeback');
      service.coachNudgeDelivered(null);
      for (const reason of COACH_NUDGE_SUPPRESSION_REASONS) service.coachNudgeSuppression(reason, 'pr');
      service.coachNudgeSuppression('nope' as never, 'invented_moment');
      service.coachNudgeFallbackUsed('kickoff');
      service.coachNudgeOpen('weekly_review');
      service.coachNudgeConversion('comeback', 'workout');
      service.coachNudgeConversion('comeback', 'check_in', 'humor');
      service.coachNudgeConversion('comeback', 'shopping', 'made_up_angle');
      service.coachAnglePicked('data');
      service.coachAnglePicked('user-123');
      service.coachFeedbackGiven('up');
      service.coachFeedbackGiven(null);

      const all = await collect(reader);

      expect(points(all, 'app.coach.nudge.sent')).toEqual(
        expect.arrayContaining([
          { attributes: { moment: 'comeback' }, value: 1 },
          { attributes: { moment: OTHER_LABEL }, value: 1 },
        ]),
      );
      const suppressed = points(all, 'app.coach.nudge.suppressed');
      for (const reason of COACH_NUDGE_SUPPRESSION_REASONS) {
        expect(suppressed).toContainEqual({ attributes: { reason, moment: 'pr' }, value: 1 });
      }
      expect(suppressed).toContainEqual({ attributes: { reason: OTHER_LABEL, moment: OTHER_LABEL }, value: 1 });
      expect(points(all, 'app.coach.nudge.fallback')).toEqual([{ attributes: { moment: 'kickoff' }, value: 1 }]);
      expect(points(all, 'app.coach.nudge.opened')).toEqual([{ attributes: { moment: 'weekly_review' }, value: 1 }]);
      expect(points(all, 'app.coach.nudge.converted')).toEqual(
        expect.arrayContaining([
          { attributes: { moment: 'comeback', target: 'workout', angle: 'none' }, value: 1 },
          { attributes: { moment: 'comeback', target: 'check_in', angle: 'humor' }, value: 1 },
          { attributes: { moment: 'comeback', target: OTHER_LABEL, angle: OTHER_LABEL }, value: 1 },
        ]),
      );
      expect(points(all, 'app.coach.angle.picked')).toEqual(
        expect.arrayContaining([
          { attributes: { angle: 'data' }, value: 1 },
          { attributes: { angle: OTHER_LABEL }, value: 1 },
        ]),
      );
      expect(points(all, 'app.coach.feedback')).toEqual(
        expect.arrayContaining([
          { attributes: { value: 'up' }, value: 1 },
          { attributes: { value: 'cleared' }, value: 1 },
        ]),
      );
    });

    it('records coach audio: ready, failures by reason, requests by outcome and purges', async () => {
      const { service, reader } = setup();

      service.coachAudioReady();
      for (const reason of COACH_AUDIO_FAILURE_REASONS) service.coachAudioFailure(reason);
      for (const outcome of COACH_AUDIO_REQUEST_OUTCOMES) service.coachAudioRequest(outcome);
      service.coachAudioPurge(3);
      service.coachAudioPurge(0); // a no-op sweep records nothing

      const all = await collect(reader);

      expect(points(all, 'app.coach.audio.generated')).toEqual([{ attributes: {}, value: 1 }]);
      expect(points(all, 'app.coach.audio.failed')).toEqual(
        COACH_AUDIO_FAILURE_REASONS.map((reason) => ({ attributes: { reason }, value: 1 })),
      );
      expect(points(all, 'app.coach.audio.requested')).toEqual(
        COACH_AUDIO_REQUEST_OUTCOMES.map((outcome) => ({ attributes: { outcome }, value: 1 })),
      );
      expect(points(all, 'app.coach.audio.purged')).toEqual([{ attributes: {}, value: 3 }]);
    });
  });

  describe('never throws', () => {
    it('swallows a failing instrument', () => {
      const throwing = {
        createCounter: () => ({ add: () => { throw new Error('boom'); } }),
        createHistogram: () => ({ record: () => { throw new Error('boom'); } }),
      } as unknown as MetricsHostOptions['meter'];
      const service = new EvoPathMetricsService(undefined, { meter: throwing });

      expect(() => {
        service.healthDocumentPurge('purged');
        service.healthExportSettled('pdf', 'completed', 10, 10);
        service.healthSummaryGenerated('ready', 10, { regenerations: 1, rejections: 1, inputTokens: 1, outputTokens: 1 });
        service.coachNudgeDelivered('pr');
        service.coachAudioPurge(2);
      }).not.toThrow();
    });
  });

  describe('OpenTelemetry off (OTEL_ENABLED unset: no SDK, the API no-op meter)', () => {
    it('records on the global no-op meter and every recorder is a safe no-op', () => {
      // No MeterProvider is registered in this process, so the global meter is the API's no-op one.
      const noopCounter = metrics.getMeter('app').createCounter('app.probe');
      expect(noopCounter.constructor.name).toBe('NoopCounterMetric');

      const host = new MetricsHostService();
      const service = new EvoPathMetricsService(host);
      expect(host.meter).toBe(metrics.getMeter('app'));
      expect(host.counter('coachNudgeSent').constructor.name).toBe('NoopCounterMetric');
      expect(host.histogram('healthExportDuration').constructor.name).toBe('NoopHistogramMetric');

      expect(() => {
        service.healthDocumentPurge('purged');
        service.healthExportSettled('pdf', 'completed', 10, 10);
        service.healthDocumentDownload('inline');
        service.healthDocumentDelete('file', true);
        service.healthSummaryGenerated('ready', 10, { regenerations: 1, rejections: 1, inputTokens: 1, outputTokens: 1 });
        service.progressPhotoChanged('added');
        service.coachGuardRejection('profanity');
        service.coachSettingsUpdate('coach');
        service.coachNudgeDelivered('pr');
        service.coachNudgeSuppression('paused', 'pr');
        service.coachNudgeFallbackUsed('pr');
        service.coachNudgeOpen('pr');
        service.coachNudgeConversion('pr', 'workout', 'data');
        service.coachAnglePicked('data');
        service.coachFeedbackGiven('down');
        service.coachAudioReady();
        service.coachAudioFailure('timeout');
        service.coachAudioRequest('ready');
        service.coachAudioPurge(1);
      }).not.toThrow();
    });

    it('the fallback instance (no DI) is one shared no-op instance', () => {
      expect(fallbackEvoPathMetrics()).toBe(fallbackEvoPathMetrics());
      expect(() => fallbackEvoPathMetrics().coachNudgeOpen('pr')).not.toThrow();
    });
  });
});
