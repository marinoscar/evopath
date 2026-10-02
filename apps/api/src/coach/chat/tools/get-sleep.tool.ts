import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import { addDays, fromDbDate, toDbDate } from '../../../check-ins/local-date';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely } from './minimise';

/** Nights `get_sleep` looks back over, today (the user's local date) included. */
export const COACH_SLEEP_NIGHTS = 14;
/** Sessions read at most (naps included). */
export const COACH_SLEEP_MAX_SESSIONS = 42;

export interface CoachSleepNight {
  /** The local date the user woke up on. */
  localDate: string;
  asleepMinutes: number;
  awakeMinutes?: number;
  lightMinutes?: number;
  deepMinutes?: number;
  remMinutes?: number;
  origin: string;
}

/**
 * `get_sleep` (#327): the user's sleep sessions over the last 14 nights (by
 * the local date of waking), newest first: minutes asleep, the stage minutes
 * the source recorded, and the origin (`manual` or `device`). The read
 * SELECTS only those columns: never the note, the provider's external id or
 * the sync device.
 */
export function createGetSleepTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_sleep',
    description:
      `The user's sleep over the last ${COACH_SLEEP_NIGHTS} nights, newest first: localDate (the day they woke), ` +
      'asleepMinutes, the stage minutes when recorded (awake, light, deep, rem) and origin (manual or device). ' +
      'An empty list means no sleep was recorded. Call it before talking about sleep or recovery.',
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async () => {
        const today = await deps.checkIns.today(ctx.userId, deps.now());
        const from = addDays(today, -(COACH_SLEEP_NIGHTS - 1));
        const rows = await deps.prisma.sleepSession.findMany({
          where: { userId: ctx.userId, localDate: { gte: toDbDate(from), lte: toDbDate(today) } },
          orderBy: [{ localDate: 'desc' }, { startAt: 'desc' }],
          take: COACH_SLEEP_MAX_SESSIONS,
          select: {
            localDate: true,
            durationMinutes: true,
            awakeMinutes: true,
            lightMinutes: true,
            deepMinutes: true,
            remMinutes: true,
            origin: true,
          },
        });
        const nights: CoachSleepNight[] = rows.map((row) => ({
          localDate: fromDbDate(row.localDate),
          asleepMinutes: row.durationMinutes,
          ...(row.awakeMinutes != null ? { awakeMinutes: row.awakeMinutes } : {}),
          ...(row.lightMinutes != null ? { lightMinutes: row.lightMinutes } : {}),
          ...(row.deepMinutes != null ? { deepMinutes: row.deepMinutes } : {}),
          ...(row.remMinutes != null ? { remMinutes: row.remMinutes } : {}),
          origin: row.origin,
        }));
        return { from, to: today, nights };
      }, TOOL_UNAVAILABLE),
  });
}
