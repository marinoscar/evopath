import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import {
  COACH_TIME_OF_DAY_PATTERN,
  COACH_WHY_MAX_LENGTH,
} from '../../../common/schemas/user-settings-namespaces.schema';
import { recordCoachKickoff } from '../../coach-kickoff.metrics';
import { COACH_COMMITMENT_INVALID } from '../coach-chat-errors';
import type { CoachChatToolDeps, CoachChatTurnActions } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';

/**
 * `save_commitment` (E7.12; spec §2.13): stores the user's answer to the
 * kickoff's implementation-intention questions, `coach.why` (at most 200
 * characters) and `coach.preferredTime` (`HH:mm`), through
 * `CoachSettingsService.update`, the path `PUT /api/coach/settings` takes.
 * Nothing else: it never touches a plan, program, workout or any other coach
 * setting, and it cannot unlock profanity.
 *
 * EXPLICIT CONFIRMATION. The description tells the model to call it only
 * after the user confirmed the exact values in this conversation; the reply
 * then states what was saved. Values are checked here (not in the schema) so
 * a refusal carries `COACH_COMMITMENT_INVALID` back to the model. Neither
 * value is logged, counted or echoed into a span.
 */
export function createSaveCommitmentTool(deps: CoachChatToolDeps, actions: CoachChatTurnActions) {
  return defineTool({
    name: 'save_commitment',
    description:
      "Save the user's training commitment to their coach settings: their reason for training (`why`, at most " +
      `${COACH_WHY_MAX_LENGTH} characters, in their own words) and/or the time of day they plan to train ` +
      '(`preferredTime`, 24-hour HH:mm). Pass null for a value you are not saving. ONLY call it after you have ' +
      'repeated the exact values back to the user and they explicitly confirmed (for example "yes, save that"). ' +
      'It does not change the training plan. Returns what was saved.',
    parameters: z.object({
      why: z.string().nullable().describe(`The user's reason for training, at most ${COACH_WHY_MAX_LENGTH} characters, or null.`),
      preferredTime: z.string().nullable().describe('The time of day the user plans to train, HH:mm (24-hour), or null.'),
    }),
    execute: async ({ why, preferredTime }, ctx) => {
      const patch: { why?: string; preferredTime?: string } = {};
      const trimmedWhy = why?.trim() ?? '';
      if (trimmedWhy.length > 0) {
        if (trimmedWhy.length > COACH_WHY_MAX_LENGTH) {
          return invalid(`why must be at most ${COACH_WHY_MAX_LENGTH} characters.`);
        }
        patch.why = trimmedWhy;
      }
      const time = preferredTime?.trim() ?? '';
      if (time.length > 0) {
        if (!COACH_TIME_OF_DAY_PATTERN.test(time)) return invalid('preferredTime must be HH:mm (24-hour), e.g. 07:30.');
        patch.preferredTime = time;
      }
      if (patch.why === undefined && patch.preferredTime === undefined) {
        return invalid('Nothing to save: pass why and/or preferredTime.');
      }
      if (!deps.commitments) return TOOL_UNAVAILABLE;

      try {
        await deps.commitments.update(ctx.userId, patch);
      } catch {
        return TOOL_UNAVAILABLE;
      }
      const saved = Object.keys(patch) as Array<'why' | 'preferredTime'>;
      actions.commitmentSaved = saved;
      recordCoachKickoff('confirmed');
      return { ok: true, saved: patch };
    },
  });
}

function invalid(message: string) {
  return { ok: false, error: COACH_COMMITMENT_INVALID, message };
}
