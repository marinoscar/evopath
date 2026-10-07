// =============================================================================
// The app's binding of the telemetry slice (marinoscar/EnterpriseAppBase#719)
// =============================================================================
//
// `@marinoscar/platform-api/telemetry`, configured for this app: routes
// guarded by the app's own `@Auth()` (`platformHost`), every app capability
// through the host ports `TelemetryHostModule` binds, and this app's own
// dashboard metric groups after the six platform groups. Imported once by
// `app.module.ts`, at the position the app module always held telemetry. Same
// shape as `../doctor.config.ts`. Platform code: never edit the package here
// (CLAUDE.md, "Platform code lives in packages").
//
// NO VERDICT OVERRIDE. This app's thresholds were identical to the platform's
// (`DASHBOARD_VERDICT_THRESHOLDS`, measured in the drift baseline), so neither
// `dashboard.verdictThresholds` nor `dashboard.verdictPolicy` is passed; a
// test pins the resolved thresholds to `DEFAULT_VERDICT_THRESHOLDS`.
//
// APP METRIC GROUPS. `coach` (`coach/telemetry/coach-metric-group.ts`), the
// AI Coach funnel over the `app.coach.*` counters. Passed here rather than
// registered from a module's `onModuleInit` so it is in the registry before
// the dashboard controller is built: the `/metrics` route's documented
// `group` enum then lists it, and the platform dashboard renders it from
// `/metric-groups` with no app UI code.
// =============================================================================

import type { Type } from '@nestjs/common';
import { TelemetryModule, type MetricGroupDef } from '@marinoscar/platform-api/telemetry';

import { COACH_METRIC_GROUP } from '../../coach/telemetry/coach-metric-group';
import { platformHost } from '../platform-host';
import { TelemetryHostModule } from './telemetry-host.module';

/** This app's own Telemetry Dashboard metric groups, in registration order. */
export const APP_METRIC_GROUPS: readonly MetricGroupDef[] = [COACH_METRIC_GROUP];

export const telemetryModule = TelemetryModule.forRoot({
  host: platformHost,
  imports: [TelemetryHostModule],
  metricGroups: APP_METRIC_GROUPS,
});

/**
 * The configured module's controller classes, by class name, so a test can
 * read a route's metadata (`telemetryControllers.TelemetryStackController.prototype.deploy`).
 */
export const telemetryControllers: Readonly<Record<string, Type<unknown>>> = Object.freeze(
  Object.fromEntries((telemetryModule.controllers ?? []).map((controller) => [controller.name, controller])),
);

/**
 * The configured module's provider classes, by class name, for tests that
 * reach a provider the slice does not export (`app.get(telemetryProviders.TelemetryDashboardService)`).
 * Production code injects only what the slice exports.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const telemetryProviders: Readonly<Record<string, Type<any>>> = Object.freeze(
  Object.fromEntries(
    (telemetryModule.providers ?? [])
      .filter((provider): provider is Type<unknown> => typeof provider === 'function')
      .map((provider) => [provider.name, provider]),
  ),
);
