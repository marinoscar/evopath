import { Global, Module } from '@nestjs/common';

import { AppMetricsService } from './app-metrics.service';

/**
 * Application metrics (issue #125). GLOBAL so any feature can inject
 * `AppMetricsService` without importing this module — the same reasoning as
 * `PrismaModule`: it is infrastructure every layer records into, and it has no
 * dependencies beyond the (global) Prisma and config providers.
 */
@Global()
@Module({
  providers: [AppMetricsService],
  exports: [AppMetricsService],
})
export class AppMetricsModule {}
