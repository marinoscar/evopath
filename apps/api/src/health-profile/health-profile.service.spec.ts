import { ConflictException, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { PrismaService } from '../prisma/prisma.service';
import type { HealthProfileInput } from './dto/health-profile.dto';
import {
  HEALTH_PROFILE_AUDIT_ACTION,
  HEALTH_PROFILE_AUDIT_TARGET,
  HealthProfileService,
  changedFields,
} from './health-profile.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const UPDATED_AT = new Date('2026-09-29T10:00:00.000Z');

const INPUT: HealthProfileInput = {
  dateOfBirth: '2000-02-29',
  sexAtBirth: 'male',
  heightMm: 1778,
  unitSystem: 'imperial',
  timeZone: 'America/Costa_Rica',
  bio: 'private free text',
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hp-1',
    userId: USER_ID,
    dateOfBirth: new Date('2000-02-29T00:00:00.000Z'),
    sexAtBirth: 'male',
    heightMm: 1778,
    unitSystem: 'imperial',
    timeZone: 'America/Costa_Rica',
    bio: 'private free text',
    labUnits: 'conventional',
    version: 1,
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe('HealthProfileService', () => {
  let service: HealthProfileService;
  let prisma: MockPrismaService;

  beforeEach(async () => {
    prisma = createMockPrismaService();
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prisma));

    const module: TestingModule = await Test.createTestingModule({
      providers: [HealthProfileService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(HealthProfileService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('get', () => {
    it('returns the empty profile with version 0 when no row exists', async () => {
      prisma.healthProfile.findUnique.mockResolvedValue(null);

      await expect(service.get(USER_ID)).resolves.toEqual({
        dateOfBirth: null,
        sexAtBirth: null,
        heightMm: null,
        unitSystem: 'metric',
        timeZone: null,
        bio: null,
        labUnits: 'conventional',
        version: 0,
        updatedAt: null,
      });
      expect(prisma.healthProfile.findUnique).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    });

    it('maps a stored row, formatting the date through UTC', async () => {
      prisma.healthProfile.findUnique.mockResolvedValue(row({ version: 4 }) as any);

      await expect(service.get(USER_ID)).resolves.toEqual({
        dateOfBirth: '2000-02-29',
        sexAtBirth: 'male',
        heightMm: 1778,
        unitSystem: 'imperial',
        timeZone: 'America/Costa_Rica',
        bio: 'private free text',
        labUnits: 'conventional',
        version: 4,
        updatedAt: UPDATED_AT.toISOString(),
      });
    });

    it('maps a stored SI lab-unit preference', async () => {
      prisma.healthProfile.findUnique.mockResolvedValue(row({ labUnits: 'si' }) as any);

      await expect(service.get(USER_ID)).resolves.toMatchObject({ labUnits: 'si' });
    });
  });

  describe('getTimeZone', () => {
    it('returns the stored zone', async () => {
      prisma.healthProfile.findUnique.mockResolvedValue({ timeZone: 'UTC' } as any);

      await expect(service.getTimeZone(USER_ID)).resolves.toBe('UTC');
      expect(prisma.healthProfile.findUnique).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        select: { timeZone: true },
      });
    });

    it('returns null when no profile or no zone is stored', async () => {
      prisma.healthProfile.findUnique.mockResolvedValueOnce(null);
      await expect(service.getTimeZone(USER_ID)).resolves.toBeNull();

      prisma.healthProfile.findUnique.mockResolvedValueOnce({ timeZone: null } as any);
      await expect(service.getTimeZone(USER_ID)).resolves.toBeNull();
    });
  });

  describe('put', () => {
    it('creates the first profile at version 1, storing the date at UTC midnight', async () => {
      prisma.healthProfile.findUnique.mockResolvedValue(null);
      prisma.healthProfile.create.mockResolvedValue(row() as any);

      const saved = await service.put(USER_ID, INPUT);

      expect(saved.version).toBe(1);
      expect(saved.labUnits).toBe('conventional');
      expect(saved.dateOfBirth).toBe('2000-02-29');
      expect(prisma.healthProfile.create).toHaveBeenCalledWith({
        data: {
          userId: USER_ID,
          dateOfBirth: new Date('2000-02-29T00:00:00.000Z'),
          sexAtBirth: 'male',
          heightMm: 1778,
          unitSystem: 'imperial',
          timeZone: 'America/Costa_Rica',
          bio: 'private free text',
          version: 1,
        },
      });
      expect(prisma.healthProfile.updateMany).not.toHaveBeenCalled();
    });

    it('updates an existing profile conditionally on its version and increments it', async () => {
      prisma.healthProfile.findUnique.mockResolvedValue(row({ version: 1, heightMm: 1700 }) as any);
      prisma.healthProfile.updateMany.mockResolvedValue({ count: 1 });
      prisma.healthProfile.findUniqueOrThrow.mockResolvedValue(row({ version: 2 }) as any);

      const saved = await service.put(USER_ID, INPUT);

      expect(saved.version).toBe(2);
      expect(prisma.healthProfile.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, version: 1 },
        data: expect.objectContaining({ heightMm: 1778, version: { increment: 1 } }),
      });
      expect(prisma.healthProfile.create).not.toHaveBeenCalled();
    });

    it('clears fields a full replace leaves null', async () => {
      prisma.healthProfile.findUnique.mockResolvedValue(row() as any);
      prisma.healthProfile.updateMany.mockResolvedValue({ count: 1 });
      prisma.healthProfile.findUniqueOrThrow.mockResolvedValue(row({ version: 2 }) as any);

      await service.put(USER_ID, {
        dateOfBirth: null,
        sexAtBirth: null,
        heightMm: null,
        unitSystem: 'metric',
        timeZone: null,
        bio: null,
      });

      expect(prisma.healthProfile.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            dateOfBirth: null,
            sexAtBirth: null,
            heightMm: null,
            unitSystem: 'metric',
            timeZone: null,
            bio: null,
            version: { increment: 1 },
          },
        }),
      );
    });

    it('writes labUnits when given and leaves the stored value alone when omitted', async () => {
      prisma.healthProfile.findUnique.mockResolvedValue(row() as any);
      prisma.healthProfile.updateMany.mockResolvedValue({ count: 1 });
      prisma.healthProfile.findUniqueOrThrow.mockResolvedValue(row({ version: 2, labUnits: 'si' }) as any);

      await expect(service.put(USER_ID, { ...INPUT, labUnits: 'si' })).resolves.toMatchObject({ labUnits: 'si' });
      expect(prisma.healthProfile.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ labUnits: 'si' }) }),
      );

      await service.put(USER_ID, INPUT);
      const data = (prisma.healthProfile.updateMany as jest.Mock).mock.calls.at(-1)[0].data;
      expect(data).not.toHaveProperty('labUnits');
    });

    it('accepts If-Match 0 for a first save', async () => {
      prisma.healthProfile.findUnique.mockResolvedValue(null);
      prisma.healthProfile.create.mockResolvedValue(row() as any);

      await expect(service.put(USER_ID, INPUT, 0)).resolves.toMatchObject({ version: 1 });
    });

    it('accepts a matching If-Match', async () => {
      prisma.healthProfile.findUnique.mockResolvedValue(row({ version: 3 }) as any);
      prisma.healthProfile.updateMany.mockResolvedValue({ count: 1 });
      prisma.healthProfile.findUniqueOrThrow.mockResolvedValue(row({ version: 4 }) as any);

      await expect(service.put(USER_ID, INPUT, 3)).resolves.toMatchObject({ version: 4 });
    });

    it('refuses a stale If-Match with 409 and writes nothing', async () => {
      prisma.healthProfile.findUnique.mockResolvedValue(row({ version: 2 }) as any);

      await expect(service.put(USER_ID, INPUT, 1)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.healthProfile.updateMany).not.toHaveBeenCalled();
      expect(prisma.healthProfile.create).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('refuses an If-Match other than 0 when nothing is stored', async () => {
      prisma.healthProfile.findUnique.mockResolvedValue(null);

      await expect(service.put(USER_ID, INPUT, 1)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.healthProfile.create).not.toHaveBeenCalled();
    });

    it('returns 409 when the row changed between the read and the conditional update', async () => {
      prisma.healthProfile.findUnique.mockResolvedValue(row({ version: 2 }) as any);
      prisma.healthProfile.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.put(USER_ID, INPUT, 2)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('maps a concurrent first save (unique violation) to 409', async () => {
      prisma.healthProfile.findUnique.mockResolvedValue(null);
      prisma.healthProfile.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(service.put(USER_ID, INPUT)).rejects.toBeInstanceOf(ConflictException);
    });

    it('rethrows other database errors', async () => {
      prisma.healthProfile.findUnique.mockRejectedValue(new Error('connection lost'));

      await expect(service.put(USER_ID, INPUT)).rejects.toThrow('connection lost');
    });

    describe('audit', () => {
      it('records only the names of the fields that changed', async () => {
        prisma.healthProfile.findUnique.mockResolvedValue(
          row({ heightMm: 1700, bio: 'old text' }) as any,
        );
        prisma.healthProfile.updateMany.mockResolvedValue({ count: 1 });
        prisma.healthProfile.findUniqueOrThrow.mockResolvedValue(row({ version: 2 }) as any);

        await service.put(USER_ID, INPUT);

        expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
        // (labUnits unchanged: not named.)
        expect(prisma.auditEvent.create).toHaveBeenCalledWith({
          data: {
            actorUserId: USER_ID,
            action: HEALTH_PROFILE_AUDIT_ACTION,
            targetType: HEALTH_PROFILE_AUDIT_TARGET,
            targetId: USER_ID,
            meta: { fields: ['heightMm', 'bio'] },
          },
        });

        const serialized = JSON.stringify((prisma.auditEvent.create as jest.Mock).mock.calls);
        expect(serialized).not.toContain('private free text');
        expect(serialized).not.toContain('old text');
        expect(serialized).not.toContain('1778');
      });

      it('compares a first save against the empty profile', async () => {
        prisma.healthProfile.findUnique.mockResolvedValue(null);
        prisma.healthProfile.create.mockResolvedValue(row() as any);

        await service.put(USER_ID, INPUT);

        expect(prisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              meta: {
                fields: ['dateOfBirth', 'sexAtBirth', 'heightMm', 'unitSystem', 'timeZone', 'bio'],
              },
            }),
          }),
        );
      });

      it('names labUnits (never its value) when the preference changes', async () => {
        prisma.healthProfile.findUnique.mockResolvedValue(row() as any);
        prisma.healthProfile.updateMany.mockResolvedValue({ count: 1 });
        prisma.healthProfile.findUniqueOrThrow.mockResolvedValue(row({ version: 2, labUnits: 'si' }) as any);

        await service.put(USER_ID, { ...INPUT, labUnits: 'si' });

        expect(prisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ meta: { fields: ['labUnits'] } }) }),
        );
      });

      it('writes no audit row for a save that changes nothing', async () => {
        prisma.healthProfile.findUnique.mockResolvedValue(row({ version: 1 }) as any);
        prisma.healthProfile.updateMany.mockResolvedValue({ count: 1 });
        prisma.healthProfile.findUniqueOrThrow.mockResolvedValue(row({ version: 2 }) as any);

        const saved = await service.put(USER_ID, INPUT);

        expect(saved.version).toBe(2);
        expect(prisma.auditEvent.create).not.toHaveBeenCalled();
      });

      it('swallows an audit failure and logs without values', async () => {
        const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        prisma.healthProfile.findUnique.mockResolvedValue(row({ bio: 'old text' }) as any);
        prisma.healthProfile.updateMany.mockResolvedValue({ count: 1 });
        prisma.healthProfile.findUniqueOrThrow.mockResolvedValue(row({ version: 2 }) as any);
        prisma.auditEvent.create.mockRejectedValue(new Error('audit table gone'));

        await expect(service.put(USER_ID, INPUT)).resolves.toMatchObject({ version: 2 });

        expect(errorLog).toHaveBeenCalledTimes(1);
        const logged = String(errorLog.mock.calls[0][0]);
        expect(logged).toContain('bio');
        expect(logged).not.toContain('private free text');
        expect(logged).not.toContain('old text');
      });
    });
  });

  describe('changedFields', () => {
    const base = {
      dateOfBirth: '1990-01-01',
      sexAtBirth: null,
      heightMm: 1800,
      unitSystem: 'metric' as const,
      timeZone: 'UTC',
      bio: null,
      labUnits: 'conventional' as const,
      version: 1,
      updatedAt: UPDATED_AT.toISOString(),
    };

    it('ignores version and updatedAt', () => {
      expect(changedFields(base, { ...base, version: 9, updatedAt: null })).toEqual([]);
    });

    it('names null <-> value transitions', () => {
      expect(changedFields(base, { ...base, sexAtBirth: 'female', timeZone: null })).toEqual([
        'sexAtBirth',
        'timeZone',
      ]);
    });
  });
});
