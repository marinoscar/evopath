import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '@marinoscar/platform-api/core';
import {
  DeleteHealthDocumentQueryDto,
  DOWNLOAD_DISPOSITIONS,
  DownloadHealthDocumentQueryDto,
  HEALTH_DOCUMENT_PAGE_SIZE_DEFAULT,
  HEALTH_DOCUMENT_PAGE_SIZE_MAX,
  HEALTH_DOCUMENT_SORTS,
  HealthDocumentDeleteResultDto,
  HealthDocumentDownloadDto,
  HealthDocumentDto,
  ListHealthDocumentsQueryDto,
  SORT_ORDERS,
  UpdateHealthDocumentDto,
} from './dto/health-document.dto';
import { HEALTH_DOCUMENT_DOWNLOAD_TTL_SECONDS, HEALTH_DOCUMENT_KINDS } from './health-document.constants';
import { documentEtag, HealthDocumentsService, requireDocumentVersion } from './health-documents.service';

// =============================================================================
// /api/health/documents — the caller's health documents (H6, #190)
// =============================================================================
//
// Owner-scoped: every route acts on the JWT user's documents only, and another
// user's (or an unknown) id is a 404, never a 403. Reads need
// `health_data:read`, writes `health_data:write`, the same strings the
// Health Documents settings card declares. PATCH and DELETE require
// `If-Match: <version>`; a stale one is a 412.
// =============================================================================

const ID_PARAM = { name: 'id', type: String, format: 'uuid', description: 'The health document id.' } as const;

const RESPONSES = {
  BAD_ID: { status: 400, description: 'Validation error, or the id is not a UUID', type: ErrorDto },
  UNAUTHENTICATED: { status: 401, description: 'Not authenticated', type: ErrorDto },
  NO_READ: { status: 403, description: 'Missing health_data:read', type: ErrorDto },
  NO_WRITE: { status: 403, description: 'Missing health_data:write', type: ErrorDto },
  NOT_FOUND: { status: 404, description: 'The caller has no health document with this id', type: ErrorDto },
  STALE: {
    status: 412,
    description:
      '`details.reason: HEALTH_DOCUMENT_STALE` (with `currentVersion`): the document changed since it was loaded.',
    type: ErrorDto,
  },
} as const;

const IF_MATCH_HEADER = {
  name: 'If-Match',
  required: true,
  description:
    'The document `version` the change is based on (bare `4` or the ETag `"4"`). Missing or unparseable: 400 ' +
    '`details.reason: IF_MATCH_REQUIRED`.',
} as const;

const { BAD_ID, UNAUTHENTICATED, NO_READ, NO_WRITE, NOT_FOUND, STALE } = RESPONSES;

@ApiTags('Health Documents')
@Controller('health/documents')
export class HealthDocumentsController {
  constructor(private readonly documents: HealthDocumentsService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @ApiOperation({
    summary: 'List health documents',
    description:
      'The files the caller handed a health intake (scale photos, lab reports), kept or erased, with the count ' +
      'of active values read from each. A document whose file was erased stays listed as metadata only ' +
      '(`fileAvailable: false`, `fileDeletedAt`). Newest upload first by default.',
  })
  @ApiQuery({ name: 'kind', required: false, enum: HEALTH_DOCUMENT_KINDS })
  @ApiQuery({ name: 'sort', required: false, enum: HEALTH_DOCUMENT_SORTS })
  @ApiQuery({ name: 'order', required: false, enum: SORT_ORDERS })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    type: Number,
    description: `Default ${HEALTH_DOCUMENT_PAGE_SIZE_DEFAULT}, max ${HEALTH_DOCUMENT_PAGE_SIZE_MAX}.`,
  })
  @ApiDataResponse(HealthDocumentDto, { pagination: 'flat', description: 'Paginated health documents' })
  @ApiResponse({ status: 400, description: 'Invalid filter, sort or pagination', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  list(@CurrentUser('id') userId: string, @Query() query: ListHealthDocumentsQueryDto) {
    return this.documents.list(userId, query);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @ApiOperation({
    summary: 'Get a health document',
    description: 'One document, as listed. `ETag` is `"<version>"`; send it back as `If-Match`.',
  })
  @ApiParam(ID_PARAM)
  @ApiDataResponse(HealthDocumentDto, { description: 'The document' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  @ApiResponse(NOT_FOUND)
  async get(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const document = await this.documents.get(userId, id);
    reply.header('ETag', documentEtag(document.version));
    return document;
  }

  @Get(':id/download')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @ApiOperation({
    summary: 'Get a download link for a health document',
    description:
      `A signed URL for the file, valid ${HEALTH_DOCUMENT_DOWNLOAD_TTL_SECONDS} seconds. The storage provider ` +
      'serves it with a `Content-Disposition` carrying the document name (ASCII fallback plus RFC 5987 ' +
      '`filename*`). Fetch it right away; do not store it. 409 `details.reason`: ' +
      '`HEALTH_DOCUMENT_FILE_DELETED` (the file was erased), `HEALTH_DOCUMENT_FILE_DELETION_PENDING` (being ' +
      'erased) or `HEALTH_DOCUMENT_FILE_NOT_READY`.',
  })
  @ApiParam(ID_PARAM)
  @ApiQuery({ name: 'disposition', required: false, enum: DOWNLOAD_DISPOSITIONS })
  @ApiDataResponse(HealthDocumentDownloadDto, { description: 'The signed link' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: 'The file is not available (see `details.reason`)', type: ErrorDto })
  async download(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DownloadHealthDocumentQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // The body carries a bearer-like URL: never cache it.
    reply.header('Cache-Control', 'no-store');
    return this.documents.downloadLink(userId, id, query.disposition);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_WRITE] })
  @ApiOperation({
    summary: 'Rename a health document or set its date',
    description:
      'Changes `originalName` (sanitised) and/or `documentDate` (`null` clears it). Requires `If-Match`. ' +
      'Returns the document with its new `version` and `ETag`.',
  })
  @ApiParam(ID_PARAM)
  @ApiHeader(IF_MATCH_HEADER)
  @ApiDataResponse(HealthDocumentDto, { description: 'The updated document' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse(STALE)
  async update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: UpdateHealthDocumentDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const expectedVersion = requireDocumentVersion(ifMatch);
    const document = await this.documents.update(userId, id, expectedVersion, dto);
    reply.header('ETag', documentEtag(document.version));
    return document;
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a health document',
    description:
      'When the file still exists, queues its deletion (`scope: file`); the document stays as a record, and ' +
      'its values stay unless `deleteValues=true`. When the file is already gone, removes the record ' +
      '(`scope: record`); values that named it then report `fileDeleted: true`. With `deleteValues=true` the ' +
      "document's active values are soft-deleted in the same transaction. Requires `If-Match`. Audited as " +
      '`health:document:delete`.',
  })
  @ApiParam(ID_PARAM)
  @ApiHeader(IF_MATCH_HEADER)
  @ApiQuery({ name: 'deleteValues', required: false, enum: ['true', 'false'] })
  @ApiDataResponse(HealthDocumentDeleteResultDto, { description: 'What was deleted' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse(STALE)
  remove(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Query() query: DeleteHealthDocumentQueryDto,
  ) {
    const expectedVersion = requireDocumentVersion(ifMatch);
    return this.documents.remove(userId, id, expectedVersion, { deleteValues: query.deleteValues });
  }
}
