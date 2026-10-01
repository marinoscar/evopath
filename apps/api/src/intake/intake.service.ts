import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { trace } from '@opentelemetry/api';
import { DraftItem, PhotoIntake, Prisma } from '@prisma/client';
import { z } from 'zod';

import { AiError } from '../ai/core/ai-error';
import { AiFeatureModelResolver } from '../ai/assignments/ai-feature-model-resolver.service';
import { RUNNABLE_FEATURE_STATES } from '../ai/assignments/dto/ai-feature-resolution.dto';
import {
  type FileRetention,
  HEALTH_DOCUMENT_PURGE_JOB_TYPE,
  HEALTH_DOCUMENT_SUBJECT_TYPE,
  RETENTION_SPAN_ATTRIBUTE,
  retainsFiles,
  retentionOf,
} from '../health-documents/health-document.constants';
import { UsableModelsService } from '../ai/keys/usable-models.service';
import { isActiveDedupConflict, JobsService } from '../jobs/jobs.service';
import { emitHealthDataChanged } from '../measurements/health-data-events';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectsService } from '../storage/objects/objects.service';
import {
  DEFAULT_INTAKE_MAX_PHOTOS,
  DRAFT_ITEM_CONFIDENCES,
  type AiDraftInput,
  type DraftItemStatus,
  type IntakeAccess,
  type IntakeKind,
  type IntakeStatus,
} from './intake-kind.interface';

/**
 * The caller's resolved permissions (`RequestUser.permissions`, what
 * `PermissionsGuard` checked). Checked against a kind's `requiredPermissions`;
 * `undefined` holds none.
 */
export type CallerPermissions = readonly string[] | undefined;
import { IntakeKindRegistry } from './intake-kind.registry';
import { IntakeInputInspector } from './intake-input-inspector';
import {
  acceptedInputsOf,
  allowedMimeTypes,
  declaredInputKind,
  INTAKE_INPUT_KIND_SPAN_ATTRIBUTE,
  INTAKE_PAGE_COUNT_SPAN_ATTRIBUTE,
  inputKindAttribute,
  inputMaxBytes,
  maxPdfPagesOf,
  PDF_INPUT_UNSUPPORTED_MESSAGE,
  unsupportedTypeMessage,
  type IntakeInputKind,
} from './intake-inputs';
import { StorageObjectReferences } from './storage-object-references';
import {
  INTAKE_ERROR_MESSAGE_MAX,
  type AnalyzeIntakeInput,
  type AttachPhotoInput,
  type CreateDraftItemInput,
  type CreateIntakeInput,
  type UpdateIntakeInput,
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
/** Statuses in which `context` may be changed (not while a job reads it, never once applied). */
const CONTEXT_EDITABLE: readonly IntakeStatus[] = ['draft', 'ready', 'failed'];

const ERROR_CODE_MAX = 64;
const UNCERTAINTY_NOTE_MAX = 500;

const INTAKE_DETAIL_INCLUDE = {
  photos: {
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { storageObject: { select: { name: true } } },
  },
  items: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
  healthDocuments: { select: { id: true, storageObjectId: true, retention: true } },
} satisfies Prisma.PhotoIntakeInclude;

type IntakeWithDetail = Prisma.PhotoIntakeGetPayload<{ include: typeof INTAKE_DETAIL_INCLUDE }>;
type PhotoWithName = Pick<IntakeWithDetail['photos'][number], 'id' | 'storageObjectId' | 'sortOrder' | 'storageObject'>;
type HealthDocumentLink = { id: string; storageObjectId: string | null; retention: string };

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

function toPhotoView(photo: PhotoWithName, document?: HealthDocumentLink | null): PhotoIntakePhotoViewData {
  return {
    id: photo.id,
    storageObjectId: photo.storageObjectId,
    name: photo.storageObject.name,
    sortOrder: photo.sortOrder,
    healthDocumentId: document?.id ?? null,
    retention: document ? asRetention(document.retention) : null,
  };
}

function asRetention(retention: string | null | undefined): FileRetention {
  return retainsFiles(retention ?? 'keep') ? 'keep' : 'delete_after_processing';
}

/** Sets the retention mode on the active span (the HTTP request's or the job's). */
function recordRetention(retention: string): void {
  trace.getActiveSpan()?.setAttribute(RETENTION_SPAN_ATTRIBUTE, asRetention(retention));
}

/** `intake.input_kind` on the active span: `image`, `pdf` or `mixed` (H2, #186). */
function recordInputKinds(kinds: Iterable<IntakeInputKind>): void {
  const value = inputKindAttribute(kinds);
  if (value) trace.getActiveSpan()?.setAttribute(INTAKE_INPUT_KIND_SPAN_ATTRIBUTE, value);
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
    retention: asRetention(intake.retention),
    retainFiles: retainsFiles(intake.retention ?? 'keep'),
    resultMeta: (intake.resultMeta ?? null) as Record<string, unknown> | null,
    createdAt: intake.createdAt.toISOString(),
    updatedAt: intake.updatedAt.toISOString(),
    completedAt: intake.completedAt ? intake.completedAt.toISOString() : null,
  };
}

export function toPhotoIntakeView(intake: IntakeWithDetail): PhotoIntakeViewData {
  const documents = new Map((intake.healthDocuments ?? []).map((doc) => [doc.storageObjectId, doc]));
  return {
    ...intakeFields(intake),
    photos: intake.photos.map((photo) => toPhotoView(photo, documents.get(photo.storageObjectId))),
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
    private readonly features: AiFeatureModelResolver,
    private readonly inputs: IntakeInputInspector,
    // Optional so a hand-built service (tests) needs none; Nest always injects it.
    @Optional() private readonly references: StorageObjectReferences = new StorageObjectReferences(),
    // Optional for the same reason: `health.data.changed` after a health intake is applied (H8).
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  // ---------------------------------------------------------------------------
  // Intakes
  // ---------------------------------------------------------------------------

  async create(userId: string, input: CreateIntakeInput, permissions?: CallerPermissions): Promise<PhotoIntakeViewData> {
    const kind = this.registry.require(input.kind);
    assertKindPermissions(kind, 'write', permissions);
    const context = parseWith(kind.contextSchema, input.context, 'context');

    if (kind.assertContext) {
      await kind.assertContext(userId, context);
    }

    const subject = kind.subjectOf?.(context) ?? null;
    const retention = retentionOf(input.retainFiles);
    recordRetention(retention);

    const intake = await this.prisma.photoIntake.create({
      data: {
        userId,
        kind: kind.kind,
        status: 'draft',
        subjectType: subject?.subjectType ?? input.subjectType ?? null,
        subjectId: subject?.subjectId ?? input.subjectId ?? null,
        context: nullableJson(context),
        retention,
      },
      include: INTAKE_DETAIL_INCLUDE,
    });

    return toPhotoIntakeView(intake);
  }

  /**
   * Replaces the intake's `context` (for example a source hint the analyzer
   * reads), in `draft`, `ready` or `failed`. Validated and checked by the kind
   * exactly as on create; the subject is re-derived when the kind defines
   * `subjectOf`. Photos and items are untouched.
   *
   * `retainFiles` changes the keep-or-delete choice of the intake AND of every
   * health document it holds, in the same conditional write's transaction. A
   * body carrying only `retainFiles` leaves `context` alone; any other body
   * (including `{}`) replaces it, as before.
   */
  async updateContext(
    userId: string,
    intakeId: string,
    input: UpdateIntakeInput,
    permissions?: CallerPermissions,
  ): Promise<PhotoIntakeViewData> {
    const intake = await this.findOwnedFor(userId, intakeId, 'write', permissions);

    if (!CONTEXT_EDITABLE.includes(intake.status as IntakeStatus)) {
      throw stateConflict(intake.status, 'change the context of');
    }

    const kind = this.registry.require(intake.kind);
    const replacesContext = input.context !== undefined || input.retainFiles === undefined;
    const data: Prisma.PhotoIntakeUpdateManyMutationInput = {};

    if (replacesContext) {
      const context = parseWith(kind.contextSchema, input.context, 'context');

      if (kind.assertContext) {
        await kind.assertContext(userId, context);
      }

      const subject = kind.subjectOf?.(context) ?? null;
      data.context = nullableJson(context);
      if (subject) {
        data.subjectType = subject.subjectType;
        data.subjectId = subject.subjectId;
      }
    }

    const retention = input.retainFiles === undefined ? null : retentionOf(input.retainFiles);
    if (retention) {
      data.retention = retention;
      recordRetention(retention);
    }

    const count = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.photoIntake.updateMany({
        where: { id: intakeId, userId, status: { in: [...CONTEXT_EDITABLE] } },
        data,
      });

      if (updated.count > 0 && retention && kind.healthDocumentKind) {
        await tx.healthDocument.updateMany({
          where: { intakeId, userId, fileDeletedAt: null },
          data: { retention },
        });
      }

      return updated.count;
    });

    if (count === 0) {
      const now = await this.prisma.photoIntake.findFirst({ where: { id: intakeId, userId }, select: { status: true } });
      if (!now) throw intakeNotFound();
      throw stateConflict(now.status, 'change the context of');
    }

    return this.get(userId, intakeId, permissions);
  }

  async list(userId: string, query: ListIntakesQuery, permissions?: CallerPermissions): Promise<PhotoIntakeSummaryData[]> {
    // Kinds the caller may not read (`requiredPermissions.read`) are left out;
    // naming one explicitly is a 403.
    const hidden = this.registry
      .list()
      .filter((name) => missingKindPermissions(this.registry.get(name), 'read', permissions).length > 0);

    if (query.kind && hidden.includes(query.kind)) {
      assertKindPermissions(this.registry.get(query.kind)!, 'read', permissions);
    }

    const rows = await this.prisma.photoIntake.findMany({
      where: {
        userId,
        ...(query.kind ? { kind: query.kind } : hidden.length > 0 ? { kind: { notIn: hidden } } : {}),
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

  async get(userId: string, intakeId: string, permissions?: CallerPermissions): Promise<PhotoIntakeViewData> {
    const intake = await this.prisma.photoIntake.findFirst({
      where: { id: intakeId, userId },
      include: INTAKE_DETAIL_INCLUDE,
    });

    if (!intake) {
      throw intakeNotFound();
    }

    const kind = this.registry.get(intake.kind);
    if (kind) assertKindPermissions(kind, 'read', permissions);

    return toPhotoIntakeView(intake);
  }

  /**
   * Discards an intake (anything but `applied`), then deletes, best effort,
   * each of its storage objects that no other intake still links.
   *
   * A health intake's documents outlive it (`intake_id` is SET NULL): a
   * `keep` file stays, claimed by the `health_documents` reference checker,
   * so the cleanup below leaves it alone; a `delete_after_processing` file is
   * handed to `health.document.purge`, enqueued in the SAME transaction as the
   * delete, so the intent is never lost and no worker sees it before commit.
   */
  async discard(userId: string, intakeId: string, permissions?: CallerPermissions): Promise<void> {
    const intake = await this.findOwnedFor(userId, intakeId, 'write', permissions);

    if (intake.status === 'applied') {
      throw stateConflict(intake.status, 'discard');
    }

    recordRetention(intake.retention);
    const kind = this.registry.get(intake.kind);

    const photos = await this.prisma.photoIntakePhoto.findMany({
      where: { intakeId },
      select: { storageObjectId: true },
    });

    const count = await this.prisma.$transaction(async (tx) => {
      // Read before the delete: the delete sets their `intake_id` to NULL.
      const toPurge = kind?.healthDocumentKind ? await this.documentsToPurge(tx, userId, intakeId) : [];

      // Conditional on "not applied", so a concurrent apply cannot be undone.
      const deleted = await tx.photoIntake.deleteMany({
        where: { id: intakeId, userId, status: { not: 'applied' } },
      });

      if (deleted.count > 0) {
        await this.enqueuePurges(tx, toPurge);
      }

      return deleted.count;
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

  /**
   * Links a photo. For a health intake kind (`healthDocumentKind`) the link
   * and the file's `HealthDocument` are written in one transaction; the
   * document's retention is `options.retainFiles` when given, else the
   * intake's. The document takes name, type and size from the storage
   * object (never logged).
   */
  async attachPhoto(
    userId: string,
    intakeId: string,
    storageObjectId: string,
    permissions?: CallerPermissions,
    options: Pick<AttachPhotoInput, 'retainFiles'> = {},
  ): Promise<PhotoIntakePhotoViewData> {
    const intake = await this.findOwnedFor(userId, intakeId, 'write', permissions);

    if (!PHOTO_ATTACHABLE.includes(intake.status as IntakeStatus)) {
      throw stateConflict(intake.status, 'add photos to');
    }

    const object = await this.prisma.storageObject.findUnique({
      where: { id: storageObjectId },
      select: {
        id: true,
        name: true,
        status: true,
        mimeType: true,
        size: true,
        storageKey: true,
        uploadedById: true,
      },
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

    const kindDef = this.registry.get(intake.kind);
    const inputKind = this.assertDeclaredInput(kindDef, object, storageObjectId);

    const maxPhotos = this.maxPhotosFor(intake.kind);
    const [attached, last] = await Promise.all([
      this.prisma.photoIntakePhoto.count({ where: { intakeId } }),
      this.prisma.photoIntakePhoto.aggregate({ where: { intakeId }, _max: { sortOrder: true } }),
    ]);

    if (attached >= maxPhotos) {
      throw refuse(400, 'TOO_MANY_PHOTOS', `An intake holds at most ${maxPhotos} photos`, { maxPhotos });
    }

    // The bytes last: the cheap row checks above answer first.
    await this.assertStoredInput(kindDef, object.storageKey, inputKind, storageObjectId);
    recordInputKinds([inputKind]);

    const documentKind = kindDef?.healthDocumentKind;
    const retention = options.retainFiles === undefined ? asRetention(intake.retention) : retentionOf(options.retainFiles);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const photo = await tx.photoIntakePhoto.create({
          data: {
            intakeId,
            storageObjectId,
            sortOrder: (last._max.sortOrder ?? -1) + 1,
          },
          include: { storageObject: { select: { name: true } } },
        });

        if (!documentKind) return toPhotoView(photo);

        const document = await tx.healthDocument.create({
          data: {
            userId,
            kind: documentKind,
            storageObjectId,
            originalName: object.name,
            mimeType: object.mimeType,
            sizeBytes: object.size,
            retention,
            intakeId,
          },
          select: { id: true, storageObjectId: true, retention: true },
        });

        return toPhotoView(photo, document);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw refuse(409, 'DUPLICATE_PHOTO', 'This photo is already attached to the intake', { storageObjectId });
      }
      throw error;
    }
  }

  async detachPhoto(
    userId: string,
    intakeId: string,
    storageObjectId: string,
    permissions?: CallerPermissions,
  ): Promise<void> {
    const intake = await this.findOwnedFor(userId, intakeId, 'write', permissions);

    if (!PHOTO_DETACHABLE.includes(intake.status as IntakeStatus)) {
      throw stateConflict(intake.status, 'remove photos from');
    }

    const isHealthKind = Boolean(this.registry.get(intake.kind)?.healthDocumentKind);

    // A removed file was never processed: its health document goes with the
    // link (same transaction), so the cleanup below may delete the object.
    const count = await this.prisma.$transaction(async (tx) => {
      const removed = await tx.photoIntakePhoto.deleteMany({
        where: { intakeId, storageObjectId },
      });

      if (removed.count > 0 && isHealthKind) {
        await tx.healthDocument.deleteMany({ where: { intakeId, userId, storageObjectId, fileDeletedAt: null } });
      }

      return removed.count;
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
   * route's guards. The model is NOT the client's choice (#173): it is the
   * administrator's assignment for the kind's `aiFeature`, resolved for the
   * caller by `AiFeatureModelResolver` (assignment -> default -> auto pick).
   * A blocked feature is a 409 `AI_FEATURE_UNAVAILABLE` naming the state; a
   * client that still sends a model other than the resolved one is a 409
   * `AI_MODEL_ASSIGNMENT_LOCKED`. The resolved model is re-checked with
   * `assertUsable` for `vision_input` and `structured_output`, and the
   * status flip, the enqueue and the job id are written in ONE transaction,
   * so a queued job always has a `scanning` intake and a `scanning` intake
   * always has its job.
   */
  async analyze(
    userId: string,
    intakeId: string,
    input: AnalyzeIntakeInput,
    permissions?: CallerPermissions,
  ): Promise<IntakeAnalyzeStartedData> {
    const intake = await this.findOwnedFor(userId, intakeId, 'write', permissions);
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

    const { kinds: inputKinds, pages } = await this.recheckInputs(kind, intakeId);
    recordInputKinds(inputKinds);
    trace.getActiveSpan()?.setAttribute(INTAKE_PAGE_COUNT_SPAN_ATTRIBUTE, pages);

    const { provider, modelId } = await this.resolveAnalyzeModel(userId, kind, input);

    await this.assertModelReads(userId, provider, modelId, inputKinds);

    const analyzeJobType = kind.analyzeJobType;

    try {
      const jobId = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.photoIntake.updateMany({
          where: { id: intakeId, userId, status: { in: [...ANALYZABLE] } },
          data: {
            status: 'scanning',
            provider,
            modelId,
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

  /**
   * Re-checks every attached file before the analyzer is queued (H2, #186):
   * its declared type is still one the kind accepts and within the size cap,
   * and a PDF's stored bytes are read again for the magic bytes and the page
   * cap. The attach made the same checks; this holds them for links made
   * before a kind changed its declaration, and keeps "no provider call for a
   * refused file" true however the link came to be. Returns the input kinds
   * and the page count (an image is one page, a PDF its counted pages).
   */
  private async recheckInputs(
    kind: IntakeKind<any, any>,
    intakeId: string,
  ): Promise<{ kinds: Set<IntakeInputKind>; pages: number }> {
    const photos =
      (await this.prisma.photoIntakePhoto.findMany({
        where: { intakeId },
        select: {
          storageObjectId: true,
          storageObject: { select: { mimeType: true, size: true, storageKey: true } },
        },
      })) ?? [];

    const kinds = new Set<IntakeInputKind>();
    let pages = 0;

    for (const photo of photos) {
      const object = photo.storageObject;
      if (!object) continue;

      const inputKind = this.assertDeclaredInput(kind, object, photo.storageObjectId);
      if (inputKind === 'pdf') {
        pages += (await this.assertStoredInput(kind, object.storageKey, inputKind, photo.storageObjectId)) ?? 1;
      } else {
        pages += 1;
      }
      kinds.add(inputKind);
    }

    return { kinds, pages };
  }

  /**
   * The resolved model is usable for the intake's inputs: `vision_input` and
   * `structured_output` always, and `file_input` when a PDF is attached. A
   * model that cannot read a PDF is refused here, before anything is queued,
   * with a message the user can act on (`AI_CAPABILITY_UNSUPPORTED`,
   * `details.capability: 'file_input'`, `details.inputKind: 'pdf'`).
   */
  private async assertModelReads(
    userId: string,
    provider: string,
    modelId: string,
    inputKinds: ReadonlySet<IntakeInputKind>,
  ): Promise<void> {
    const hasPdf = inputKinds.has('pdf');
    const pdfRefusal = () =>
      new AiError('AI_CAPABILITY_UNSUPPORTED', PDF_INPUT_UNSUPPORTED_MESSAGE, {
        details: { provider, model: modelId, capability: 'file_input', inputKind: 'pdf' },
      });

    let usable: Awaited<ReturnType<UsableModelsService['assertUsable']>> | undefined;

    try {
      usable = await this.usableModels.assertUsable(
        userId,
        provider,
        modelId,
        hasPdf ? ['vision_input', 'structured_output', 'file_input'] : ['vision_input', 'structured_output'],
      );
    } catch (error) {
      if (
        hasPdf &&
        error instanceof AiError &&
        error.code === 'AI_CAPABILITY_UNSUPPORTED' &&
        (error.getResponse() as { details?: { capability?: string } }).details?.capability === 'file_input'
      ) {
        throw pdfRefusal();
      }
      throw error;
    }

    // The runtime also requires the `file` input modality for a stored PDF.
    const modalities = usable?.model?.capabilities?.inputModalities;
    if (hasPdf && modalities && !modalities.includes('file')) {
      throw pdfRefusal();
    }
  }

  /**
   * The declared type of `object` is one `kind` accepts and within its size
   * cap; returns the input kind. 400 `UNSUPPORTED_MEDIA_TYPE` or
   * `OBJECT_TOO_LARGE` otherwise.
   */
  private assertDeclaredInput(
    kind: IntakeKind<any, any> | undefined,
    object: { mimeType: string; size: bigint | number },
    storageObjectId: string,
  ): IntakeInputKind {
    const accepted = acceptedInputsOf(kind);
    const inputKind = declaredInputKind(object.mimeType);

    if (!inputKind || !accepted.includes(inputKind)) {
      throw refuse(400, 'UNSUPPORTED_MEDIA_TYPE', unsupportedTypeMessage(accepted), {
        storageObjectId,
        allowed: allowedMimeTypes(accepted),
      });
    }

    const maxBytes = inputMaxBytes(inputKind);

    if (Number(object.size) > maxBytes) {
      throw refuse(
        400,
        'OBJECT_TOO_LARGE',
        inputKind === 'pdf' ? 'The PDF is larger than 50 MiB' : 'The image is larger than 20 MiB',
        { storageObjectId, maxBytes },
      );
    }

    return inputKind;
  }

  /**
   * The STORED bytes agree with the declared type (magic bytes), and a PDF is
   * within the size and page caps. 400 `UNSUPPORTED_MEDIA_TYPE` (with
   * `details.contentMismatch`), `OBJECT_TOO_LARGE`, `PDF_UNREADABLE` or
   * `TOO_MANY_PAGES`. Never logs the bytes.
   */
  private async assertStoredInput(
    kind: IntakeKind<any, any> | undefined,
    storageKey: string,
    inputKind: IntakeInputKind,
    storageObjectId: string,
  ): Promise<number | null> {
    const inspection = await this.inputs.inspect(storageKey, inputKind);

    if (inspection.oversize) {
      throw refuse(400, 'OBJECT_TOO_LARGE', 'The PDF is larger than 50 MiB', {
        storageObjectId,
        maxBytes: inputMaxBytes(inputKind),
      });
    }

    if (inspection.detected !== inputKind) {
      throw refuse(
        400,
        'UNSUPPORTED_MEDIA_TYPE',
        inputKind === 'pdf' ? 'This file is not a PDF' : 'This file is not a PNG, JPEG, GIF or WebP image',
        { storageObjectId, allowed: allowedMimeTypes(acceptedInputsOf(kind)), contentMismatch: true },
      );
    }

    if (inputKind !== 'pdf') return null;

    const maxPages = maxPdfPagesOf(kind);

    if (inspection.pages === null) {
      throw refuse(400, 'PDF_UNREADABLE', 'This PDF could not be read; it may be damaged or password-protected', {
        storageObjectId,
      });
    }

    if (inspection.pages > maxPages) {
      throw refuse(400, 'TOO_MANY_PAGES', `A PDF may have at most ${maxPages} pages`, {
        storageObjectId,
        pages: inspection.pages,
        maxPages,
      });
    }

    return inspection.pages;
  }

  /** The administrator-assigned model for `kind`'s AI feature, for this caller (#173). */
  private async resolveAnalyzeModel(
    userId: string,
    kind: IntakeKind<any, any>,
    input: AnalyzeIntakeInput,
  ): Promise<{ provider: string; modelId: string }> {
    if (!kind.aiFeature) {
      // The registry refuses such a kind; this is the type narrowing's guard.
      throw new Error(`Intake kind "${kind.kind}" has an analyzer but no aiFeature`);
    }

    const resolution = await this.features.resolve(userId, kind.aiFeature);

    if (!RUNNABLE_FEATURE_STATES.includes(resolution.state) || !resolution.model) {
      throw refuse(
        409,
        'AI_FEATURE_UNAVAILABLE',
        `No AI model is available to analyze these photos (${resolution.state}).`,
        { featureId: kind.aiFeature, state: resolution.state, fix: resolution.fix },
      );
    }

    const { provider, modelId } = resolution.model;

    if (input.provider !== undefined && (input.provider !== provider || input.modelId !== modelId)) {
      throw refuse(
        409,
        'AI_MODEL_ASSIGNMENT_LOCKED',
        'The AI model for this feature is chosen by your administrator; omit provider and modelId.',
        { featureId: kind.aiFeature, provider, modelId },
      );
    }

    return { provider, modelId };
  }

  // ---------------------------------------------------------------------------
  // Draft items
  // ---------------------------------------------------------------------------

  async addItem(
    userId: string,
    intakeId: string,
    input: CreateDraftItemInput,
    permissions?: CallerPermissions,
  ): Promise<DraftItemViewData> {
    const intake = await this.findOwnedFor(userId, intakeId, 'write', permissions);

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
    permissions?: CallerPermissions,
  ): Promise<DraftItemViewData> {
    const intake = await this.findOwnedFor(userId, intakeId, 'write', permissions);

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

  async deleteItem(userId: string, intakeId: string, itemId: string, permissions?: CallerPermissions): Promise<void> {
    const intake = await this.findOwnedFor(userId, intakeId, 'write', permissions);

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
  async acceptAll(userId: string, intakeId: string, permissions?: CallerPermissions): Promise<DraftItemViewData[]> {
    const intake = await this.findOwnedFor(userId, intakeId, 'write', permissions);

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
   *
   * A health intake's `delete_after_processing` documents get their
   * `health.document.purge` job in the same transaction, after the kind's
   * writes: nothing is purged unless the measurements committed, and a
   * worker cannot claim the job before they have.
   */
  async apply(userId: string, intakeId: string, permissions?: CallerPermissions): Promise<unknown> {
    let healthKind = false;
    const result = await this.prisma.$transaction(async (tx) => {
      const intake = await tx.photoIntake.findFirst({ where: { id: intakeId, userId } });

      if (!intake) throw intakeNotFound();

      const kind = this.registry.require(intake.kind);
      assertKindPermissions(kind, 'write', permissions);

      if (!APPLICABLE.includes(intake.status as IntakeStatus)) throw stateConflict(intake.status, 'apply');

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

      recordRetention(intake.retention);
      const healthDocuments = kind.healthDocumentKind
        ? await tx.healthDocument.findMany({
            where: { intakeId, userId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, storageObjectId: true },
          })
        : [];

      const applied = await kind.apply({
        tx,
        userId,
        intake,
        context: this.contextOf(kind, intake),
        accepted,
        healthDocuments,
      });

      if (kind.healthDocumentKind) {
        await this.enqueuePurges(tx, await this.documentsToPurge(tx, userId, intakeId));
        healthKind = true;
      }

      return applied;
    });

    // A health intake wrote measurements: after commit, the health summary's trigger.
    if (healthKind) emitHealthDataChanged(this.events, this.logger, { userId, source: 'intake' });

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
   * `options.context`, when given, replaces the intake's context in the same
   * transaction (an analyzer that reads document-level fields, e.g. a lab
   * report's collection date). It is validated with the kind's
   * `contextSchema`; an invalid one is not stored and its issues are recorded
   * in `resultMeta.invalidContext`.
   *
   * Throws 404 when the intake is gone (discarded mid-scan) and 409
   * `NOT_SCANNING` when it is no longer `scanning` (another writer won).
   */
  async replaceAiDrafts(
    intakeId: string,
    items: readonly AiDraftInput[],
    options: { resultMeta?: Record<string, unknown>; context?: unknown } = {},
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

      const value = kind.normalizeValue ? await kind.normalizeValue(parsed.data, context, 'analyzer') : parsed.data;
      valid.push({ input, value });
    }

    // A context the analyzer read (a lab report's collection date, H4 #188),
    // validated like a user's; an invalid one is not stored, only recorded.
    let nextContext: { value: unknown } | null = null;
    let invalidContext: InvalidAiDraft['issues'] | null = null;

    if (options.context !== undefined) {
      const parsed = kind.contextSchema.safeParse(options.context);
      if (parsed.success) {
        nextContext = { value: parsed.data };
      } else {
        invalidContext = parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
      }
    }

    const resultMeta: Record<string, unknown> = {
      ...(options.resultMeta ?? {}),
      itemsReturned: items.length,
      itemsStored: valid.length,
      ...(invalid.length > 0 ? { invalidItems: invalid } : {}),
      ...(invalidContext ? { invalidContext } : {}),
    };

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.photoIntake.updateMany({
        where: { id: intakeId, status: 'scanning' },
        data: {
          status: 'ready',
          resultMeta: resultMeta as Prisma.InputJsonValue,
          errorCode: null,
          errorMessage: null,
          ...(nextContext ? { context: nullableJson(nextContext.value) } : {}),
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

  /** `findOwned`, then the kind's own `requiredPermissions` for `access` (a 403). */
  private async findOwnedFor(
    userId: string,
    intakeId: string,
    access: IntakeAccess,
    permissions: CallerPermissions,
  ): Promise<PhotoIntake> {
    const intake = await this.findOwned(userId, intakeId);
    const kind = this.registry.get(intake.kind);

    if (kind) assertKindPermissions(kind, access, permissions);

    return intake;
  }

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

  /** The intake's documents whose file is to be erased and still exists. */
  private async documentsToPurge(tx: Prisma.TransactionClient, userId: string, intakeId: string): Promise<string[]> {
    const rows = await tx.healthDocument.findMany({
      where: { intakeId, userId, retention: 'delete_after_processing', fileDeletedAt: null },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /**
   * One `health.document.purge` job per document, inside the caller's
   * transaction. `skipDedup`: a unique violation would abort that
   * transaction, and the handler is idempotent anyway.
   */
  private async enqueuePurges(tx: Prisma.TransactionClient, healthDocumentIds: readonly string[]): Promise<void> {
    for (const healthDocumentId of healthDocumentIds) {
      await this.jobs.enqueueWithin(tx, {
        type: HEALTH_DOCUMENT_PURGE_JOB_TYPE,
        reason: 'upload',
        subjectType: HEALTH_DOCUMENT_SUBJECT_TYPE,
        subjectId: healthDocumentId,
        payload: { healthDocumentId },
        skipDedup: true,
      });
    }
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

    return kind.normalizeValue ? kind.normalizeValue(value, this.contextOf(kind, intake), 'user') : value;
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

/**
 * The permissions a kind requires for `access` that the caller lacks. A
 * caller whose permissions are unknown (`undefined`) holds none, so a kind
 * that declares requirements fails closed for it.
 */
function missingKindPermissions(
  kind: IntakeKind<any, any> | undefined,
  access: IntakeAccess,
  permissions: CallerPermissions,
): string[] {
  const required = kind?.requiredPermissions?.[access] ?? [];
  return required.filter((permission) => !(permissions ?? []).includes(permission));
}

/** 403 in the `PermissionsGuard` wording, with `details.reason: MISSING_KIND_PERMISSIONS`. */
function assertKindPermissions(kind: IntakeKind<any, any>, access: IntakeAccess, permissions: CallerPermissions): void {
  const missing = missingKindPermissions(kind, access, permissions);

  if (missing.length > 0) {
    throw new ForbiddenException({
      message: `Missing permissions: ${missing.join(', ')}`,
      details: { reason: 'MISSING_KIND_PERMISSIONS', kind: kind.kind, permissions: missing },
    });
  }
}

function itemNotFound(): NotFoundException {
  return new NotFoundException('Draft item not found');
}
