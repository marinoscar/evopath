import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { STACK_SERVICE_HEALTH, STACK_SERVICE_STATES } from '../stack-agent.client';

// =============================================================================
// /api/admin/telemetry/stack — responses (issue #567, epic #528)
// =============================================================================
//
// A diagnosis, never an error: a deployment without a stack-agent (every
// development machine) is `agent: 'not_configured'` with a 200, so the admin
// page can say so instead of rendering a failure.
// =============================================================================

export const TELEMETRY_STACK_AGENT_STATES = ['available', 'unavailable', 'unauthorized', 'not_configured'] as const;

export const telemetryStackServiceSchema = z.object({
  /** The compose service, e.g. `greptimedb` or `otel-collector`. */
  name: z.string(),
  /** The container's state; `missing` when it has never been created. */
  state: z.enum(STACK_SERVICE_STATES),
  /** The container's health check, or null when it has none (or is not running). */
  health: z.enum(STACK_SERVICE_HEALTH).nullable(),
});

export const telemetryStackDeploySchema = z.object({
  jobId: z.string(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** Why the deploy failed (`Job.lastError`), or null. */
  error: z.string().nullable(),
  /** The agent's command output (tail, at most 4 KB), or null before it answered. */
  output: z.string().nullable(),
});

export const telemetryStackStatusSchema = z.object({
  /**
   * `available` — the stack-agent answered; `unavailable` — it is configured but
   * could not be reached (or answered unexpectedly); `unauthorized` — it refused
   * the API's token; `not_configured` — this deployment has no stack-agent.
   */
  agent: z.enum(TELEMETRY_STACK_AGENT_STATES),
  /**
   * Why the stack-agent is `unavailable` or `unauthorized`: the client's
   * message (the agent's origin and the failure, never the token). Null when
   * `agent` is `available` or `not_configured`.
   */
  agentError: z
    .string()
    .nullable()
    .describe(
      'Why the stack agent is `unavailable` or `unauthorized`: the agent origin and the failure ' +
        '(for example a timeout, a connection error or the HTTP status). Never carries the token. ' +
        'Null when `agent` is `available` or `not_configured`.',
    ),
  /** Each telemetry service's container. Empty unless `agent` is `available`. */
  services: z.array(telemetryStackServiceSchema),
  /** The most recent `telemetry.stack.deploy` job, or null when there has never been one. */
  deploy: telemetryStackDeploySchema.nullable(),
});

export const telemetryStackDeployStartedSchema = z.object({
  /** The deploy job — a new one, or the one already pending/running. */
  jobId: z.string(),
});

export class TelemetryStackStatusDto extends createZodDto(telemetryStackStatusSchema) {}
export class TelemetryStackDeployStartedDto extends createZodDto(telemetryStackDeployStartedSchema) {}

export type TelemetryStackStatus = z.infer<typeof telemetryStackStatusSchema>;
export type TelemetryStackDeploy = z.infer<typeof telemetryStackDeploySchema>;
export type TelemetryStackAgentState = (typeof TELEMETRY_STACK_AGENT_STATES)[number];
