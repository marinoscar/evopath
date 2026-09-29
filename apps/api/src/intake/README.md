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
  intake.service.ts          # Routes' logic + replaceAiDrafts / failIntake for jobs
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
  readonly itemKinds = ['equipment'] as const;

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
| `maxPhotos` | Optional; default 48 (`DEFAULT_INTAKE_MAX_PHOTOS`). |
| `itemKinds` | Optional allow-list for `DraftItem.kind`. Omitted means any non-empty string. |
| `assertContext` | Optional. Checks the context against the caller; another user's record is a 404, never a 403. Runs on create. |
| `normalizeValue` | Optional. Recomputes derived fields; runs after `valueSchema` on every stored value. |
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
`provider`, `modelId` and `jobId` on the intake. The handler:

1. Reads the intake (`provider`, `modelId`, `userId`) and its photos by id.
2. Calls the model through `AiService.forUser(intake.userId)`, with the photos
   as stored image inputs. See [the AI README](../ai/README.md).
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

Rules for the handler:

- **Server-only.** Implement neither `nodeResultSchema` nor
  `persistNodeResult`; `test/ai/ai-jobs-server-only.spec.ts` discovers `ai.*`
  types. A user's key never reaches a worker node.
- **Declare a `profile`** (`{ maxRuntimeMs, maxAttempts }`) or take the global
  default.
- **Never drop items.** Pass every item the model returned, including
  low-confidence and uncertain ones. Do not filter by confidence.
- **`resultMeta` is diagnostics only:** prompt version, batch counts, ignored
  objects. Never keys, prompts or image bytes.

### 5. Know What the Helpers Guarantee

| Helper | Behaviour |
|---|---|
| `replaceAiDrafts(intakeId, items, { resultMeta? })` | One transaction: moves a `scanning` intake to `ready`, deletes only untouched AI drafts of an earlier scan (`origin: 'ai'`, `status: 'pending'`, `userVerified: false`), appends the new items after the survivors. An item that fails the shape check, `itemKinds` or `valueSchema` is not stored and is recorded by index and issue (never the value) in `resultMeta.invalidItems`. Returns `{ inserted, removed, invalid }`. Throws 404 when the intake was discarded and 409 `NOT_SCANNING` when it is no longer `scanning`. |
| `failIntake(intakeId, code, message)` | Moves a `scanning` intake to `failed` with `errorCode` and a short user-safe `errorMessage`. Returns `false` and changes nothing when the intake is gone or not `scanning`, so a failure path may call it unconditionally. |

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

## Error Reasons

Refusals carry a machine-readable `details.reason` next to the message.

| Reason | Status | Cause |
|---|---|---|
| `UNKNOWN_INTAKE_KIND` | 400 | `kind` is not registered (`IntakeKindRegistry.require`). |
| `MANUAL_ONLY_KIND` | 400 | `analyze` on a kind whose `analyzeJobType` is `null`. |
| `NO_PHOTOS` | 400 | `analyze` with no photo attached. |
| `OBJECT_NOT_READY` | 400 | The storage object is not `ready`. |
| `UNSUPPORTED_MEDIA_TYPE` | 400 | The object is not a PNG, JPEG, GIF or WebP image. |
| `OBJECT_TOO_LARGE` | 400 | The image is over 20 MiB. |
| `TOO_MANY_PHOTOS` | 400 | The intake already holds `maxPhotos`. |
| `PENDING_ITEMS` | 400 | `apply` while items are still `pending`; `details.count` says how many. |
| `DUPLICATE_PHOTO` | 409 | The object is already attached to this intake. |
| `INTAKE_SCANNING` | 409 | The intake (or its analyze job) is already in flight. |
| `ALREADY_APPLIED` | 409 | The intake was applied; nothing changes. |
| `INVALID_INTAKE_STATUS` | 409 | The operation does not fit the current status (`details.status`). |
| `NOT_SCANNING` | 409 | `replaceAiDrafts` on an intake that is no longer `scanning`. |
| `USE_REJECT` | 409 | `DELETE` on an AI item. |

An analyze refused by the AI gates uses the AI platform's reasons
(`AI_DISABLED`, `AI_MODEL_NOT_ENABLED`, `AI_CAPABILITY_UNSUPPORTED`), listed in
[the AI platform spec](../../../../docs/specs/ai-platform.md).

## Ownership

Every route filters by the JWT user. Another user's intake, item or photo is a
404, never a 403. Analyzer jobs act on an intake id they were queued with and
read the owner from the row.

## Testing a Kind

Register a stub kind in the spec instead of production code; the existing
`intake.service.spec.ts` and `intake-kind.registry.spec.ts` show the pattern.
Cover at least: `valueSchema` rejections, `assertContext` refusing another
user's record, and an `apply` that throws leaving the intake `ready`.
