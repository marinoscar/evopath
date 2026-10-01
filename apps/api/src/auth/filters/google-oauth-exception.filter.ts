import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuthErrorCode,
  buildAuthErrorRedirectUrl,
  resolveAuthErrorCode,
} from '../auth-error-codes';

/**
 * Turns a failure raised by `GoogleOAuthGuard` into the same redirect the
 * callback controller issues for its own failures (#652).
 *
 * The guard runs before the controller body, so its errors never reach the
 * controller's `try/catch`: consent cancelled at Google (`AuthorizationError`
 * `access_denied`), a replayed or expired code (`TokenError`), a profile with no
 * email. Without this filter each one surfaced as a raw JSON body from a
 * top-level navigation to `/api/auth/google/callback`.
 *
 * Applied with `@UseFilters` on the callback route ONLY, never globally: every
 * other route keeps `HttpExceptionFilter`'s JSON envelope.
 *
 * Only the code from the closed set (`auth-error-codes.ts`) leaves this
 * filter. Logs carry the error's name and message and never the request URL,
 * which holds the authorization code.
 */
@Catch()
export class GoogleOAuthExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GoogleOAuthExceptionFilter.name);

  constructor(private readonly configService: ConfigService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse();
    const code = resolveAuthErrorCode(exception);

    this.log(exception, code);

    // Nothing sensible can be redirected once a response has started.
    if (reply.sent || reply.raw?.headersSent) return;

    reply.redirect(
      buildAuthErrorRedirectUrl(this.configService.get<string>('appUrl'), code),
    );
  }

  private log(exception: unknown, code: AuthErrorCode): void {
    const name = exception instanceof Error ? exception.name : typeof exception;
    const message = exception instanceof Error ? exception.message : '';

    // The person declining consent, or a policy refusal, is expected traffic.
    if (code === 'access_denied' || code === 'not_allowlisted' || code === 'account_disabled') {
      this.logger.warn(`Google sign-in ended as ${code} (${name})`);
      return;
    }

    this.logger.error(
      `Google sign-in failed before the callback handler (${name}): ${message}`,
      exception instanceof Error ? exception.stack : undefined,
    );
  }
}
