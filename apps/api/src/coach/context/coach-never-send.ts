import { NEVER_SEND, type NeverSendEntry } from '../../training-agents/context/never-send';

// =============================================================================
// What the AI Coach is NEVER sent (E7.5, #245; docs/specs/ai-coach.md §2.6)
// =============================================================================
//
// The training agents' list (`training-agents/context/never-send.ts`) plus the
// coach's own sources. Every coach prompt (nudge, weekly review, chat) is
// built from the signals service, `CoachState`, the coach timeline and the
// user's `coach.why`; nothing on this list may reach a model request.
// `apps/api/test/coach/coach-never-send.spec.ts` seeds a canary in each source
// the nudge job reads and asserts none reaches the request.
//
// `coach.why` is NOT on this list: it is text the user wrote FOR the coach
// (spec §3.1), and it is delimited in the prompt as data.
// =============================================================================

export const COACH_NEVER_SEND: readonly NeverSendEntry[] = [
  ...NEVER_SEND,
  { id: 'progress_photos', label: 'Progress photos, their notes, dates and file names (never sent to any model)' },
  { id: 'coach_audio', label: 'Coach voice notes and their files' },
  { id: 'body_measurements', label: 'Body weight and body-fat figures (the coach never comments on your body)' },
  { id: 'coach_message_bodies', label: 'The full text of earlier coach messages (only their titles and moments)' },
];

export const COACH_NEVER_SEND_IDS: readonly string[] = COACH_NEVER_SEND.map((entry) => entry.id);
