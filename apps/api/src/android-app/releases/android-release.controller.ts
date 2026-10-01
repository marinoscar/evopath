import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import { DownloadLinkDto, PublicReleaseDto } from '../dto/android-release.dto';
import { APK_MIME_TYPE, DOWNLOAD_LINK_TTL_SECONDS, apkFileName } from './android-release.constants';
import { AndroidReleaseService } from './android-release.service';

// =============================================================================
// /api/android-app — the hosted APK for users (issue #285, epic #276)
// =============================================================================
//
//   GET  /api/android-app/releases/latest              any signed-in user
//   POST /api/android-app/releases/:id/download-link   any signed-in user
//   GET  /api/android-app/download/:token              public, token-validated
//
// The download is PUBLIC because it must be a plain navigable URL: Chrome and
// the Android app's Trusted Web Activity hand an APK navigation to the system
// downloader, which sends no Authorization header. The signed, ten-minute token
// in the path is the authorization (`download-token.ts`).
//
// NOT exempt from maintenance mode: like every other user route, a window
// blocks it (503). `@Res()` takes the reply over, so the bytes are never
// wrapped in the `{ data }` envelope.
// =============================================================================

@ApiTags('Android App')
@Controller('android-app')
export class AndroidReleaseController {
  constructor(private readonly releases: AndroidReleaseService) {}

  @Get('releases/latest')
  @Auth()
  @ApiOperation({
    summary: 'Get the current Android app release',
    description:
      'The release this server offers (version, size, SHA-256, notes). 404 `NO_RELEASE` when none is published. ' +
      'Compare `versionCode` with the installed app\'s to offer an update.',
  })
  @ApiDataResponse(PublicReleaseDto)
  @ApiResponse({ status: 401, description: 'Not authenticated', type: ErrorDto })
  @ApiResponse({ status: 404, description: '`NO_RELEASE`', type: ErrorDto })
  latest() {
    return this.releases.latest();
  }

  @Post('releases/:id/download-link')
  @HttpCode(HttpStatus.OK)
  @Auth()
  @ApiOperation({
    summary: 'Create a download link for an Android release',
    description:
      `A same-origin URL (\`/api/android-app/download/<token>\`) valid for ${DOWNLOAD_LINK_TTL_SECONDS / 60} ` +
      'minutes. Navigate to it (no Authorization header needed) so the browser or the Android installer ' +
      'downloads the APK natively. 404 `RELEASE_NOT_FOUND`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'The release id.' })
  @ApiDataResponse(DownloadLinkDto)
  @ApiResponse({ status: 400, description: 'The id is not a UUID', type: ErrorDto })
  @ApiResponse({ status: 401, description: 'Not authenticated', type: ErrorDto })
  @ApiResponse({ status: 404, description: '`RELEASE_NOT_FOUND`', type: ErrorDto })
  downloadLink(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string) {
    return this.releases.createDownloadLink(id, userId);
  }

  @Get('download/:token')
  @Public()
  @ApiOperation({
    summary: 'Download an Android APK (signed link)',
    description:
      'Streams the APK named by a link from `POST /api/android-app/releases/{id}/download-link`: ' +
      `\`Content-Type: ${APK_MIME_TYPE}\`, \`Content-Disposition: attachment; ` +
      `filename="${apkFileName('<versionName>')}"\`, \`Content-Length\`. ` +
      '404 `DOWNLOAD_LINK_INVALID` for a ' +
      'malformed or tampered token (or a deleted release or deactivated user); 410 `DOWNLOAD_LINK_EXPIRED` ' +
      'once the link has expired.',
  })
  @ApiParam({ name: 'token', type: String, description: 'The signed token from the download link.' })
  @ApiProduces(APK_MIME_TYPE)
  @ApiResponse({
    status: 200,
    description: 'The APK bytes',
    content: { [APK_MIME_TYPE]: { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse({ status: 404, description: '`DOWNLOAD_LINK_INVALID`', type: ErrorDto })
  @ApiResponse({ status: 410, description: '`DOWNLOAD_LINK_EXPIRED`', type: ErrorDto })
  async download(@Param('token') token: string, @Res() reply: FastifyReply) {
    const download = await this.releases.openDownload(token);

    return reply
      .status(200)
      .header('Content-Type', APK_MIME_TYPE)
      .header('Content-Disposition', `attachment; filename="${download.fileName}"`)
      .header('Content-Length', String(download.sizeBytes))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .send(download.stream);
  }
}
