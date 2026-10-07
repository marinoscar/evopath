import { Module } from '@nestjs/common';
import { RegistryFreezeService } from '@marinoscar/platform-api/core';
import { AdminBootstrapService } from './services/admin-bootstrap.service';

// RegistryFreezeService (@marinoscar/platform-api/core) freezes every static
// registry once the application has bootstrapped: the app-metric registry
// among them, filled at import time by common/otel/app-metric.manifest.ts and
// app-metrics/evopath-metrics.module.ts.
@Module({
  providers: [AdminBootstrapService, RegistryFreezeService],
  exports: [AdminBootstrapService],
})
export class CommonModule {}
