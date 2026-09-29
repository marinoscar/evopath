import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { IntakeModule } from '../intake/intake.module';
import { JobsModule } from '../jobs/jobs.module';
import { MeasurementsController } from './measurements.controller';
import { MeasurementsService } from './measurements.service';
import { BodyMetricReadingHandler } from './photo/body-metric-reading.handler';
import { BodyMetricReadingIntakeKind } from './photo/body-metric-reading.kind';

/**
 * The caller's measurements (E2.2, #50). `PrismaService` comes from the global
 * `PrismaModule`. `MeasurementsService` is exported for later health features
 * (check-ins, photo intake); the metric registry is a plain module
 * (`./metric-registry`) any feature imports directly.
 *
 * "Read a value from a photo" (E2.6, #64) lives in `./photo`: the
 * `body_metric_reading` intake kind (registered on `IntakeModule`'s
 * `IntakeKindRegistry`) and its server-only `ai.health.body_metric_reading`
 * job (registered on `JobsModule`'s `JobHandlerRegistry`, calling
 * `AiModule`'s `AiService`).
 */
@Module({
  imports: [AiModule, JobsModule, IntakeModule],
  controllers: [MeasurementsController],
  providers: [MeasurementsService, BodyMetricReadingIntakeKind, BodyMetricReadingHandler],
  exports: [MeasurementsService],
})
export class MeasurementsModule {}
