import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '../../doctor/doctor-check.interface';
import { DoctorCheckRegistry } from '../../doctor/doctor-check.registry';
import { TelemetryStackStatus } from '../stack/dto/telemetry-stack.dto';
import { STACK_AGENT_STATUS_TIMEOUT_MS, StackAgentClient } from '../stack/stack-agent.client';
import { TelemetryStackService } from '../stack/telemetry-stack.service';
import { TELEMETRY_SETTINGS_PATH } from './telemetry-export.doctor-check';

/** Pure: judges the stack agent's view of the telemetry containers. */
export function decideTelemetryStack(status: TelemetryStackStatus): DoctorCheckOutcome {
  const services = status.services;
  const notRunning = services.filter((s) => s.state !== 'running' || s.health === 'unhealthy');
  const data = { agent: status.agent, services: services.length, notRunning: notRunning.length };

  if (status.agent === 'unauthorized') {
    return {
      status: 'fail',
      detail: 'The stack agent refused this API’s token',
      remedy: 'Make STACK_AGENT_TOKEN identical for the api and stack-agent containers, then restart both.',
      data,
    };
  }

  if (status.agent !== 'available') {
    return {
      status: 'warn',
      detail: `The stack agent is ${status.agent === 'not_configured' ? 'not configured on its side' : 'unavailable'}`,
      remedy: 'Check the stack-agent container is running on the VPS (`docker ps`), and STACK_AGENT_URL.',
      data,
    };
  }

  if (services.length === 0 || notRunning.length > 0) {
    const names = notRunning.map((s) => `${s.name} (${s.health === 'unhealthy' ? 'unhealthy' : s.state})`).join(', ');

    return {
      status: 'warn',
      detail: services.length === 0 ? 'No telemetry containers are deployed' : `Not running: ${names}`,
      remedy: `Start or redeploy the telemetry stack from ${TELEMETRY_SETTINGS_PATH}.`,
      data,
    };
  }

  return { status: 'pass', detail: `${services.length} telemetry container(s) running`, data };
}

/**
 * `telemetry` / `telemetry.stack` — on a VPS deploy, the telemetry containers
 * the stack agent manages are running. Only `GET /v1/telemetry` on the agent;
 * never a deploy. Independent of the other telemetry checks: the containers
 * can be inspected (and are worth inspecting) even when collection is off.
 */
@Injectable()
export class TelemetryStackDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'telemetry.stack';
  readonly category = 'telemetry';
  readonly label = 'Telemetry containers';
  readonly settingsPath = TELEMETRY_SETTINGS_PATH;
  readonly timeoutMs = STACK_AGENT_STATUS_TIMEOUT_MS + 2_000;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly agent: StackAgentClient,
    private readonly stack: TelemetryStackService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    if (!this.agent.isConfigured()) {
      return { status: 'skip', detail: 'No stack agent (not a VPS deploy)' };
    }

    return decideTelemetryStack(await this.stack.getStatus());
  }
}
