import { Module } from '@nestjs/common';

import { HealthModule } from '../health/health.module';
import { AboutController } from './about.controller';
import { AboutService } from './about.service';

// =============================================================================
// AboutModule (issue #401, epic #397)
// =============================================================================
//
// One controller, one service, one import.
//
// `HealthModule` is imported for `DatabaseHealthIndicator` — REUSED rather than
// reimplemented. There is exactly one definition in this repository of "the
// database answers", it already carries the `SELECT 1` and the timing, and a
// second probe written here would be a second thing to keep in step with the
// readiness endpoint. The import makes `HealthModule` export the indicator; it
// does not re-register `HealthController`, which belongs to the module that
// declares it.
//
// The direction is acyclic: health reaches Terminus, maintenance and Prisma, and
// nothing in that graph reaches back here.
//
// `PrismaService` is not imported — `PrismaModule` is `@Global()` — and neither
// is `SettingsModule`: this module reads no settings. The deploy document comes
// off the local filesystem and the API version comes from `openapi/version.ts`,
// a free function with no module of its own.
//
// Nothing is exported. The report is the controller's; anything else that wants
// these facts should ask the same two sources directly rather than routing a
// second consumer through an HTTP-shaped projection of them.
// =============================================================================

@Module({
  imports: [HealthModule],
  controllers: [AboutController],
  providers: [AboutService],
})
export class AboutModule {}
