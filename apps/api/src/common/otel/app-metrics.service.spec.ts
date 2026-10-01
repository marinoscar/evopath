import { ConfigService } from '@nestjs/config';
import {
  DataPointType,
  MeterProvider,
  MetricReader,
  type MetricData,
} from '@opentelemetry/sdk-metrics';

import type { PrismaService } from '../../prisma/prisma.service';
import {
  APP_METRIC_NAMES,
  AppMetricsService,
  GAUGE_CACHE_TTL_MS,
  MAX_DISTINCT_VALUES,
  OTHER_LABEL,
  UNKNOWN_LABEL,
  fallbackAppMetrics,
  type AppMetricsOptions,
} from './app-metrics.service';

// =============================================================================
// AppMetricsService (issue #125)
// =============================================================================
//
// Proven against a REAL in-memory SDK MeterProvider, collected on demand: the
// names, units and attribute sets asserted here are exactly what the OTLP
// exporter would send to the collector.
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

interface PrismaStub {
  job: { groupBy: jest.Mock };
  databaseBackupRun: { findFirst: jest.Mock };
}

function prismaStub(): PrismaStub {
  return {
    job: {
      groupBy: jest.fn(async (args: { by: string[] }) =>
        args.by.length === 2
          ? [
              { type: 'db.backup.run', status: 'pending', _count: { _all: 3 } },
              { type: 'db.backup.run', status: 'running', _count: { _all: 1 } },
            ]
          : [{ type: 'db.backup.run', _min: { createdAt: new Date(1_000_000 - 90_000) } }],
      ),
    },
    databaseBackupRun: {
      findFirst: jest.fn(async () => ({
        finishedAt: new Date(1_700_000_000_500),
        sizeBytes: BigInt(4096),
      })),
    },
  };
}

function setup(
  opts: { prisma?: PrismaStub; otelEnabled?: boolean; options?: Partial<AppMetricsOptions> } = {},
) {
  const reader = new TestReader();
  const provider = new MeterProvider({ readers: [reader] });
  let now = 1_000_000;
  let gate = true;
  const config = { get: jest.fn((key: string) => (key === 'otel.enabled' ? opts.otelEnabled ?? true : undefined)) };

  const service = new AppMetricsService(
    opts.prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    {
      meter: provider.getMeter('app'),
      now: () => now,
      gateOpen: () => gate,
      ...opts.options,
    },
  );

  return {
    service,
    reader,
    provider,
    advance: (ms: number) => {
      now += ms;
    },
    setGate: (open: boolean) => {
      gate = open;
    },
  };
}

describe('AppMetricsService', () => {
  describe('counters and histograms', () => {
    it('records job lifecycle metrics with their names, units and low-cardinality attributes', async () => {
      const { service, reader } = setup();

      service.jobEnqueued('db.backup.run');
      service.jobEnqueued('db.backup.run');
      service.jobsClaimedBy('server', ['db.backup.run', 'db.backup.run', 'ai.image']);
      service.jobSettled('db.backup.run', 'succeeded', 2500, 'node');
      service.jobSettled('db.backup.run', 'retry-scheduled', null, null);
      service.leaseReaped('failed', 1, 'ai.image');
      service.leaseReaped('requeued', 4);
      service.leaseReaped('requeued', 0); // a no-op sweep records nothing

      const all = await collect(reader);

      expect(metric(all, APP_METRIC_NAMES.jobsEnqueued).descriptor.unit).toBe('{job}');
      expect(points(all, 'app.jobs.enqueued')).toEqual([
        { attributes: { job_type: 'db.backup.run' }, value: 2 },
      ]);

      expect(points(all, 'app.jobs.claimed')).toEqual(
        expect.arrayContaining([
          { attributes: { job_type: 'db.backup.run', executor: 'server' }, value: 2 },
          { attributes: { job_type: 'ai.image', executor: 'server' }, value: 1 },
        ]),
      );

      expect(points(all, 'app.jobs.settled')).toEqual(
        expect.arrayContaining([
          { attributes: { job_type: 'db.backup.run', outcome: 'succeeded', executor: 'node' }, value: 1 },
          {
            attributes: { job_type: 'db.backup.run', outcome: 'retry-scheduled', executor: UNKNOWN_LABEL },
            value: 1,
          },
        ]),
      );

      const duration = metric(all, 'app.jobs.duration');
      expect(duration.descriptor.unit).toBe('s');
      expect(duration.dataPointType).toBe(DataPointType.HISTOGRAM);
      // Only the settlement with a known start contributed, in SECONDS.
      expect(duration.dataPoints).toHaveLength(1);
      expect((duration.dataPoints[0].value as { sum: number; count: number }).sum).toBeCloseTo(2.5);
      expect((duration.dataPoints[0].value as { count: number }).count).toBe(1);

      expect(points(all, 'app.jobs.reaped')).toEqual(
        expect.arrayContaining([
          { attributes: { outcome: 'failed', job_type: 'ai.image' }, value: 1 },
          { attributes: { outcome: 'requeued' }, value: 4 },
        ]),
      );
    });

    it('records backup outcomes, duration in seconds and size in bytes (completed only)', async () => {
      const { service, reader } = setup();

      service.backupSettled('completed', 120_000, BigInt(5_000_000));
      service.backupSettled('failed', 30_000, BigInt(9_999));
      service.backupSettled('failed', null);

      const all = await collect(reader);

      expect(metric(all, 'app.backup.runs').descriptor.unit).toBe('{run}');
      expect(points(all, 'app.backup.runs')).toEqual(
        expect.arrayContaining([
          { attributes: { outcome: 'completed' }, value: 1 },
          { attributes: { outcome: 'failed' }, value: 2 },
        ]),
      );

      expect(metric(all, 'app.backup.duration').descriptor.unit).toBe('s');
      const size = metric(all, 'app.backup.size');
      expect(size.descriptor.unit).toBe('By');
      expect(size.dataPoints).toHaveLength(1);
      expect(size.dataPoints[0].attributes).toEqual({ outcome: 'completed' });
      expect((size.dataPoints[0].value as { sum: number }).sum).toBe(5_000_000);
    });

    it('records auth logins and refreshes by outcome', async () => {
      const { service, reader } = setup();

      service.authLogin('success');
      service.authLogin('allowlist_rejected');
      service.authRefresh('expired');
      service.authRefresh('bogus' as never);

      const all = await collect(reader);

      expect(points(all, 'app.auth.logins')).toEqual(
        expect.arrayContaining([
          { attributes: { provider: 'google', outcome: 'success' }, value: 1 },
          { attributes: { provider: 'google', outcome: 'allowlist_rejected' }, value: 1 },
        ]),
      );
      expect(points(all, 'app.auth.refreshes')).toEqual(
        expect.arrayContaining([
          { attributes: { outcome: 'expired' }, value: 1 },
          { attributes: { outcome: OTHER_LABEL }, value: 1 },
        ]),
      );
    });

    it('records AI requests, tokens by type and latency in seconds', async () => {
      const { service, reader } = setup();

      service.aiUsage({
        provider: 'openai',
        model: 'gpt-5-mini',
        operation: 'responses',
        status: 'succeeded',
        keySource: 'org',
        inputTokens: 120,
        outputTokens: 30,
        latencyMs: 1500,
      });
      service.aiUsage({
        provider: 'openai',
        model: 'gpt-5-mini',
        operation: 'responses',
        status: 'failed',
        inputTokens: null,
        outputTokens: 0,
        latencyMs: 200,
      });

      const all = await collect(reader);
      const base = { provider: 'openai', model: 'gpt-5-mini', operation: 'responses' };

      expect(points(all, 'app.ai.requests')).toEqual(
        expect.arrayContaining([
          { attributes: { ...base, status: 'succeeded', key_source: 'org' }, value: 1 },
          { attributes: { ...base, status: 'failed', key_source: UNKNOWN_LABEL }, value: 1 },
        ]),
      );
      expect(metric(all, 'app.ai.tokens').descriptor.unit).toBe('{token}');
      expect(points(all, 'app.ai.tokens')).toEqual(
        expect.arrayContaining([
          { attributes: { ...base, token_type: 'input' }, value: 120 },
          { attributes: { ...base, token_type: 'output' }, value: 30 },
        ]),
      );
      expect(points(all, 'app.ai.tokens')).toHaveLength(2);
      const latency = metric(all, 'app.ai.request.duration');
      expect(latency.descriptor.unit).toBe('s');
      expect(latency.dataPoints).toHaveLength(2);
    });

    it('records notification deliveries by channel, event and outcome', async () => {
      const { service, reader } = setup();

      service.notificationDelivery('email', 'sent', 'user.welcome');
      service.notificationDelivery('push', 'rate_limited');

      const all = await collect(reader);

      expect(points(all, 'app.notifications.deliveries')).toEqual(
        expect.arrayContaining([
          { attributes: { channel: 'email', event: 'user.welcome', outcome: 'sent' }, value: 1 },
          { attributes: { channel: 'push', event: UNKNOWN_LABEL, outcome: 'rate_limited' }, value: 1 },
        ]),
      );
    });

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
  });

  describe('label bounding', () => {
    it('maps empty, non-identifier and over-long strings to unknown/other', () => {
      const { service } = setup();

      expect(service.boundLabel('k', '')).toBe(UNKNOWN_LABEL);
      expect(service.boundLabel('k', undefined)).toBe(UNKNOWN_LABEL);
      expect(service.boundLabel('k', 'user@example.com')).toBe(OTHER_LABEL);
      expect(service.boundLabel('k', 'claude-sonnet@20250101')).toBe('claude-sonnet@20250101');
      expect(service.boundLabel('k', 'has spaces in it')).toBe(OTHER_LABEL);
      expect(service.boundLabel('k', 'https://x.test/a?b=c')).toBe(OTHER_LABEL);
      expect(service.boundLabel('k', 'a'.repeat(65))).toBe(OTHER_LABEL);
      expect(service.boundLabel('k', '  db.backup.run  ')).toBe('db.backup.run');
    });

    it('admits at most MAX_DISTINCT_VALUES distinct values per key, then folds into other', () => {
      const { service } = setup();

      for (let i = 0; i < MAX_DISTINCT_VALUES; i += 1) {
        expect(service.boundLabel('job_type', `type.${i}`)).toBe(`type.${i}`);
      }

      expect(service.boundLabel('job_type', 'one.too.many')).toBe(OTHER_LABEL);
      // Already-seen values keep their own label; other keys have their own budget.
      expect(service.boundLabel('job_type', 'type.0')).toBe('type.0');
      expect(service.boundLabel('ai_model', 'one.too.many')).toBe('one.too.many');
    });

    it('maps an unknown enumerated outcome to other rather than passing it through', async () => {
      const { service, reader } = setup();

      service.jobSettled('t', 'Error: connection refused for user 42', 10, 'server');

      const all = await collect(reader);
      expect(points(all, 'app.jobs.settled')[0].attributes).toEqual({
        job_type: 't',
        outcome: OTHER_LABEL,
        executor: 'server',
      });
    });
  });

  describe('never throws', () => {
    it('swallows a failing instrument', () => {
      const broken = {
        createCounter: () => ({ add: () => { throw new Error('boom'); } }),
        createHistogram: () => ({ record: () => { throw new Error('boom'); } }),
      };
      const service = new AppMetricsService(undefined, undefined, { meter: broken as never });

      expect(() => service.jobEnqueued('x')).not.toThrow();
      expect(() => service.jobSettled('x', 'succeeded', 1, 'server')).not.toThrow();
      expect(() => service.backupSettled('completed', 1, 1)).not.toThrow();
      expect(() => service.authLogin('success')).not.toThrow();
      expect(() =>
        service.aiUsage({ provider: 'p', model: 'm', operation: 'o', status: 'succeeded', latencyMs: 1, inputTokens: 1 }),
      ).not.toThrow();
      expect(() => service.notificationDelivery('email', 'sent')).not.toThrow();
      expect(() => service.healthDocumentPurge('purged')).not.toThrow();
      expect(() => service.healthDocumentDownload('inline')).not.toThrow();
      expect(() => service.healthDocumentDelete('file', true)).not.toThrow();
    });

    it('the fallback instance (no DI) works against the global no-op meter', () => {
      expect(() => fallbackAppMetrics().jobEnqueued('x')).not.toThrow();
      expect(fallbackAppMetrics()).toBe(fallbackAppMetrics());
    });
  });

  describe('observable gauges', () => {
    it('observes queue depth, oldest pending age and last backup from one cached snapshot', async () => {
      const prisma = prismaStub();
      const { service, reader } = setup({ prisma });
      service.onModuleInit();

      const all = await collect(reader);

      expect(metric(all, APP_METRIC_NAMES.jobsQueueDepth).descriptor.unit).toBe('{job}');
      expect(points(all, 'app.jobs.queue.depth')).toEqual(
        expect.arrayContaining([
          { attributes: { job_type: 'db.backup.run', status: 'pending' }, value: 3 },
          { attributes: { job_type: 'db.backup.run', status: 'running' }, value: 1 },
        ]),
      );

      expect(metric(all, 'app.jobs.oldest_pending.age').descriptor.unit).toBe('s');
      expect(points(all, 'app.jobs.oldest_pending.age')).toEqual([
        { attributes: { job_type: 'db.backup.run' }, value: 90 },
      ]);

      expect(metric(all, 'app.backup.last_success.timestamp').descriptor.unit).toBe('s');
      expect(points(all, 'app.backup.last_success.timestamp')).toEqual([
        { attributes: {}, value: 1_700_000_000 },
      ]);
      expect(metric(all, 'app.backup.last_success.size').descriptor.unit).toBe('By');
      expect(points(all, 'app.backup.last_success.size')).toEqual([{ attributes: {}, value: 4096 }]);

      // Depth is restricted to live statuses; oldest-age to due pending rows.
      const [depthArgs] = prisma.job.groupBy.mock.calls.find(([a]) => a.by.length === 2)!;
      expect(depthArgs.where).toEqual({ status: { in: ['pending', 'running'] } });
      const [ageArgs] = prisma.job.groupBy.mock.calls.find(([a]) => a.by.length === 1)!;
      expect(ageArgs.where.status).toBe('pending');
      expect(ageArgs._min).toEqual({ createdAt: true });
    });

    it('reuses the snapshot within the TTL and shares one in-flight read', async () => {
      const prisma = prismaStub();
      const { service, advance } = setup({ prisma });

      const [a, b] = await Promise.all([service.gaugeSnapshot(), service.gaugeSnapshot()]);
      expect(a).toBe(b);
      expect(prisma.databaseBackupRun.findFirst).toHaveBeenCalledTimes(1);

      advance(GAUGE_CACHE_TTL_MS - 1);
      await service.gaugeSnapshot();
      expect(prisma.databaseBackupRun.findFirst).toHaveBeenCalledTimes(1);

      advance(2);
      await service.gaugeSnapshot();
      expect(prisma.databaseBackupRun.findFirst).toHaveBeenCalledTimes(2);
    });

    it('queries nothing while the export gate is closed', async () => {
      const prisma = prismaStub();
      const { service, reader, setGate } = setup({ prisma });
      service.onModuleInit();
      setGate(false);

      const all = await collect(reader);

      expect(all.find((m) => m.descriptor.name === 'app.jobs.queue.depth')?.dataPoints ?? []).toEqual([]);
      expect(prisma.job.groupBy).not.toHaveBeenCalled();
    });

    it('never throws from the callback when the database read fails', async () => {
      const prisma = prismaStub();
      prisma.job.groupBy.mockRejectedValue(new Error('connection lost'));
      const { service, reader } = setup({ prisma });
      service.onModuleInit();

      const all = await collect(reader); // `collect` asserts no callback errors

      expect(all.find((m) => m.descriptor.name === 'app.jobs.queue.depth')?.dataPoints ?? []).toEqual([]);
      // The failure is not cached: the next collection tries again.
      prisma.job.groupBy.mockImplementation(prismaStub().job.groupBy);
      const again = await collect(reader);
      expect(points(again, 'app.jobs.queue.depth').length).toBeGreaterThan(0);
    });

    it('registers no gauge (and so runs no query) when OTEL is not enabled', async () => {
      const prisma = prismaStub();
      const { service, reader } = setup({ prisma, otelEnabled: false });
      service.onModuleInit();

      const all = await collect(reader);

      expect(all.map((m) => m.descriptor.name)).not.toContain('app.jobs.queue.depth');
      expect(prisma.job.groupBy).not.toHaveBeenCalled();
    });

    it('registers no gauge without a database (the fallback instance)', async () => {
      const { service, reader } = setup();
      service.onModuleInit();

      const all = await collect(reader);
      expect(all.map((m) => m.descriptor.name)).not.toContain('app.jobs.queue.depth');
    });
  });
});
