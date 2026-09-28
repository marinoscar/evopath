import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { MaintenanceModule } from '../common/maintenance/maintenance.module';

@Module({
  // MaintenanceModule (#257) for `MaintenanceModeService`: the readiness probe
  // answers the maintenance question BEFORE the database probe. The edge goes
  // one way — nothing in the maintenance graph knows this module exists.
  imports: [TerminusModule, MaintenanceModule],
  controllers: [HealthController],
  providers: [DatabaseHealthIndicator],
  // Exported for `AboutModule` (#401, epic #397): `GET /api/admin/about`
  // reports a database liveness fact and must use THIS indicator rather than a
  // second `SELECT 1` of its own, so there stays one definition of "the
  // database answers". The indicator throws `HealthCheckError` on failure,
  // which is right for Terminus and wrong for an about page — `AboutService`
  // catches it and reports `database: null` plus `databaseError`.
  exports: [DatabaseHealthIndicator],
})
export class HealthModule {}
