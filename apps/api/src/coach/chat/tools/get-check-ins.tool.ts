import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely } from './minimise';

/** Days of check-ins the tool reads. */
export const COACH_CHECK_IN_DAYS = 14;

/** `get_check_ins`: recent readiness scores. The check-in note is never returned (never-send). */
export function createGetCheckInsTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_check_ins',
    description:
      `The user's daily readiness check-ins of the last ${COACH_CHECK_IN_DAYS} days, newest first: energy, sleep ` +
      'quality, soreness and stress, each 1 to 5 (null when not recorded). Days without a check-in are absent.',
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async () => {
        const list = await deps.checkIns.list(ctx.userId, COACH_CHECK_IN_DAYS);
        return {
          checkIns: list.items.map((item) => ({
            date: item.date,
            energy: item.energy,
            sleepQuality: item.sleepQuality,
            soreness: item.soreness,
            stress: item.stress,
          })),
        };
      }, TOOL_UNAVAILABLE),
  });
}
