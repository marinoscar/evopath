import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import { COACH_PAUSE_INVALID, COACH_PAUSE_MAX_DAYS, COACH_PAUSE_MIN_DAYS } from '../coach-chat-errors';
import type { CoachChatToolDeps, CoachChatTurnActions } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';

/** `reason` cap (spec E7.7 contract). */
export const COACH_PAUSE_REASON_MAX = 120;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `pause_coach`: the chat's ONE write tool. Sets `CoachState.pausedUntil` to
 * now plus `days` (1 to 14), which the sweep's `paused` gate honours
 * (E7.4). It never touches a plan, program or workout.
 *
 * `days` outside 1..14 answers `COACH_PAUSE_INVALID` to the model (the range
 * is checked here, not in the schema, so the refusal carries the coach code).
 * The `reason` is not logged, not counted and not stored on the state (it has
 * no column for it); it only shapes the model's own confirmation.
 */
export function createPauseCoachTool(deps: CoachChatToolDeps, actions: CoachChatTurnActions) {
  return defineTool({
    name: 'pause_coach',
    description:
      `Pause the coach's reminders and nudges for ${COACH_PAUSE_MIN_DAYS} to ${COACH_PAUSE_MAX_DAYS} days, for ` +
      'example while the user is ill or on holiday. It does not change the training plan. Only call it when the ' +
      'user asks for a pause or agrees to one. Returns the date the pause ends.',
    parameters: z.object({
      days: z.number().int().describe(`Whole days to pause, ${COACH_PAUSE_MIN_DAYS} to ${COACH_PAUSE_MAX_DAYS}.`),
      reason: z.string().max(COACH_PAUSE_REASON_MAX).describe('A few words: why the user wants the pause.'),
    }),
    execute: async ({ days }, ctx) => {
      if (days < COACH_PAUSE_MIN_DAYS || days > COACH_PAUSE_MAX_DAYS) {
        return {
          ok: false,
          error: COACH_PAUSE_INVALID,
          message: `days must be between ${COACH_PAUSE_MIN_DAYS} and ${COACH_PAUSE_MAX_DAYS}.`,
        };
      }
      try {
        const pausedUntil = new Date(deps.now().getTime() + days * DAY_MS);
        await deps.prisma.coachState.upsert({
          where: { userId: ctx.userId },
          create: { userId: ctx.userId, pausedUntil },
          update: { pausedUntil },
        });
        actions.pausedUntil = pausedUntil;
        return { ok: true, days, pausedUntil: pausedUntil.toISOString() };
      } catch {
        return TOOL_UNAVAILABLE;
      }
    },
  });
}
