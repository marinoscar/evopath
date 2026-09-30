import { DoctorCheckRegistry } from '../../../doctor/doctor-check.registry';
import { MaintenanceModeService, MaintenanceStatus } from '../maintenance-mode.service';
import { MaintenanceModeDoctorCheck, decideMaintenance } from './maintenance-mode.doctor-check';

function status(overrides: Partial<MaintenanceStatus> = {}, readable = true): MaintenanceStatus {
  return {
    enabled: false,
    message: 'Back soon',
    allowAdmins: true,
    startedAt: null,
    startedById: null,
    source: 'persisted',
    layers: {
      env: { present: false, enabled: null },
      memory: { present: false, override: null },
      persisted: { readable, value: { enabled: false } as never },
    },
    ...overrides,
  };
}

describe('maintenance.mode doctor check', () => {
  it('passes when the deployment is in service', () => {
    expect(decideMaintenance(status())).toMatchObject({ status: 'pass', data: { enabled: false } });
  });

  it('warns when a window is open, naming the layer', () => {
    const outcome = decideMaintenance(status({ enabled: true, source: 'persisted' }));

    expect(outcome.status).toBe('warn');
    expect(outcome.detail).toContain('saved maintenance setting');
    expect(outcome.remedy).toContain('/admin/settings/maintenance');
  });

  it('points at the environment variable when env holds it open', () => {
    const outcome = decideMaintenance(status({ enabled: true, source: 'env' }));

    expect(outcome.status).toBe('warn');
    expect(outcome.remedy).toContain('MAINTENANCE_MODE');
  });

  it('warns when the saved setting could not be read', () => {
    const outcome = decideMaintenance(status({}, false));

    expect(outcome.status).toBe('warn');
    expect(outcome.remedy).toEqual(expect.any(String));
  });

  it('reads the switch fresh and registers itself', async () => {
    const resolve = jest.fn().mockResolvedValue(status());
    const registry = new DoctorCheckRegistry();
    const check = new MaintenanceModeDoctorCheck(registry, { resolve } as unknown as MaintenanceModeService);
    check.onModuleInit();

    await check.run();

    expect(resolve).toHaveBeenCalledWith({ fresh: true });
    expect(registry.get('maintenance.mode')).toBe(check);
  });
});
