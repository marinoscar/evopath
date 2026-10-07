// =============================================================================
// The node span relay (issue #133)
// =============================================================================
//
// `POST /api/nodes/:id/telemetry` lands here. A node reports the phases of a
// job it ran (download, execute, upload, submit, secret) and this service
// re-emits each accepted phase as a real OpenTelemetry span through the
// server's own tracer, parented on the span that ENQUEUED the job
// (`jobs.trace_context`, #132). The result, in the trace explorer: the request
// that queued a backup, then the node's download/execute/upload/submit under
// it, in one trace — and a node that never learns where the collector is.
//
// -----------------------------------------------------------------------------
// THE ORDER OF OPERATIONS IS THE SECURITY ARGUMENT
// -----------------------------------------------------------------------------
//
//   1. OWNERSHIP (`NodesService.assertOwnership`): 404/403 before anything
//      else, so a caller learns nothing about a node that is not theirs, and
//      so the rate-limit bucket below can only ever be keyed by a node the
//      caller owns.
//   2. RATE LIMIT (`NodeTelemetryRateLimiter`): 429 for the whole request.
//   3. ATTRIBUTION, PER SPAN: a span is accepted only when its job is held by
//      THIS node right now (`claimedByNodeId === :id`) or was settled by this
//      node within the grace window (`NodeSettlementLedger`). Anything else —
//      a job that does not exist, one held by another node, one this node ran
//      last week — is DROPPED AND COUNTED, never accepted. Dropping rather than
//      refusing the batch means one stale span cannot cost a node the rest of
//      a legitimate batch, and the count tells the node (and a test) exactly
//      what happened without saying anything about another node's jobs.
//   4. EMISSION: identity attributes come from the PATH and the ROWS
//      (`node.id`, `node.name`, `job.id`, `job.type`), never from the payload.
//
// ⚠ EMISSION NEVER THROWS. Tracing is an observer: a misbehaving exporter or
// processor loses a span, never the request. An accepted span with tracing
// off is discarded by the API's no-op tracer, and still counted as accepted —
// "accepted" means "attributed and handed over", which is what the node can
// act on.
//
// A JOB WITH NO STORED TRACE CONTEXT still gets its spans, as a root trace of
// its own (the same choice `JobWorker.withJobSpan` makes for a server-run job
// with no parent): `job.id` on every span still ties them together, and
// dropping them would hide exactly the jobs enqueued outside a traced request
// — crons, which are most of the background work.
// =============================================================================

import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Attributes, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { resolveServiceName } from '../common/otel/telemetry-identity';
import { jobParentContext } from '../jobs/job-trace-context';
import { PrismaService } from '../prisma/prisma.service';
import { NodeSpan, NodeTelemetryDto } from './dto/node-telemetry.dto';
import { NodeSettlementLedger } from './node-settlement-ledger';
import { NodeTelemetryRateLimiter } from './node-telemetry-rate-limiter';
import { NodesService } from './nodes.service';

/** What the relay tells the node. */
export interface NodeTelemetryOutcome {
  accepted: number;
  dropped: number;
}

/** The job columns attribution and emission read — nothing else is selected. */
interface JobAttributionRow {
  id: string;
  type: string;
  claimedByNodeId: string | null;
  traceContext: string | null;
}

/** Wire attribute key → span attribute key. The ONLY attributes relayed. */
const RELAYED_ATTRIBUTES: Record<string, string> = {
  bytes: 'job.phase.bytes',
  attempt: 'job.attempt',
  exitCode: 'process.exit_code',
  httpStatus: 'http.response.status_code',
};

@Injectable()
export class NodeTelemetryService {
  private readonly logger = new Logger(NodeTelemetryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nodes: NodesService,
    private readonly ledger: NodeSettlementLedger,
    private readonly limiter: NodeTelemetryRateLimiter
  ) {}

  async relay(userId: string, nodeId: string, dto: NodeTelemetryDto): Promise<NodeTelemetryOutcome> {
    // 1. Ownership — see the header for why it comes first.
    const node = await this.nodes.assertOwnership(userId, nodeId);

    // 2. Budget.
    const verdict = this.limiter.take(node.id, dto.spans.length);
    if (!verdict.allowed) {
      throw new HttpException(
        {
          message:
            `Worker node ${node.id} is sending spans faster than this server relays them. ` +
            `Drop this batch; do not retry it.`,
          details: { nodeId: node.id, reason: 'rate_limited', retryAfterMs: verdict.retryAfterMs },
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    // 3. Attribution — one query for the whole batch (at most 50 distinct ids).
    const jobIds = [...new Set(dto.spans.map((span) => span.jobId))];
    const rows: JobAttributionRow[] = await this.prisma.job.findMany({
      where: { id: { in: jobIds } },
      select: { id: true, type: true, claimedByNodeId: true, traceContext: true },
    });
    const attributable = new Map<string, JobAttributionRow>();
    for (const row of rows) {
      if (row.claimedByNodeId === node.id || this.ledger.settledRecentlyBy(row.id, node.id)) {
        attributable.set(row.id, row);
      }
    }

    // 4. Emission.
    let accepted = 0;
    for (const span of dto.spans) {
      const job = attributable.get(span.jobId);
      if (!job) continue;

      accepted += 1;
      this.emit(node.id, node.name, job, span);
    }

    const dropped = dto.spans.length - accepted;
    if (dropped > 0) {
      this.logger.debug(
        `Node ${node.id}: dropped ${dropped} of ${dto.spans.length} relayed span(s) for jobs ` +
          `not held or recently settled by this node`
      );
    }

    return { accepted, dropped };
  }

  /** Re-emits one node phase span. Never throws — see the header. */
  private emit(nodeId: string, nodeName: string, job: JobAttributionRow, span: NodeSpan): void {
    try {
      const attributes: Attributes = {
        'job.id': job.id,
        'job.type': job.type,
        'job.executor': 'node',
        'node.id': nodeId,
        'node.name': nodeName,
        // Provenance: this span was reported by a node, not observed here.
        'telemetry.relay': 'node',
      };

      for (const [key, value] of Object.entries(span.attributes ?? {})) {
        const mapped = RELAYED_ATTRIBUTES[key];
        if (mapped !== undefined && typeof value === 'number') attributes[mapped] = value;
      }

      if (span.status === 'error' && span.errorType !== undefined) {
        attributes['error.type'] = span.errorType;
      }

      const otelSpan = trace.getTracer(resolveServiceName()).startSpan(
        span.name,
        {
          kind: SpanKind.INTERNAL,
          startTime: span.startTimeUnixMs,
          attributes,
        },
        jobParentContext(job.traceContext)
      );

      if (span.status === 'error') {
        otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: span.errorType ?? 'error' });
      }

      otelSpan.end(span.startTimeUnixMs + span.durationMs);
    } catch {
      // Best-effort; see the header.
    }
  }
}
