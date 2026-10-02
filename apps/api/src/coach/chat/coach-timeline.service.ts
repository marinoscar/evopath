import { BadRequestException, Injectable } from '@nestjs/common';
import type { CoachMessage } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { afterChatClear, chatClearedAtOf, clearCoachChat } from './coach-chat-clear';
import {
  COACH_AUDIO_STATUSES,
  type CoachTimelineItem,
  type CoachTimelinePage,
  type CoachTimelineQuery,
} from './dto/coach-chat.dto';

// =============================================================================
// The coach timeline: GET /api/coach/messages (E7.7, #247; spec §2.9)
// =============================================================================
//
// One timeline per user, every kind mixed (nudge, chat, weekly review, ...),
// newest first, keyset-paged on `(createdAt, id)` descending (the
// `(userId, createdAt desc)` index). `before` is a message id: the cursor row
// is looked up AMONG THE CALLER'S OWN rows, so another user's id (or an
// unknown one) is a 400 invalid cursor, never a leak. Every query is
// `where: { userId }`.
//
// START OVER (#323). Only rows created after `CoachState.chatClearedAt` are
// listed (`coach-chat-clear.ts`); a `before` cursor older than the clear is
// still the caller's own row, so it is valid and simply pages into nothing.
// =============================================================================

type Row = Pick<
  CoachMessage,
  | 'id'
  | 'role'
  | 'kind'
  | 'moment'
  | 'personaId'
  | 'intensity'
  | 'title'
  | 'body'
  | 'audioStatus'
  | 'audioStorageObjectId'
  | 'feedback'
  | 'openedAt'
  | 'data'
  | 'createdAt'
>;

export const COACH_TIMELINE_SELECT = {
  id: true,
  role: true,
  kind: true,
  moment: true,
  personaId: true,
  intensity: true,
  title: true,
  body: true,
  audioStatus: true,
  audioStorageObjectId: true,
  feedback: true,
  openedAt: true,
  data: true,
  createdAt: true,
} as const;

function invalidCursor(): BadRequestException {
  return new BadRequestException({
    message: 'Invalid cursor',
    details: { issues: [{ path: 'before', message: 'Invalid cursor' }] },
  });
}

/** One row as the timeline shows it. Audio fields only once the audio is ready. */
export function toTimelineItem(row: Row): CoachTimelineItem {
  const ready = row.audioStatus === 'ready';
  const data = (row.data ?? null) as unknown;
  const voice =
    ready && data && typeof data === 'object' && typeof (data as Record<string, unknown>).voice === 'string'
      ? ((data as Record<string, unknown>).voice as string)
      : null;

  return {
    id: row.id,
    role: row.role === 'user' ? 'user' : 'coach',
    kind: row.kind,
    moment: row.moment,
    personaId: row.personaId,
    intensity: row.intensity,
    title: row.title,
    body: row.body,
    audioStatus: (COACH_AUDIO_STATUSES as readonly string[]).includes(row.audioStatus)
      ? (row.audioStatus as CoachTimelineItem['audioStatus'])
      : 'none',
    audioStorageObjectId: ready ? row.audioStorageObjectId : null,
    voice,
    feedback: row.feedback === 'up' || row.feedback === 'down' ? row.feedback : null,
    openedAt: row.openedAt ? row.openedAt.toISOString() : null,
    data,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class CoachTimelineService {
  constructor(private readonly prisma: PrismaService) {}

  /** "Start over": stamps `chatClearedAt` (soft, idempotent). */
  async clear(userId: string): Promise<void> {
    await clearCoachChat(this.prisma, userId);
  }

  async list(userId: string, query: CoachTimelineQuery): Promise<CoachTimelinePage> {
    const cleared = afterChatClear(await chatClearedAtOf(this.prisma, userId));
    let older = {};
    if (query.before) {
      const cursor = await this.prisma.coachMessage.findFirst({
        where: { id: query.before, userId },
        select: { id: true, createdAt: true },
      });
      if (!cursor) throw invalidCursor();
      older = {
        OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
      };
    }

    const rows = await this.prisma.coachMessage.findMany({
      where: { userId, ...cleared, ...older },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: COACH_TIMELINE_SELECT,
    });

    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row) => toTimelineItem(row)),
      nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }
}
