// =============================================================================
// What the training agents are NEVER sent
// =============================================================================
//
// The one list the "what will be sent" summary shows under "excluded" and the
// data-minimisation canary test walks: for each entry the test seeds a unique
// canary value in the corresponding source column and asserts it appears in
// no request any agent received. Adding a data source to the context builder
// means checking it against this list first.
//
// HEALTH (H8, #192). Raw lab values, blood pressure, documents and photos
// STAY on this list, opt-in or not. The only health content a training agent
// may receive is the stored text of the user's opt-in AI health summary
// (`planner.healthSummary`, the evaluator's `profile.healthSummary`), read
// through `HealthSummaryReader.forTraining`; the canary tests seed
// distinctive raw values and prove none of them reaches any request.
// =============================================================================

export interface NeverSendEntry {
  /** Stable id (the canary test keys on it). */
  id: string;
  /** Shown in the summary. */
  label: string;
}

export const NEVER_SEND: readonly NeverSendEntry[] = [
  { id: 'name', label: 'Your name' },
  { id: 'email', label: 'Your email address' },
  { id: 'date_of_birth', label: 'Your date of birth (only an age in whole years is used)' },
  { id: 'exact_age', label: 'Your exact age (researcher: an age band, and only if you opt in)' },
  { id: 'check_in_notes', label: 'Check-in notes' },
  { id: 'pain_notes', label: 'Pain notes on logged sets' },
  { id: 'other_free_text', label: 'Any free text other than what you typed for this plan (workout and measurement notes)' },
  { id: 'medications', label: 'Medications' },
  { id: 'labs', label: 'Raw biomarkers, lab results and blood pressure readings (if you opt in, only your health summary\'s text is used)' },
  { id: 'documents_photos', label: 'Documents and photos, and their file names' },
  { id: 'storage', label: 'Storage keys and file URLs' },
  { id: 'other_gyms', label: 'Your other gyms' },
  { id: 'gym_name', label: "The gym's name, notes and location" },
  { id: 'other_users', label: "Other users' data" },
  { id: 'ids', label: 'Internal ids (exercises are named by a stable key)' },
];

/** The labels, in order, for the summary. */
export const NEVER_SEND_LABELS: readonly string[] = NEVER_SEND.map((entry) => entry.label);
