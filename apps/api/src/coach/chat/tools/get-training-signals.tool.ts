import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import { compactSignals, type CompactOptions } from '../../../programs/signals/compact-signals';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely, withoutIds } from './minimise';

/**
 * `get_training_signals`: the caller's training signals, computed by
 * `TrainingSignalsService.forUser` with the SAME defaults as
 * `GET /api/training/signals` (active program, default range, as of today),
 * compacted for a prompt (`compactSignals`) and stripped of ids. Every figure
 * the coach states about adherence, frequency, volume, lifts, effort, pain
 * counts, readiness or body trend comes from here, so it equals what the
 * signals route shows.
 *
 * BODY MEASUREMENTS (#338). The compaction's `body` (weight and body-fat
 * trend) is kept: the owner lifted `body_measurements` for the coach chat
 * (`coach/context/coach-never-send.ts`). The prompt still forbids judging
 * appearance, body shape or weight.
 */
/**
 * Generous compaction caps for the chat (#338: the owner wants every data
 * point, not a prompt budget): every exercise, muscle and week the signals hold.
 */
export const COACH_SIGNALS_COMPACT: CompactOptions = { maxExercises: 200, maxWeeks: 52, maxMuscles: 50 };

export function createGetTrainingSignalsTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_training_signals',
    description:
      "The user's training facts: planned versus done per ISO week, streaks, frequency, weekly hard sets per muscle, " +
      'lift trends and PRs, effort, pain flag counts, readiness averages and the body-weight and body-fat trend. ' +
      'Weights are kilograms. Call it before talking about progress, adherence or how the user is doing.',
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async () => withoutIds(compactSignals(await deps.signals.forUser(ctx.userId, {}), COACH_SIGNALS_COMPACT)), TOOL_UNAVAILABLE),
  });
}
