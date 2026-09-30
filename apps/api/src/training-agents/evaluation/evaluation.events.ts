import { z } from 'zod';

import { registerRunEventType } from '../runtime/run-events.registry';

// =============================================================================
// Run events of the evaluate graph's deterministic nodes. Counts, flags and
// codes only: no signal value, no note, no ref, no id.
// =============================================================================

const COUNT = z.number().int().min(0);

/** `load_signals`: what the evaluator will see, by size. */
export const evaluationSignalsEventSchema = z
  .object({
    sessions: COUNT,
    remainingWeeks: COUNT,
    changeableWorkouts: COUNT,
    historyEntries: COUNT,
    evidenceClaims: COUNT,
    missedStreak: COUNT,
  })
  .strict();

/** `safety_gate`: what the server decided before any model call. */
export const evaluationSafetyEventSchema = z
  .object({
    level: z.enum(['ok', 'conservative', 'blocked']),
    painPattern: z.boolean(),
    forcedOperations: COUNT,
    recover: z.boolean(),
    paused: z.boolean(),
  })
  .strict();

registerRunEventType('evaluation.signals', evaluationSignalsEventSchema);
registerRunEventType('evaluation.safety', evaluationSafetyEventSchema);
