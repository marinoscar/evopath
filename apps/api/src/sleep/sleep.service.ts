import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { SleepSession } from '@prisma/client';

import { daysBetween } from '../activity/goal-progress';
import { fromDbDate, toDbDate } from '../check-ins/local-date';
import { PrismaService } from '../prisma/prisma.service';
import { type ListSleepQuery, SLEEP_LIST_MAX_RANGE_DAYS, type SleepSessionView } from './dto/sleep.dto';

// =============================================================================
// SleepService — the caller's sleep sessions (epic #276, #278)
// =============================================================================
//
// Owner-scoped: another user's session is a 404. Sessions are written by the
// Health Connect sync (`origin: device`); this service reads and deletes.
// A deleted device session is hard-deleted: the phone re-sends it while it is
// still inside the sync window.
// =============================================================================

@Injectable()
export class SleepService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, query: ListSleepQuery): Promise<SleepSessionView[]> {
    if (daysBetween(query.from, query.to) + 1 > SLEEP_LIST_MAX_RANGE_DAYS) {
      throw new BadRequestException({
        message: `from..to may span at most ${SLEEP_LIST_MAX_RANGE_DAYS} days`,
        details: { reason: 'RANGE_TOO_LARGE', max: SLEEP_LIST_MAX_RANGE_DAYS },
      });
    }
    const sessions = await this.prisma.sleepSession.findMany({
      where: { userId, localDate: { gte: toDbDate(query.from), lte: toDbDate(query.to) } },
      orderBy: [{ localDate: 'desc' }, { startAt: 'desc' }, { id: 'desc' }],
    });
    return sessions.map(toSleepSessionView);
  }

  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.sleepSession.deleteMany({ where: { id, userId } });
    if (count === 0) throw new NotFoundException('Sleep session not found');
  }
}

export function toSleepSessionView(session: SleepSession): SleepSessionView {
  return {
    id: session.id,
    startAt: session.startAt.toISOString(),
    endAt: session.endAt.toISOString(),
    localDate: fromDbDate(session.localDate),
    durationMinutes: session.durationMinutes,
    awakeMinutes: session.awakeMinutes,
    lightMinutes: session.lightMinutes,
    deepMinutes: session.deepMinutes,
    remMinutes: session.remMinutes,
    unknownMinutes: session.unknownMinutes,
    origin: session.origin,
    provider: session.provider,
    note: session.note,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}
