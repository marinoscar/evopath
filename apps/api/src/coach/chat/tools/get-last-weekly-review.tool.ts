import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely, withoutIds } from './minimise';

/**
 * `get_last_weekly_review`: the newest `weekly_review` coach message's
 * headline (`title`) and its stored stats (`data`, the deterministic block of
 * spec §2.10), ids stripped. `{ found: false }` before the first review.
 */
export function createGetLastWeeklyReviewTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_last_weekly_review',
    description:
      "The user's most recent weekly review: when it was written, its headline and its stats. found is false when " +
      'there has been no weekly review yet.',
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async () => {
        const row = await deps.prisma.coachMessage.findFirst({
          where: { userId: ctx.userId, kind: 'weekly_review' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { title: true, data: true, createdAt: true },
        });
        if (!row) return { found: false };
        return {
          found: true,
          writtenAt: row.createdAt.toISOString(),
          headline: row.title,
          stats: row.data === null ? null : withoutIds(row.data),
        };
      }, TOOL_UNAVAILABLE),
  });
}
