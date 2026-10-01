// =============================================================================
// Route and caller attributes on the HTTP server span (issue #258)
// =============================================================================
//
// WHY THIS EXISTS
// -----------------------------------------------------------------------------
// A web build newer than the API build called routes the API did not have
// (`GET /api/coach/messages`, …). Nest answered its default 404 ("Cannot GET
// …") in about a millisecond, and the telemetry dashboard stayed green: it
// only counted 5xx, OpenTelemetry leaves a 4xx server span STATUS_CODE_UNSET,
// and nothing logged. Worse, a 404 from an unknown route looked exactly like a
// legitimate 404 from a matched route (`GET /api/gyms/:id` for a deleted gym),
// because the server span carried no route at all: the http instrumentation
// cannot know Fastify's route table, and there is no Fastify instrumentation
// in the auto-instrumentation bundle this API uses.
//
// So one `onRequest` hook, registered on the root Fastify instance before any
// route or plugin, writes what only Fastify knows onto the ACTIVE span:
//
//   http.route         the matched route pattern (`/api/gyms/:id`) — the OTel
//                      semantic-convention attribute. Matched requests only.
//                      As a side effect the http instrumentation renames the
//                      server span to `GET /api/gyms/:id` when it ends (it
//                      reads `http.route` back), so `span_name` becomes
//                      useful too.
//   app.route.matched  `false` when Fastify fell through to the not-found
//                      handler (no route for this method + path). Absent on a
//                      matched request: the dashboard asks only "= false", and
//                      writing `true` on every span would only cost storage.
//   app.request.bearer whether an `Authorization: Bearer …` header is PRESENT.
//                      true/false on every request. NEVER the token or any
//                      part of it — only `startsWith('bearer ')` is read. The
//                      web app always sends a bearer, so this separates "our
//                      own client is calling a route that does not exist"
//                      (a deploy skew, a real defect) from anonymous internet
//                      scanners probing `/api/wp-login.php`.
//
// VERIFIED (Fastify 5.11, @opentelemetry/instrumentation-http 0.221, issue #258):
//   - Fastify resolves the route BEFORE `onRequest`, so `routeOptions.url` is
//     the pattern for a matched request and `undefined` for the not-found
//     handler (also for a known path with an unregistered method). `is404` is
//     the same fact as a boolean, and is what the hook branches on.
//   - During `onRequest`, `trace.getActiveSpan()` IS the http SERVER span
//     (kind SERVER): the http instrumentation runs the server's `request`
//     emit inside `context.with(serverSpan)`, and nothing between that emit
//     and the hook opens another span (no Fastify instrumentation; the
//     nestjs-core instrumentation only wraps the handler). The spec proves the
//     hook writes to whatever span is active; the SERVER-kind fact was
//     checked with a real `NodeSDK` + http instrumentation over a socket
//     (Jest's module registry defeats require-in-the-middle, so it cannot be
//     a Jest test).
//
// NO-OP WITHOUT OTEL. `main.ts` registers the hook only when the SDK is
// installed (`OTEL_ENABLED=true`). Even if registered without it, the no-op
// API's `getActiveSpan()` is undefined and the hook does nothing. It does not
// consult the runtime export gate (`telemetry-gate.ts`): the SDK keeps
// creating spans while the gate is closed, and an attribute set is cheaper
// than the branch would be worth.
//
// COST: one header read, one `getActiveSpan()`, two attribute sets. No
// allocation beyond what `setAttribute` itself does.
//
// The collector's `attributes/redact` processor only deletes credential
// attributes (authorization/cookie headers, url.query), so these three pass
// through; GreptimeDB's `greptime_trace_v1` pipeline flattens them into the
// columns `span_attributes.http.route`, `span_attributes.app.route.matched`
// and `span_attributes.app.request.bearer`, created on first write.
// =============================================================================

import { trace } from '@opentelemetry/api';
import type { FastifyInstance, FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

/** Semantic-convention route attribute (stable HTTP semconv). */
export const ATTR_HTTP_ROUTE = 'http.route';
/** `false` when no route matched (Fastify's not-found handler answered). Absent otherwise. */
export const ATTR_APP_ROUTE_MATCHED = 'app.route.matched';
/** Whether an `Authorization: Bearer` header was present. Never the token. */
export const ATTR_APP_REQUEST_BEARER = 'app.request.bearer';

/** Whether the request carries an `Authorization: Bearer …` header. Reads only the scheme. */
export function hasBearer(authorization: string | string[] | undefined): boolean {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  return typeof value === 'string' && value.length > 7 && value.slice(0, 7).toLowerCase() === 'bearer ';
}

/** The `onRequest` hook itself; exported for the spec. */
export function requestSpanAttributesHook(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  const span = trace.getActiveSpan();
  if (span) {
    if (request.is404) {
      span.setAttribute(ATTR_APP_ROUTE_MATCHED, false);
    } else {
      const route = request.routeOptions.url;
      if (route) span.setAttribute(ATTR_HTTP_ROUTE, route);
    }
    span.setAttribute(ATTR_APP_REQUEST_BEARER, hasBearer(request.headers.authorization));
  }
  done();
}

/**
 * Registers the hook on the ROOT Fastify instance. Call it before any plugin
 * or route is registered (right after `NestFactory.create`), so it runs first
 * — before a CORS preflight or any other `onRequest` hook can reply.
 *
 * Returns whether the hook was registered.
 */
export function registerRequestSpanAttributes(
  fastify: Pick<FastifyInstance, 'addHook'>,
  otelEnabled: boolean,
): boolean {
  if (!otelEnabled) return false;
  fastify.addHook('onRequest', requestSpanAttributesHook);
  return true;
}
