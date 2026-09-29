import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import type { HealthProfileService } from '../health-profile/health-profile.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  CHECK_IN_AUDIT_TARGET,
  CHECK_IN_DELETE_AUDIT_ACTION,
  CHECK_IN_FUTURE_MESSAGE,
  CHECK_IN_TOO_OLD_MESSAGE,
  CheckInsService,
} from './check-ins.service';
import {
  CHECK_IN_FIELDS,
  CHECK_IN_METRIC_KEYS,
  listCheckInsQuerySchema,
  putCheckInSchema,
} from './dto/check-in.dto';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID = '22222222-2222-4222-8222-222222222222';
const ACTIVE_PREDICATE = { supersededAt: null, deletedAt: null };
const NOW = new Date('2026-09-29T12:30:00.000Z');
const SAVED_AT = new Date('2026-09-29T08:00:00.000Z');

let seq = 0;

function row(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    userId: USER_ID,
    entryId: ENTRY_ID,
    metricKey: 'energy',
    value: 4,
    unit: 'score',
    measuredAt: SAVED_AT,
    localDate: new Date('2026-09-29T00:00:00.000Z'),
    method: 'self_report',
    origin: 'manual',
    notes: null,
    sourceRef: null,
    revision: 1,
    supersedesId: null,
    supersededAt: null,
    deletedAt: null,
    createdAt: SAVED_AT,
    updatedAt: SAVED_AT,
    ...overrides,
  };
}

/** A full stored day: energy 4, sleep 3, soreness 2, stress 3. */
function storedDay(overrides: Record<string, unknown> = {}) {
  return [
    row({ metricKey: 'energy', value: 4, ...overrides }),
    row({ metricKey: 'sleep_quality', value: 3, ...overrides }),
    row({ metricKey: 'muscle_soreness', value: 2, ...overrides }),
    row({ metricKey: 'stress', value: 3, ...overrides }),
  ];
}

const body = (input: unknown) => putCheckInSchema.parse(input);

describe('CheckInsService', () => {
  let service: CheckInsService;
  let prisma: MockPrismaService;
  let timeZone: string | null;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    prisma = createMockPrismaService();
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prisma));
    (prisma.measurement.create as jest.Mock).mockImplementation(async ({ data }: any) =>
      row({ ...data, sourceRef: null, createdAt: NOW, updatedAt: NOW }),
    );
    (prisma.measurement.findMany as jest.Mock).mockResolvedValue([]);
    timeZone = null;
    const healthProfile = { getTimeZone: jest.fn(async () => timeZone) } as unknown as HealthProfileService;
    service = new CheckInsService(prisma as unknown as PrismaService, healthProfile);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // DTO
  // ---------------------------------------------------------------------------

  describe('putCheckInSchema', () => {
    it('maps every API field to a wellness registry key', () => {
      expect(CHECK_IN_FIELDS.map((f) => [f.field, f.metricKey])).toEqual([
        ['energy', 'energy'],
        ['sleepQuality', 'sleep_quality'],
        ['soreness', 'muscle_soreness'],
        ['stress', 'stress'],
      ]);
    });

    it.each([
      [{ energy: 0 }, 'energy'],
      [{ energy: 6 }, 'energy'],
      [{ energy: 3.5 }, 'energy'],
      [{ sleepQuality: '3' }, 'sleepQuality'],
      [{ energy: 3, note: 'x'.repeat(501) }, 'note'],
      [{ energy: 3, origin: 'ai' }, ''],
      [{}, ''],
      [{ energy: null, sleepQuality: null, soreness: null, stress: null, note: 'only a note' }, ''],
    ])('refuses %p (path %p)', (input, path) => {
      const result = putCheckInSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error!.issues.map((i) => i.path.join('.'))).toContain(path);
    });

    it('trims the note and stores a blank one as null', () => {
      expect(body({ energy: 3, note: '  Big day  ' }).note).toBe('Big day');
      expect(body({ energy: 3, note: '   ' }).note).toBeNull();
      expect(body({ energy: 3 }).note).toBeNull();
      expect(body({ energy: 3, note: `${'x'.repeat(500)}   ` }).note).toHaveLength(500);
    });

    it('bounds days to 1..365 with a default of 30', () => {
      expect(listCheckInsQuerySchema.parse({})).toEqual({ days: 30 });
      expect(listCheckInsQuerySchema.parse({ days: '7' })).toEqual({ days: 7 });
      for (const days of ['0', '366', '400', '2.5', 'x']) {
        expect(listCheckInsQuerySchema.safeParse({ days }).success).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  describe('getToday / getForDate', () => {
    it('uses the profile time zone to decide today (Auckland is already the 30th)', async () => {
      timeZone = 'Pacific/Auckland';
      await expect(service.getToday(USER_ID)).resolves.toEqual({ date: '2026-09-30', checkIn: null });
      expect(prisma.measurement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: USER_ID,
            ...ACTIVE_PREDICATE,
            localDate: new Date('2026-09-30T00:00:00.000Z'),
            metricKey: { in: [...CHECK_IN_METRIC_KEYS] },
          },
        }),
      );
    });

    it('uses UTC when no time zone is set', async () => {
      await expect(service.getToday(USER_ID)).resolves.toMatchObject({ date: '2026-09-29' });
    });

    it('uses UTC for a stored zone this runtime does not know', async () => {
      timeZone = 'Mars/Olympus_Mons';
      await expect(service.getToday(USER_ID)).resolves.toMatchObject({ date: '2026-09-29' });
    });

    it('follows DST: 03:59Z on 2026-11-01 is still Oct 31 in New York', async () => {
      jest.setSystemTime(new Date('2026-11-01T03:59:00Z'));
      timeZone = 'America/New_York';
      await expect(service.getToday(USER_ID)).resolves.toMatchObject({ date: '2026-10-31' });
      jest.setSystemTime(new Date('2026-11-02T04:30:00Z')); // 23:30 EST on Nov 1
      await expect(service.getToday(USER_ID)).resolves.toMatchObject({ date: '2026-11-01' });
    });

    it('maps the rows of a day onto the DTO, null for unrecorded scores', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([
        row({ metricKey: 'energy', value: 4, notes: 'Big presentation' }),
        row({ metricKey: 'stress', value: 3, notes: 'Big presentation', updatedAt: NOW }),
      ]);

      await expect(service.getForDate(USER_ID, '2026-09-29')).resolves.toEqual({
        date: '2026-09-29',
        energy: 4,
        sleepQuality: null,
        soreness: null,
        stress: 3,
        note: 'Big presentation',
        updatedAt: NOW.toISOString(),
      });
    });

    it('refuses an invalid date before querying', async () => {
      await expect(service.getForDate(USER_ID, '2026-02-30')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.measurement.findMany).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('groups rows by day, newest day first, over the last `days` local days', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([
        row({ metricKey: 'energy', value: 5, localDate: new Date('2026-09-27T00:00:00Z') }),
        row({ metricKey: 'energy', value: 2, localDate: new Date('2026-09-29T00:00:00Z') }),
        row({ metricKey: 'stress', value: 1, localDate: new Date('2026-09-27T00:00:00Z') }),
      ]);

      const { items } = await service.list(USER_ID, 7);

      expect(items.map((i) => [i.date, i.energy, i.stress])).toEqual([
        ['2026-09-29', 2, null],
        ['2026-09-27', 5, 1],
      ]);
      expect(prisma.measurement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: USER_ID,
            ...ACTIVE_PREDICATE,
            metricKey: { in: [...CHECK_IN_METRIC_KEYS] },
            localDate: {
              gte: new Date('2026-09-23T00:00:00.000Z'),
              lte: new Date('2026-09-29T00:00:00.000Z'),
            },
          },
        }),
      );
    });

    it('days=1 is today only', async () => {
      await service.list(USER_ID, 1);
      const where = (prisma.measurement.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.localDate).toEqual({
        gte: new Date('2026-09-29T00:00:00.000Z'),
        lte: new Date('2026-09-29T00:00:00.000Z'),
      });
    });
  });

  // ---------------------------------------------------------------------------
  // put
  // ---------------------------------------------------------------------------

  describe('put', () => {
    const FULL = { energy: 4, sleepQuality: 3, soreness: 2, stress: 3, note: 'Big presentation' };

    it('creates a new entry: four rows, one entryId, revision 1, localDate, self_report, manual', async () => {
      const result = await service.put(USER_ID, '2026-09-29', body(FULL));

      expect(result).toEqual({ date: '2026-09-29', ...FULL, updatedAt: NOW.toISOString() });
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'Serializable',
      });

      const creates = (prisma.measurement.create as jest.Mock).mock.calls.map(([arg]) => arg.data);
      expect(creates.map((d) => [d.metricKey, d.value])).toEqual([
        ['energy', 4],
        ['sleep_quality', 3],
        ['muscle_soreness', 2],
        ['stress', 3],
      ]);
      expect(new Set(creates.map((d) => d.entryId)).size).toBe(1);
      for (const data of creates) {
        expect(data).toMatchObject({
          userId: USER_ID,
          unit: 'score',
          measuredAt: NOW,
          localDate: new Date('2026-09-29T00:00:00.000Z'),
          method: 'self_report',
          origin: 'manual',
          notes: 'Big presentation',
          revision: 1,
          supersedesId: null,
        });
      }
      expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
    });

    it('writes nothing when the submission equals the stored day', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue(
        storedDay({ notes: 'Big presentation' }),
      );

      const result = await service.put(USER_ID, '2026-09-29', body(FULL));

      expect(result).toMatchObject({ ...FULL, updatedAt: SAVED_AT.toISOString() });
      expect(prisma.measurement.create).not.toHaveBeenCalled();
      expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
    });

    it('treats a changed note as a change', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue(storedDay({ notes: 'old' }));
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 4 });

      await service.put(USER_ID, '2026-09-29', body(FULL));

      expect(prisma.measurement.create).toHaveBeenCalledTimes(4);
    });

    it('replaces the day: supersedes submitted scores, soft-deletes omitted ones', async () => {
      const stored = storedDay({ notes: 'Big presentation' });
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue(stored);
      (prisma.measurement.updateMany as jest.Mock)
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 3 });

      const result = await service.put(USER_ID, '2026-09-29', body({ energy: 5 }));

      expect(result).toMatchObject({ energy: 5, sleepQuality: null, soreness: null, stress: null, note: null });

      const [supersede, remove] = (prisma.measurement.updateMany as jest.Mock).mock.calls.map(([a]) => a);
      expect(supersede).toEqual({
        where: { id: { in: [stored[0].id] }, ...ACTIVE_PREDICATE },
        data: { supersededAt: NOW },
      });
      expect(remove).toEqual({
        where: { id: { in: [stored[1].id, stored[2].id, stored[3].id] }, ...ACTIVE_PREDICATE },
        data: { deletedAt: NOW },
      });

      expect(prisma.measurement.create).toHaveBeenCalledTimes(1);
      expect((prisma.measurement.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
        entryId: ENTRY_ID,
        metricKey: 'energy',
        value: 5,
        revision: 2,
        supersedesId: stored[0].id,
        notes: null,
      });
    });

    it('adds a newly scored key to the existing entry at the next revision', async () => {
      const energy = row({ metricKey: 'energy', value: 4 });
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([energy]);
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.put(USER_ID, '2026-09-29', body({ energy: 4, stress: 2 }));

      const creates = (prisma.measurement.create as jest.Mock).mock.calls.map(([a]) => a.data);
      expect(creates).toEqual([
        expect.objectContaining({ metricKey: 'energy', revision: 2, supersedesId: energy.id, entryId: ENTRY_ID }),
        expect.objectContaining({ metricKey: 'stress', revision: 2, supersedesId: null, entryId: ENTRY_ID }),
      ]);
    });

    it('409s when a stamped row was changed concurrently', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue(storedDay());
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(service.put(USER_ID, '2026-09-29', body({ energy: 1 }))).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });

    it.each(['P2002', 'P2034'])('maps Prisma %s to 409', async (code) => {
      (prisma.$transaction as jest.Mock).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('conflict', { code, clientVersion: 'test' }),
      );

      await expect(service.put(USER_ID, '2026-09-29', body({ energy: 1 }))).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('maps a raw adapter serialization failure (40001 at COMMIT) to 409', async () => {
      const error = Object.assign(new Error('TransactionWriteConflict'), {
        name: 'DriverAdapterError',
        cause: { originalCode: '40001', kind: 'TransactionWriteConflict' },
      });
      (prisma.$transaction as jest.Mock).mockRejectedValue(error);

      await expect(service.put(USER_ID, '2026-09-29', body({ energy: 1 }))).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rethrows any other error', async () => {
      (prisma.$transaction as jest.Mock).mockRejectedValue(new Error('boom'));
      await expect(service.put(USER_ID, '2026-09-29', body({ energy: 1 }))).rejects.toThrow('boom');
    });

    it('refuses an all-empty submission from a server-side caller', async () => {
      await expect(
        service.put(USER_ID, '2026-09-29', { energy: null, sleepQuality: undefined, note: 'x' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    describe('the date window (today in the profile zone and 7 days back)', () => {
      it.each([
        ['2026-09-29', null],
        ['2026-09-22', null], // exactly 7 days back
        ['2026-09-30', CHECK_IN_FUTURE_MESSAGE],
        ['2026-09-21', CHECK_IN_TOO_OLD_MESSAGE],
      ])('UTC: %s -> %p', async (date, message) => {
        const promise = service.put(USER_ID, date, body({ energy: 3 }));
        if (message) {
          await expect(promise).rejects.toMatchObject({
            response: { message, details: expect.objectContaining({ issues: [{ path: 'date', message }] }) },
          });
          expect(prisma.$transaction).not.toHaveBeenCalled();
        } else {
          await expect(promise).resolves.toMatchObject({ date, energy: 3 });
        }
      });

      it('lets an Auckland user write the 30th, which is tomorrow in UTC', async () => {
        timeZone = 'Pacific/Auckland';
        await expect(service.put(USER_ID, '2026-09-30', body({ energy: 3 }))).resolves.toMatchObject({
          date: '2026-09-30',
        });
        await expect(service.put(USER_ID, '2026-09-22', body({ energy: 3 }))).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });

      it('refuses a date that is not a real day', async () => {
        await expect(service.put(USER_ID, '2026-02-30', body({ energy: 3 }))).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // remove
  // ---------------------------------------------------------------------------

  describe('remove', () => {
    it('soft-deletes the day and audits the count only', async () => {
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 4 });

      await service.remove(USER_ID, '2026-09-29');

      expect(prisma.measurement.updateMany).toHaveBeenCalledWith({
        where: {
          userId: USER_ID,
          ...ACTIVE_PREDICATE,
          localDate: new Date('2026-09-29T00:00:00.000Z'),
          metricKey: { in: [...CHECK_IN_METRIC_KEYS] },
        },
        data: { deletedAt: NOW },
      });
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: USER_ID,
          action: CHECK_IN_DELETE_AUDIT_ACTION,
          targetType: CHECK_IN_AUDIT_TARGET,
          targetId: '2026-09-29',
          meta: { scoreCount: 4 },
        },
      });
    });

    it('404s when there is nothing to delete, without auditing', async () => {
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(service.remove(USER_ID, '2026-09-29')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('still succeeds when the audit write fails, logging no values', async () => {
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (prisma.auditEvent.create as jest.Mock).mockRejectedValue(new Error('audit down'));
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(service.remove(USER_ID, '2026-09-29')).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('2 scores'));
    });
  });
});
