import { metrics, trace } from '@opentelemetry/api';
import { APP_SLUG } from '@app/shared';
import {
  appMetricRegistry,
  MetricsHostService,
  telemetryGate,
  Trace,
} from '@marinoscar/platform-api/otel-core';

import { EVOPATH_METRIC_NAMES } from '../../src/app-metrics/evopath-metric-names';
import { EvoPathMetricsService } from '../../src/app-metrics/evopath-metrics.service';
import { AppMetricsService } from '../../src/common/otel/app-metrics.service';
import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';

// =============================================================================
// The API with OpenTelemetry OFF (marinoscar/EnterpriseAppBase#700, #718)
// =============================================================================
//
// docs/specs/platform-packages.md: "Apps must still run with OTEL_ENABLED=false
// and no telemetry stack." With OTEL_ENABLED unset, `instrumentation.ts`
// installs no SDK, the full AppModule (mocked database) boots, the one metrics
// host is the package's, on the API's no-op meter, with gauges off, and every
// AppMetricsService and EvoPathMetricsService method is a safe no-op. The CI
// `smoke` job proves the same for the compiled API (`OTEL_ENABLED: 'false'`).
// =============================================================================

describe('API with OTEL_ENABLED unset', () => {
  const saved = process.env.OTEL_ENABLED;
  let ctx: TestContext;

  beforeAll(async () => {
    delete process.env.OTEL_ENABLED;
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
    if (saved === undefined) delete process.env.OTEL_ENABLED;
    else process.env.OTEL_ENABLED = saved;
  });

  it('instrumentation.ts installs no SDK and logs the disabled line', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sdk } = require('../../src/instrumentation') as { sdk: unknown };
        expect(sdk).toBeNull();
      });
      expect(log).toHaveBeenCalledWith('OpenTelemetry disabled (OTEL_ENABLED !== true)');
    } finally {
      log.mockRestore();
    }
  });

  it('boots, with the API no-op providers and the export gate closed', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health/live' });
    expect(res.statusCode).toBe(200);
    expect(trace.getActiveSpan()).toBeUndefined();
    expect(telemetryGate.isEnabled()).toBe(false);
    expect(telemetryGate.instanceId()).toBe(APP_SLUG);
  });

  it('wires both metrics services onto the one global metrics host, on the no-op meter, gauges off', () => {
    const appMetrics = ctx.module.get(AppMetricsService);
    const evoPathMetrics = ctx.module.get(EvoPathMetricsService);
    const host = ctx.module.get(MetricsHostService);

    expect(host.meter).toBe(metrics.getMeter('app'));
    expect((appMetrics as unknown as { host: MetricsHostService }).host).toBe(host);
    expect((evoPathMetrics as unknown as { host: MetricsHostService }).host).toBe(host);
    expect(host.gaugesEnabled()).toBe(false);
    expect(appMetrics.gaugeContext()).toBeNull();
  });

  it('has registered the EvoPath metric names', () => {
    for (const [key, name] of Object.entries(EVOPATH_METRIC_NAMES)) {
      expect(appMetricRegistry.require(key).name).toBe(name);
    }
  });

  it('makes every AppMetricsService method a safe no-op', async () => {
    const m = ctx.module.get(AppMetricsService);

    expect(() => {
      m.jobEnqueued('db.backup.run');
      m.jobsClaimedBy('server', ['db.backup.run']);
      m.jobSettled('db.backup.run', 'succeeded', 1200, 'server');
      m.leaseReaped('requeued', 2);
      m.leaseReaped('failed', 1, 'ai.image');
      m.backupSettled('completed', 5_000, BigInt(4096));
      m.authLogin('success');
      m.authRefresh('reuse_detected');
      m.aiUsage({ provider: 'openai', model: 'm', operation: 'responses', status: 'succeeded', latencyMs: 10, inputTokens: 5 });
      m.notificationDelivery('email', 'sent', 'job.failed');
      m.record('jobsDuration', 1);
      m.add('noSuchMetric');
      m.boundLabel('job_type', 'x');
      m.registerGauges();
    }).not.toThrow();

    await expect(m.gaugeSnapshot()).resolves.toBeNull();
  });

  it('makes every EvoPathMetricsService method a safe no-op', () => {
    const m = ctx.module.get(EvoPathMetricsService);

    expect(() => {
      m.healthDocumentPurge('purged');
      m.healthExportSettled('pdf', 'completed', 2500, 48_000);
      m.healthDocumentDownload('attachment');
      m.healthDocumentDelete('file', true);
      m.healthSummaryGenerated('ready', 2_000, { regenerations: 1, rejections: 1, inputTokens: 900, outputTokens: 300 });
      m.progressPhotoChanged('added');
      m.progressPhotoChanged('deleted');
      m.coachGuardRejection('profanity');
      m.coachSettingsUpdate('drill_sergeant');
      m.coachNudgeDelivered('comeback');
      m.coachNudgeSuppression('paused', 'comeback');
      m.coachNudgeFallbackUsed('kickoff');
      m.coachNudgeOpen('pr');
      m.coachNudgeConversion('pr', 'workout', 'data');
      m.coachAnglePicked('humor');
      m.coachFeedbackGiven('up');
      m.coachAudioReady();
      m.coachAudioFailure('timeout');
      m.coachAudioRequest('ready');
      m.coachAudioPurge(2);
    }).not.toThrow();
  });

  it('runs a @Trace() method unchanged (a no-op span)', async () => {
    class Report {
      @Trace('report.build')
      async build(id: string): Promise<string> {
        return `report-${id}`;
      }
    }

    await expect(new Report().build('7')).resolves.toBe('report-7');
  });
});
