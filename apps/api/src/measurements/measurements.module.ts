import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { IntakeModule } from '../intake/intake.module';
import { JobsModule } from '../jobs/jobs.module';
import { BiomarkersController } from './biomarkers/biomarkers.controller';
import { BiomarkersService } from './biomarkers/biomarkers.service';
import { LabReportDuplicatesService } from './lab-report/lab-report-duplicates.service';
import { LabReportController } from './lab-report/lab-report.controller';
import { LabReportHandler } from './lab-report/lab-report.handler';
import { LabReportIntakeKind } from './lab-report/lab-report.kind';
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
 *
 * "Import a lab report" (H4, #188) lives in `./lab-report`: the `lab_report`
 * intake kind, its server-only `ai.health.lab_report` job, and the
 * duplicate-warning route under `/api/measurements/lab-reports`.
 *
 * Blood-work history (H5, #189) adds `./biomarkers`: the per-analyte summary
 * under `/api/health/biomarkers`.
 */
@Module({
  imports: [AiModule, JobsModule, IntakeModule],
  controllers: [MeasurementsController, LabReportController, BiomarkersController],
  providers: [
    MeasurementsService,
    BodyMetricReadingIntakeKind,
    BodyMetricReadingHandler,
    LabReportIntakeKind,
    LabReportHandler,
    LabReportDuplicatesService,
    BiomarkersService,
  ],
  exports: [MeasurementsService],
})
export class MeasurementsModule {}
