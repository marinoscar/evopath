import { Module } from '@nestjs/common';

import { MeasurementsController } from './measurements.controller';
import { MeasurementsService } from './measurements.service';

/**
 * The caller's measurements (E2.2, #50). `PrismaService` comes from the global
 * `PrismaModule`. `MeasurementsService` is exported for later health features
 * (check-ins, photo intake); the metric registry is a plain module
 * (`./metric-registry`) any feature imports directly.
 */
@Module({
  controllers: [MeasurementsController],
  providers: [MeasurementsService],
  exports: [MeasurementsService],
})
export class MeasurementsModule {}
