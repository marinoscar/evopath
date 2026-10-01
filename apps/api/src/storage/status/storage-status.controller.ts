// =============================================================================
// /api/storage/status — is object storage usable at all? (#204)
// =============================================================================
//
// For every `storage:read` holder, so the web app can replace an upload control
// that would fail with a "not enabled yet" notice. It answers ONE boolean and
// never the provider, bucket, region or any credential: those stay behind
// `storage_config:read` on `/api/admin/storage`.
//
// The completeness rule is not restated here: the answer is exactly whether
// the Doctor's `storage.config` decision (`decideStorageConfig`) would pass on
// the resolved configuration. Cheap and read-only: a settings read through the
// service's short cache plus the credential lookup, never a bucket round trip.
// A configuration that cannot be read at all is reported as not configured,
// which is what the Doctor reports for it too.
// =============================================================================

import { Controller, Get, Logger } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { decideStorageConfig } from '../config/doctor/storage-config.doctor-check';
import { StorageConfigService } from '../config/storage-config.service';
import { StorageStatusResponse, StorageStatusResponseDto } from './dto/storage-status.dto';

@ApiTags('Storage')
@Controller('storage/status')
export class StorageStatusController {
  private readonly logger = new Logger(StorageStatusController.name);

  constructor(private readonly storageConfig: StorageConfigService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.STORAGE_READ] })
  @ApiOperation({
    summary: 'Is object storage configured?',
    description:
      'Returns `{ configured }`: `true` when the object-storage configuration is complete, the ' +
      'same rule the Doctor\'s `storage.config` check applies. Lets a client show a ' +
      '"not enabled yet" notice instead of an upload control that would fail.\n\n' +
      'Never returns the provider, bucket, region or any credential. Read-only and cheap: ' +
      'no request reaches the object store. A configuration that cannot be read is reported ' +
      'as `configured: false`.',
  })
  @ApiDataResponse(StorageStatusResponseDto, { description: 'Whether object storage is configured.' })
  async getStatus(): Promise<StorageStatusResponse> {
    try {
      const resolution = await this.storageConfig.resolve();

      return { configured: decideStorageConfig(resolution).status === 'pass' };
    } catch (error) {
      this.logger.warn(
        `Storage configuration unreadable for status: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { configured: false };
    }
  }
}
