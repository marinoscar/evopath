import { Module } from '@nestjs/common';

import { IntakeModule } from '../intake/intake.module';
import { JobsModule } from '../jobs/jobs.module';
import { StorageModule } from '../storage/storage.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { HealthDocumentPurgeHandler } from './handlers/health-document-purge.handler';
import { HealthDocumentObjectReferences } from './health-document-object-references';
import { HealthDocumentsController } from './health-documents.controller';
import { HealthDocumentsService } from './health-documents.service';

/**
 * Health documents (H1, #185; API H6, #190): the files a user handed a health
 * intake, with their keep-or-delete choice. `IntakeService` writes the rows
 * (a kind opts in with `healthDocumentKind`) and enqueues the purge; this
 * module owns what outlives the intake: the `health.document.purge` job
 * (server-only), the `health_documents` storage reference checker that keeps
 * a held file from the intake's cleanup, and `/api/health/documents` (list,
 * read, rename/date, download link, delete).
 */
@Module({
  imports: [IntakeModule, JobsModule, StorageModule, StorageProvidersModule],
  controllers: [HealthDocumentsController],
  providers: [HealthDocumentPurgeHandler, HealthDocumentObjectReferences, HealthDocumentsService],
})
export class HealthDocumentsModule {}
