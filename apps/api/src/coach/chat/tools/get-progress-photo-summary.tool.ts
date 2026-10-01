import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely } from './minimise';

/**
 * `get_progress_photo_summary`: counts and dates ONLY, from
 * `ProgressPhotoSummaryService` (the one photo surface the coach may read).
 * No id, storage object id, URL, note or byte can be in it: the service does
 * not select them.
 */
export function createGetProgressPhotoSummaryTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_progress_photo_summary',
    description:
      "How many progress photos the user has taken, per pose, and the date of the newest. Dates and counts only: " +
      'you never see a photo.',
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async () => {
        const summary = await deps.photos.summarize(ctx.userId);
        return { count: summary.count, lastLocalDate: summary.lastLocalDate, byPose: { ...summary.byPose } };
      }, TOOL_UNAVAILABLE),
  });
}
