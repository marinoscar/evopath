import { canPrompt, confirm, type PromptContext } from '../prompt.js';

// =============================================================================
// Asking before acting on shared or persistent infrastructure  (issue #391)
// =============================================================================
//
// Install now ACTS on two prerequisites it used to only report: it creates a
// missing database, and it bootstraps a missing shared proxy. Both are
// consequential enough that silence is not consent -- a typo in POSTGRES_DB
// must not quietly produce a second, empty database -- so each is gated the
// same way:
//
//   - its flag (`--create-database`, `--bootstrap-proxy`) is consent given in
//     advance, and is the ONLY consent a non-interactive run can give;
//   - otherwise, on a terminal, the operator is asked, defaulting to NO;
//   - otherwise (no terminal, --non-interactive, the TUI) consent is
//     UNAVAILABLE, and the caller fails with a remedy naming the flag.
//
// One helper rather than two copies, so the two gates cannot drift apart.
// =============================================================================

export type ConsentOutcome =
  /** The flag was passed. */
  | 'flag'
  /** The operator answered yes. */
  | 'granted'
  /** The operator answered no. */
  | 'declined'
  /** Nobody could be asked, and the flag was not passed. */
  | 'unavailable';

export interface ConsentOptions {
  /** The flag that gives consent in advance. */
  flag?: boolean | undefined;
  nonInteractive?: boolean | undefined;
  promptContext?: PromptContext | undefined;
  /** Replaces the terminal question; the test seam. */
  ask?: ((question: string) => Promise<boolean>) | undefined;
}

export function consented(outcome: ConsentOutcome): boolean {
  return outcome === 'flag' || outcome === 'granted';
}

/** Asks, or does not, by the rules in the header. Never throws for want of a TTY. */
export async function obtainConsent(
  question: string,
  options: ConsentOptions,
): Promise<ConsentOutcome> {
  if (options.flag === true) return 'flag';
  if (options.nonInteractive === true) return 'unavailable';

  if (options.ask !== undefined) {
    return (await options.ask(question)) ? 'granted' : 'declined';
  }

  if (!canPrompt(options.promptContext)) return 'unavailable';

  // Defaults to NO: both actions this gates are hard to take back.
  const yes = await confirm(question, { defaultValue: false }, options.promptContext);
  return yes ? 'granted' : 'declined';
}

/**
 * Whether `obtainConsent` COULD answer anything but `unavailable` -- the flag
 * was passed, or someone can be asked -- without asking. For a gate that wants
 * to refuse early, before anything is cloned, exactly when the later gate is
 * bound to refuse (#396). Never prompts.
 */
export function canObtainConsent(options: ConsentOptions): boolean {
  if (options.flag === true) return true;
  if (options.nonInteractive === true) return false;
  if (options.ask !== undefined) return true;
  return canPrompt(options.promptContext);
}
