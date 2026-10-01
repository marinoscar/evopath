import type { SvgIcon } from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import PauseCircleOutlinedIcon from '@mui/icons-material/PauseCircleOutlined';
import UndoOutlinedIcon from '@mui/icons-material/UndoOutlined';
import ErrorOutlineOutlinedIcon from '@mui/icons-material/ErrorOutlineOutlined';
import BuildCircleOutlinedIcon from '@mui/icons-material/BuildCircleOutlined';
import { APP_NAME } from '@app/shared';

/**
 * The closed set of sign-in failure codes, MIRRORED BY HAND from
 * `apps/api/src/auth/auth-error-codes.ts` (`AUTH_ERROR_CODES`): the web app
 * cannot import from the API (a test reads that file and fails on drift).
 * Adding a code there means adding it here, with its copy. The API redirects
 * every failed Google sign-in to `/auth/callback?error=<code>` (#273).
 */
export const SIGN_IN_ERROR_CODES = [
  'not_allowlisted',
  'account_disabled',
  'access_denied',
  'authentication_failed',
  'server_misconfigured',
] as const;

export type SignInErrorCode = (typeof SIGN_IN_ERROR_CODES)[number];

/** Used for every unknown, legacy or missing value. Never echo the raw input. */
export const DEFAULT_SIGN_IN_ERROR_CODE: SignInErrorCode = 'authentication_failed';

/**
 * `info` and `warning` are deliberately calm: they are for refusals the person
 * can act on. `error` is reserved for faults.
 */
export type SignInErrorSeverity = 'info' | 'warning' | 'error';

/** What the primary button does. `none`: nothing the person can do themselves. */
export type SignInErrorPrimaryAction = 'different-account' | 'try-again' | 'none';

export interface SignInErrorContent {
  severity: SignInErrorSeverity;
  Icon: typeof SvgIcon;
  headline: string;
  /** What happened and what it means, in a sentence or two. */
  explanation: string;
  /** What to do next, one sentence per step. */
  nextSteps: string[];
  primaryAction: SignInErrorPrimaryAction;
}

/**
 * Single source of copy for every sign-in failure code.
 *
 * VOICE: calm and personal, never alarming and never blaming. A person's health
 * record is private, so a refusal is framed as that privacy being protected and
 * access being by invitation. No exclamation marks, no health or medical
 * wording: this is a sign-in screen, not advice.
 */
export const SIGN_IN_ERROR_CONTENT: Record<SignInErrorCode, SignInErrorContent> = {
  not_allowlisted: {
    severity: 'info',
    Icon: LockOutlinedIcon,
    headline: `${APP_NAME} is invite-only right now`,
    explanation:
      "Your Google sign-in worked, but this account hasn't been invited yet. Because a health record is private, access is by invitation. Nothing was created or shared by trying.",
    nextSteps: [
      'Ask the person who invited you, or an administrator, to add your email address.',
      'Or sign in with a different Google account.',
    ],
    primaryAction: 'different-account',
  },
  account_disabled: {
    severity: 'warning',
    Icon: PauseCircleOutlinedIcon,
    headline: 'Access for this account is paused',
    explanation: `Your Google sign-in worked, but this account's access to ${APP_NAME} is paused right now. Nothing was changed.`,
    nextSteps: [
      "Contact an administrator if you'd like access restored.",
      'Or sign in with a different Google account.',
    ],
    primaryAction: 'different-account',
  },
  access_denied: {
    severity: 'info',
    Icon: UndoOutlinedIcon,
    headline: 'Sign-in was cancelled',
    explanation: 'You stepped out of the Google sign-in before it finished, so nothing was changed.',
    nextSteps: ["Try again whenever you're ready."],
    primaryAction: 'try-again',
  },
  authentication_failed: {
    severity: 'error',
    Icon: ErrorOutlineOutlinedIcon,
    headline: "We couldn't finish signing you in",
    explanation: 'Something went wrong on the way back from Google. Nothing was changed.',
    nextSteps: [
      'Try again in a moment.',
      'If it keeps happening, contact an administrator.',
    ],
    primaryAction: 'try-again',
  },
  server_misconfigured: {
    severity: 'error',
    Icon: BuildCircleOutlinedIcon,
    headline: `${APP_NAME} isn't ready for sign-in yet`,
    explanation:
      "Some setup on the server isn't finished, so sign-in can't be completed for anyone right now. This isn't something you did.",
    nextSteps: ['An administrator needs to finish the setup before anyone can sign in.'],
    primaryAction: 'none',
  },
};

/**
 * Narrows an untrusted `?error=` value to a known code. Anything else
 * (including legacy free-text values and `null`) becomes the generic failure.
 */
export function resolveSignInErrorCode(value: string | null | undefined): SignInErrorCode {
  return (SIGN_IN_ERROR_CODES as readonly string[]).includes(value ?? '')
    ? (value as SignInErrorCode)
    : DEFAULT_SIGN_IN_ERROR_CODE;
}
