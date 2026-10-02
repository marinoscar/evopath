import { addressesAssistant, containsUrl, startsImperative } from '../../memory/memory-validation';

// =============================================================================
// The user's name in the coach chat (#327; docs/specs/ai-coach.md §2.9)
// =============================================================================
//
// The coach chat is the ONE coach surface that is sent the user's name (the
// documented exception in `coach/context/coach-never-send.ts`): the
// effective display name (`users.display_name`, else the sign-in provider's
// name, exactly as `GET /api/auth/me` resolves it), sanitised here, rides in
// the system instructions as one delimited `<user_name>` data line and in the
// `get_profile` tool result. Nudges, the weekly review and the training
// agents still never receive it.
//
// `checkDisplayName` is the `set_display_name` tool's validation: a name the
// user TOLD the coach, so it is stricter than the settings form (letters,
// marks, spaces and `' . -` only; no digits, link, email or instruction).
// =============================================================================

/** The longest name the coach is sent or may save, in characters. */
export const COACH_USER_NAME_MAX = 60;

/** Words a saved name may have at most. */
export const COACH_USER_NAME_MAX_WORDS = 5;

/**
 * A display name made safe for a prompt: control and format characters
 * (zero-width and bidi included) and angle brackets removed, whitespace
 * collapsed, capped at `COACH_USER_NAME_MAX` characters. `null` when nothing
 * is left.
 */
export function sanitiseUserName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const capped = [...clean].slice(0, COACH_USER_NAME_MAX).join('').trim();
  return capped.length > 0 ? capped : null;
}

/** The effective display name, as `/api/auth/me` resolves it (override first), sanitised. */
export function effectiveUserName(
  user: { displayName?: string | null; providerDisplayName?: string | null } | null | undefined,
): string | null {
  if (!user) return null;
  return sanitiseUserName(user.displayName || user.providerDisplayName || null);
}

/** Letters and combining marks, separated by single spaces, apostrophes, dots or hyphens. */
const NAME_SHAPE = /^[\p{L}\p{M}]+(?:[ '\u2019.-]{1,2}[\p{L}\p{M}]+)*\.?$/u;

export type DisplayNameCheck = { ok: true; name: string } | { ok: false; message: string };

/** Validates a name the user asked the coach to save (`set_display_name`). */
export function checkDisplayName(raw: unknown): DisplayNameCheck {
  if (typeof raw !== 'string') return { ok: false, message: 'Pass the name as text.' };
  if (/[\p{Cc}\p{Cf}<>]/u.test(raw.trim())) {
    return { ok: false, message: 'A name cannot contain control characters or angle brackets.' };
  }
  const name = raw.replace(/\s+/g, ' ').trim();
  const length = [...name].length;
  if (length < 1 || length > COACH_USER_NAME_MAX) {
    return { ok: false, message: `A name must be 1 to ${COACH_USER_NAME_MAX} characters.` };
  }
  if (containsUrl(name) || name.includes('@')) {
    return { ok: false, message: 'A name cannot contain a link or an email address.' };
  }
  if (!NAME_SHAPE.test(name)) {
    return {
      ok: false,
      message: "A name may contain only letters, spaces, apostrophes, dots and hyphens (no digits or other symbols).",
    };
  }
  const words = name.split(' ');
  if (words.length > COACH_USER_NAME_MAX_WORDS) {
    return { ok: false, message: `A name has at most ${COACH_USER_NAME_MAX_WORDS} words.` };
  }
  // A one- or two-word name may be a word like "Will" or "Do Kim"; longer text that starts like a command is not a name.
  if (addressesAssistant(name) || (words.length >= 3 && startsImperative(name))) {
    return { ok: false, message: 'That reads like an instruction, not a name. Ask the user what they would like to be called.' };
  }
  return { ok: true, name };
}
