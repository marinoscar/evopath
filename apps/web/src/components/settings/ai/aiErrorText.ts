/**
 * Turning AI error codes into sentences a user can act on — issue #430.
 *
 * The AI API answers with a GENERIC top-level `code` (`BAD_REQUEST`,
 * `FORBIDDEN`, …) and puts the AI-specific code in `details.reason`. Reading
 * it is `toAiErrorInfo`'s job (`services/aiErrors.ts`, the one helper every
 * AI surface uses); this module only words the code for the AI Keys page.
 */
import { toAiErrorInfo } from '../../../services/aiErrors';

const FRIENDLY: Record<string, string> = {
  AI_KEY_INVALID: 'The provider rejected this key',
  AI_KEY_REQUIRED: 'A key is required for this provider',
  AI_DISABLED: 'AI has been switched off by your administrator',
  AI_PROVIDER_DISABLED: 'Your administrator has disabled this provider',
  AI_PROVIDER_UNAVAILABLE: 'The provider could not be reached. Try again later',
  AI_RATE_LIMITED: 'The provider is rate limiting requests. Try again shortly',
};

/** A friendly sentence for an AI error code; unknown codes get a generic one. */
export function aiCodeText(code: string | null | undefined): string {
  if (!code) return 'Something went wrong';
  return FRIENDLY[code] ?? `The provider reported an error (${code})`;
}

/** A friendly sentence for a thrown error from an AI call. */
export function aiErrorText(err: unknown, fallback: string): string {
  const reason = toAiErrorInfo(err).code;
  if (reason && FRIENDLY[reason]) return FRIENDLY[reason];
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
