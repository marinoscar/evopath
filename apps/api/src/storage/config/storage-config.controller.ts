import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Put,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { StorageBucketProvisionService } from './storage-bucket-provision.service';
import { StorageConfigAdminService } from './storage-config-admin.service';
import { StorageConnectionTestService } from './storage-connection-test.service';
import { ProvisionStorageBucketDto, StorageBucketProvisionResultDto } from './dto/storage-bucket-provision.dto';
import { StorageConfigResponseDto } from './dto/storage-config-response.dto';
import {
  StorageConnectionTestResultDto,
  TestStorageConfigDto,
} from './dto/storage-connection-test.dto';
import { UpdateStorageConfigDto } from './dto/update-storage-config.dto';

// =============================================================================
// StorageConfigController (issue #375, epic #372)
// =============================================================================
//
// The HTTP surface behind `/admin/settings/storage` (#376). Four operations:
//
//   GET  /api/admin/storage-config          storage_config:read
//   PUT  /api/admin/storage-config          storage_config:write
//   POST /api/admin/storage-config/test     storage_config:write
//   POST /api/admin/storage-config/bucket   storage_config:write
//
// -----------------------------------------------------------------------------
// `storage_config:*`, AND WHY IT IS NEITHER OF THE TWO PAIRS THAT ALREADY EXIST
// -----------------------------------------------------------------------------
//
// NOT `system_settings:*`: a wrong bucket, a wrong endpoint or a rotated-out
// secret does not degrade one feature, it breaks every upload, avatar, job
// artifact and database backup in the deployment at once — and immediately,
// because the configuration is resolved per call with no restart in between.
// That is the same "distinct blast radius" argument `nodes:*`, `db_backup:*`,
// `broadcasts:*` and `push:*` each made before it.
//
// NOT `storage:*`, which is the closer-looking mistake: that pair gates OBJECT
// ACCESS and is seeded to Viewer and Contributor, so every ordinary user of this
// application holds `storage:read`. Reusing it here would put the deployment's
// credential-bearing configuration screen in front of the entire user base.
//
// The Settings UI Pattern (CLAUDE.md rule 3) requires a hub card's `permission`
// to be the exact string its controller enforces, so #376's Storage card mirrors
// these two strings and nothing else. See `common/constants/roles.constants.ts`.
//
// -----------------------------------------------------------------------------
// THE TWO PROBES ARE GATED ON `:write`, NOT `:read`
// -----------------------------------------------------------------------------
//
// Both are side-effecting. `POST /test` writes a throwaway object into somebody
// else's bucket and asks a third-party endpoint to do work; `POST /bucket`
// creates infrastructure. `:read` is held by anyone who may LOOK at the
// configuration, and looking is not writing — the identical argument
// `EmailSettingsController` makes for its test send.
//
// -----------------------------------------------------------------------------
// ⚠ BOTH PROBES ANSWER 200 EVEN WHEN THE ANSWER IS BAD
// -----------------------------------------------------------------------------
//
// A refused `HeadBucket` and a credential without `s3:CreateBucket` are
// DIAGNOSES, not transport failures, and this app's error envelope would discard
// exactly the detail they exist to deliver (`HttpExceptionFilter` suppresses
// detail in production, and the web client funnels 4xx/5xx into generic failure
// handling). The outcome therefore travels in the body — `success` for the test,
// `outcome` for the bucket action — and a client that reads the status code
// instead reports success for every misconfiguration there is. See each DTO's
// header, and `email/dto/test-email-result.dto.ts`, which makes the argument
// first.
//
// -----------------------------------------------------------------------------
// A SEPARATE CONTROLLER, NOT ROUTES ON `SystemSettingsController`
// -----------------------------------------------------------------------------
//
// Same reasoning as `EmailSettingsController` and `PushConfigController`: this
// surface writes a credential and drives an object store, which the generic
// settings routes have no business doing, it enforces a different permission
// pair, and keeping it separate keeps the OpenAPI tag — and therefore the API
// reference — aligned with the settings page it backs.
// =============================================================================

@ApiTags('Storage Configuration')
@Controller('admin/storage-config')
export class StorageConfigController {
  constructor(
    private readonly storageConfig: StorageConfigAdminService,
    private readonly connectionTest: StorageConnectionTestService,
    private readonly bucketProvision: StorageBucketProvisionService,
  ) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.STORAGE_CONFIG_READ] })
  @ApiOperation({
    summary: 'Get the object-storage configuration (Admin only)',
    description:
      'Returns the `storage` settings namespace together with `secretStatus`, a masked, ' +
      'non-secret description of the stored secret access key. **The secret access key ' +
      'itself is never returned by this or any other endpoint** — it is held in the ' +
      'encrypted credential store and is unreadable through the API by design. ' +
      '`accessKeyId` IS returned: it is an identifier that travels in the clear in every ' +
      'signed request, and an administrator who cannot see it cannot tell a rotated key ' +
      'from a mistyped one.\n\n' +
      '`configured` is the single definition of "this deployment can store a file", ' +
      'answered by the same function the upload path asks; `missing` names every field ' +
      'standing in the way. `effectiveEndpoint` is read-only and is what an S3 client ' +
      "would actually be pointed at — for R2 that is derived from the account id, so a " +
      'settings page never has to build that host itself.',
  })
  @ApiResponse({
    status: 200,
    description: 'The storage configuration and the masked status of its stored secret',
    type: StorageConfigResponseDto,
  })
  async getConfig() {
    return this.storageConfig.describeForAdmin();
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.STORAGE_CONFIG_WRITE] })
  @ApiOperation({
    summary: 'Replace the object-storage configuration (Admin only)',
    description:
      'Full replace of the seven settings fields. `secretAccessKey` is **write-only**: ' +
      'send it to set or rotate the secret, and **omit it or send it empty to keep the ' +
      'stored one**. There is no way to erase a stored secret through this endpoint.\n\n' +
      'Sending an empty string for a text field CLEARS it — that is how an operator drops ' +
      'an endpoint override, or un-configures storage entirely by clearing `bucket`.\n\n' +
      '**`409` when the save would repoint a deployment that still holds objects.** ' +
      'Changing `provider`, `bucket` or the effective endpoint does NOT copy anything: ' +
      'existing objects and database-backup archives stay where they are and become ' +
      'unreachable. The 409 body names how many rows are affected; re-send with ' +
      '`{"confirmation":"SWITCH"}` to proceed. A first configuration, or one with nothing ' +
      'stored at the old location, needs no confirmation.',
  })
  @ApiHeader({
    name: 'If-Match',
    description:
      'Expected `version` for optimistic concurrency. Use `0` to assert that nothing is ' +
      'stored yet. Omit to overwrite unconditionally. Note this is the version of the ' +
      'whole system-settings row, so a concurrent save of an unrelated setting can cause ' +
      'a conflict — reload and re-apply.',
    required: false,
  })
  @ApiResponse({
    status: 200,
    description: 'The updated storage configuration',
    type: StorageConfigResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({
    status: 409,
    description:
      'Version conflict, or the save relocates storage and the `SWITCH` confirmation was ' +
      'missing',
  })
  async replaceConfig(
    @Body() dto: UpdateStorageConfigDto,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    // `Number.isInteger` rather than a bare `parseInt`, matching
    // `EmailSettingsController` and `PushConfigController`: `parseInt('abc')` is
    // `NaN`, and `NaN !== currentVersion` is always true, so a malformed header
    // would turn every save into a 409 that no amount of reloading fixes. An
    // unparseable `If-Match` is treated as absent instead, which is exactly what
    // the header's own "omit to overwrite unconditionally" semantics say.
    const parsed = ifMatch !== undefined ? Number.parseInt(ifMatch, 10) : NaN;
    const expectedVersion = Number.isInteger(parsed) ? parsed : undefined;

    return this.storageConfig.replace(dto, userId, expectedVersion);
  }

  @Post('test')
  @Auth({ permissions: [PERMISSIONS.STORAGE_CONFIG_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test an object-storage configuration (Admin only)',
    description:
      'Runs four checks against the configuration **in the request body**, which does not ' +
      'have to have been saved — so a new bucket can be proved before the deployment is ' +
      'committed to it. A blank `secretAccessKey` means "use the stored one".\n\n' +
      '**This returns HTTP 200 even when the configuration is broken.** A refused request ' +
      'is a successful diagnosis, and it is the reason this endpoint exists — read the ' +
      '`success` field. Treating 200 as "storage works" reports success for every ' +
      'misconfiguration there is.\n\n' +
      'Each check is reported separately, with a machine-readable `code`, because the ' +
      'ways this can fail need different fixes. In particular `bucket_missing` (404 — no ' +
      'such bucket, create it) and `bucket_forbidden` (403 — it exists and this key may ' +
      'not see it, so widen the policy or fix a typo that landed on somebody else’s ' +
      'bucket) are deliberately NOT collapsed together.\n\n' +
      'The round-trip check writes one small object under `storage-config-test/` and ' +
      'deletes it again.',
  })
  @ApiResponse({
    status: 200,
    description:
      'The outcome of the four checks. Check `success`; each entry in `checks` carries a ' +
      "`code`, an actionable `detail` and the provider's verbatim `error`.",
    type: StorageConnectionTestResultDto,
  })
  async testConfig(
    @Body() dto: TestStorageConfigDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.connectionTest.test(dto, userId);
  }

  @Post('bucket')
  @Auth({ permissions: [PERMISSIONS.STORAGE_CONFIG_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create and harden the configured bucket (Admin only)',
    description:
      'Creates the bucket named by the configuration **in the request body**, then applies ' +
      'the settings this application needs: all public access blocked and default ' +
      'encryption on (AWS S3 only — R2 buckets are private and encrypted by default), and ' +
      'a CORS rule allowing `PUT`/`GET`/`HEAD` from this deployment’s own origin **with ' +
      '`ExposeHeaders: ["ETag"]`**, which browser multipart uploads cannot complete ' +
      'without.\n\n' +
      'Every step reports its own outcome: a bucket that was created but could not be ' +
      'hardened answers `outcome: "partial"` and says which step failed, rather than ' +
      'reporting a success that hides it.\n\n' +
      '**A credential without `s3:CreateBucket` answers `200` with `outcome: "guided"`** ' +
      'and a ready-to-paste command block with this deployment’s real values in it — ' +
      'never a 4xx. A least-privilege credential that cannot create buckets is the ' +
      'ordinary configuration, not a fault.\n\n' +
      'Safe to repeat: a bucket that already exists and belongs to this account is left ' +
      'alone and the hardening steps still run, which is also the repair path for a bucket ' +
      'created by hand without a CORS rule.',
  })
  @ApiResponse({
    status: 200,
    description:
      'The per-step outcome. Read `outcome`; `guided` carries `guidance.commands` and is ' +
      'not an error.',
    type: StorageBucketProvisionResultDto,
  })
  async provisionBucket(
    @Body() dto: ProvisionStorageBucketDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.bucketProvision.provision(dto, userId);
  }
}
