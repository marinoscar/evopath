import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import { COACH_DISPLAY_NAME_INVALID } from '../coach-chat-errors';
import { COACH_USER_NAME_MAX, checkDisplayName } from '../coach-user-name';
import type { CoachChatToolDeps, CoachChatTurnActions } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';

/**
 * `set_display_name` (#327): saves the user's profile display name, through
 * `UserSettingsService.patchSettings({ profile: { displayName } })`, the
 * path `PATCH /api/user-settings` takes (it also syncs
 * `users.display_name`). Nothing else.
 *
 * WHEN. Only when the profile has no name and the user tells the coach their
 * name, or when the user explicitly asks to change their profile name; the
 * coach confirms first unless the user's message itself is that explicit
 * request. A nickname ("call me Bobby") is a memory, not the profile.
 *
 * Validation runs here (`checkDisplayName`), not in the schema, so a refusal
 * carries `COACH_DISPLAY_NAME_INVALID` back to the model. The value is never
 * logged, counted or put on a span; `actions.displayNameUpdated` records only
 * that it happened (the `done` frame's `profileUpdated`).
 */
export function createSetDisplayNameTool(deps: CoachChatToolDeps, actions: CoachChatTurnActions) {
  return defineTool({
    name: 'set_display_name',
    description:
      "Save the user's name on their profile (shown across the app). ONLY call it when (a) get_profile or your " +
      'instructions say no name is on file and the user tells you their name, or (b) the user explicitly asks to ' +
      'change the name on their profile. Confirm the exact spelling with the user first, unless their message ' +
      'itself is the explicit request (for example "change my profile name to Ana Lopez"). A nickname ("call me ' +
      'Bobby") is NOT a profile change: remember it instead, unless they say to change their profile name. ' +
      `The name: 1 to ${COACH_USER_NAME_MAX} characters, letters, spaces, apostrophes, dots and hyphens only. ` +
      'Returns the saved name.',
    parameters: z.object({
      name: z.string().describe(`The name exactly as the user gave it, at most ${COACH_USER_NAME_MAX} characters.`),
    }),
    execute: async ({ name }, ctx) => {
      const check = checkDisplayName(name);
      if (!check.ok) return { ok: false, error: COACH_DISPLAY_NAME_INVALID, message: check.message };
      if (!deps.profile) return TOOL_UNAVAILABLE;
      try {
        await deps.profile.userSettings.patchSettings(ctx.userId, { profile: { displayName: check.name } });
      } catch {
        return TOOL_UNAVAILABLE;
      }
      actions.displayNameUpdated = true;
      return { ok: true, name: check.name };
    },
  });
}
