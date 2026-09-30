import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '../../doctor/doctor-check.interface';
import { DoctorCheckRegistry } from '../../doctor/doctor-check.registry';
import { NodesAdminService } from '../nodes-admin.service';

export const NODES_SETTINGS_PATH = '/admin/settings/workers';

/**
 * Pure: judges the fleet from the admin view, whose `health` is already
 * `deriveNodeHealth`'s verdict (heartbeat age against the stale window).
 *
 * A DISABLED node is left out of the verdict: an operator switched it off, so
 * its silence is not news. Its count is still reported.
 */
export function decideNodesFleet(nodes: Array<{ name: string; status: string; health: string }>): DoctorCheckOutcome {
  if (nodes.length === 0) {
    return { status: 'pass', detail: 'No worker nodes enrolled; this API runs every job itself', data: { nodes: 0 } };
  }

  const active = nodes.filter((n) => n.status !== 'disabled');
  const healthy = active.filter((n) => n.health === 'healthy');
  const unhealthy = active.filter((n) => n.health !== 'healthy');
  const data = {
    nodes: nodes.length,
    healthy: healthy.length,
    stale: active.filter((n) => n.health === 'stale').length,
    offline: active.filter((n) => n.health === 'offline').length,
    disabled: nodes.length - active.length,
  };

  if (unhealthy.length > 0) {
    const names = unhealthy.slice(0, 5).map((n) => `${n.name} (${n.health})`).join(', ');

    return {
      status: 'warn',
      detail: `${unhealthy.length} of ${active.length} active node(s) not heartbeating: ${names}${unhealthy.length > 5 ? ', …' : ''}`,
      remedy:
        `Check the node processes are running and can reach the API (\`appctl node status\` on the node), ` +
        `or disable or remove them at ${NODES_SETTINGS_PATH}.`,
      data,
    };
  }

  return { status: 'pass', detail: `${healthy.length} node(s) healthy`, data };
}

/** `nodes` / `nodes.fleet` — every enrolled worker node is heartbeating. */
@Injectable()
export class NodesFleetDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'nodes.fleet';
  readonly category = 'nodes';
  readonly label = 'Worker node fleet';
  readonly settingsPath = NODES_SETTINGS_PATH;
  readonly dependsOn = ['db.connection'];

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly nodesAdmin: NodesAdminService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    return decideNodesFleet(await this.nodesAdmin.listFleet());
  }
}
