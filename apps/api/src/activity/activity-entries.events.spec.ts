import { ACTIVITY_ENTRY_RECORDED_EVENT } from './activity-events';
import { ActivityEntriesService } from './activity-entries.service';

// #269: `activity.entry.recorded` after a manual check-in committed.

const USER = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-09-30T12:00:00Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000e1',
    userId: USER,
    occurredOn: new Date('2026-09-30T00:00:00Z'),
    occurredAt: null,
    activityKind: 'walk',
    completed: true,
    durationSeconds: null,
    steps: null,
    distanceMeters: null,
    source: 'manual',
    workoutId: null,
    provider: null,
    externalId: null,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function setup(options: { createdCount?: number; emitThrows?: boolean } = {}) {
  const order: string[] = [];
  const tx = {
    activityEntry: { createMany: jest.fn(async () => ({ count: options.createdCount ?? 1 })) },
    $queryRaw: jest.fn(async () => []),
  };
  const prisma = {
    activityEntry: { create: jest.fn(async () => (order.push('write'), row())) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      const result = await fn(tx);
      order.push('commit');
      return result;
    }),
  };
  const checkIns = { today: jest.fn(async () => '2026-09-30') };
  const events = {
    emit: jest.fn(() => {
      order.push('emit');
      if (options.emitThrows) throw new Error('listener blew up');
      return true;
    }),
  };
  const service = new ActivityEntriesService(prisma as never, checkIns as never, {} as never, events as never);
  return { service, events, order };
}

describe('ActivityEntriesService: activity.entry.recorded', () => {
  it('create emits once, after the row was written, with ids and an instant only', async () => {
    const t = setup();
    const before = Date.now();
    await t.service.create(USER, { activityKind: 'walk' } as never, NOW);
    expect(t.order).toEqual(['write', 'emit']);
    expect(t.events.emit).toHaveBeenCalledWith(ACTIVITY_ENTRY_RECORDED_EVENT, { userId: USER, recordedSince: expect.any(String) });
    const payload = (t.events.emit.mock.calls[0] as unknown as [string, { recordedSince: string }])[1];
    expect(Date.parse(payload.recordedSince)).toBeGreaterThanOrEqual(before - 1);
    expect(Object.keys(payload).sort()).toEqual(['recordedSince', 'userId']);
  });

  it('batch emits after the transaction committed', async () => {
    const t = setup();
    await t.service.batch(USER, { entries: [{ activityKind: 'walk' }] } as never, NOW);
    expect(t.order).toEqual(['commit', 'emit']);
  });

  it('a batch that wrote nothing emits nothing', async () => {
    const t = setup({ createdCount: 0 });
    await t.service.batch(USER, { entries: [{ activityKind: 'walk' }] } as never, NOW);
    expect(t.events.emit).not.toHaveBeenCalled();
  });

  it('a throwing listener never fails the check-in', async () => {
    const t = setup({ emitThrows: true });
    await expect(t.service.create(USER, { activityKind: 'walk' } as never, NOW)).resolves.toMatchObject({ activityKind: 'walk' });
  });
});
