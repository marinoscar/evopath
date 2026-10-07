import { Global, Module } from '@nestjs/common';
import { registerAppMetrics } from '@marinoscar/platform-api/otel-core';

import { EVOPATH_APP_METRICS } from './domain-metric-names';
import { EvoPathMetricsService } from './domain-metrics.service';

// =============================================================================
// The app's metric-name registration (marinoscar/EnterpriseAppBase#718)
// =============================================================================
//
// THE APP'S EXTENSION POINT FOR METRICS. The 26 health and coach metrics are
// declared in the otel-core app-metric registry here, ONCE, at import time:
// `app.module.ts` imports this file while it is evaluated, which is before the
// Nest application exists and so before `RegistryFreezeService` freezes every
// registry on bootstrap. The platform's metrics are registered first, by
// `common/otel/app-metric.manifest.ts` (loaded by `AppMetricsService`, which
// `app.module.ts` reaches through its earlier imports).
//
// A duplicate key or name fails fast: `registerAppMetrics` throws a
// `RegistryError` (`DUPLICATE_ID`, or `INVALID_ENTRY` naming the clash) and
// the boot stops at import. After the freeze, a late registration throws
// `FROZEN`.
// =============================================================================

registerAppMetrics(EVOPATH_APP_METRICS);

/**
 * Provides `EvoPathMetricsService` to every module. GLOBAL for the same reason
 * as `AppMetricsModule`: it is infrastructure the health and coach modules
 * record into. It needs the platform's `MetricsHostService`, which the global
 * `OtelMetricsModule` (imported by `AppMetricsModule`) provides.
 */
@Global()
@Module({
  providers: [EvoPathMetricsService],
  exports: [EvoPathMetricsService],
})
export class EvoPathMetricsModule {}
