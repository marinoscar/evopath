/**
 * Turning AI error codes into sentences a user can act on — issue #430.
 *
 * The AI API answers with a GENERIC top-level `code` (`BAD_REQUEST`,
 * `FORBIDDEN`, …) and puts the AI-specific code in `details.reason`. Reading
 * it is `toAiErrorInfo`'s job (`services/aiErrors.ts`, the one helper every
 * AI surface uses); this module only words the code for the AI Keys page.
 */
import { TRAINING_RUN_BUDGET_EXCEEDED, toAiErrorInfo } from '../../../services/aiErrors';

/** Where the per-run token cap is changed (the agent model settings card). */
export const TOKEN_CAP_SETTINGS_PATH = '/settings/ai/agents';

const tokenCount = new Intl.NumberFormat('en-US');

const FRIENDLY: Record<string, string> = {
  AI_KEY_INVALID: 'The provider rejected this key',
  AI_KEY_REQUIRED: 'A key is required for this provider',
  AI_DISABLED: 'AI has been switched off by your administrator',
  AI_PROVIDER_DISABLED: 'Your administrator has disabled this provider',
  AI_PROVIDER_UNAVAILABLE: 'The provider could not be reached. Try again later',
  AI_RATE_LIMITED: 'The provider is rate limiting requests. Try again shortly',
  [TRAINING_RUN_BUDGET_EXCEEDED]: 'Stopped at your per-run token limit. Raise it in AI settings.',
};

/**
 * An agent run stopped at the per-run token cap (E6.3), with the numbers when
 * they are known: "Stopped at your limit of 20,000 tokens per run (used
 * 20,340). Raise it in AI settings." Tokens only: never a currency amount.
 */
export function tokenCapText(cap?: { limitTokens?: number | null; usedTokens?: number | null } | null): string {
  const limit = cap?.limitTokens;
  if (typeof limit !== 'number') return FRIENDLY[TRAINING_RUN_BUDGET_EXCEEDED];
  const used = cap?.usedTokens;
  const usedPart = typeof used === 'number' ? ` (used ${tokenCount.format(used)})` : '';
  return `Stopped at your limit of ${tokenCount.format(limit)} tokens per run${usedPart}. Raise it in AI settings.`;
}

/** A friendly sentence for an AI error code; unknown codes get a generic one. */
export function aiCodeText(code: string | null | undefined): string {
  if (!code) return 'Something went wrong';
  return FRIENDLY[code] ?? `The provider reported an error (${code})`;
}

/** A friendly sentence for a thrown error from an AI call. */
export function aiErrorText(err: unknown, fallback: string): string {
  const info = toAiErrorInfo(err);
  const reason = info.code;
  if (reason === TRAINING_RUN_BUDGET_EXCEEDED) return tokenCapText(info);
  if (reason && FRIENDLY[reason]) return FRIENDLY[reason];
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
