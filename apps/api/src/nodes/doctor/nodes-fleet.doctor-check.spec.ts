import { DoctorCheckRegistry } from '../../doctor/doctor-check.registry';
import { NodesAdminService } from '../nodes-admin.service';
import { NodesFleetDoctorCheck, decideNodesFleet } from './nodes-fleet.doctor-check';

describe('nodes.fleet doctor check', () => {
  it('passes with no nodes enrolled', () => {
    expect(decideNodesFleet([])).toMatchObject({ status: 'pass', detail: expect.stringContaining('No worker nodes') });
  });

  it('passes when every active node is healthy', () => {
    expect(
      decideNodesFleet([
        { name: 'a', status: 'online', health: 'healthy' },
        { name: 'b', status: 'online', health: 'healthy' },
      ]),
    ).toMatchObject({ status: 'pass', data: { healthy: 2 } });
  });

  it('warns on a stale or offline node, naming it, with a remedy', () => {
    const outcome = decideNodesFleet([
      { name: 'a', status: 'online', health: 'healthy' },
      { name: 'gpu-1', status: 'online', health: 'stale' },
      { name: 'gpu-2', status: 'offline', health: 'offline' },
    ]);

    expect(outcome.status).toBe('warn');
    expect(outcome.detail).toContain('gpu-1 (stale)');
    expect(outcome.data).toMatchObject({ stale: 1, offline: 1 });
    expect(outcome.remedy).toContain('/admin/settings/workers');
  });

  it('ignores a disabled node’s silence', () => {
    expect(
      decideNodesFleet([{ name: 'parked', status: 'disabled', health: 'offline' }]),
    ).toMatchObject({ status: 'pass', data: { disabled: 1 } });
  });

  it('reads the admin fleet view and registers itself', async () => {
    const listFleet = jest.fn().mockResolvedValue([]);
    const registry = new DoctorCheckRegistry();
    const check = new NodesFleetDoctorCheck(registry, { listFleet } as unknown as NodesAdminService);
    check.onModuleInit();

    await expect(check.run()).resolves.toMatchObject({ status: 'pass' });
    expect(registry.get('nodes.fleet')).toBe(check);
  });
});
