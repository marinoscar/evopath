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
// THE COACH CHAT'S TOOLS: ALL RELEVANT DATA, NO SECRETS (#338). The owner
// decided the coach chat should see every data point about him. The list
// above still binds nudges, the weekly review and the training agents
// unchanged, and it still binds the chat's own prompt (instructions and
// history), with one exception there: the effective display name in the
// instructions' one delimited `<user_name>` data line (#327; sanitised and
// capped at 60 characters, `coach/chat/coach-user-name.ts`, read from the
// name columns only, never the email). The chat's READ TOOLS alone are exempt from the entries in
// `COACH_CHAT_TOOL_LIFTED` below: the display name and an age in whole years
// (`get_profile`), check-in, sleep, workout, exercise and set notes, pain
// notes, activity notes, the plan intake's text and the plan's rationale,
// the bio, gym names, body weight, body fat and other body readings, and the
// workout ids a follow-up tool takes (`get_workout`). Each free-text value is
// a plain JSON field value (data, never an instruction), whitespace collapsed
// and bounded only as a safety net (2000 characters, above any stored note;
// the plan rationale 4000, its stored maximum): `coach/chat/tools/
// user-context.ts`, `userText`. The owner wants no artificial caps.
//
// What the chat's tools STILL never send (`COACH_CHAT_TOOL_NEVER_SEND`): the
// email address, the date of birth itself, medications, storage keys and
// file URLs (and the files and photos themselves), another user's data,
// progress photos beyond dates and counts, coach audio, and earlier coach
// message bodies; nor credentials, tokens, device installation or token ids,
// or keys of any kind (no tool reads a credential table). Labs and health
// documents stay behind the user's own health-data setting
// (`HealthSummaryReader.consentOn`, a switch the user controls in Settings). The canaries: `apps/api/test/coach/coach-never-send.spec.ts`
// (every read tool, secrets seeded in every source it reads) and
// `coach/chat/coach-chat.service.spec.ts` (a whole turn).
// =============================================================================

export const COACH_NEVER_SEND: readonly NeverSendEntry[] = [
  ...NEVER_SEND,
  { id: 'progress_photos', label: 'Progress photos, their notes, dates and file names (never sent to any model)' },
  { id: 'coach_audio', label: 'Coach voice notes and their files' },
  { id: 'body_measurements', label: 'Body weight and body-fat figures (the coach never comments on your body)' },
  { id: 'coach_message_bodies', label: 'The full text of earlier coach messages (only their titles and moments)' },
];

export const COACH_NEVER_SEND_IDS: readonly string[] = COACH_NEVER_SEND.map((entry) => entry.id);

/**
 * The entries of `COACH_NEVER_SEND` the coach chat's READ TOOLS are exempt
 * from (#338), each with what the tools may now send. Nothing else is lifted.
 */
export const COACH_CHAT_TOOL_LIFTED: Readonly<Record<string, string>> = {
  name: 'The effective display name (get_profile), sanitised and capped at 60 characters',
  exact_age: 'An age in whole years (get_profile); never the date of birth',
  check_in_notes: 'Check-in notes (get_check_ins)',
  pain_notes: 'Pain notes on logged sets (get_recent_workouts, get_workout_history, get_workout, get_exercise_history)',
  other_free_text: 'Workout, exercise, set, sleep and activity notes, the plan intake text, the plan rationale and the bio',
  gym_name: "The gym's name, type, description, notes, location and full equipment inventory (get_gyms)",
  other_gyms: "Every gym of the user and its inventory (get_gyms)",
  ids: 'The workout id where a follow-up tool takes it (workoutId); no other id',
  body_measurements: 'Body weight, body fat and other body and vital readings (get_profile, get_measurements, get_training_signals)',
  labs:
    "Lab values with their reference range, printed reference text, flag and note, and blood pressure, only while the user's own " +
    '"Use my health data in training plans and coach chat" setting is on (get_measurements, list_biomarkers, get_biomarker_values)',
  documents_photos:
    "Health document metadata (kind, file name, date, type, size) behind the same setting (get_health_documents), and gym photo " +
    'captions (get_gyms); never a file, a photo or its content',
};

/** What the coach chat's read tools still never send (#338): `COACH_NEVER_SEND` minus the lifted entries. */
export const COACH_CHAT_TOOL_NEVER_SEND: readonly NeverSendEntry[] = COACH_NEVER_SEND.filter(
  (entry) => !(entry.id in COACH_CHAT_TOOL_LIFTED),
);
