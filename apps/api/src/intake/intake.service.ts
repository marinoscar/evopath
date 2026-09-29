import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DraftItem, PhotoIntake, Prisma } from '@prisma/client';
import { z } from 'zod';

import {
  AI_STORAGE_INPUT_IMAGE_MAX_BYTES,
  AI_STORAGE_INPUT_IMAGE_MIME_TYPES,
} from '../ai/core/types/file-inputs.types';
import { UsableModelsService } from '../ai/keys/usable-models.service';
import { isActiveDedupConflict, JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { mimeTypeMatches } from '../storage/mime-type-match';
import { ObjectsService } from '../storage/objects/objects.service';
import {
  DEFAULT_INTAKE_MAX_PHOTOS,
  DRAFT_ITEM_CONFIDENCES,
  type AiDraftInput,
  type DraftItemStatus,
  type IntakeKind,
  type IntakeStatus,
} from './intake-kind.interface';
import { IntakeKindRegistry } from './intake-kind.registry';
import { StorageObjectReferences } from './storage-object-references';
import {
  INTAKE_ERROR_MESSAGE_MAX,
  type AnalyzeIntakeInput,
  type CreateDraftItemInput,
  type CreateIntakeInput,
  type DraftItemViewData,
  type IntakeAnalyzeStartedData,
  type ListIntakesQuery,
  type PhotoIntakePhotoViewData,
  type PhotoIntakeSummaryData,
  type PhotoIntakeViewData,
  type UpdateDraftItemInput,
} from './dto/intake.dto';

// =============================================================================
// IntakeService — photo intakes and their draft items (E3.1)
// =============================================================================
//
// OWNERSHIP. Every route-facing method takes the JWT user's id and filters by
// it; another user's intake (or an item or photo under it) is a 404, never a
// 403. `replaceAiDrafts` and `failIntake` are for analyzer jobs, which act on
// an intake id they were queued with.
//
// STATE. `draft -> scanning -> ready -> applied`, with `failed` when the
// analyzer gives up. Transitions that must not race are conditional updates
// on the current status (`updateMany ... where status`), so two concurrent
// requests cannot both win: the loser sees a count of 0 and answers 409.
//
// PROVENANCE (the public contract, each rule tested):
//   - `originalAiValue` is written on the FIRST value edit of an AI item and
//     never overwritten (a conditional write on `original_ai_value IS NULL`);
//   - a user item has `confidence: null`, `userVerified: true`;
//   - an AI item nobody touched has `userVerified: false`;
//   - an AI item is never hard-deleted through the API (409 `USE_REJECT`);
//   - `replaceAiDrafts` deletes ONLY untouched AI drafts (`origin: ai`,
//     `status: pending`, `userVerified: false`), so a re-scan never loses an
//     accepted, rejected, edited or user-added item.
//
// Machine-readable refusal reasons go in `details.reason` (the error filter
// derives the top-level `code` from the status).
// =============================================================================

/** Statuses from which `analyze` may start (a failed scan may be retried). */
const ANALYZABLE: readonly IntakeStatus[] = ['draft', 'ready', 'failed'];
/** Statuses in which photos may be attached. */
const PHOTO_ATTACHABLE: readonly IntakeStatus[] = ['draft', 'ready', 'failed'];
/** Statuses in which photos may be detached (not while the analyzer may read them). */
const PHOTO_DETACHABLE: readonly IntakeStatus[] = ['draft', 'ready', 'failed'];
/** Statuses from which `apply` may run: the manual path applies a `draft` or `failed` intake. */
const APPLICABLE: readonly IntakeStatus[] = ['draft', 'ready', 'failed'];

const ERROR_CODE_MAX = 64;
const UNCERTAINTY_NOTE_MAX = 500;

const INTAKE_DETAIL_INCLUDE = {
  photos: {
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { storageObject: { select: { name: true } } },
  },
  items: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.PhotoIntakeInclude;

type IntakeWithDetail = Prisma.PhotoIntakeGetPayload<{ include: typeof INTAKE_DETAIL_INCLUDE }>;
type PhotoWithName = IntakeWithDetail['photos'][number];

// -----------------------------------------------------------------------------
// Views
// -----------------------------------------------------------------------------

export function toDraftItemView(item: DraftItem): DraftItemViewData {
  return {
    id: item.id,
    kind: item.kind,
    origin: item.origin as DraftItemViewData['origin'],
    status: item.status as DraftItemViewData['status'],
    confidence: (item.confidence ?? null) as DraftItemViewData['confidence'],
    uncertain: item.uncertain,
    uncertaintyNote: item.uncertaintyNote,
    sourcePhotoIds: item.sourcePhotoIds,
    userVerified: item.userVerified,
    value: item.value,
    originalAiValue: item.originalAiValue ?? null,
    sortOrder: item.sortOrder,
  };
}

function toPhotoView(photo: PhotoWithName): PhotoIntakePhotoViewData {
  return {
    id: photo.id,
    storageObjectId: photo.storageObjectId,
    name: photo.storageObject.name,
    sortOrder: photo.sortOrder,
  };
}

function intakeFields(intake: PhotoIntake) {
  return {
    id: intake.id,
    kind: intake.kind,
    status: intake.status as IntakeStatus,
    subjectType: intake.subjectType,
    subjectId: intake.subjectId,
    context: intake.context ?? null,
    provider: intake.provider,
    modelId: intake.modelId,
    jobId: intake.jobId,
    errorCode: intake.errorCode,
    errorMessage: intake.errorMessage,
    resultMeta: (intake.resultMeta ?? null) as Record<string, unknown> | null,
    createdAt: intake.createdAt.toISOString(),
    updatedAt: intake.updatedAt.toISOString(),
    completedAt: intake.completedAt ? intake.completedAt.toISOString() : null,
  };
}

export function toPhotoIntakeView(intake: IntakeWithDetail): PhotoIntakeViewData {
  return {
    ...intakeFields(intake),
    photos: intake.photos.map(toPhotoView),
    items: intake.items.map(toDraftItemView),
  };
}

// -----------------------------------------------------------------------------
// Errors and helpers
// -----------------------------------------------------------------------------

function intakeNotFound(): NotFoundException {
  return new NotFoundException('Intake not found');
}

function refuse(status: 400 | 409, reason: string, message: string, extra: Record<string, unknown> = {}) {
  const body = { message, details: { reason, ...extra } };
  return status === 400 ? new BadRequestException(body) : new ConflictException(body);
}

/** The 409 for an intake whose status forbids the operation. */
function stateConflict(status: string, operation: string): ConflictException {
  if (status === 'applied') {
    return refuse(409, 'ALREADY_APPLIED', 'This intake was already applied') as ConflictException;
  }
  if (status === 'scanning') {
    return refuse(409, 'INTAKE_SCANNING', 'This intake is being analyzed; wait until it finishes') as ConflictException;
  }
  return refuse(409, 'INVALID_INTAKE_STATUS', `Cannot ${operation} an intake that is ${status}`, {
    status,
  }) as ConflictException;
}

/** Parses `input` with a kind's schema; issues are published under `details.issues`, prefixed. */
function parseWith<T>(schema: z.ZodType<T>, input: unknown, prefix: string): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new BadRequestException({
      message: 'Validation failed',
      details: {
        issues: result.error.issues.map((issue) => ({
          path: [prefix, ...issue.path.map(String)].join('.'),
          message: issue.message,
        })),
      },
    });
  }

  return result.data;
}

/** Json for a NOT NULL column. */
function jsonValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null || value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

/** Json for a nullable column. */
function nullableJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

const aiDraftShapeSchema = z.object({
  kind: z.string().trim().min(1).max(64),
  confidence: z.enum(DRAFT_ITEM_CONFIDENCES),
  uncertain: z.boolean().optional(),
  uncertaintyNote: z.string().nullable().optional(),
  sourcePhotoIds: z.array(z.uuid()).max(1000).optional(),
});

/** An analyzer item that did not pass validation: where and why, never the value. */
export interface InvalidAiDraft {
  index: number;
  issues: Array<{ path: string; message: string }>;
}

export interface ReplaceAiDraftsResult {
  /** How many AI items were stored. */
  inserted: number;
  /** How many untouched AI drafts of an earlier scan were removed. */
  removed: number;
  /** Items that failed validation (recorded in `resultMeta.invalidItems` too). */
  invalid: InvalidAiDraft[];
}

@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: IntakeKindRegistry,
    private readonly jobs: JobsService,
    private readonly usableModels: UsableModelsService,
    private readonly objects: ObjectsService,
    // Optional so a hand-built service (tests) needs none; Nest always injects it.
    @Optional() private readonly references: StorageObjectReferences = new StorageObjectReferences(),
  ) {}

  // ---------------------------------------------------------------------------
  // Intakes
  // ---------------------------------------------------------------------------

  async create(userId: string, input: CreateIntakeInput): Promise<PhotoIntakeViewData> {
    const kind = this.registry.require(input.kind);
    const context = parseWith(kind.contextSchema, input.context, 'context');

    if (kind.assertContext) {
      await kind.assertContext(userId, context);
    }

    const subject = kind.subjectOf?.(context) ?? null;

    const intake = await this.prisma.photoIntake.create({
      data: {
        userId,
        kind: kind.kind,
        status: 'draft',
        subjectType: subject?.subjectType ?? input.subjectType ?? null,
        subjectId: subject?.subjectId ?? input.subjectId ?? null,
        context: nullableJson(context),
      },
      include: INTAKE_DETAIL_INCLUDE,
    });

    return toPhotoIntakeView(intake);
  }

  async list(userId: string, query: ListIntakesQuery): Promise<PhotoIntakeSummaryData[]> {
    const rows = await this.prisma.photoIntake.findMany({
      where: {
        userId,
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.subjectId ? { subjectId: query.subjectId } : {}),
        ...(query.status ? { status: { in: query.status } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      include: { _count: { select: { photos: true, items: true } } },
    });

    return rows.map((row) => ({
      ...intakeFields(row),
      photoCount: row._count.photos,
      itemCount: row._count.items,
    }));
  }

  async get(userId: string, intakeId: string): Promise<PhotoIntakeViewData> {
    const intake = await this.prisma.photoIntake.findFirst({
      where: { id: intakeId, userId },
      include: INTAKE_DETAIL_INCLUDE,
    });

    if (!intake) {
      throw intakeNotFound();
    }

    return toPhotoIntakeView(intake);
  }

  /**
   * Discards an intake (anything but `applied`), then deletes, best effort,
   * each of its storage objects that no other intake still links.
   */
  async discard(userId: string, intakeId: string): Promise<void> {
    const intake = await this.findOwned(userId, intakeId);

    if (intake.status === 'applied') {
      throw stateConflict(intake.status, 'discard');
    }

    const photos = await this.prisma.photoIntakePhoto.findMany({
      where: { intakeId },
      select: { storageObjectId: true },
    });

    // Conditional on "not applied", so a concurrent apply cannot be undone.
    const { count } = await this.prisma.photoIntake.deleteMany({
      where: { id: intakeId, userId, status: { not: 'applied' } },
    });

    if (count === 0) {
      const now = await this.findOwned(userId, intakeId);
      throw stateConflict(now.status, 'discard');
    }

    await this.deleteUnreferencedObjects(
      userId,
      photos.map((photo) => photo.storageObjectId),
    );
  }

  // ---------------------------------------------------------------------------
  // Photos
  // ---------------------------------------------------------------------------

  async attachPhoto(userId: string, intakeId: string, storageObjectId: string): Promise<PhotoIntakePhotoViewData> {
    const intake = await this.findOwned(userId, intakeId);

    if (!PHOTO_ATTACHABLE.includes(intake.status as IntakeStatus)) {
      throw stateConflict(intake.status, 'add photos to');
    }

    const object = await this.prisma.storageObject.findUnique({
      where: { id: storageObjectId },
      select: { id: true, name: true, status: true, mimeType: true, size: true, uploadedById: true },
    });

    // Somebody else's object is indistinguishable from a missing one.
    if (!object || object.uploadedById !== userId) {
      throw new NotFoundException({
        message: 'Storage object not found',
        details: { storageObjectId },
      });
    }

    if (object.status !== 'ready') {
      throw refuse(400, 'OBJECT_NOT_READY', 'The storage object is not ready yet', { storageObjectId });
    }

    if (!mimeTypeMatches(object.mimeType, AI_STORAGE_INPUT_IMAGE_MIME_TYPES)) {
      throw refuse(400, 'UNSUPPORTED_MEDIA_TYPE', 'Only PNG, JPEG, GIF and WebP images can be attached', {
        storageObjectId,
        allowed: [...AI_STORAGE_INPUT_IMAGE_MIME_TYPES],
      });
    }

    if (Number(object.size) > AI_STORAGE_INPUT_IMAGE_MAX_BYTES) {
      throw refuse(400, 'OBJECT_TOO_LARGE', 'The image is larger than 20 MiB', {
        storageObjectId,
        maxBytes: AI_STORAGE_INPUT_IMAGE_MAX_BYTES,
      });
    }

    const maxPhotos = this.maxPhotosFor(intake.kind);
    const [attached, last] = await Promise.all([
      this.prisma.photoIntakePhoto.count({ where: { intakeId } }),
      this.prisma.photoIntakePhoto.aggregate({ where: { intakeId }, _max: { sortOrder: true } }),
    ]);

    if (attached >= maxPhotos) {
      throw refuse(400, 'TOO_MANY_PHOTOS', `An intake holds at most ${maxPhotos} photos`, { maxPhotos });
    }

    try {
      const photo = await this.prisma.photoIntakePhoto.create({
        data: {
          intakeId,
          storageObjectId,
          sortOrder: (last._max.sortOrder ?? -1) + 1,
        },
        include: { storageObject: { select: { name: true } } },
      });

      return toPhotoView(photo);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw refuse(409, 'DUPLICATE_PHOTO', 'This photo is already attached to the intake', { storageObjectId });
      }
      throw error;
    }
  }

  async detachPhoto(userId: string, intakeId: string, storageObjectId: string): Promise<void> {
    const intake = await this.findOwned(userId, intakeId);

    if (!PHOTO_DETACHABLE.includes(intake.status as IntakeStatus)) {
      throw stateConflict(intake.status, 'remove photos from');
    }

    const { count } = await this.prisma.photoIntakePhoto.deleteMany({
      where: { intakeId, storageObjectId },
    });

    if (count === 0) {
      throw new NotFoundException({
        message: 'Photo not attached to this intake',
        details: { storageObjectId },
      });
    }

    await this.deleteUnreferencedObjects(userId, [storageObjectId]);
  }

  // ---------------------------------------------------------------------------
  // Analyze
  // ---------------------------------------------------------------------------

  /**
   * Queues the kind's analyzer job. The AI kill switch and `ai:use` are the
   * route's guards; here the model is re-checked for `vision_input` and
   * `structured_output`, and the status flip, the enqueue and the job id are
   * written in ONE transaction, so a queued job always has a `scanning`
   * intake and a `scanning` intake always has its job.
   */
  async analyze(userId: string, intakeId: string, input: AnalyzeIntakeInput): Promise<IntakeAnalyzeStartedData> {
    const intake = await this.findOwned(userId, intakeId);
    const kind = this.registry.require(intake.kind);

    if (!ANALYZABLE.includes(intake.status as IntakeStatus)) {
      throw stateConflict(intake.status, 'analyze');
    }

    if (!kind.analyzeJobType) {
      throw refuse(400, 'MANUAL_ONLY_KIND', `Intake kind "${kind.kind}" has no analyzer; add items manually`);
    }

    const photos = await this.prisma.photoIntakePhoto.count({ where: { intakeId } });

    if (photos === 0) {
      throw refuse(400, 'NO_PHOTOS', 'Attach at least one photo before analyzing');
    }

    await this.usableModels.assertUsable(userId, input.provider, input.modelId, [
      'vision_input',
      'structured_output',
    ]);

    const analyzeJobType = kind.analyzeJobType;

    try {
      const jobId = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.photoIntake.updateMany({
          where: { id: intakeId, userId, status: { in: [...ANALYZABLE] } },
          data: {
            status: 'scanning',
            provider: input.provider,
            modelId: input.modelId,
            errorCode: null,
            errorMessage: null,
            completedAt: null,
          },
        });

        if (count === 0) {
          const now = await tx.photoIntake.findFirst({ where: { id: intakeId, userId }, select: { status: true } });
          if (!now) throw intakeNotFound();
          throw stateConflict(now.status, 'analyze');
        }

        const job = await this.jobs.enqueueWithin(tx, {
          type: analyzeJobType,
          reason: 'upload',
          subjectType: 'photo_intake',
          subjectId: intakeId,
          payload: { intakeId },
        });

        await tx.photoIntake.update({ where: { id: intakeId }, data: { jobId: job.id } });

        return job.id;
      });

      return { intakeId, jobId };
    } catch (error) {
      // An earlier analyze job of this intake is still active (the dedup index).
      if (isActiveDedupConflict(error)) {
        throw refuse(409, 'INTAKE_SCANNING', 'An analysis of this intake is still running');
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Draft items
  // ---------------------------------------------------------------------------

  async addItem(userId: string, intakeId: string, input: CreateDraftItemInput): Promise<DraftItemViewData> {
    const intake = await this.findOwned(userId, intakeId);

    if (intake.status === 'applied') {
      throw stateConflict(intake.status, 'add items to');
    }

    const kind = this.registry.require(intake.kind);
    this.assertItemKind(kind, input.kind);
    const value = await this.validateValue(kind, intake, input.value);

    const last = await this.prisma.draftItem.aggregate({ where: { intakeId }, _max: { sortOrder: true } });

    const item = await this.prisma.draftItem.create({
      data: {
        intakeId,
        kind: input.kind,
        origin: 'user',
        status: 'accepted',
        confidence: null,
        uncertain: false,
        uncertaintyNote: null,
        sourcePhotoIds: [],
        userVerified: true,
        value: jsonValue(value),
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
    });

    return toDraftItemView(item);
  }

  async updateItem(
    userId: string,
    intakeId: string,
    itemId: string,
    input: UpdateDraftItemInput,
  ): Promise<DraftItemViewData> {
    const intake = await this.findOwned(userId, intakeId);

    if (intake.status === 'applied') {
      throw stateConflict(intake.status, 'edit items of');
    }

    const item = await this.findItem(intakeId, itemId);
    const kind = this.registry.require(intake.kind);

    const data: Prisma.DraftItemUpdateInput = {};
    const editsValue = input.value !== undefined;

    if (editsValue) {
      data.value = jsonValue(await this.validateValue(kind, intake, input.value));
      data.userVerified = true;
    }

    if (input.status !== undefined) {
      data.status = input.status satisfies DraftItemStatus;
      if (input.status === 'accepted') data.userVerified = true;
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        if (editsValue && item.origin === 'ai') {
          // Write-once: only while `original_ai_value` IS NULL. A concurrent
          // first edit blocks on the row lock and then fails this predicate.
          await tx.draftItem.updateMany({
            where: { id: itemId, intakeId, originalAiValue: { equals: Prisma.DbNull } },
            data: { originalAiValue: jsonValue(item.value) },
          });
        }

        return tx.draftItem.update({ where: { id: itemId }, data });
      });

      return toDraftItemView(updated);
    } catch (error) {
      if (isRecordNotFound(error)) throw itemNotFound();
      throw error;
    }
  }

  async deleteItem(userId: string, intakeId: string, itemId: string): Promise<void> {
    const intake = await this.findOwned(userId, intakeId);

    if (intake.status === 'applied') {
      throw stateConflict(intake.status, 'delete items of');
    }

    const item = await this.findItem(intakeId, itemId);

    if (item.origin !== 'user') {
      throw refuse(409, 'USE_REJECT', 'An AI item cannot be deleted; reject it instead so its provenance is kept');
    }

    await this.prisma.draftItem.deleteMany({ where: { id: itemId, intakeId, origin: 'user' } });
  }

  /** Accepts every `pending` item; returns the items it changed. */
  async acceptAll(userId: string, intakeId: string): Promise<DraftItemViewData[]> {
    const intake = await this.findOwned(userId, intakeId);

    if (intake.status === 'applied') {
      throw stateConflict(intake.status, 'accept items of');
    }

    const items = await this.prisma.$transaction(async (tx) => {
      const pending = await tx.draftItem.findMany({
        where: { intakeId, status: 'pending' },
        select: { id: true },
      });
      const ids = pending.map((row) => row.id);

      if (ids.length === 0) return [];

      await tx.draftItem.updateMany({
        where: { id: { in: ids }, intakeId, status: 'pending' },
        data: { status: 'accepted', userVerified: true },
      });

      return tx.draftItem.findMany({
        where: { id: { in: ids } },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
    });

    return items.map(toDraftItemView);
  }

  // ---------------------------------------------------------------------------
  // Apply
  // ---------------------------------------------------------------------------

  /**
   * Runs the kind's `apply` over the accepted items in ONE transaction and
   * marks the intake `applied`. The status flip comes first and is
   * conditional, so it doubles as the lock: a concurrent apply waits on the
   * row and then answers 409; a throw from the kind rolls both back.
   */
  async apply(userId: string, intakeId: string): Promise<unknown> {
    const result = await this.prisma.$transaction(async (tx) => {
      const intake = await tx.photoIntake.findFirst({ where: { id: intakeId, userId } });

      if (!intake) throw intakeNotFound();
      if (!APPLICABLE.includes(intake.status as IntakeStatus)) throw stateConflict(intake.status, 'apply');

      const kind = this.registry.require(intake.kind);

      const pending = await tx.draftItem.count({ where: { intakeId, status: 'pending' } });

      if (pending > 0) {
        throw refuse(400, 'PENDING_ITEMS', `${pending} item(s) still need to be accepted or rejected`, {
          count: pending,
        });
      }

      const { count } = await tx.photoIntake.updateMany({
        where: { id: intakeId, userId, status: intake.status },
        data: { status: 'applied', completedAt: new Date() },
      });

      if (count === 0) {
        const now = await tx.photoIntake.findFirst({ where: { id: intakeId, userId }, select: { status: true } });
        throw stateConflict(now?.status ?? 'applied', 'apply');
      }

      const accepted = await tx.draftItem.findMany({
        where: { intakeId, status: 'accepted' },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });

      return kind.apply({
        tx,
        userId,
        intake,
        context: this.contextOf(kind, intake),
        accepted,
      });
    });

    return result ?? null;
  }

  // ---------------------------------------------------------------------------
  // For analyzer jobs
  // ---------------------------------------------------------------------------

  /**
   * Stores an analyzer's items and moves a `scanning` intake to `ready`, in
   * one transaction. Deletes ONLY the untouched AI drafts of an earlier scan
   * (`origin: ai`, `status: pending`, `userVerified: false`); accepted,
   * rejected, edited and user items survive, and new items are appended after
   * them. Every item is validated with the kind's `valueSchema` (and
   * normalized); one that fails is not stored and is recorded, by index and
   * issue only, in `resultMeta.invalidItems`. Low-confidence and uncertain
   * items are stored like any other.
   *
   * Throws 404 when the intake is gone (discarded mid-scan) and 409
   * `NOT_SCANNING` when it is no longer `scanning` (another writer won).
   */
  async replaceAiDrafts(
    intakeId: string,
    items: readonly AiDraftInput[],
    options: { resultMeta?: Record<string, unknown> } = {},
  ): Promise<ReplaceAiDraftsResult> {
    const intake = await this.prisma.photoIntake.findUnique({ where: { id: intakeId } });

    if (!intake) throw intakeNotFound();

    const kind = this.registry.require(intake.kind);
    const context = this.contextOf(kind, intake);

    const valid: Array<{ input: AiDraftInput; value: unknown }> = [];
    const invalid: InvalidAiDraft[] = [];

    for (const [index, input] of items.entries()) {
      const issues: InvalidAiDraft['issues'] = [];
      const shape = aiDraftShapeSchema.safeParse(input);

      if (!shape.success) {
        issues.push(...shape.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })));
      } else if (kind.itemKinds && !kind.itemKinds.includes(shape.data.kind)) {
        issues.push({ path: 'kind', message: 'kind is not an item kind of this intake kind' });
      }

      const parsed = kind.valueSchema.safeParse(input?.value);

      if (!parsed.success) {
        issues.push(
          ...parsed.error.issues.map((i) => ({ path: ['value', ...i.path.map(String)].join('.'), message: i.message })),
        );
      }

      if (issues.length > 0 || !parsed.success) {
        invalid.push({ index, issues });
        continue;
      }

      const value = kind.normalizeValue ? await kind.normalizeValue(parsed.data, context) : parsed.data;
      valid.push({ input, value });
    }

    const resultMeta: Record<string, unknown> = {
      ...(options.resultMeta ?? {}),
      itemsReturned: items.length,
      itemsStored: valid.length,
      ...(invalid.length > 0 ? { invalidItems: invalid } : {}),
    };

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.photoIntake.updateMany({
        where: { id: intakeId, status: 'scanning' },
        data: {
          status: 'ready',
          resultMeta: resultMeta as Prisma.InputJsonValue,
          errorCode: null,
          errorMessage: null,
        },
      });

      if (count === 0) {
        const now = await tx.photoIntake.findUnique({ where: { id: intakeId }, select: { status: true } });
        if (!now) throw intakeNotFound();
        throw refuse(409, 'NOT_SCANNING', `The intake is ${now.status}, not scanning`, { status: now.status });
      }

      const removed = await tx.draftItem.deleteMany({
        where: { intakeId, origin: 'ai', status: 'pending', userVerified: false },
      });

      const last = await tx.draftItem.aggregate({ where: { intakeId }, _max: { sortOrder: true } });
      const start = (last._max.sortOrder ?? -1) + 1;

      if (valid.length > 0) {
        await tx.draftItem.createMany({
          data: valid.map(({ input, value }, offset) => ({
            intakeId,
            kind: input.kind.trim(),
            origin: 'ai',
            status: 'pending',
            confidence: input.confidence,
            uncertain: input.uncertain ?? false,
            uncertaintyNote: input.uncertaintyNote ? input.uncertaintyNote.slice(0, UNCERTAINTY_NOTE_MAX) : null,
            sourcePhotoIds: input.sourcePhotoIds ?? [],
            userVerified: false,
            value: jsonValue(value),
            sortOrder: start + offset,
          })),
        });
      }

      return { inserted: valid.length, removed: removed.count, invalid };
    });
  }

  /**
   * Marks a `scanning` intake `failed` with a machine code and a short,
   * user-safe message. Returns false (and changes nothing) when the intake is
   * gone or not scanning, so a job's failure path may call it unconditionally.
   */
  async failIntake(intakeId: string, code: string, message: string): Promise<boolean> {
    const { count } = await this.prisma.photoIntake.updateMany({
      where: { id: intakeId, status: 'scanning' },
      data: {
        status: 'failed',
        errorCode: code.slice(0, ERROR_CODE_MAX),
        errorMessage: message.slice(0, INTAKE_ERROR_MESSAGE_MAX),
        completedAt: new Date(),
      },
    });

    return count > 0;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async findOwned(userId: string, intakeId: string): Promise<PhotoIntake> {
    const intake = await this.prisma.photoIntake.findFirst({ where: { id: intakeId, userId } });

    if (!intake) throw intakeNotFound();

    return intake;
  }

  private async findItem(intakeId: string, itemId: string): Promise<DraftItem> {
    const item = await this.prisma.draftItem.findFirst({ where: { id: itemId, intakeId } });

    if (!item) throw itemNotFound();

    return item;
  }

  private maxPhotosFor(kindName: string): number {
    return this.registry.get(kindName)?.maxPhotos ?? DEFAULT_INTAKE_MAX_PHOTOS;
  }

  private assertItemKind(kind: IntakeKind<any, any>, itemKind: string): void {
    if (kind.itemKinds && !kind.itemKinds.includes(itemKind)) {
      throw new BadRequestException({
        message: 'Validation failed',
        details: {
          issues: [{ path: 'kind', message: `kind must be one of ${kind.itemKinds.join(', ')}` }],
        },
      });
    }
  }

  private contextOf(kind: IntakeKind<any, any>, intake: PhotoIntake): unknown {
    return parseWith(kind.contextSchema, intake.context ?? undefined, 'context');
  }

  private async validateValue(kind: IntakeKind<any, any>, intake: PhotoIntake, raw: unknown): Promise<unknown> {
    const value = parseWith(kind.valueSchema, raw, 'value');

    return kind.normalizeValue ? kind.normalizeValue(value, this.contextOf(kind, intake)) : value;
  }

  /**
   * Deletes each object no intake links any more and no other consumer
   * references (`StorageObjectReferences`, e.g. a gym photo). Best effort: a
   * failure is logged, never thrown.
   */
  private async deleteUnreferencedObjects(userId: string, storageObjectIds: readonly string[]): Promise<void> {
    for (const storageObjectId of storageObjectIds) {
      try {
        const links = await this.prisma.photoIntakePhoto.count({ where: { storageObjectId } });

        if (links === 0 && !(await this.references.isReferenced(storageObjectId))) {
          await this.objects.delete(storageObjectId, userId);
        }
      } catch (error) {
        this.logger.warn(
          `Could not delete storage object ${storageObjectId} after detaching it from an intake: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }
}

function itemNotFound(): NotFoundException {
  return new NotFoundException('Draft item not found');
}
