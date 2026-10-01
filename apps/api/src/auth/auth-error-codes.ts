import { ForbiddenException } from '@nestjs/common';
import { DatabaseSeedException } from '../common/exceptions/database-seed.exception';

/**
 * The CLOSED set of sign-in failure codes (#652).
 *
 * A failed Google sign-in always ends as a 302 to
 * `${appUrl}/auth/callback?error=<code>`, where `<code>` is one of these and
 * nothing else: never an exception message, never raw JSON. Free text in that
 * query string let anyone craft a link that rendered attacker-chosen copy on a
 * trusted origin, and made the web page recognise cases by sniffing prose.
 *
 * Consumer: `apps/web/src/pages/AuthCallbackPage.tsx` maps each code to its own
 * copy and treats any other value as a generic failure without echoing it. The
 * two lists are kept in step by hand (the web app cannot import from the API),
 * so adding a code here means adding it there.
 *
 *   not_allowlisted         the email is not on the allowlist
 *   account_disabled        the account exists but is deactivated
 *   access_denied           the person cancelled or denied consent at Google
 *   authentication_failed   token exchange failed, code replayed or expired,
 *                           no email on the profile, or anything unexpected
 *   server_misconfigured    seed data is missing (`DatabaseSeedException`)
 */
export const AUTH_ERROR_CODES = [
  'not_allowlisted',
  'account_disabled',
  'access_denied',
  'authentication_failed',
  'server_misconfigured',
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/** The code used for every failure that has no more specific one. */
export const DEFAULT_AUTH_ERROR_CODE: AuthErrorCode = 'authentication_failed';

/** Reasons a login can be refused, a subset of `AuthErrorCode`. */
export type AuthLoginDeniedReason = Extract<
  AuthErrorCode,
  'not_allowlisted' | 'account_disabled' | 'access_denied'
>;

/**
 * A sign-in that ended in a refusal rather than a fault: refused by policy
 * (allowlist, disabled account) or declined by the person at Google's consent
 * screen (`GoogleOAuthGuard` raises that one).
 *
 * Still a 403 `ForbiddenException`, so every caller that treats it as one (and
 * the OpenAPI document) is unchanged; `reason` is what the OAuth callback turns
 * into the redirect's `error` code. The human message stays for logs and API
 * consumers and is never put in the redirect.
 */
export class AuthLoginDeniedException extends ForbiddenException {
  constructor(
    readonly reason: AuthLoginDeniedReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Builds the frontend callback URL for a failed sign-in:
 * `${appUrl}/auth/callback?error=<code>`.
 */
export function buildAuthErrorRedirectUrl(
  appUrl: string | undefined,
  code: AuthErrorCode,
): string {
  const url = new URL('/auth/callback', appUrl);
  url.searchParams.set('error', code);
  return url.toString();
}

/**
 * True for Passport's `AuthorizationError` with code `access_denied`.
 *
 * `passport-oauth2` does not currently raise that for a consent denial (it
 * calls `fail()` for `?error=access_denied`, which `GoogleOAuthGuard` turns into
 * an `AuthLoginDeniedException('access_denied')`), but a strategy that does
 * raise it must still land on the same code.
 *
 * Matched structurally (name and code) rather than with `instanceof`, because
 * the class belongs to `passport-oauth2`, a transitive dependency this module
 * should not import, and more than one copy of it can be installed.
 */
export function isOAuthAccessDenied(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === 'AuthorizationError' && code === 'access_denied';
}

/**
 * Maps anything thrown on the Google sign-in path to a code from the closed
 * set. Anything unrecognised is `authentication_failed`, so a new failure mode
 * can never leak its message into the redirect.
 */
export function resolveAuthErrorCode(error: unknown): AuthErrorCode {
  if (error instanceof AuthLoginDeniedException) return error.reason;
  if (error instanceof DatabaseSeedException) return 'server_misconfigured';
  if (isOAuthAccessDenied(error)) return 'access_denied';
  return DEFAULT_AUTH_ERROR_CODE;
}
