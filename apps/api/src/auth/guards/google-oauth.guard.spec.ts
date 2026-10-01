import { ExecutionContext } from '@nestjs/common';
import { GoogleOAuthGuard } from './google-oauth.guard';
import { AuthLoginDeniedException } from '../auth-error-codes';

function contextWithQuery(query: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      // Fastify request: `query` lives here, `raw` is the IncomingMessage.
      getRequest: () => ({ query, raw: {} }),
    }),
  } as unknown as ExecutionContext;
}

describe('GoogleOAuthGuard.getAuthenticateOptions', () => {
  const guard = new GoogleOAuthGuard();

  it('asks Google to show the account chooser for ?select_account=1', () => {
    expect(
      guard.getAuthenticateOptions(contextWithQuery({ select_account: '1' })),
    ).toEqual({ prompt: 'select_account' });
  });

  it.each([
    ['no query', undefined],
    ['empty query', {}],
    ['select_account=0', { select_account: '0' }],
    ['select_account=true', { select_account: 'true' }],
    ['select_account repeated', { select_account: ['1', '1'] }],
    ['an unrelated param', { prompt: 'none' }],
  ])('leaves the default behaviour for %s', (_label, query) => {
    expect(
      guard.getAuthenticateOptions(contextWithQuery(query)),
    ).toBeUndefined();
  });
});

describe('GoogleOAuthGuard.handleRequest', () => {
  const guard = new GoogleOAuthGuard();

  it('returns the user and copies it onto the Fastify request', () => {
    const request: Record<string, unknown> = { query: {}, raw: {} };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    expect(guard.handleRequest(null, { id: 'g-1' }, undefined, context)).toEqual({ id: 'g-1' });
    expect(request.user).toEqual({ id: 'g-1' });
  });

  it('rethrows a strategy error unchanged', () => {
    const error = new Error('token exchange failed');

    expect(() =>
      guard.handleRequest(error, false, undefined, contextWithQuery({})),
    ).toThrow(error);
  });

  it('names a consent denial (?error=access_denied) so it maps to access_denied', () => {
    let thrown: unknown;
    try {
      guard.handleRequest(
        null,
        false,
        { message: 'user said no' },
        contextWithQuery({ error: 'access_denied', error_description: 'user said no' }),
      );
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(AuthLoginDeniedException);
    expect((thrown as AuthLoginDeniedException).reason).toBe('access_denied');
    expect((thrown as Error).message).not.toContain('user said no');
  });

  it('throws a generic error when authentication fails for any other reason', () => {
    expect(() =>
      guard.handleRequest(null, false, undefined, contextWithQuery({})),
    ).toThrow('Authentication failed');
  });
});
