import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { Job, Prisma } from '@prisma/client';

import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { TelemetryStackAgentState, TelemetryStackDeploy, TelemetryStackStatus } from './dto/telemetry-stack.dto';
import { StackAgentClient } from './stack-agent.client';
import { TELEMETRY_STACK_DEPLOY_TYPE } from './telemetry-stack-deploy.handler';

// =============================================================================
// TelemetryStackService — GET /api/admin/telemetry/stack and
// POST /api/admin/telemetry/stack/deploy (issue #567, epic #528)
// =============================================================================
//
// The status read asks the stack-agent for each telemetry container's state
// (bounded to five seconds) and reads the most recent deploy job. It always
// answers: an agent that is missing, unreachable or refusing the token is a
// state, not an error.
//
// The deploy enqueues `telemetry.stack.deploy` — never calls the agent inline
// (an image pull can take ten minutes). The job has no subject, so the queue's
// active-dedup index makes the enqueue idempotent: while one is pending or
// running, the call returns that job. Refused with 409 when this deployment
// has no stack-agent, since the job could only fail.
// =============================================================================

export const TELEMETRY_STACK_DEPLOY_AUDIT_ACTION = 'telemetry:stack_deploy';

@Injectable()
export class TelemetryStackService {
  private readonly logger = new Logger(TelemetryStackService.name);

  constructor(
    private readonly agent: StackAgentClient,
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  async getStatus(): Promise<TelemetryStackStatus> {
    const [status, latest] = await Promise.all([
      this.agent.telemetryStatus(),
      this.prisma.job.findFirst({
        where: { type: TELEMETRY_STACK_DEPLOY_TYPE },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    let agent: TelemetryStackAgentState;
    if (status.ok) {
      agent = 'available';
    } else if (status.error === 'not_configured' || status.error === 'unauthorized') {
      agent = status.error;
    } else {
      agent = 'unavailable';
    }

    return {
      agent,
      services: status.ok ? status.services : [],
      deploy: latest ? toDeploy(latest) : null,
    };
  }

  /** Queues a deploy (or returns the one in flight) and audits the request. */
  async deploy(userId: string): Promise<{ jobId: string }> {
    if (!this.agent.isConfigured()) {
      throw new ConflictException({
        message:
          'GreptimeDB cannot be deployed from here: this deployment has no stack agent ' +
          '(STACK_AGENT_URL and STACK_AGENT_TOKEN are not set).',
        details: { reason: 'STACK_AGENT_NOT_CONFIGURED' },
      });
    }

    const job = await this.jobs.enqueue({
      type: TELEMETRY_STACK_DEPLOY_TYPE,
      // A person asking for the stack to be (re)started.
      reason: 'rerun',
      // GLOBAL — no subject — so the dedup key is constant for the type and
      // at most one deploy is ever pending or running.
      payload: { requestedByUserId: userId },
    });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: TELEMETRY_STACK_DEPLOY_AUDIT_ACTION,
        targetType: 'job',
        targetId: job.id,
        meta: { type: TELEMETRY_STACK_DEPLOY_TYPE, status: job.status } as Prisma.InputJsonValue,
      },
    });

    this.logger.log(`Telemetry stack deploy requested by ${userId} (job ${job.id}, ${job.status})`);

    return { jobId: job.id };
  }
}

/** The API shape of one deploy job. `output` comes from the handler's `payload.result`. */
export function toDeploy(job: Pick<Job, 'id' | 'status' | 'createdAt' | 'finishedAt' | 'lastError' | 'payload'>): TelemetryStackDeploy {
  const payload = job.payload as { result?: { output?: unknown } } | null;
  const output = payload && typeof payload === 'object' ? payload.result?.output : undefined;

  return {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    // A succeeded job's `lastError` is history from an earlier attempt, not its outcome.
    error: job.status === 'succeeded' ? null : (job.lastError ?? null),
    output: typeof output === 'string' ? output : null,
  };
}
