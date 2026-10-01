import { Logger } from '@nestjs/common';

import { createMockPrismaService, type MockPrismaService } from '../../test/mocks/prisma.mock';
import { CheckInsService } from '../check-ins/check-ins.service';
import { HealthProfileService } from '../health-profile/health-profile.service';
import type { PrismaService } from '../prisma/prisma.service';
import { createMeasurementEntrySchema } from './dto/measurement.dto';
import { emitHealthDataChanged, HEALTH_DATA_CHANGED_EVENT } from './health-data-events';
import { MeasurementsService } from './measurements.service';

// =============================================================================
// health.data.changed (H8, #192): emitted after every committed health write
// the AI health summary reads, never before the commit and never on a failure.
// =============================================================================

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID = '22222222-2222-4222-8222-222222222222';

describe('health.data.changed emitters (H8, #192)', () => {
  let prisma: MockPrismaService;
  let events: { emit: jest.Mock };

  beforeEach(() => {
    prisma = createMockPrismaService();
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prisma));
    events = { emit: jest.fn(() => true) };
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('MeasurementsService', () => {
    let service: MeasurementsService;

    beforeEach(() => {
      service = new MeasurementsService(prisma as unknown as PrismaService, events as never);
    });

    it('createEntry emits after its transaction', async () => {
      (prisma.measurement.create as jest.Mock).mockImplementation(async ({ data }: any) => ({
        id: '33333333-3333-4333-8333-333333333333',
        revision: 1,
        supersedesId: null,
        supersededAt: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        referenceLow: null,
        referenceHigh: null,
        referenceText: null,
        flag: null,
        localDate: null,
        ...data,
        sourceRef: null,
      }));

      await service.createEntry(USER_ID, createMeasurementEntrySchema.parse({ readings: [{ metricKey: 'weight', value: 80 }] }));

      expect(events.emit).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledWith(HEALTH_DATA_CHANGED_EVENT, { userId: USER_ID, source: 'measurements' });
      expect(events.emit.mock.invocationCallOrder[0]).toBeGreaterThan((prisma.measurement.create as jest.Mock).mock.invocationCallOrder[0]);
    });

    it('deleteEntry emits; a 404 emits nothing', async () => {
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

      await expect(service.deleteEntry(USER_ID, ENTRY_ID)).rejects.toThrow();
      expect(events.emit).not.toHaveBeenCalled();

      await service.deleteEntry(USER_ID, ENTRY_ID);
      expect(events.emit).toHaveBeenCalledWith(HEALTH_DATA_CHANGED_EVENT, { userId: USER_ID, source: 'measurements' });
    });

    it('a throwing listener never fails the write', async () => {
      events.emit.mockImplementation(() => {
        throw new Error('listener bug');
      });
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await expect(service.deleteEntry(USER_ID, ENTRY_ID)).resolves.toBeUndefined();
    });
  });

  it('CheckInsService.remove emits with source check_in', async () => {
    const service = new CheckInsService(prisma as unknown as PrismaService, {} as never, events as never);
    (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 4 });

    await service.remove(USER_ID, '2026-09-30');

    expect(events.emit).toHaveBeenCalledWith(HEALTH_DATA_CHANGED_EVENT, { userId: USER_ID, source: 'check_in' });
  });

  describe('HealthProfileService.put', () => {
    const existing = {
      id: 'p1',
      userId: USER_ID,
      dateOfBirth: new Date('1980-01-01T00:00:00Z'),
      sexAtBirth: 'male',
      heightMm: 1800,
      unitSystem: 'metric',
      timeZone: 'UTC',
      bio: 'old',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    function arrange(updated: Partial<typeof existing>) {
      (prisma.healthProfile.findUnique as jest.Mock).mockResolvedValue(existing);
      (prisma.healthProfile.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.healthProfile.findUniqueOrThrow as jest.Mock).mockResolvedValue({ ...existing, ...updated, version: 2 });
    }

    const input = (overrides: Record<string, unknown>) => ({
      dateOfBirth: '1980-01-01',
      sexAtBirth: 'male',
      heightMm: 1800,
      unitSystem: 'metric',
      timeZone: 'UTC',
      bio: 'old',
      ...overrides,
    });

    it('emits when the age or sex input changes', async () => {
      const service = new HealthProfileService(prisma as unknown as PrismaService, events as never);
      arrange({ dateOfBirth: new Date('1981-01-01T00:00:00Z') });

      await service.put(USER_ID, input({ dateOfBirth: '1981-01-01' }) as never);

      expect(events.emit).toHaveBeenCalledWith(HEALTH_DATA_CHANGED_EVENT, { userId: USER_ID, source: 'health_profile' });
    });

    it('does not emit for a field the summary does not read (the bio)', async () => {
      const service = new HealthProfileService(prisma as unknown as PrismaService, events as never);
      arrange({ bio: 'new' });

      await service.put(USER_ID, input({ bio: 'new' }) as never);

      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  it('emitHealthDataChanged tolerates no emitter at all', () => {
    expect(() => emitHealthDataChanged(undefined, { warn: jest.fn() }, { userId: USER_ID, source: 'intake' })).not.toThrow();
  });
});
