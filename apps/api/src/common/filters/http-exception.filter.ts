import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { hasVerbatimErrorBody } from '../exceptions/verbatim-error-body.exception';

interface ErrorResponse {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  timestamp: string;
  path: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // ---------------------------------------------------------------------
      // Verbatim bodies (#153) — checked FIRST, and returns immediately.
      // ---------------------------------------------------------------------
      // A branded exception carries a body dictated by an external spec, not by
      // us: today that is `POST /auth/device/token`, whose RFC 8628 §3.5 body is
      // `{ error, error_description }`. Sending it through the envelope below
      // destroys it — the envelope reads only `message`, `code` and `details`,
      // so all four RFC outcomes used to arrive as the same generic 400 and a
      // polling client could not tell them apart. See
      // `common/exceptions/verbatim-error-body.exception.ts` for why the opt-out
      // is an explicit brand rather than the filter sniffing for an `error` key.
      //
      // Nothing is merged in — not `statusCode`, not `timestamp`, not `path`.
      // Extra keys would not upset a tolerant parser, but they would put fields
      // the RFC never defines into a protocol response, and a body that is
      // "mostly the spec" is exactly the kind of thing a strict client rejects
      // and a reader stops trusting. The status line still carries the code.
      //
      // The object guard matters: a string payload has nothing to send
      // verbatim, so such an exception falls through to the envelope rather than
      // putting a bare JSON string on the wire.
      if (
        hasVerbatimErrorBody(exception) &&
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        this.logOutcome(
          request,
          status,
          this.summarize(exceptionResponse as Record<string, unknown>),
          exception,
        );

        response.code(status).send(exceptionResponse);
        return;
      }

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const resp = exceptionResponse as Record<string, unknown>;
        message = (resp.message as string) || message;
        details = resp.details;
      }

      // `code` is ALWAYS derived from the status, and a `code` on the thrown
      // payload is deliberately ignored.
      //
      // This line used to be preceded by `code = (resp.code as string) ||
      // this.getCodeFromStatus(status)`, which this one immediately overwrote —
      // dead since it was written, so no exception in the app could ever set its
      // own code (#153). The dead line was removed rather than made to work,
      // because honouring a payload `code` is a real behaviour change on the
      // wire and the current behaviour is the one the API actually promises:
      //
      //   * `common/dto/error.dto.ts` publishes `code` as a CLOSED ENUM of the
      //     nine status-derived values, and says in so many words that the
      //     filter overwrites any `code` an exception supplied. That DTO is the
      //     `default` error response on every operation in the OpenAPI document,
      //     so it is a published contract, not a comment.
      //   * `http-exception.filter.spec.ts` asserts it ("The filter overrides
      //     custom code with standard code mapping"). The behaviour is tested,
      //     not accidental.
      //   * One exception does pass a `code`: `DatabaseSeedException` sends
      //     `DATABASE_SEED_REQUIRED`. Reviving the dead line would have changed
      //     that response's `code` from `INTERNAL_ERROR` to a value outside the
      //     published enum — a silent contract break in the one place nobody
      //     would think to check. Its identifying data is already in `details`,
      //     which the envelope carries through.
      //
      // Endpoint-specific machine-readable data belongs under `details`; an
      // externally-specified body belongs behind the verbatim brand above.
      code = this.getCodeFromStatus(status);
    } else if (exception instanceof Error) {
      message = exception.message;
      // Don't expose stack traces in production
      if (process.env.NODE_ENV !== 'production') {
        details = exception.stack;
      }
    }

    const errorResponse: ErrorResponse = {
      statusCode: status,
      code,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    if (details) {
      errorResponse.details = details;
    }

    this.logOutcome(request, status, message, exception);

    // A 429 that says when to come back (`details.retryAfterMs` — every
    // `AiError('AI_RATE_LIMITED')` that knows, including the AI rate limits of
    // #450) also says so in the standard header, in whole seconds rounded UP
    // so a client that honours it never retries early.
    const retryAfterSeconds = status === 429 ? retryAfterSecondsOf(details) : undefined;

    if (retryAfterSeconds !== undefined) {
      response.header('Retry-After', String(retryAfterSeconds));
    }

    // Fastify response - use code() and send()
    response.code(status).send(errorResponse);
  }

  /**
   * One log line per handled failure, identical for enveloped and verbatim
   * responses. Extracted so the verbatim early-return above cannot silently
   * skip logging — a device-flow `slow_down` storm has to be visible in the
   * logs like any other 4xx.
   */
  private logOutcome(
    request: { method: string; url: string },
    status: number,
    summary: string,
    exception: unknown,
  ): void {
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} - ${status}`,
        exception instanceof Error ? exception.stack : exception,
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} - ${status}: ${summary}`,
      );
    }
  }

  /**
   * A short log-only description of a verbatim body.
   *
   * Reading `error` here is for the LOG LINE ONLY and shapes nothing — an RFC
   * body's `error` is the single most useful thing to see in operations
   * (`slow_down` and `access_denied` mean very different things at 3am), and
   * without it every device-flow failure logs as an indistinguishable 400. The
   * body itself is never stringified into the log: a verbatim payload is
   * whatever the spec says it is, and this filter should not assume the rest of
   * it is safe to print.
   */
  private summarize(body: Record<string, unknown>): string {
    const label = body.error ?? body.message;
    return typeof label === 'string' ? label : 'verbatim error body';
  }

  private getCodeFromStatus(status: number): string {
    const codeMap: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      413: 'PAYLOAD_TOO_LARGE',
      422: 'UNPROCESSABLE_ENTITY',
      429: 'TOO_MANY_REQUESTS',
      500: 'INTERNAL_ERROR',
    };
    return codeMap[status] || 'ERROR';
  }
}

/** `details.retryAfterMs` as a `Retry-After` delta-seconds value (at least 1), or `undefined`. */
function retryAfterSecondsOf(details: unknown): number | undefined {
  if (details === null || typeof details !== 'object') return undefined;

  const ms = (details as { retryAfterMs?: unknown }).retryAfterMs;

  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : undefined;
}
