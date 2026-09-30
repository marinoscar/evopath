import { Module } from '@nestjs/common';

import { JobsModule } from '../jobs/jobs.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { AdminFactoryResetController } from './admin-factory-reset.controller';
import { AdminFactoryResetService } from './admin-factory-reset.service';
import { AdminFactoryResetHandler } from './handlers/admin-factory-reset.handler';

/**
 * The admin factory reset (issue #211): `/api/admin/factory-reset/*` under
 * `system:factory_reset`, and the server-only `admin.factory_reset` job. The
 * per-user deletion it runs for every user is `user-data/user-data-purge.ts`,
 * shared with the user's own data reset (#202).
 */
@Module({
  imports: [JobsModule, StorageProvidersModule],
  controllers: [AdminFactoryResetController],
  providers: [AdminFactoryResetService, AdminFactoryResetHandler],
})
export class AdminFactoryResetModule {}
