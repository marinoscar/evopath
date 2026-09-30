import { Module } from '@nestjs/common';

import { JobsModule } from '../jobs/jobs.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { UserDataResetHandler } from './handlers/user-data-reset.handler';
import { UserDataController } from './user-data.controller';
import { UserDataService } from './user-data.service';

/**
 * The caller's own data reset (issue #202): `/api/user-data/*` under
 * `user_settings:write`, and the server-only `user.data_reset` job.
 *
 * `StorageProvidersModule`, not `StorageModule`, for the `STORAGE_PROVIDER`
 * token — the same choice `ProfileImageModule` and `JobsModule` make, and for
 * the same reason (no route or processing pipeline is needed, only deletes).
 */
@Module({
  imports: [JobsModule, StorageProvidersModule],
  controllers: [UserDataController],
  providers: [UserDataService, UserDataResetHandler],
})
export class UserDataModule {}
