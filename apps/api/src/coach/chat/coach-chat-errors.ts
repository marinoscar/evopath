// =============================================================================
// Coach chat error codes (E7.7, #247; docs/specs/ai-coach.md §3.7)
// =============================================================================
//
// `COACH_PAUSE_INVALID`: `pause_coach` with `days` outside 1 to 14. The chat
// tool answers the MODEL with it (a tool result, never an HTTP error: the
// tool loop feeds refusals back so the model can correct itself or explain).
//
// `COACH_COMMITMENT_INVALID`: `save_commitment` with nothing to save, a `why`
// over 200 characters or a `preferredTime` that is not `HH:mm` (E7.12). Also a
// tool result for the model, never an HTTP error.
//
// `COACH_DISPLAY_NAME_INVALID`: `set_display_name` with a name that is empty,
// over 60 characters, or not a plain name (digits, symbols, a link, an email
// or instruction-like text; #327). A tool result for the model too.
// =============================================================================

export const COACH_DISPLAY_NAME_INVALID = 'COACH_DISPLAY_NAME_INVALID';

export const COACH_COMMITMENT_INVALID = 'COACH_COMMITMENT_INVALID';

export const COACH_PAUSE_INVALID = 'COACH_PAUSE_INVALID';
export const COACH_PAUSE_MIN_DAYS = 1;
export const COACH_PAUSE_MAX_DAYS = 14;
