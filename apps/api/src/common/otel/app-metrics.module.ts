import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtelMetricsModule } from '@marinoscar/platform-api/otel-core';

import { AppMetricsService } from './app-metrics.service';

/**
 * Application metrics (issue #125). GLOBAL so any feature can inject
 * `AppMetricsService` without importing this module — the same reasoning as
 * `PrismaModule`: it is infrastructure every layer records into, and it has no
 * dependencies beyond the (global) Prisma and config providers.
 *
 * Since marinoscar/EnterpriseAppBase#700 the instruments live on the platform's metrics host
 * (`MetricsHostService`, `@marinoscar/platform-api/otel-core`), provided
 * globally by `OtelMetricsModule`; gauges follow `otel.enabled`, exactly as
 * `AppMetricsService` decided before.
 */
@Global()
@Module({
  imports: [
    OtelMetricsModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ gauges: config.get<boolean>('otel.enabled') === true }),
    }),
  ],
  providers: [AppMetricsService],
  exports: [AppMetricsService],
})
export class AppMetricsModule {}
