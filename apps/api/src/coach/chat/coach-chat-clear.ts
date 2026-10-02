import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// "Start over": the coach chat's soft clear (#323; docs/specs/ai-coach.md §2.9)
// =============================================================================
//
// `POST /api/coach/chat/clear` stamps `CoachState.chatClearedAt = now`. No
// row is deleted. Three readers then see only messages created AFTER it:
//
//   GET /api/coach/messages        the timeline (coach-timeline.service.ts)
//   the chat turn's model history  (coach-chat.service.ts), and a `retryOf`
//                                  naming a row from before the clear is
//                                  400 COACH_RETRY_INVALID
//   the nudge prompt's last 10     (coach-nudge.handler.ts)
//
// Deliberately NOT filtered:
//
//   - the 24-hour safety lookback (`hasRecentBlockedTurn`): a blocked safety
//     turn keeps the supportive register for its whole window, clear or not.
//     Safety wins over "start over".
//   - the planner's pacing and dedup windows and the angle learning stats: a
//     clear must not reset the daily cap, the spacing gate or the bandit.
//   - opened / feedback / audio routes: they act on any of the caller's own
//     messages, before the clear or after.
//   - memories, settings, the weekly review tool: "Your memories and settings
//     stay."
// =============================================================================

/** The caller's `chatClearedAt`, or null when the chat was never cleared (or there is no state row). */
export async function chatClearedAtOf(prisma: PrismaService, userId: string): Promise<Date | null> {
  const row = await prisma.coachState.findUnique({ where: { userId }, select: { chatClearedAt: true } });
  return row?.chatClearedAt ?? null;
}

/** A `coachMessage` where-fragment: rows created after the clear (empty when never cleared). */
export function afterChatClear(clearedAt: Date | null): Prisma.CoachMessageWhereInput {
  return clearedAt ? { createdAt: { gt: clearedAt } } : {};
}

/** Stamps the clear. Idempotent: a second clear only moves the instant forward. Creates the state row when missing. */
export async function clearCoachChat(prisma: PrismaService, userId: string, now: Date = new Date()): Promise<Date> {
  await prisma.coachState.upsert({
    where: { userId },
    create: { userId, chatClearedAt: now },
    update: { chatClearedAt: now },
  });
  return now;
}
