// =============================================================================
// NodeTelemetryService — the node span relay (issue #133)
// =============================================================================
//
// What the relay DECIDES (attribution, budget) and what it EMITS (parent,
// identity from the path, allowlisted attributes), against the real global
// tracer via the in-memory helper. The wire half — `nod_` admitted, strict
// body, 403 for another owner's node — is `test/nodes/node-telemetry.integration.spec.ts`.
// =============================================================================

import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { WorkerNode } from '@prisma/client';

import { installTestTracing, TestTracing } from '../../test/helpers/otel-tracing.helper';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { PrismaService } from '../prisma/prisma.service';
import { NodeTelemetryDto } from './dto/node-telemetry.dto';
import { NodeSettlementLedger } from './node-settlement-ledger';
import {
  NODE_TELEMETRY_REQUESTS_PER_MINUTE,
  NodeTelemetryRateLimiter,
} from './node-telemetry-rate-limiter';
import { NodeTelemetryService } from './node-telemetry.service';
import { NodesService } from './nodes.service';

describe('NodeTelemetryService', () => {
  const USER = 'user-1';
  const NODE_ID = '11111111-1111-4111-8111-111111111111';
  const OTHER_NODE = '99999999-9999-4999-8999-999999999999';
  const HELD_JOB = '22222222-2222-4222-8222-222222222222';
  const SETTLED_JOB = '33333333-3333-4333-8333-333333333333';
  const FOREIGN_JOB = '44444444-4444-4444-8444-444444444444';
  const MISSING_JOB = '55555555-5555-4555-8555-555555555555';

  const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
  const PARENT_SPAN_ID = 'b7ad6b7169203331';
  const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`;

  let prisma: MockPrismaService;
  let nodes: { assertOwnership: jest.Mock };
  let ledger: NodeSettlementLedger;
  let limiter: NodeTelemetryRateLimiter;
  let service: NodeTelemetryService;
  let tracing: TestTracing;

  const node = { id: NODE_ID, name: 'prod-worker-1', createdById: USER } as WorkerNode;

  const jobRows = [
    { id: HELD_JOB, type: 'example.checksum', claimedByNodeId: NODE_ID, traceContext: TRACEPARENT },
    { id: SETTLED_JOB, type: 'db.backup.run', claimedByNodeId: null, traceContext: null },
    { id: FOREIGN_JOB, type: 'example.checksum', claimedByNodeId: OTHER_NODE, traceContext: TRACEPARENT },
  ];

  const span = (jobId: string, overrides: Record<string, unknown> = {}) => ({
    jobId,
    name: 'job.execute' as const,
    startTimeUnixMs: Date.now() - 10_000,
    durationMs: 2_500,
    status: 'ok' as const,
    ...overrides,
  });

  const body = (...spans: ReturnType<typeof span>[]) => ({ spans }) as NodeTelemetryDto;

  beforeEach(() => {
    tracing = installTestTracing();
    prisma = createMockPrismaService();
    (prisma.job.findMany as jest.Mock).mockImplementation(async ({ where }: any) =>
      jobRows.filter((row) => where.id.in.includes(row.id))
    );
    nodes = { assertOwnership: jest.fn().mockResolvedValue(node) };
    ledger = new NodeSettlementLedger();
    limiter = new NodeTelemetryRateLimiter();
    service = new NodeTelemetryService(
      prisma as unknown as PrismaService,
      nodes as unknown as NodesService,
      ledger,
      limiter
    );
  });

  afterEach(() => {
    tracing.uninstall();
  });

  describe('attribution', () => {
    it('accepts a span for a job this node holds', async () => {
      const result = await service.relay(USER, NODE_ID, body(span(HELD_JOB)));

      expect(result).toEqual({ accepted: 1, dropped: 0 });
      expect(tracing.exporter.getFinishedSpans()).toHaveLength(1);
    });

    it('drops, and never emits, spans for another node’s job or a missing one', async () => {
      const result = await service.relay(
        USER,
        NODE_ID,
        body(span(HELD_JOB), span(FOREIGN_JOB), span(MISSING_JOB))
      );

      expect(result).toEqual({ accepted: 1, dropped: 2 });
      const emitted = tracing.exporter.getFinishedSpans();
      expect(emitted).toHaveLength(1);
      expect(emitted[0].attributes['job.id']).toBe(HELD_JOB);
    });

    it('accepts a span for a job this node settled within the grace window', async () => {
      ledger.record(SETTLED_JOB, NODE_ID);

      const result = await service.relay(USER, NODE_ID, body(span(SETTLED_JOB)));

      expect(result).toEqual({ accepted: 1, dropped: 0 });
    });

    it('drops a settled job’s spans when ANOTHER node settled it', async () => {
      ledger.record(SETTLED_JOB, OTHER_NODE);

      const result = await service.relay(USER, NODE_ID, body(span(SETTLED_JOB)));

      expect(result).toEqual({ accepted: 0, dropped: 1 });
      expect(tracing.exporter.getFinishedSpans()).toHaveLength(0);
    });

    it('drops a settled job’s spans once the grace window has passed', async () => {
      ledger.record(SETTLED_JOB, NODE_ID);
      const realNow = Date.now();
      const spy = jest.spyOn(Date, 'now').mockReturnValue(realNow + 11 * 60 * 1000);

      try {
        const result = await service.relay(
          USER,
          NODE_ID,
          body(span(SETTLED_JOB, { startTimeUnixMs: realNow }))
        );
        expect(result).toEqual({ accepted: 0, dropped: 1 });
      } finally {
        spy.mockRestore();
      }
    });

    it('checks ownership first, and reads no job when it fails', async () => {
      nodes.assertOwnership.mockRejectedValue(new ForbiddenException());

      await expect(service.relay(USER, NODE_ID, body(span(HELD_JOB)))).rejects.toThrow(
        ForbiddenException
      );
      expect(prisma.job.findMany).not.toHaveBeenCalled();
    });

    it('reads the batch’s jobs in ONE query over the distinct ids', async () => {
      await service.relay(USER, NODE_ID, body(span(HELD_JOB), span(HELD_JOB), span(FOREIGN_JOB)));

      expect(prisma.job.findMany).toHaveBeenCalledTimes(1);
      expect((prisma.job.findMany as jest.Mock).mock.calls[0][0].where.id.in).toEqual([
        HELD_JOB,
        FOREIGN_JOB,
      ]);
    });
  });

  describe('rate limit', () => {
    it('answers 429 once the node exceeds its request budget, before reading any job', async () => {
      for (let i = 0; i < NODE_TELEMETRY_REQUESTS_PER_MINUTE; i += 1) {
        await service.relay(USER, NODE_ID, body(span(HELD_JOB)));
      }
      (prisma.job.findMany as jest.Mock).mockClear();

      const refusal = await service.relay(USER, NODE_ID, body(span(HELD_JOB))).catch((e) => e);

      expect(refusal).toBeInstanceOf(HttpException);
      expect((refusal as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(prisma.job.findMany).not.toHaveBeenCalled();
    });
  });

  describe('emission', () => {
    it('parents the span on the job’s stored traceparent, with explicit times', async () => {
      const start = Date.now() - 10_000;

      await service.relay(USER, NODE_ID, body(span(HELD_JOB, { startTimeUnixMs: start, durationMs: 2_500 })));

      const [emitted] = tracing.exporter.getFinishedSpans();
      expect(emitted.name).toBe('job.execute');
      expect(emitted.spanContext().traceId).toBe(TRACE_ID);
      expect(emitted.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);

      const startMs = emitted.startTime[0] * 1000 + emitted.startTime[1] / 1e6;
      const endMs = emitted.endTime[0] * 1000 + emitted.endTime[1] / 1e6;
      expect(Math.round(startMs)).toBe(start);
      expect(Math.round(endMs - startMs)).toBe(2_500);
    });

    it('takes node identity from the path and the row, and job facts from the job row', async () => {
      await service.relay(USER, NODE_ID, body(span(HELD_JOB)));

      const [emitted] = tracing.exporter.getFinishedSpans();
      expect(emitted.attributes).toMatchObject({
        'node.id': NODE_ID,
        'node.name': 'prod-worker-1',
        'job.id': HELD_JOB,
        'job.type': 'example.checksum',
        'job.executor': 'node',
      });
    });

    it('relays only the allowlisted attributes, renamed', async () => {
      await service.relay(
        USER,
        NODE_ID,
        body(span(HELD_JOB, { attributes: { bytes: 4096, attempt: 2, exitCode: 0, httpStatus: 200 } }))
      );

      const [emitted] = tracing.exporter.getFinishedSpans();
      expect(emitted.attributes).toMatchObject({
        'job.phase.bytes': 4096,
        'job.attempt': 2,
        'process.exit_code': 0,
        'http.response.status_code': 200,
      });
      expect(Object.keys(emitted.attributes)).not.toContain('bytes');
    });

    it('marks an errored phase ERROR with its errorType, never a message', async () => {
      await service.relay(
        USER,
        NODE_ID,
        body(span(HELD_JOB, { name: 'job.download', status: 'error', errorType: 'MissingJobInputError' }))
      );

      const [emitted] = tracing.exporter.getFinishedSpans();
      expect(emitted.status).toEqual({ code: SpanStatusCode.ERROR, message: 'MissingJobInputError' });
      expect(emitted.attributes['error.type']).toBe('MissingJobInputError');
    });

    it('emits a job with no stored trace context as a root span', async () => {
      ledger.record(SETTLED_JOB, NODE_ID);

      await service.relay(USER, NODE_ID, body(span(SETTLED_JOB)));

      const [emitted] = tracing.exporter.getFinishedSpans();
      expect(emitted.parentSpanContext).toBeUndefined();
      expect(emitted.attributes['job.id']).toBe(SETTLED_JOB);
    });

    it('never throws when the tracer does, and still counts the span as accepted', async () => {
      const spy = jest.spyOn(trace, 'getTracer').mockImplementation(() => {
        throw new Error('exporter on fire');
      });

      try {
        await expect(service.relay(USER, NODE_ID, body(span(HELD_JOB)))).resolves.toEqual({
          accepted: 1,
          dropped: 0,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});
