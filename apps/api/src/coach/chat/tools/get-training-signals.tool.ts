import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import { compactSignals, type CompactSignals } from '../../../programs/signals/compact-signals';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely, withoutIds } from './minimise';

/**
 * `get_training_signals`: the caller's training signals, computed by
 * `TrainingSignalsService.forUser` with the SAME defaults as
 * `GET /api/training/signals` (active program, default range, as of today),
 * compacted for a prompt (`compactSignals`) and stripped of ids. Every figure
 * the coach states about adherence, frequency, volume, lifts, effort, pain
 * counts or readiness comes from here, so it equals what the signals route
 * shows.
 *
 * BODY MEASUREMENTS (#327). The compaction's `body` (weight and body-fat
 * trend) is dropped (`coachSignals`): the coach is never sent body weight or
 * body-fat figures (`COACH_NEVER_SEND`, `body_measurements`).
 */
export function coachSignals(compact: CompactSignals): Omit<CompactSignals, 'body'> {
  const { body: _body, ...rest } = compact;
  return rest;
}

export function createGetTrainingSignalsTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_training_signals',
    description:
      "The user's training facts: planned versus done per ISO week, streaks, frequency, weekly hard sets per muscle, " +
      'lift trends and PRs, effort, pain flag counts (never notes) and readiness averages. ' +
      'Weights are kilograms. Call it before talking about progress, adherence or how the user is doing.',
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async () => withoutIds(coachSignals(compactSignals(await deps.signals.forUser(ctx.userId, {})))), TOOL_UNAVAILABLE),
  });
}
