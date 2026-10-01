# Photo Intake (`apps/api/src/intake`)

The kind-agnostic staging area for "share pictures instead of typing" flows.
A user attaches photos, an AI job drafts structured items from them, the user
reviews and overwrites the drafts, and only then does a feature write real
rows. The module stores the photos, the draft items and their provenance, and
enforces ownership, state and the review rules. Everything that depends on
*what* is being captured is one registered **intake kind**.

This file is the recipe for adding a kind. The route table lives in the
generated OpenAPI (Scalar at `/api/docs`, tag **Intakes**); the models and
permissions are listed in [ARCHITECTURE.md](../../../../docs/ARCHITECTURE.md#61-prisma-models).

## Module map

```
intake/
  intake.module.ts           # Exports IntakeKindRegistry and IntakeService
  intake-kind.interface.ts   # IntakeKind, IntakeApplyArgs, AiDraftInput, status enums
  intake-kind.registry.ts    # IntakeKindRegistry: register(), get(), require(), list()
  intake-analyzer.ts         # Shared chunk loop, input parts (image/file) and error handling for analyzer jobs
  intake-inputs.ts           # Accepted inputs, MIME/size caps, magic-byte sniff, PDF page counting (pure)
  intake-input-inspector.ts  # IntakeInputInspector: reads a stored file's bytes back through STORAGE_PROVIDER
  intake.service.ts          # Routes' logic + replaceAiDrafts / failIntake for jobs
  storage-object-references.ts # StorageObjectReferences: consumers that still use an intake photo
  intake.controller.ts       # /api/intakes (analyze sits behind AiEnabledGuard)
  dto/intake.dto.ts          # Zod schemas and the view types
```

The web side is a kit in `apps/web/src/components/intake/` (`ImageIntake`,
`AiVisionDisclosure`, `AiDraftReview`, exported from `index.ts`). A kind's
web half supplies only `renderValue` and `renderEditor`.

## The lifecycle

```
draft --analyze--> scanning --replaceAiDrafts--> ready --apply--> applied
                       |
                       +--failIntake--> failed --analyze--> scanning
```

- Photos attach and detach in `draft`, `ready` and `failed`.
- `analyze` and `apply` run from `draft`, `ready` and `failed`, so a fully manual intake
  applies without ever scanning, and a re-scan starts from `ready` or `failed`.
- Items can be added and edited in any status except `applied`.
- `PATCH /api/intakes/:id` replaces the `context` (for example a source hint the analyzer reads) in `draft`, `ready` and `failed`; the kind validates it as on create. It answers 409 `INVALID_INTAKE_STATUS` while the intake is `scanning` or `applied`. Photos and items are untouched.
- `apply` needs no `pending` item; accepted items reach the kind, rejected ones do not.

## Adding a Kind

### 1. Implement `IntakeKind`

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { type IntakeApplyArgs, type IntakeKind } from '../intake/intake-kind.interface';
import { IntakeKindRegistry } from '../intake/intake-kind.registry';

const contextSchema = z.object({ gymId: z.uuid() });
const valueSchema = z.object({ name: z.string().trim().min(1).max(120) });

type Context = z.infer<typeof contextSchema>;
type Value = z.infer<typeof valueSchema>;

@Injectable()
export class GymEquipmentIntakeKind implements IntakeKind<Context, Value>, OnModuleInit {
  // PERMANENT once photo_intakes rows carry it.
  readonly kind = 'gym_equipment';
  readonly contextSchema = contextSchema;
  readonly valueSchema = valueSchema;
  readonly analyzeJobType = 'ai.equipment.scan'; // null = manual-only kind
  readonly aiFeature = 'gym_scan'; // required with an analyzeJobType
  readonly itemKinds = ['equipment'] as const;
  // apply writes gym rows: the gym routes' permissions, on top of intakes:*
  readonly requiredPermissions = { read: [PERMISSIONS.GYMS_READ], write: [PERMISSIONS.GYMS_WRITE] };

  constructor(
    private readonly registry: IntakeKindRegistry,
    private readonly gyms: GymsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertContext(userId: string, context: Context): Promise<void> {
    await this.gyms.assertOwned(userId, context.gymId); // throw a 404 otherwise
  }

  async apply({ tx, userId, context, accepted }: IntakeApplyArgs<Context>): Promise<unknown> {
    // Every write goes through `tx`.
    return { created: accepted.length };
  }
}
```

| Member | Contract |
|---|---|
| `kind` | Unique, at most 64 characters, permanent once rows exist. A duplicate registration replaces the earlier one with a warning (the last one wins). |
| `contextSchema` | Validates `PhotoIntake.context` on create. A kind without context uses an optional schema. A failure is a 400 with `details.issues` prefixed `context`. |
| `valueSchema` | Validates every `DraftItem.value`: a user's add or edit, and the analyzer job's items in `replaceAiDrafts`. |
| `analyzeJobType` | The server-only `ai.*` job type, or `null`. A `null` kind answers `analyze` with 400 `MANUAL_ONLY_KIND`. |
| `aiFeature` | Required when `analyzeJobType` is set: the AI feature id (`AI_FEATURE_IDS`) whose administrator-assigned model analyzes this kind. `IntakeKindRegistry.register` throws for an analyzer kind without one. Register a new id first (see [the AI README](../ai/README.md)). |
| `maxPhotos` | Optional; default 48 (`DEFAULT_INTAKE_MAX_PHOTOS`). A PDF counts as one photo. |
| `acceptedInputs` | Optional; `['image']` by default, or `['image', 'pdf']` (`INTAKE_INPUT_KINDS`). What files an attach accepts; a PDF on a kind without `'pdf'` is a 400 `UNSUPPORTED_MEDIA_TYPE`. The registry refuses an empty list, an unknown entry or a duplicate. `body_metric_reading` accepts PDFs; `gym_equipment` and `workout_prefill` stay image-only. See [Accepted Inputs](#accepted-inputs). |
| `maxPdfPages` | Optional; default 20 (`INTAKE_PDF_MAX_PAGES`). The most pages one PDF input may have; a positive integer. |
| `itemKinds` | Optional allow-list for `DraftItem.kind`. Omitted means any non-empty string. |
| `requiredPermissions` | Optional `{ read?, write? }`: permissions this kind needs on top of the routes' `intakes:read` / `intakes:write`. See [Kind Permissions](#kind-permissions). |
| `healthDocumentKind` | Optional (`body_metric`, `lab_report`). Declares a health intake kind: each attached file becomes one `HealthDocument` carrying the user's `retainFiles` choice, `apply` receives them as `args.healthDocuments`, and a `delete_after_processing` file is erased by the `health.document.purge` job once the intake is applied or discarded. `body_metric_reading` is the worked example. |
| `assertContext` | Optional. Checks the context against the caller; another user's record is a 404, never a 403. Runs on create. |
| `subjectOf` | Optional. Derives `subjectType`/`subjectId` from the context (e.g. the gym); when defined it wins over what the client sent, so the list filter `subjectId` finds the intake. |
| `normalizeValue` | Optional. Recomputes derived fields; runs after `valueSchema` on every stored value. Its third argument, `source`, is `'user'` (a route add or edit: throw a 400 naming the field) or `'analyzer'` (`replaceAiDrafts`: be lenient and never throw, so a doubtful AI item is shown flagged rather than dropped; `apply` refuses it until the user resolves it). |
| `apply` | Turns `accepted` items into real rows. The return value is the `apply` route's response. |

### 2. Register It in `onModuleInit`

The `this.registry.register(this)` line is the whole mechanism. There is no
central list of kinds to edit. Provide the class in your feature module and
import `IntakeModule` there, which exports `IntakeKindRegistry` and
`IntakeService`.

### 3. Apply Inside the Transaction

`IntakeService.apply` opens one `$transaction`, flips the intake to `applied`
(a conditional update that doubles as the lock), reads the `accepted` items
and calls `kind.apply`. Two consequences:

- Write only through `args.tx`. Never use an injected `PrismaService` inside
  `apply`: those writes would not roll back.
- A throw rolls back your writes **and** the status flip, so the intake stays
  `ready` and the user can retry. A concurrent second apply answers 409
  `ALREADY_APPLIED`.

`apply` receives rejected items never. `intake.subjectType` / `subjectId` and
the parsed `context` say which record the items belong to. Do not call
`notify()` from `apply`; it runs after the commit, outside any transaction (see
[the notifications README](../notifications/README.md)).

### 4. Add the Analyzer Job

Write one `ai.*` `JobHandler` per kind, following
[the job handlers README](../jobs/handlers/README.md). It is enqueued for you:
`POST /api/intakes/:id/analyze` flips the intake to `scanning` and enqueues
`analyzeJobType` with `{ intakeId }` as payload in one transaction, storing
`provider`, `modelId` and `jobId` on the intake. The request body is `{}`: the
server resolves the model from the kind's `aiFeature` for the caller
(administrator's feature assignment, then default, then an automatic pick), so
neither the client nor the kind chooses one. The handler:

1. Reads the intake (`provider`, `modelId`, `userId`) and its photos by id.
2. Calls the model through `AiService.forUser(intake.userId)`, with the photos
   as stored inputs (`intakeInputPart`: images as `image` parts, PDFs as `file`
   parts). See [the AI README](../ai/README.md).
3. Hands every item the model returned to `IntakeService.replaceAiDrafts`.
4. On failure, calls `IntakeService.failIntake` and throws.

```typescript
await this.intakes.replaceAiDrafts(
  intakeId,
  items.map((i) => ({
    kind: 'equipment',
    value: i.value,
    confidence: i.confidence, // 'high' | 'medium' | 'low'
    uncertain: i.uncertain,
    uncertaintyNote: i.note,
    sourcePhotoIds: i.photoIds, // storage object ids
  })),
  { resultMeta: { promptVersion: 'v1', batches: 2 } },
);
```

Chunked vision analyzers do not hand-roll the loop. `intake-analyzer.ts`
exports the shared pieces: `chunkPhotos` (16 photos per request, the platform's
stored-input cap), `buildPhotoContent` (`Photo 0:`, image, ... plus a closing
reminder), the `photo_intake` subject type and payload schema, and the error
policy. A rate limit is thrown for a clean re-run, a terminal `AI_RUN_TERMINAL_CODES`
code on the first chunk fails the intake, a terminal code on a later chunk is
recorded in `failedChunks` and the earlier drafts are kept, and any other error
fails the intake and is thrown. The registered analyzers, `ai.equipment.scan`
(`gym_equipment`) and `ai.workout.prefill` (`workout_prefill`), both sit on it;
read either as the worked example.

Rules for the handler:

- **Server-only.** Implement neither `nodeResultSchema` nor
  `persistNodeResult`; `test/ai/ai-jobs-server-only.spec.ts` discovers `ai.*`
  types. A user's key never reaches a worker node.
- **Declare a `profile`** (`{ maxRuntimeMs, maxAttempts }`) or take the global
  default.
- **Settle safety net.** Listen to `JOB_SETTLED_EVENT` and fail an intake still `scanning` when its job settled, so a crashed run never leaves it stuck.
- **Never drop items.** Pass every item the model returned, including
  low-confidence and uncertain ones. Do not filter by confidence.
- **`resultMeta` is diagnostics only:** prompt version, batch counts, ignored
  objects. Never keys, prompts or image bytes.

### 5. Know What the Helpers Guarantee

| Helper | Behaviour |
|---|---|
| `replaceAiDrafts(intakeId, items, { resultMeta? })` | One transaction: moves a `scanning` intake to `ready`, deletes only untouched AI drafts of an earlier scan (`origin: 'ai'`, `status: 'pending'`, `userVerified: false`), appends the new items after the survivors. An item that fails the shape check, `itemKinds` or `valueSchema` is not stored and is recorded by index and issue (never the value) in `resultMeta.invalidItems`. Returns `{ inserted, removed, invalid }`. Throws 404 when the intake was discarded and 409 `NOT_SCANNING` when it is no longer `scanning`. |
| `failIntake(intakeId, code, message)` | Moves a `scanning` intake to `failed` with `errorCode` and a short user-safe `errorMessage`. Returns `false` and changes nothing when the intake is gone or not `scanning`, so a failure path may call it unconditionally. |

### 6. Keep Photos Other Features Use

Discarding an intake, or detaching one of its photos, deletes each storage
object that no intake links any more. If your feature keeps using an intake's
photos (the gym scan turns them into gym photos on apply), register a checker
with `StorageObjectReferences` (exported by `IntakeModule`) in your own
`onModuleInit`, so the object is kept while your row references it:

```typescript
@Injectable()
export class GymPhotoObjectReferences implements StorageObjectReferenceChecker, OnModuleInit {
  readonly name = 'gym_photos';

  constructor(
    private readonly references: StorageObjectReferences,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.references.register(this);
  }

  async isReferenced(storageObjectId: string): Promise<boolean> {
    return (await this.prisma.gymPhoto.count({ where: { storageObjectId } })) > 0;
  }
}
```

- A checker answers for its own tables only. The object is kept when any
  checker says it is referenced.
- A checker that throws counts as "referenced": keeping an object is the safe
  side of a best-effort cleanup. The failure is logged.
- Without a checker, the cascade from the object delete would remove your row.
- The reverse direction is yours: when your feature deletes its own row, do not
  count links of `applied` intakes as holders (they are history; the object
  delete removes them by cascade). `GymStorageService.deleteObjects` is the
  worked example.

## Accepted Inputs

An attach is checked cheapest first, so a bad file is refused at attach time,
before any AI call (`IntakeService.attachPhoto`):

1. **Declared type.** The storage object's MIME type must be one the kind
   accepts: a PNG, JPEG, GIF or WebP image, or `application/pdf` for a kind
   whose `acceptedInputs` lists `'pdf'`. Otherwise 400 `UNSUPPORTED_MEDIA_TYPE`
   with `details.allowed`.
2. **Size.** 20 MiB for an image, 50 MiB for a PDF (the AI platform's
   `AI_STORAGE_INPUT_IMAGE_MAX_BYTES` / `AI_STORAGE_INPUT_FILE_MAX_BYTES`).
   Otherwise 400 `OBJECT_TOO_LARGE` with `details.maxBytes`.
3. **Stored bytes.** `IntakeInputInspector` reads the object back through
   `STORAGE_PROVIDER`: the first 1024 bytes of an image, the whole of a PDF
   (bounded by 50 MiB). The magic bytes must agree with the declared type
   (a text file renamed to `.pdf` is 400 `UNSUPPORTED_MEDIA_TYPE` with
   `details.contentMismatch: true`), and a PDF's pages are counted against
   `maxPdfPages` (400 `TOO_MANY_PAGES` with `details.pages` and
   `details.maxPages`). A PDF whose pages cannot be counted is 400
   `PDF_UNREADABLE`.

`POST /api/intakes/:id/analyze` repeats the checks before it queues anything:
every attached file must still be a type the kind accepts, each PDF is read and
counted again, and a PDF requires `file_input` on top of `vision_input` and
`structured_output`. A model without it is refused with `AI_CAPABILITY_UNSUPPORTED`,
`details.capability: 'file_input'`, `details.inputKind: 'pdf'` and the message
"Your AI model can't read PDFs; choose a model with file input or upload an
image." No job is queued and no provider is called.

The page counter (`countPdfPages` in `intake-inputs.ts`) needs no PDF library:
it counts `/Type /Page` objects in the clear and inside Flate-compressed object
streams, under a 64 MiB inflate budget. It errs high (an incremental update may
be counted twice), never low.

Analyzer jobs map each input with `intakeInputPart`: an image to
`{ type: 'image', storageObjectId, detail: 'high' }`, a PDF to
`{ type: 'file', storageObjectId }`, labelled `Photo <n> (PDF document):`.
The span attribute `intake.input_kind` (`image`, `pdf` or `mixed`) is set on
attach, analyze and the `body_metric_reading` job. Nothing logs file bytes, names
or presigned URLs.

In tests, `src/intake/testing/input-inspector.stub.ts` has
`trustingInputInspector()` (for rows without bytes) and
`inMemoryInputInspector(blobs)` (the real inspector over an in-memory storage);
`src/intake/testing/pdf-bytes.ts` builds PDFs with a known page count.

## Provenance Fields

The draft item is the public contract (`DraftItemView` in OpenAPI). The
service maintains its provenance; a kind never writes these fields itself.

| Field | Rule |
|---|---|
| `origin` | `'ai'` from `replaceAiDrafts`; `'user'` from `POST /intakes/:id/items`. |
| `confidence` | `'high'`, `'medium'` or `'low'` for AI items; always `null` for user items. |
| `uncertain`, `uncertaintyNote` | Set by the job when the model flags doubt. Shown to the user, never hidden. |
| `sourcePhotoIds` | Storage object ids the item was read from. May point at a photo the user later removed. |
| `status` | `pending`, `accepted` or `rejected`. A user item starts `accepted`. |
| `userVerified` | `false` on an untouched AI item; `true` after any edit or accept. Always `true` for a user item. |
| `originalAiValue` | Written once, on the first value edit of an AI item, from the previous `value`. Never overwritten. |

Deleting is asymmetric on purpose: `DELETE` removes a user item, and an AI
item answers 409 `USE_REJECT` so its provenance survives; reject it instead.

## Kind Permissions

The routes check only `intakes:read` / `intakes:write` (and `ai:use` for
analyze), because the module does not know what a kind writes. A kind whose
`apply` writes data guarded by its own permission declares it, so an intake
cannot become a side door around that permission:

```typescript
readonly requiredPermissions = {
  read: [PERMISSIONS.HEALTH_DATA_READ],   // GET /intakes/:id, and GET /intakes
  write: [PERMISSIONS.HEALTH_DATA_WRITE], // create, photos, analyze, items, discard, apply
};
```

`IntakeService` checks it against the caller's resolved permissions (the
`RequestUser.permissions` that `PermissionsGuard` checked, passed by the
controller as each method's last argument):

- a missing permission is a 403 `Missing permissions: <list>` with
  `details.reason: MISSING_KIND_PERMISSIONS`, `details.kind` and
  `details.permissions`, before anything is read into a response or written;
- `GET /intakes` leaves out the kinds the caller may not read, and a
  `?kind=` naming one is a 403;
- ownership comes first: another user's intake is still a 404;
- a server-side caller that passes no permissions holds none, so a kind that
  declares requirements fails closed for it. Kinds without
  `requiredPermissions` behave exactly as before.

The registered kinds each declare one: `body_metric_reading` (`measurements/photo/`)
requires `health_data:read` / `health_data:write`, `gym_equipment`
(`gyms/intake/`) requires `gyms:read` / `gyms:write`, and `workout_prefill`
(`workouts/intake/`) requires `workouts:read` and `workouts:write` plus
`exercises:write`. `body_metric_reading` is the worked example.

## Error Reasons

Refusals carry a machine-readable `details.reason` next to the message.

| Reason | Status | Cause |
|---|---|---|
| `UNKNOWN_INTAKE_KIND` | 400 | `kind` is not registered (`IntakeKindRegistry.require`). |
| `MANUAL_ONLY_KIND` | 400 | `analyze` on a kind whose `analyzeJobType` is `null`. |
| `NO_PHOTOS` | 400 | `analyze` with no photo attached. |
| `OBJECT_NOT_READY` | 400 | The storage object is not `ready`. |
| `UNSUPPORTED_MEDIA_TYPE` | 400 | The object is not a type the kind accepts (a PNG, JPEG, GIF or WebP image; a PDF only where `acceptedInputs` lists it), or its bytes do not match its type (`details.contentMismatch`). |
| `OBJECT_TOO_LARGE` | 400 | The image is over 20 MiB, or the PDF over 50 MiB. |
| `TOO_MANY_PAGES` | 400 | The PDF has more pages than the kind's `maxPdfPages` (default 20); `details.pages`, `details.maxPages`. |
| `PDF_UNREADABLE` | 400 | The PDF's pages cannot be counted (damaged, or its page objects are encrypted). |
| `TOO_MANY_PHOTOS` | 400 | The intake already holds `maxPhotos`. |
| `PENDING_ITEMS` | 400 | `apply` while items are still `pending`; `details.count` says how many. |
| `DUPLICATE_PHOTO` | 409 | The object is already attached to this intake. |
| `INTAKE_SCANNING` | 409 | The intake (or its analyze job) is already in flight. |
| `MISSING_KIND_PERMISSIONS` | 403 | The caller lacks a permission the kind's `requiredPermissions` names (`details.permissions`). |
| `ALREADY_APPLIED` | 409 | The intake was applied; nothing changes. |
| `INVALID_INTAKE_STATUS` | 409 | The operation does not fit the current status (`details.status`). |
| `NOT_SCANNING` | 409 | `replaceAiDrafts` on an intake that is no longer `scanning`. |
| `USE_REJECT` | 409 | `DELETE` on an AI item. |
| `AI_FEATURE_UNAVAILABLE` | 409 | The kind's `aiFeature` resolves to a blocking state for the caller (`details.state`, `details.fix`: a key or an administrator). |
| `AI_MODEL_ASSIGNMENT_LOCKED` | 409 | The request named a model other than the resolved one; `details.provider` and `details.modelId` name it. |

An analyze refused by the AI gates uses the AI platform's reasons
(`AI_DISABLED`, `AI_MODEL_NOT_ENABLED`, `AI_CAPABILITY_UNSUPPORTED`; for a PDF on a
model without file input, `details.capability: 'file_input'` and `details.inputKind: 'pdf'`), listed in
[the AI platform spec](../../../../docs/specs/ai-platform.md).

## Ownership

Every route filters by the JWT user. Another user's intake, item or photo is a
404, never a 403. (A 403 on your own intake means a missing permission: the
route's, or the kind's `requiredPermissions`.) Analyzer jobs act on an intake
id they were queued with and read the owner from the row.

## Testing a Kind

Register a stub kind in the spec instead of production code; the existing
`intake.service.spec.ts` and `intake-kind.registry.spec.ts` show the pattern.
Cover at least: `valueSchema` rejections, `assertContext` refusing another
user's record, and an `apply` that throws leaving the intake `ready`.
