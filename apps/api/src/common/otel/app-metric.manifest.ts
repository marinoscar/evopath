// =============================================================================
// App-metric manifest (marinoscar/EnterpriseAppBase#680)
// =============================================================================
//
// Registers the platform's `app.*` metrics at import time (the core slice's
// registry README, "Recipe: a static registry"). Imported by
// `app-metrics.service.ts`; nothing else imports this file.
//
// This app's own metrics (health, coach) are NOT registered here: they are
// declared in `app-metrics/evopath-metric-names.ts` and registered once by
// `app-metrics/evopath-metrics.module.ts` (marinoscar/EnterpriseAppBase#718),
// which `app.module.ts` imports after `AppMetricsModule`, so a key or name
// collision names the app's declaration.
// =============================================================================

import { registerAppMetrics } from '@marinoscar/platform-api/otel-core';

import { PLATFORM_APP_METRICS } from './platform-app-metrics';

registerAppMetrics(PLATFORM_APP_METRICS);
