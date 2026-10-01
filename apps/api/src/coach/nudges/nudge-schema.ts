import { z } from 'zod';

import { COACH_MOMENTS } from '../personas';

// =============================================================================
// The `ai.coach.nudge` structured answer (E7.5, #245; spec §2.6)
// =============================================================================
//
// Every field is required (strict structured output). `send: false` is a real
// answer: the data allows a message but a message would not help now. The
// limits are the content guard's (`COACH_FIELD_MAX_LENGTH`), so a schema-valid
// answer only fails the guard on content, never on length.
// =============================================================================

export const COACH_NUDGE_SCHEMA_NAME = 'coach_nudge';

export const coachNudgeSchema = z.object({
  /** false = the model decides to stay quiet. */
  send: z.boolean(),
  moment: z.enum(COACH_MOMENTS),
  title: z.string().max(60),
  body: z.string().max(320),
  /** Lock-screen-safe headline. */
  pushTitle: z.string().max(60),
  /** Lock-screen-safe line. */
  pushBody: z.string().max(140),
  /** Spoken text (E7.6); may differ from body. */
  audioScript: z.string().max(600),
  /** Delivery notes for TTS (E7.6). */
  audioInstructions: z.string().max(300),
  /** Why send or not; for learning, never shown and never logged in full. */
  reason: z.string().max(200),
});

export type CoachNudgeOutput = z.infer<typeof coachNudgeSchema>;
