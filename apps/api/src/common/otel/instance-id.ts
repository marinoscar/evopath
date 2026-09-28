// =============================================================================
// The telemetry instance identifier (issue #565)
// =============================================================================
//
// WHAT IT IS, AND WHY IT IS NOT THE SERVICE NAME
// -----------------------------------------------------------------------------
//
// `service.name` (see `service-name.ts`) says WHICH PROGRAM produced a span:
// `my-app-api`. It is fixed per deployment by `OTEL_SERVICE_NAME` and cannot
// change without a restart, because it lives on the SDK resource.
//
// `app.instance.id` says WHICH DEPLOYMENT OF THE APPLICATION produced it. Two
// forks of this template — or staging and production of one fork — can ship
// into one shared telemetry store (a Grafana stack, a GreptimeDB several
// deployments point at), and without a label of their own their series and
// traces are indistinguishable. An administrator sets it at
// `/admin/settings/telemetry` (`telemetry.instanceId`), at runtime.
//
// THE DEFAULT IS `APP_SLUG`, RESOLVED ON EVERY CALL
// -----------------------------------------------------------------------------
//
// The stored setting is `null` until an administrator overrides it, and `null`
// means "follow `APP_SLUG`". Storing the slug literally on first write would
// freeze it: a fork renamed afterwards (`scripts/rename.mjs`) would keep
// reporting under the template's identity until someone noticed. Resolving
// here, at the point of use, keeps a renamed fork correct by construction.
//
// SAFE TO IMPORT BEFORE THE SDK STARTS
// -----------------------------------------------------------------------------
//
// `telemetry-gate.ts` imports this, and `instrumentation.ts` imports the gate
// ahead of `sdk.start()`. So, like `service-name.ts`: no side effects, and
// nothing imported but `@app/shared` (plain CommonJS over `identity.json`) —
// never `http`, `pg`, `pino` or anything the auto-instrumentation must patch.
// =============================================================================

import { APP_SLUG } from '@app/shared';

/** The OTel resource attribute key the instance identifier is exported under. */
export const ATTR_APP_INSTANCE_ID = 'app.instance.id';

/**
 * The instance identifier telemetry is stamped with: the administrator's
 * `telemetry.instanceId` when set, else `APP_SLUG`.
 *
 * An empty string is treated like `null` — the settings schema never admits
 * one, but a label of `""` would be worse than the default in every backend.
 */
export function resolveTelemetryInstanceId(configured: string | null | undefined): string {
  return configured || APP_SLUG;
}
