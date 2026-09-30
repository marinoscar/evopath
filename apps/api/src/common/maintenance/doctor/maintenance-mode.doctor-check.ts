import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '../../../doctor/doctor-check.interface';
import { DoctorCheckRegistry } from '../../../doctor/doctor-check.registry';
import { MaintenanceModeService, MaintenanceStatus } from '../maintenance-mode.service';

const SOURCE_LABEL: Record<MaintenanceStatus['source'], string> = {
  env: 'the MAINTENANCE_MODE environment variable',
  memory: 'an in-memory override on this instance',
  persisted: 'the saved maintenance setting',
};

/** Pure: an open window is worth knowing about, and so is which layer holds it open. */
export function decideMaintenance(status: MaintenanceStatus): DoctorCheckOutcome {
  const data = {
    enabled: status.enabled,
    source: status.source,
    allowAdmins: status.allowAdmins,
    startedAt: status.startedAt,
    settingsReadable: status.layers.persisted.readable,
  };

  if (status.enabled) {
    return {
      status: 'warn',
      detail: `Maintenance mode is ON (set by ${SOURCE_LABEL[status.source]}); non-admin requests get 503`,
      remedy:
        status.source === 'env'
          ? 'Unset MAINTENANCE_MODE (or set it to `false`) and restart the API; it outranks the admin switch.'
          : 'Turn maintenance mode off at /admin/settings/maintenance when the work is done.',
      data,
    };
  }

  if (!status.layers.persisted.readable) {
    return {
      status: 'warn',
      detail: 'Maintenance mode is off, but the saved setting could not be read',
      remedy: 'Check the database connection; the switch is answering from its last known state.',
      data,
    };
  }

  return { status: 'pass', detail: 'Maintenance mode is off', data };
}

/** `maintenance` / `maintenance.mode` — the deployment is in service. */
@Injectable()
export class MaintenanceModeDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'maintenance.mode';
  readonly category = 'maintenance';
  readonly label = 'Maintenance mode';
  readonly settingsPath = '/admin/settings/maintenance';

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly maintenance: MaintenanceModeService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    return decideMaintenance(await this.maintenance.resolve({ fresh: true }));
  }
}
