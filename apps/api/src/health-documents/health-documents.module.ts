import { Module } from '@nestjs/common';

import { IntakeModule } from '../intake/intake.module';
import { JobsModule } from '../jobs/jobs.module';
import { StorageModule } from '../storage/storage.module';
import { HealthDocumentPurgeHandler } from './handlers/health-document-purge.handler';
import { HealthDocumentObjectReferences } from './health-document-object-references';

/**
 * Health documents (H1, #185): the files a user handed a health intake, with
 * their keep-or-delete choice. `IntakeService` writes the rows (a kind opts in
 * with `healthDocumentKind`) and enqueues the purge; this module owns what
 * outlives the intake: the `health.document.purge` job (server-only) and the
 * `health_documents` storage reference checker that keeps a held file from
 * the intake's cleanup. No routes yet (the documents API is H6).
 */
@Module({
  imports: [IntakeModule, JobsModule, StorageModule],
  providers: [HealthDocumentPurgeHandler, HealthDocumentObjectReferences],
})
export class HealthDocumentsModule {}
