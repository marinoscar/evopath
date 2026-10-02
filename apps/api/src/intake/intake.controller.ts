import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AiEnabledGuard } from '../ai/config/ai-enabled.guard';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../common/dto/error.dto';
import {
  AcceptAllItemsDto,
  AnalyzeIntakeDto,
  AttachPhotoDto,
  CreateDraftItemDto,
  CreateIntakeDto,
  DraftItemView,
  INTAKE_LIST_LIMIT_DEFAULT,
  INTAKE_LIST_LIMIT_MAX,
  IntakeAnalyzeStarted,
  ListIntakesQueryDto,
  PhotoIntakePhotoView,
  PhotoIntakeSummary,
  PhotoIntakeView,
  UpdateDraftItemDto,
  UpdateIntakeDto,
} from './dto/intake.dto';
import { IntakeService } from './intake.service';

// =============================================================================
// /api/intakes — the caller's photo intakes (E3.1)
// =============================================================================
//
// Owner-scoped: every route acts on the JWT user's intakes only; another
// user's intake (or an item or photo under it) is a 404, never a 403.
// Refusal reasons are in `details.reason`.
//
// Two controllers on one prefix: `IntakeAnalyzeController` carries
// `AiEnabledGuard` at CLASS level (the kill switch answers before auth, as on
// every `/api/ai/*` controller), and nothing else in this module may sit
// behind it — the manual path works with AI off.
// =============================================================================

const ID_PARAM = { name: 'id', type: String, format: 'uuid', description: 'The intake id.' } as const;
const ITEM_PARAM = { name: 'itemId', type: String, format: 'uuid' } as const;
const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const NO_READ = {
  status: 403,
  description: "Missing intakes:read, or a permission the intake's kind requires (`details.reason: MISSING_KIND_PERMISSIONS`)",
  type: ErrorDto,
} as const;
const NO_WRITE = {
  status: 403,
  description: "Missing intakes:write, or a permission the intake's kind requires (`details.reason: MISSING_KIND_PERMISSIONS`)",
  type: ErrorDto,
} as const;
const NOT_FOUND = { status: 404, description: 'No intake with this id for the caller', type: ErrorDto } as const;
const STATE_CONFLICT = {
  status: 409,
  description: 'The intake status forbids this (`details.reason`: `ALREADY_APPLIED`, `INTAKE_SCANNING`, `INVALID_INTAKE_STATUS`)',
  type: ErrorDto,
} as const;

@ApiTags('Intakes')
@Controller('intakes')
export class IntakesController {
  constructor(private readonly intakes: IntakeService) {}

  @Post()
  @Auth({ permissions: [PERMISSIONS.INTAKES_WRITE] })
  @ApiOperation({
    summary: 'Start a photo intake',
    description:
      'Creates a `draft` intake of a registered `kind`. `context` is validated by the kind (for ' +
      'example that the gym it names is yours; a foreign id is a 404). `retainFiles` (default `true`) ' +
      'is the keep-or-delete choice for the files of a health intake kind.',
  })
  @ApiDataResponse(PhotoIntakeView, { status: 201, description: 'The new intake' })
  @ApiResponse({
    status: 400,
    description: 'Validation error, or `details.reason: UNKNOWN_INTAKE_KIND`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateIntakeDto) {
    return this.intakes.create(user.id, dto, user.permissions);
  }

  @Get()
  @Auth({ permissions: [PERMISSIONS.INTAKES_READ] })
  @ApiOperation({
    summary: 'List my photo intakes',
    description:
      'The caller\'s intakes, newest first, without photos and items (counts only); used to resume ' +
      'an unfinished intake.',
  })
  @ApiQuery({ name: 'kind', required: false, type: String })
  @ApiQuery({ name: 'subjectId', required: false, type: String, format: 'uuid' })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description: 'One status or a comma list: `draft`, `scanning`, `ready`, `applied`, `failed`.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: `Default ${INTAKE_LIST_LIMIT_DEFAULT}, max ${INTAKE_LIST_LIMIT_MAX}.`,
  })
  @ApiDataResponse(PhotoIntakeSummary, { isArray: true, description: 'The caller\'s intakes' })
  @ApiResponse({ status: 400, description: 'Invalid filter', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  list(@CurrentUser() user: RequestUser, @Query() query: ListIntakesQueryDto) {
    return this.intakes.list(user.id, query, user.permissions);
  }

  // ---------------------------------------------------------------------------
  // Parameterised routes
  // ---------------------------------------------------------------------------

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.INTAKES_READ] })
  @ApiOperation({
    summary: 'Get a photo intake',
    description: 'The intake with its photos and every draft item (rejected ones included), in `sortOrder`.',
  })
  @ApiParam(ID_PARAM)
  @ApiDataResponse(PhotoIntakeView, { description: 'The intake' })
  @ApiResponse({ status: 400, description: 'id is not a UUID', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  @ApiResponse(NOT_FOUND)
  get(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.intakes.get(user.id, id, user.permissions);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.INTAKES_WRITE] })
  @ApiOperation({
    summary: 'Change a photo intake\'s context or file retention',
    description:
      'Replaces `context` (for example a source hint the analyzer reads) in `draft`, `ready` or ' +
      '`failed`. The kind validates it as on create; photos and items are untouched. `retainFiles` ' +
      'changes the keep-or-delete choice of the intake and of every file already attached; a body ' +
      'with only `retainFiles` leaves `context` as it is.',
  })
  @ApiParam(ID_PARAM)
  @ApiDataResponse(PhotoIntakeView, { description: 'The intake' })
  @ApiResponse({ status: 400, description: 'Validation error (`details.issues`, prefixed `context`)', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse(STATE_CONFLICT)
  updateContext(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateIntakeDto,
  ) {
    return this.intakes.updateContext(user.id, id, dto, user.permissions);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.INTAKES_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Discard a photo intake',
    description:
      'Deletes the intake, its photo links and its draft items; allowed unless `applied`. Each of ' +
      'its storage objects that no other intake links is deleted too (best effort).',
  })
  @ApiParam(ID_PARAM)
  @ApiResponse({ status: 204, description: 'Discarded' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: '`details.reason: ALREADY_APPLIED`', type: ErrorDto })
  async discard(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.intakes.discard(user.id, id, user.permissions);
  }

  @Post(':id/photos')
  @Auth({ permissions: [PERMISSIONS.INTAKES_WRITE] })
  @ApiOperation({
    summary: 'Attach a photo',
    description:
      'Links one of your `ready` storage objects to the intake, while it is `draft`, `ready` or `failed`: ' +
      'a PNG, JPEG, GIF or WebP image of at most 20 MiB, or, for a kind that accepts PDFs ' +
      '(`body_metric_reading`, `lab_report`), a PDF of at most 50 MiB and 20 pages. The stored bytes are read back: ' +
      'their magic bytes must match the declared type. At most the kind\'s photo cap (default 48); ' +
      'a PDF counts as one.',
  })
  @ApiParam(ID_PARAM)
  @ApiDataResponse(PhotoIntakePhotoView, { status: 201, description: 'The attached photo' })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, or `details.reason`: `OBJECT_NOT_READY`, `UNSUPPORTED_MEDIA_TYPE` ' +
      '(`details.contentMismatch` when the bytes do not match the type), `OBJECT_TOO_LARGE`, ' +
      '`TOO_MANY_PAGES` (`details.pages`, `details.maxPages`), `PDF_UNREADABLE`, `TOO_MANY_PHOTOS`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse({ status: 404, description: 'No such intake, or no such storage object of yours', type: ErrorDto })
  @ApiResponse({
    status: 409,
    description: '`details.reason`: `DUPLICATE_PHOTO`, or the intake status forbids it',
    type: ErrorDto,
  })
  attachPhoto(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AttachPhotoDto,
  ) {
    return this.intakes.attachPhoto(user.id, id, dto.storageObjectId, user.permissions, {
      retainFiles: dto.retainFiles,
    });
  }

  @Delete(':id/photos/:storageObjectId')
  @Auth({ permissions: [PERMISSIONS.INTAKES_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a photo',
    description:
      'Unlinks the photo (not while `scanning` or once `applied`) and deletes the storage object ' +
      'when no other intake links it (best effort). Draft items keep listing its id.',
  })
  @ApiParam(ID_PARAM)
  @ApiParam({ name: 'storageObjectId', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Removed' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse({ status: 404, description: 'No such intake, or the photo is not attached', type: ErrorDto })
  @ApiResponse(STATE_CONFLICT)
  async detachPhoto(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('storageObjectId', ParseUUIDPipe) storageObjectId: string,
  ): Promise<void> {
    await this.intakes.detachPhoto(user.id, id, storageObjectId, user.permissions);
  }

  @Post(':id/items')
  @Auth({ permissions: [PERMISSIONS.INTAKES_WRITE] })
  @ApiOperation({
    summary: 'Add an item yourself',
    description:
      'Adds a user item: `origin: user`, `status: accepted`, `userVerified: true`, ' +
      '`confidence: null`. `value` is validated by the intake kind.',
  })
  @ApiParam(ID_PARAM)
  @ApiDataResponse(DraftItemView, { status: 201, description: 'The new item' })
  @ApiResponse({ status: 400, description: 'Validation error; `details.issues` names each field', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse(STATE_CONFLICT)
  addItem(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateDraftItemDto,
  ) {
    return this.intakes.addItem(user.id, id, dto, user.permissions);
  }

  @Post(':id/items/accept-all')
  @Auth({ permissions: [PERMISSIONS.INTAKES_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept every pending item, or only the high-confidence ones',
    description:
      'Every `pending` item becomes `accepted` and `userVerified`. With the optional body ' +
      '`{ "only": "high_confidence" }`, only the pending items with `confidence: high` and ' +
      '`uncertain: false` are accepted; the rest stay pending. An absent or empty body accepts every ' +
      'pending item. Works for every intake kind. Returns the items it changed.',
  })
  @ApiParam(ID_PARAM)
  @ApiBody({ type: AcceptAllItemsDto, required: false })
  @ApiDataResponse(DraftItemView, { isArray: true, description: 'The items that were accepted' })
  @ApiResponse({ status: 400, description: 'Validation error: an unknown `only` filter or an extra key', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse(STATE_CONFLICT)
  acceptAll(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptAllItemsDto,
  ) {
    return this.intakes.acceptAll(user.id, id, user.permissions, dto);
  }

  @Patch(':id/items/:itemId')
  @Auth({ permissions: [PERMISSIONS.INTAKES_WRITE] })
  @ApiOperation({
    summary: 'Edit, accept, reject or restore an item',
    description:
      'A `value` edit is validated by the intake kind and sets `userVerified`; the FIRST value edit ' +
      'of an AI item keeps the previous value in `originalAiValue`, which is never overwritten. ' +
      '`status: accepted` sets `userVerified`; `rejected` keeps the row; `pending` restores it. ' +
      'Last write wins; the full item is returned.',
  })
  @ApiParam(ID_PARAM)
  @ApiParam(ITEM_PARAM)
  @ApiDataResponse(DraftItemView, { description: 'The item as it now stands' })
  @ApiResponse({ status: 400, description: 'Validation error; `details.issues` names each field', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse({ status: 404, description: 'No such intake or item for the caller', type: ErrorDto })
  @ApiResponse(STATE_CONFLICT)
  updateItem(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateDraftItemDto,
  ) {
    return this.intakes.updateItem(user.id, id, itemId, dto, user.permissions);
  }

  @Delete(':id/items/:itemId')
  @Auth({ permissions: [PERMISSIONS.INTAKES_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an item you added',
    description:
      'Hard-deletes a user item. An AI item answers 409 `details.reason: USE_REJECT`: reject it ' +
      'instead, so its provenance survives.',
  })
  @ApiParam(ID_PARAM)
  @ApiParam(ITEM_PARAM)
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse({ status: 404, description: 'No such intake or item for the caller', type: ErrorDto })
  @ApiResponse({
    status: 409,
    description: '`details.reason`: `USE_REJECT` (an AI item), or the intake status forbids it',
    type: ErrorDto,
  })
  async deleteItem(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): Promise<void> {
    await this.intakes.deleteItem(user.id, id, itemId, user.permissions);
  }

  @Post(':id/apply')
  @Auth({ permissions: [PERMISSIONS.INTAKES_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply the accepted items',
    description:
      'Writes the accepted items as real data through the intake kind, in one transaction, and ' +
      'marks the intake `applied`. Needs no `pending` item left; works on a `ready` intake and, for ' +
      'the manual path, a `draft` or `failed` one. A failure rolls everything back. The response ' +
      '`data` is the kind\'s own result.',
  })
  @ApiParam(ID_PARAM)
  @ApiOkResponse({
    description: "The kind's result, in the `{ data }` envelope",
    schema: { type: 'object', required: ['data'], properties: { data: {} } },
  })
  @ApiResponse({
    status: 400,
    description: '`details.reason: PENDING_ITEMS` with `details.count`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    ...STATE_CONFLICT,
    description:
      STATE_CONFLICT.description +
      '; or, for a `lab_report` intake, `UNRESOLVED_ANALYTES` with `details.itemIds`: accepted results not matched ' +
      'to a catalog analyte, each to be mapped (an edit setting `value.analyteKey`) or rejected first',
  })
  apply(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.intakes.apply(user.id, id, user.permissions);
  }
}

@ApiTags('Intakes')
@Controller('intakes')
@UseGuards(AiEnabledGuard)
export class IntakeAnalyzeController {
  constructor(private readonly intakes: IntakeService) {}

  @Post(':id/analyze')
  @Auth({ permissions: [PERMISSIONS.INTAKES_WRITE, PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Analyze the photos with AI',
    description:
      'Queues the intake kind\'s analyzer job and answers **202** at once; poll ' +
      '`GET /api/intakes/{id}` until the status leaves `scanning`. Needs at least one photo and a ' +
      'kind with an analyzer. A `failed` intake may be analyzed again.\n\n' +
      'The model is chosen by the administrator, not the client: the assignment for the kind\'s AI ' +
      'feature (see `GET /api/ai/features`), else the administrator\'s default, else an automatic ' +
      'pick among your usable vision models. Send an empty JSON object (`{}`). `provider`/`modelId`, if sent, ' +
      'must equal the resolved model, else **409** `AI_MODEL_ASSIGNMENT_LOCKED` (`details.provider`, ' +
      '`details.modelId` name the resolved one). No usable model is **409** `AI_FEATURE_UNAVAILABLE` ' +
      '(`details.featureId`, `details.state`, `details.fix`).\n\n' +
      'AI refusals carry the code in `details.reason`: `AI_DISABLED`, `AI_PROVIDER_DISABLED`, ' +
      '`AI_MODEL_NOT_ENABLED`, `AI_KEY_REQUIRED`, `AI_MODEL_NOT_REACHABLE` (403); ' +
      '`AI_CAPABILITY_UNSUPPORTED` (400). With a PDF attached the model also needs `file_input`; ' +
      'without it the 400 carries `details.capability: file_input` and `details.inputKind: pdf`, and ' +
      'nothing is queued. Each attached file is re-checked first (type, size, a PDF\'s magic bytes and pages).',
  })
  @ApiParam(ID_PARAM)
  @ApiDataResponse(IntakeAnalyzeStarted, { status: 202, description: 'The analysis was queued' })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, `AI_CAPABILITY_UNSUPPORTED`, or `details.reason`: `NO_PHOTOS`, `MANUAL_ONLY_KIND`, ' +
      '`UNSUPPORTED_MEDIA_TYPE`, `OBJECT_TOO_LARGE`, `TOO_MANY_PAGES`, `PDF_UNREADABLE`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse({
    status: 403,
    description:
      '`AI_DISABLED`, `AI_PROVIDER_DISABLED`, `AI_MODEL_NOT_ENABLED`, `AI_KEY_REQUIRED`, ' +
      '`AI_MODEL_NOT_REACHABLE`, or missing `intakes:write` / `ai:use`',
    type: ErrorDto,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      'Already `scanning` or `applied`, or the model is unavailable or locked (`details.reason`: ' +
      '`INTAKE_SCANNING`, `ALREADY_APPLIED`, `AI_FEATURE_UNAVAILABLE`, `AI_MODEL_ASSIGNMENT_LOCKED`)',
    type: ErrorDto,
  })
  analyze(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnalyzeIntakeDto,
  ) {
    return this.intakes.analyze(user.id, id, dto, user.permissions);
  }
}
