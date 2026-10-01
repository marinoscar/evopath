import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import { AdminReleaseDto, AdminReleaseListDto } from '../dto/android-release.dto';
import {
  APK_FILE_FIELD,
  DEFAULT_ANDROID_PACKAGE_NAME,
  MAX_APK_BYTES,
  MAX_RELEASE_NOTES_LENGTH,
  MAX_VERSION_CODE,
  MAX_VERSION_NAME_LENGTH,
} from './android-release.constants';
import { AndroidReleaseService } from './android-release.service';

// =============================================================================
// /api/admin/android-app/releases — hosted APKs (issue #285, epic #276)
// =============================================================================
//
//   POST   /api/admin/android-app/releases                    system_settings:write
//   GET    /api/admin/android-app/releases                    system_settings:read
//   POST   /api/admin/android-app/releases/:id/make-current   system_settings:write
//   DELETE /api/admin/android-app/releases/:id                system_settings:write
//
// The same strings as the rest of the Android app settings page
// (`android-app.controller.ts`), so the admin card's permission stays exact.
// =============================================================================

const MAX_MB = MAX_APK_BYTES / (1024 * 1024);
const RELEASE_ID_PARAM = { name: 'id', type: String, format: 'uuid', description: 'The release id.' } as const;
const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const NO_READ = { status: 403, description: 'Missing system_settings:read', type: ErrorDto } as const;
const NO_WRITE = { status: 403, description: 'Missing system_settings:write', type: ErrorDto } as const;
const NOT_FOUND = { status: 404, description: '`RELEASE_NOT_FOUND`', type: ErrorDto } as const;

@ApiTags('Android App')
@Controller('admin/android-app/releases')
export class AndroidReleaseAdminController {
  constructor(private readonly releases: AndroidReleaseService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Upload an Android APK release (Admin only)',
    description:
      `Multipart upload: the APK in the \`${APK_FILE_FIELD}\` file field plus text fields \`packageName\`, ` +
      '`versionName`, `versionCode`, `signingSha256` and optional `notes`, `makeCurrent` (default `true`) and ' +
      '`force` (default `false`). Send the text fields before the file to be refused before any byte is stored. ' +
      `The file is streamed to object storage (never buffered), must start with the ZIP signature and be at most ` +
      `${MAX_MB} MB; its SHA-256 and size are computed while it streams. \`versionCode\` is an integer 1..` +
      `${MAX_VERSION_CODE}, \`versionName\` at most ${MAX_VERSION_NAME_LENGTH} characters of ` +
      '`[0-9A-Za-z._+-]`, `notes` at most ' +
      `${MAX_RELEASE_NOTES_LENGTH} characters, \`signingSha256\` the signing certificate SHA-256 (colon-separated ` +
      'or 64 hex digits, stored uppercase colon-separated).\n\n' +
      'Refusals (`details.reason`): `RELEASE_NOT_AN_APK`, `RELEASE_INVALID_UPLOAD` (400); `RELEASE_TOO_LARGE` ' +
      '(413); `RELEASE_VERSION_EXISTS` (409, that package and versionCode exist); `RELEASE_VERSION_NOT_NEWER` ' +
      '(409, making it current would not raise the current release\'s versionCode for the same package; send ' +
      '`force=true` to override); `RELEASE_CURRENT_CONFLICT` (409, a concurrent make-current). 503 when object ' +
      'storage is not configured.\n\n' +
      'Made current, the release\'s (packageName, signingSha256) is added to the trusted Android apps ' +
      '(`/.well-known/assetlinks.json`) when absent. Audited (`android_app.release.uploaded`).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: [APK_FILE_FIELD, 'packageName', 'versionName', 'versionCode', 'signingSha256'],
      properties: {
        packageName: { type: 'string', example: DEFAULT_ANDROID_PACKAGE_NAME },
        versionName: { type: 'string', example: '0.1.0' },
        versionCode: { type: 'integer', example: 1 },
        signingSha256: { type: 'string', description: 'AA:BB:… (32 bytes)' },
        notes: { type: 'string' },
        makeCurrent: { type: 'boolean', default: true },
        force: { type: 'boolean', default: false },
        [APK_FILE_FIELD]: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiDataResponse(AdminReleaseDto, { status: 201, description: 'The stored release' })
  @ApiResponse({ status: 400, description: '`RELEASE_NOT_AN_APK`, `RELEASE_INVALID_UPLOAD`', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse({
    status: 409,
    description: '`RELEASE_VERSION_EXISTS`, `RELEASE_VERSION_NOT_NEWER`, `RELEASE_CURRENT_CONFLICT`',
    type: ErrorDto,
  })
  @ApiResponse({ status: 413, description: `\`RELEASE_TOO_LARGE\` (over ${MAX_MB} MB)`, type: ErrorDto })
  @ApiResponse({ status: 503, description: 'Object storage is not configured', type: ErrorDto })
  async upload(@Req() req: FastifyRequest, @CurrentUser('id') userId: string) {
    if (!req.isMultipart()) {
      throw new BadRequestException({
        message: `Expected multipart/form-data with the APK in the "${APK_FILE_FIELD}" field.`,
        details: { reason: 'RELEASE_INVALID_UPLOAD' },
      });
    }

    await this.releases.assertStorageWritable();

    // The plugin's own `fileSize` (100 MB or less) is replaced for this route.
    // An over-limit file is reported by `ApkInspector` (413), whatever the
    // plugin's `throwFileSizeLimit` default.
    const parts = req.parts({
      limits: { fileSize: MAX_APK_BYTES, files: 1, fields: 16, fieldSize: 16 * 1024 },
    });
    return this.releases.upload(parts, userId);
  }

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'List Android APK releases (Admin only)',
    description: 'Every uploaded release, newest first; `isCurrent` marks the one users are offered.',
  })
  @ApiResponse({ status: 200, description: '`{ data: Release[] }`', type: AdminReleaseListDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  list() {
    return this.releases.list();
  }

  @Post(':id/make-current')
  @HttpCode(HttpStatus.OK)
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Make an Android release current (Admin only)',
    description:
      'Offers this release to users and devices; the previous current release stops being current in the same ' +
      'transaction. Any release may be made current, a lower versionCode included (a rollback: devices already ' +
      'on a newer build cannot install it, Android refuses downgrades). Adds the release\'s signing key to the ' +
      'trusted Android apps when absent. Idempotent. `RELEASE_CURRENT_CONFLICT` (409) when a concurrent ' +
      'make-current won. Audited (`android_app.release.made_current`).',
  })
  @ApiParam(RELEASE_ID_PARAM)
  @ApiDataResponse(AdminReleaseDto, { description: 'The release, now current' })
  @ApiResponse({ status: 400, description: 'The id is not a UUID', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: '`RELEASE_CURRENT_CONFLICT`', type: ErrorDto })
  makeCurrent(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string) {
    return this.releases.makeCurrent(id, userId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Delete an Android release (Admin only)',
    description:
      'Deletes the stored APK, then the release. The current release cannot be deleted ' +
      '(`RELEASE_IS_CURRENT`, 409). 503 when object storage is not configured (nothing is deleted). Audited ' +
      '(`android_app.release.deleted`).',
  })
  @ApiParam(RELEASE_ID_PARAM)
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 400, description: 'The id is not a UUID', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: '`RELEASE_IS_CURRENT`', type: ErrorDto })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string): Promise<void> {
    await this.releases.remove(id, userId);
  }
}
