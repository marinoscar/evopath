import { ArgumentsHost, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleOAuthExceptionFilter } from './google-oauth-exception.filter';
import { AuthLoginDeniedException } from '../auth-error-codes';
import { DatabaseSeedException } from '@marinoscar/platform-api/core';

const APP_URL = 'https://app.example.com';

/** Mirrors passport-oauth2's AuthorizationError / TokenError shape. */
function passportError(name: string, code: string, message = 'boom') {
  const err = new Error(message) as Error & { code: string };
  err.name = name;
  err.code = code;
  return err;
}

describe('GoogleOAuthExceptionFilter', () => {
  let filter: GoogleOAuthExceptionFilter;
  let reply: { redirect: jest.Mock; sent?: boolean; raw?: { headersSent: boolean } };
  let host: ArgumentsHost;

  beforeEach(() => {
    const config = {
      get: jest.fn((key: string) => (key === 'appUrl' ? APP_URL : undefined)),
    } as unknown as ConfigService;
    filter = new GoogleOAuthExceptionFilter(config);
    reply = { redirect: jest.fn(), sent: false, raw: { headersSent: false } };
    host = {
      switchToHttp: () => ({ getResponse: () => reply }),
    } as unknown as ArgumentsHost;
  });

  const target = () => new URL(reply.redirect.mock.calls[0][0]);

  it.each([
    [
      'AuthorizationError access_denied',
      passportError('AuthorizationError', 'access_denied', 'The user denied access'),
      'access_denied',
    ],
    [
      'AuthorizationError server_error',
      passportError('AuthorizationError', 'server_error'),
      'authentication_failed',
    ],
    [
      'TokenError (replayed code)',
      passportError('TokenError', 'invalid_grant', 'Bad Request'),
      'authentication_failed',
    ],
    ['plain Error (no email)', new Error('No email found in Google profile'), 'authentication_failed'],
    ['non-Error throw', 'nope', 'authentication_failed'],
    [
      'AuthLoginDeniedException not_allowlisted',
      new AuthLoginDeniedException('not_allowlisted', 'Your email is not authorized'),
      'not_allowlisted',
    ],
    [
      'AuthLoginDeniedException account_disabled',
      new AuthLoginDeniedException('account_disabled', 'User account is disabled'),
      'account_disabled',
    ],
    ['DatabaseSeedException', new DatabaseSeedException('roles'), 'server_misconfigured'],
    ['unrelated ForbiddenException', new ForbiddenException('nope'), 'authentication_failed'],
  ])('redirects %s to error=%s', (_label, exception, code) => {
    filter.catch(exception, host);

    expect(reply.redirect).toHaveBeenCalledTimes(1);
    const url = target();
    expect(url.origin + url.pathname).toBe(`${APP_URL}/auth/callback`);
    expect(url.searchParams.get('error')).toBe(code);
    expect([...url.searchParams.keys()]).toEqual(['error']);
  });

  it('never puts the error message in the redirect', () => {
    filter.catch(new Error('Call 555-0100 to restore access'), host);

    expect(reply.redirect.mock.calls[0][0]).not.toContain('555');
  });

  it('does not redirect once the response has started', () => {
    reply.raw = { headersSent: true };

    filter.catch(new Error('late'), host);

    expect(reply.redirect).not.toHaveBeenCalled();
  });
});
