// =============================================================================
// This app's telemetry identity (issues #343, #565; bound here by marinoscar/EnterpriseAppBase#700)
// =============================================================================
//
// The resolvers live in `@marinoscar/platform-api/otel-core/sdk`, which knows
// no product identity (a platform slice never imports `@app/shared`). This
// file binds them to the app's, ONCE, so every surface that names the service
// or the instance (the SDK resource in `instrumentation.ts`, `otel.serviceName`
// in `config/configuration.ts`, the `service` field of every log line in
// `common/logger/pino.config.ts`, the AI adapters' spans, the node relay, the
// telemetry settings) agrees by construction, and a fork renamed with
// `scripts/rename.mjs` follows its new `APP_SLUG` without editing a line.
//
//   service.name     `OTEL_SERVICE_NAME`, else `${APP_SLUG}-api`
//   app.instance.id  the `telemetry.instanceId` setting, else `APP_SLUG`
//
// THE GATE STARTS AT `APP_SLUG`. The package's gate starts at a placeholder
// (`DEFAULT_INSTANCE_ID`); this module sets the app's default the moment it is
// loaded, which is before anything reads or sets the gate's id (the telemetry
// settings service imports it). So the first exported batch is never
// unlabelled, and the settings service logs a relabel only when an
// administrator's `telemetry.instanceId` actually differs from the slug.
//
// SAFE TO IMPORT BEFORE THE SDK STARTS: `instrumentation.ts` imports it ahead
// of `initializeOtel()`. It reads `@app/shared` (plain CommonJS over
// `identity.json`) and the Nest-free `sdk` subpath, nothing that the
// auto-instrumentation patches. Keep it that way.
// =============================================================================

import { APP_SLUG } from '@app/shared';
import {
  ATTR_APP_INSTANCE_ID,
  resolveServiceName as resolvePlatformServiceName,
  resolveTelemetryInstanceId as resolvePlatformInstanceId,
  telemetryGate,
} from '@marinoscar/platform-api/otel-core/sdk';

export { ATTR_APP_INSTANCE_ID };

/**
 * The service name this process reports to OpenTelemetry: `OTEL_SERVICE_NAME`
 * when set (it is, in `infra/compose/base.compose.yml` and `.env.example`),
 * else `${APP_SLUG}-api`. Resolved on every call.
 */
export function resolveServiceName(): string {
  return resolvePlatformServiceName(`${APP_SLUG}-api`);
}

/**
 * The instance identifier telemetry is stamped with: the administrator's
 * `telemetry.instanceId` when set, else `APP_SLUG`. An empty string counts as
 * unset.
 */
export function resolveTelemetryInstanceId(configured: string | null | undefined): string {
  return resolvePlatformInstanceId(configured, APP_SLUG);
}

telemetryGate.setInstanceId(resolveTelemetryInstanceId(null));
