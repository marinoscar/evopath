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
// (spec §3.1), and it is delimited in the prompt as data. Neither are the
// user's memories (#325, docs/specs/ai-memory.md): user-curated facts the user
// sees and edits in Settings > Memory, sent as one delimited `<user_memories>`
// block marked as untrusted data, with `[m<n>]` refs instead of ids.
//
// THE COACH CHAT'S ONE EXCEPTION: THE DISPLAY NAME (#327). `name` stays on
// this list, and nudges, the weekly review and the training agents are still
// never sent it. The CHAT alone is sent the user's effective display name
// (the name the user chose for the app, else the sign-in provider's), so the
// coach can address the user: sanitised and capped at 60 characters
// (`coach/chat/coach-user-name.ts`), only in the system instructions' one
// delimited `<user_name>` data line and in the `get_profile` tool result.
// Nothing else on this list rides with it: the read selects the name columns
// only (never the email), and `get_profile` sends an age in whole years,
// never the date of birth. The chat's own bio (`get_profile`, clipped to 500
// characters and withheld when it names an urgent symptom) and the active
// plan's intake text (`get_training_profile`) are the user's own words for
// the profile and the plan, like the planner's. The canary test
// (`coach/chat/coach-chat.service.spec.ts`) proves the name appears only in
// those two places and no other canary appears at all.
//
// THE COACH CHAT'S SECOND EXCEPTION: BIOMARKER VALUES (#327). `labs` stays
// on this list, and the training agents, nudges and the weekly review never
// receive a raw lab value (the training agents get only the health summary's
// text). The CHAT alone may read individual biomarker values, and only
// through its `list_biomarkers` and `get_biomarker_values` tools, only while
// the user's health consent ("Use my health data in training plans and
// coach chat", `HealthSummaryReader.consentOn`) is on, and only the date,
// value, unit, numeric reference range and flag: never a measurement id, a
// note, the printed reference text, the source document or its file name.
// Blood pressure readings are not lab analytes and stay excluded, as do
// medications and documents/photos, everywhere.
//
// `body_measurements` holds for the chat too: `get_training_signals` drops
// the signals' `body` block (weight, body fat) before the model sees it.
// =============================================================================

export const COACH_NEVER_SEND: readonly NeverSendEntry[] = [
  ...NEVER_SEND,
  { id: 'progress_photos', label: 'Progress photos, their notes, dates and file names (never sent to any model)' },
  { id: 'coach_audio', label: 'Coach voice notes and their files' },
  { id: 'body_measurements', label: 'Body weight and body-fat figures (the coach never comments on your body)' },
  { id: 'coach_message_bodies', label: 'The full text of earlier coach messages (only their titles and moments)' },
];

export const COACH_NEVER_SEND_IDS: readonly string[] = COACH_NEVER_SEND.map((entry) => entry.id);
