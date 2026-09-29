# Gyms and Equipment

> **Status:** shipped (gyms, equipment catalog, custom equipment, photos, AI Scan Gym, optional GPS location) · **Code:** `apps/api/src/gyms/`, `apps/web/src/pages/Gym*.tsx`, `apps/web/src/components/gyms/` · **API:** `/api/gyms/*`, `/api/equipment-types/*`, `/api/capabilities` (see `/api/docs`, tags "Gyms", "Equipment" and "Capabilities"; the scan uses the "Intakes" routes) · **Admin UI:** none (user pages `/gyms`, `/gyms/new`, `/gyms/:gymId`, `/gyms/:gymId/scan`) · **Runbook:** none (AI setup: [ai-configuration](../runbooks/ai-configuration.md)) · **Recipe:** [section 4](#4-extending-it-in-a-fork)

A gym is a place a user trains: their home garage, a club, a hotel room. Each gym holds the equipment found there, chosen from a seeded catalog or from the user's own custom types, with a quantity, an optional brand and model, and photos. Every piece of data is created by hand first. **Scan gym** is an optional shortcut on top: the user shares photos of the room, a server-only AI job drafts the equipment list, and the user reviews, edits and applies it. Equipment written from an AI draft records that it came from AI and what the AI originally said, so nothing the user later relies on is silently a guess. A gym can also carry an optional position, typed or read once from the device. Later features (workout planning, hotel and temporary gyms) read a gym's equipment and the capabilities it enables.

## 1. Purpose

- **What it is.**
  - The answer to "what can I train with here?", per place, per user.
  - A shared, slug-keyed equipment catalog with the movements (capabilities) each type enables.
  - The worked example of the photo-intake kit ([intake README](../../apps/api/src/intake/README.md)) and of a vision `ai.*` job.
- **What it is not.**
  - Not a workout planner. It records what exists, not what to do with it.
  - Not a live location tracker. A position is optional, set on request, and never collected in the background.
  - Not shared between users. A gym, its equipment rows, photos and custom types belong to one user; a foreign id answers `404`.
  - Not AI-dependent. Every flow works with AI off, without a key and without a vision model.

## 2. How it works

### 2.1 Data model

| Table | Holds |
|---|---|
| `gyms` | One place: `name`, `type` (`home`, `club`, `office`, `hotel`, `apartment`, `outdoor`, `other`), `description`, `notes`, `latitude`, `longitude`, `isDefault`, `isTemporary` |
| `equipment_types` | Catalog rows: permanent `slug`, `name`, `category`, `aliases`, `description`. `ownerUserId` is null for a seeded row and the owner's id for custom equipment |
| `capabilities` | A movement an equipment type enables: permanent `slug`, `movementPattern`, `primaryMuscles` |
| `equipment_type_capabilities` | Join of type to capability |
| `gym_equipment` | Equipment in a gym: type, `quantity`, `brand`, `model`, `notes` and the provenance columns |
| `gym_photos` | A gym's photo: a unique link to a `storage_objects` row, `caption`, `takenAt` |
| `gym_equipment_photos` | Join of equipment row to the gym photos that show it |

The column list, relations and delete rules are in `apps/api/prisma/schema.prisma` (models `Gym` to `GymEquipmentPhoto`); the table inventory is in [ARCHITECTURE.md](../ARCHITECTURE.md#61-prisma-models).

- Deleting a gym cascades to its equipment, photos and links. An equipment type is `Restrict`ed while any gym equipment uses it.
- Coordinate ranges and the `quantity` range (1 to 99) are `CHECK` constraints written in the migration SQL.
- Every size limit and vocabulary (names, notes, 50 gyms per user, 100 photos per gym, 100 custom types, image types, 20 MiB) lives in `apps/api/src/gyms/gyms.constants.ts`. `GYM_TYPES` and the category list are compiled against the Prisma enum and the seed so they cannot drift.

### 2.2 The default gym

At most one gym per user is the default. The database decides, not the service:

- `gyms_user_default_uniq_idx` is a raw-SQL partial unique index (`(user_id) WHERE is_default = true`) that exists only in the migration SQL. Prisma cannot express it. Never declare it as `@@unique` and never replace it with a `findFirst` pre-check.
- The first gym a user creates becomes the default.
- `POST /api/gyms/:id/default` demotes the old default and promotes the target in one transaction.
- Deleting the default promotes the oldest remaining gym in the same transaction; deleting the last gym leaves none.
- A write that loses the race for the slot gets a unique violation, retries once, and then answers `409` with `details.reason: DEFAULT_CONFLICT`.

### 2.3 The catalog and slug permanence

- The seeded catalog is `CAPABILITY_CATALOG` and `EQUIPMENT_CATALOG` in `apps/api/prisma/seed-data.ts`. `npm run prisma:seed` upserts it by `slug`, so re-running it changes no row count and never touches a custom type.
- **A slug is permanent once seeded.** Gym equipment, intake drafts and the AI scan vocabulary all key on it. Rename the display `name` freely; never rename or reuse a `slug`.
- Custom equipment gets a slug `custom-<8 random characters>` from `customSlug()`. A user creates, renames and deletes only their own custom types; a catalog row or another user's row answers `404`. Deleting a custom type still used by gym equipment is a `409` with `details.reason: EQUIPMENT_TYPE_IN_USE`.
- `GET /api/equipment-types?q=` matches the query as a case-insensitive substring of the name or any alias, over the seeded catalog plus the caller's custom types. The picker's search ("cross" finds the elliptical "cross trainer") relies on the aliases.
- The catalog has no `other` row. `other` exists only in the scan vocabulary ([section 2.7](#27-the-scan-job)): an unknown machine becomes a custom type when the scan is applied.

### 2.4 Provenance

Every `gym_equipment` row records where it came from.

| Field | Rule |
|---|---|
| `origin` | `manual` for a row the user adds through the equipment routes; `ai` for a row applied from a scan draft that came from the model |
| `confidence` | `high`, `medium` or `low` on an AI row; null on a manual row |
| `userVerified` | `true` on a manual row; on an AI row `false` until the user accepts or edits the draft, so it is `true` once applied |
| `originalAiValue` | Write-once JSON snapshot of what the AI proposed (`equipmentTypeId`, `quantity`, `brand`, `model`, `notes`), kept when the user changed the AI value before applying, or edits the row later |

- The first edit of an `origin: 'ai'` row through `PATCH /api/gyms/:id/equipment/:equipmentId` snapshots the previous values into `originalAiValue` with a conditional update, so a concurrent second edit cannot overwrite the snapshot with an already-edited value.
- The web list shows an "AI guess" tag until `userVerified`, "You verified" afterwards, and "AI said: ..." from `originalAiValue`.
- The same rules for the draft item (before apply) are in the [intake README](../../apps/api/src/intake/README.md#provenance-fields); apply carries them onto the gym row.

### 2.5 Photos and storage references

- Bytes never pass through the gyms routes. The browser uploads the image to `POST /api/storage/objects` and attaches the resulting object with `POST /api/gyms/:id/photos { storageObjectId }`.
- The object must be the caller's (another user's is a `404`), `ready` (`OBJECT_NOT_READY`), a PNG, JPEG, GIF or WebP image (`UNSUPPORTED_MEDIA_TYPE`) and at most 20 MiB (`OBJECT_TOO_LARGE`). One object is one photo: `gym_photos.storage_object_id` is unique, and a second attach is a `409 PHOTO_ALREADY_ATTACHED` decided by the index.
- A photo can be linked to the equipment rows it shows (`PATCH .../photos/:photoId`); the link must stay inside the same gym (`EQUIPMENT_NOT_IN_GYM`).
- Removing a photo or a gym deletes the storage object **after** the database write commits, best effort: a provider failure is logged and the user's action still succeeds. `GymStorageService.deleteObjects` skips an object another row still holds (another gym photo, or an unapplied photo intake). Links of **applied** intakes are history, not holders; they go with the object by cascade.
- The other direction: discarding an intake or detaching a photo from it deletes each object that no intake links any more. `GymPhotoObjectReferences` (`gyms/intake/gym-photo-references.ts`) registers with `StorageObjectReferences` so an object that became a gym photo is kept. The mechanism is documented once in the [intake README](../../apps/api/src/intake/README.md#6-keep-photos-other-features-use).

### 2.6 The `gym_equipment` intake kind

"Scan gym" is one registered intake kind, `gym_equipment` (`gyms/intake/gym-equipment.intake-kind.ts`). The kit contract (lifecycle, `IntakeKind` members, `apply` inside one transaction, `replaceAiDrafts`, error reasons, ownership) is owned by the [intake README](../../apps/api/src/intake/README.md); this section lists only what is specific to gyms.

| Member | Value |
|---|---|
| `kind` | `gym_equipment` (permanent once intakes carry it) |
| context | `{ gymId }`, strict; `assertContext` makes another user's gym a `404`; the intake's subject is the gym, so `GET /intakes?kind=gym_equipment&subjectId=<gymId>` resumes an unfinished scan |
| `analyzeJobType` | `ai.equipment.scan` |
| `maxPhotos` | 48 |
| `itemKinds` | `equipment` |
| `requiredPermissions` | read `gyms:read`, write `gyms:write`, on top of `intakes:*` |
| draft value | `gymEquipmentValueSchema` (`gyms/intake/gym-equipment.value.ts`): `equipmentTypeSlug` (catalog slug, own custom slug, or null for "other"), `name`, `quantity`, `quantityUncertain`, `brand`, `brandEvidence`, `model`, `configuration`, `notes`, `capabilitySlugs`, `targetMuscles` |

- `normalizeValue` recomputes `name`, `capabilitySlugs` and `targetMuscles` from the slug's type, so a client can never make them disagree with the catalog. A user edit with an unknown slug is a `400` naming the field; the analyzer path is lenient so a doubtful item is shown flagged rather than dropped.
- **Apply** (one transaction, every write through `tx`) does four things:
  1. Every intake photo becomes a gym photo (an object already attached is skipped; past 100 photos the rest are skipped and counted).
  2. Each accepted item resolves to a type: a catalog or own-custom slug is that row; a null slug reuses the caller's custom type with the same name (case-insensitive) or creates one (category `cardio` when a capability is cardio, else `accessories`), once per name per apply.
  3. A gym row with the same `(type, lower(brand), lower(model))` is left untouched and counted `merged`; otherwise a row is created with the item's provenance.
  4. The equipment row is linked to the gym photos of the item's `sourcePhotoIds`.
- The apply result is `{ gymId, created, merged, photosAttached, photosSkipped }`.
- Rejected items never reach apply. An AI item cannot be deleted (`409 USE_REJECT`); it is rejected instead, so its provenance survives.

### 2.7 The scan job

`ai.equipment.scan` (`gyms/scan/equipment-scan.handler.ts`) is enqueued by `POST /api/intakes/:id/analyze` in the transaction that flips the intake to `scanning`. Its payload is `{ intakeId }`.

**Server-only, permanently.** It implements neither `nodeResultSchema` nor `persistNodeResult`: the call spends the user's own provider key or the organization key, and no AI key reaches a worker node. `apps/api/test/ai/ai-jobs-server-only.spec.ts` discovers the type automatically. Profile: `{ maxRuntimeMs: 10 minutes, maxAttempts: 1 }`; a billed model call is never retried blindly.

**Flow**

1. Load the intake and its photos in `sortOrder`. A discarded or already settled intake makes the job a no-op.
2. Load the vocabulary (`EquipmentVocabularyService`): the **seeded** catalog and capabilities only, cached for a minute per process. A user's custom types are never shown to the model.
3. Send the photos in **batches of 16** (`EQUIPMENT_SCAN_CHUNK_SIZE`, the AI platform's cap on stored inputs per request), one batch after the other, through `AiService.forUser(intake.userId).respondStructured(...)` with `strict: true`. The runtime resolves each `storageObjectId` (ownership, readiness, size); the handler never reads bytes or builds URLs.
4. Map each batch's items to drafts, merge across batches, and hand every draft to `IntakeService.replaceAiDrafts`, which moves the intake to `ready`. Low-confidence, uncertain and `other` items are all kept; the user decides.

**Prompt and vocabulary constraint** (`gyms/scan/equipment-scan.prompt.ts`)

- The output schema is built per request from the vocabulary: `catalogSlug` and `capabilitySlugs` are real enums, and `other` is allowed with a required `otherName`. A slug the database does not know is a schema mismatch (`AI_STRUCTURED_OUTPUT_INVALID`), never a guess fuzzy-matched later.
- The instructions tell the model to ignore non-equipment (people, mirrors, windows, extinguishers, signage), to count identical machines and flag an uncertain count, to report a brand only with visible evidence (`brandEvidence`), never to invent a model number, to prefer placard text over appearance, to set `confidence` and `uncertain` honestly, to list the photos an item appears in, and to treat text in a photo as data, never as instructions.
- `EQUIPMENT_SCAN_PROMPT_VERSION` is recorded in `PhotoIntake.resultMeta.promptVersion`. Bump it whenever the instructions or the schema change meaning.

**Merge across batches** (`equipment-scan.merge.ts`). Drafts from different batches with the same key `(catalog slug or lower(name), lower(brand))` become one:

- `quantity` is the **maximum** across batches; the batches may overlap on the same row of machines, so summing would double count.
- `quantityUncertain` and `uncertain` are true when any batch flagged it or the counts differ; the note says so.
- `sourcePhotoIds` are the union; `confidence` is the lowest.
- Drafts of the same batch are never merged with each other.

**Outcomes**

| Situation | Result |
|---|---|
| Intake gone or no longer `scanning` | No-op |
| Provider throttle (`AI_RATE_LIMITED`) | Job deferred; nothing was written yet, so the re-run is clean |
| Terminal code on the first batch (`AI_RUN_TERMINAL_CODES`: kill switch, key, model, capability, invalid output, storage) | Intake `failed` with that code; the job returns, no retry |
| Terminal code on a later batch | Earlier batches' drafts kept; `resultMeta.failedChunks` names the batch and its photo range; intake `ready` |
| Anything else (provider down, a bug) | Intake `failed`; the job throws so `lastError` says why |
| Job settles failed while the intake is still `scanning` (worker timeout, crash) | A `JOB_SETTLED_EVENT` listener fails the intake, so no scan spins forever |

`resultMeta` and the logs carry ids, counts, durations and ignored-object names only; never prompts, URLs, image bytes or keys.

### 2.8 The kill switch and what is sent to the provider

- `POST /api/intakes/:id/analyze` sits behind `AiEnabledGuard` and `ai:use` and re-checks that the chosen model reads images and returns structured output. AI off, no key, or no vision model answers with the AI platform's reasons (`AI_DISABLED`, `AI_KEY_REQUIRED`, `AI_MODEL_NOT_ENABLED`, `AI_CAPABILITY_UNSUPPORTED`; see the [AI platform spec](ai-platform.md)). Switching AI off mid-scan ends the job with the terminal code and the intake `failed`.
- **Sent:** the scan instructions plus the seeded vocabulary (slugs, names, aliases), and per photo a `Photo N:` label with the image at `detail: high`.
- **Never sent:** the gym's name, description, notes, type or **coordinates**; the user's identity or email; any key; custom equipment types. The handler does not read the `gyms` row at all.
- The keys stay server-side ([AI platform rules](../../CLAUDE.md#mandatory-ai-platform-rules)). The web page names the provider, model and whose key pays before the first photo is sent (`AiVisionDisclosure`), and spells out the request count above 16 photos.

### 2.9 GPS location (optional)

- A gym may carry `latitude` and `longitude`, set with `PUT /api/gyms/:id/location` and cleared with `DELETE /api/gyms/:id/location`. Both are one field pair on the row; there is no separate table.
- The user types the coordinates (a pasted `lat, lng` pair splits into both fields) or presses **Use my location**. The button asks the browser **once**, from the click (`useGeolocationOnce`, never `watchPosition`), and only fills the fields; nothing is saved until the user saves. The button is hidden where the browser has no geolocation or the context is not secure; manual entry always works, including after a denied prompt.
- Stored coordinates are rounded to 5 decimals (about 1 m). `accuracyMeters` may accompany a write so the response can echo it; it is validated, **never stored and never logged**.
- Coordinates are personal data: returned to their owner only, never logged, never a span attribute, never sent to an AI provider ([section 2.8](#28-the-kill-switch-and-what-is-sent-to-the-provider)).
- The browser permission comes from the nginx `Permissions-Policy` header: `geolocation=(self)` grants it to the app origin and never to a frame (`infra/nginx/nginx.conf`). The camera stays denied.

### 2.10 Manual-first guarantees

- Creating a gym, picking or searching catalog equipment, adding custom equipment, setting quantity, brand and model, attaching photos and setting the default use no AI route and no AI permission.
- **Scan gym** is disabled with a plain-language reason when the user lacks a permission (`gyms:write`, `intakes:write`, `storage:write`, `ai:use`) or AI is off, has no key or has no vision model (`apps/web/src/components/gyms/scanAvailability.ts`). The API is the gate; the page only explains.
- The scan page always offers **Continue manually**, which opens the equipment picker on the gym page.
- AI output is a draft: reviewable, editable, deletable by rejection, with confidence and uncertainty always shown and a low-confidence row never collapsed.

### 2.11 Reference examples

Two committed photos with deterministic expected output show the behaviour end to end.

| Example | Photo | Model output the fake returns | Expected drafts |
|---|---|---|---|
| A wide shot of a cardio row | [`cardio-row-wide.jpg`](../examples/gym-scan/cardio-row-wide.jpg) | [`cardio-row-wide.model-output.json`](../../apps/api/test/fixtures/gym-scan/cardio-row-wide.model-output.json) | [`cardio-row-wide.expected-drafts.json`](../../apps/api/test/fixtures/gym-scan/cardio-row-wide.expected-drafts.json) |
| A placard on a leg curl machine | [`leg-curl-placard.jpg`](../examples/gym-scan/leg-curl-placard.jpg) | [`leg-curl-placard.model-output.json`](../../apps/api/test/fixtures/gym-scan/leg-curl-placard.model-output.json) | [`leg-curl-placard.expected-drafts.json`](../../apps/api/test/fixtures/gym-scan/leg-curl-placard.expected-drafts.json) |

The first shows an uncertain count, brand evidence from lettering, a partly visible machine at low confidence, and ignored non-equipment. The second shows placard text beating appearance. A third fixture, [`both.model-output.json`](../../apps/api/test/fixtures/gym-scan/both.model-output.json), is the answer for both photos in one request.

### 2.12 The fake vision server

For owner testing and e2e, `tests/e2e/support/fake-vision-server.mjs` is a dependency-free, OpenAI-compatible server that answers every chat completion with a canned fixture, so the real gate pipeline, storage resolution and job path run with no key and no cost. Its routes are documented in the file header.

The overlay mounts all of `apps/api/test/fixtures` read-only and the server reads `*.model-output.json` from its `gym-scan/` and `workout-prefill/` folders. Besides the gym-scan fixtures below, it serves `workout-placard` and `workout-notebook` for "Prefill from photo" ([5.24 in ARCHITECTURE](../ARCHITECTURE.md#524-workout-logging)).

1. Start the stack with the overlay (`infra/compose/fake-ai.compose.yml`, service `fake-ai`, host port 4010):

   ```bash
   cd infra/compose
   docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml -f fake-ai.compose.yml up
   ```

2. As admin, at `/admin/settings/ai`, turn AI on and enable the OpenAI-compatible provider with base URL `http://fake-ai:4010/v1`, API style `chat_completions` and "requires key" off. Nothing is configured with an environment variable.
3. At `/admin/settings/ai/models`, refresh the catalog. `fake-vision` arrives unclassified: give it the `responses`, `structured_output` and `vision_input` capabilities and the `text` and `image` input modalities, and enable it.
4. Choose the answer for the next request, and inspect what the fake received (image counts only, never bytes):

   ```bash
   curl -X POST localhost:4010/__control/next -d '{"fixture":"leg-curl-placard"}'   # or cardio-row-wide, both, workout-placard, workout-notebook
   curl localhost:4010/__control/requests
   curl -X POST localhost:4010/__control/reset
   ```

Fixtures are chosen by the control endpoint, not by image hash: the web client downscales photos with a canvas, so the bytes the fake receives differ from the committed files. Without a queued fixture, one image gets `cardio-row-wide` and two or more get `both`. The Playwright specs that use it are listed in [TESTING.md](../TESTING.md#end-to-end-tests-playwright).

## 3. Configuration and permissions

**Settings and environment.** None. The feature adds no environment variable and no settings page. AI, the vision model and the key policy are configured at runtime ([ai-configuration runbook](../runbooks/ai-configuration.md)); storage at `/admin/settings/storage`.

**Permissions.** The matrix is in [ARCHITECTURE.md](../ARCHITECTURE.md#7-authorization); all three seeded roles hold `gyms:*` and `intakes:*`.

| Permission | Guards |
|---|---|
| `gyms:read` | Reading own gyms, equipment, photos, the catalog and capabilities |
| `gyms:write` | Creating, editing and deleting own gyms, equipment, custom types and the location |
| `storage:write` | Also required to attach or remove a gym photo, and to upload photos for a scan (a viewer lacks it) |
| `intakes:read`, `intakes:write` | The intake routes a scan uses |
| `ai:use` | Also required by `POST /api/intakes/:id/analyze`, behind `AiEnabledGuard` (a viewer lacks it) |

The `gym_equipment` kind declares `requiredPermissions` (`gyms:read`, `gyms:write`), so the generic intake routes cannot become a side door around `gyms:*`: a missing permission is a `403` with `details.reason: MISSING_KIND_PERMISSIONS`. See the [security architecture](../SECURITY-ARCHITECTURE.md).

**Routes.** Compact table; parameters, bodies and responses are in `/api/docs` (`npm run openapi:dump`).

| Route | Permission |
|---|---|
| `GET`, `POST /api/gyms`; `GET`, `PATCH`, `DELETE /api/gyms/:id` | `gyms:read` (reads), `gyms:write` |
| `POST /api/gyms/:id/default` | `gyms:write` |
| `PUT`, `DELETE /api/gyms/:id/location` | `gyms:write` |
| `GET`, `POST /api/gyms/:id/equipment`; `PATCH`, `DELETE .../equipment/:equipmentId` | `gyms:read` (list), `gyms:write` |
| `GET /api/gyms/:id/photos`; `PATCH .../photos/:photoId` | `gyms:read`, `gyms:write` |
| `POST /api/gyms/:id/photos`; `DELETE .../photos/:photoId` | `gyms:write` and `storage:write` |
| `GET`, `POST /api/equipment-types`; `PATCH`, `DELETE /api/equipment-types/:id` | `gyms:read` (list), `gyms:write` |
| `GET /api/capabilities` | `gyms:read` |
| `POST /api/intakes` (`kind: gym_equipment`), photos, items, `apply`, `DELETE` | `intakes:write` plus the kind's `gyms:write` |
| `POST /api/intakes/:id/analyze` | `intakes:write`, `ai:use`, `gyms:write`; `AiEnabledGuard` |

Refusals carry `details.reason` (values in `GYM_REFUSALS`, `apps/api/src/gyms/gyms.constants.ts`; intake reasons in the intake README).

## 4. Extending it in a fork

| To | Do |
|---|---|
| Add equipment or a capability to the catalog | Append a row to `EQUIPMENT_CATALOG` or `CAPABILITY_CATALOG` in `apps/api/prisma/seed-data.ts` with a new permanent `slug` and existing capability slugs (an unknown one makes the seed throw), then `npm run prisma:seed`. The scan vocabulary picks it up within a minute. `apps/api/test/gyms/gym-catalog.spec.ts` guards the shape |
| Change a display name or alias | Edit `name` or `aliases` in the seed and re-seed. Never change a `slug` |
| Add an equipment category | Extend `EQUIPMENT_CATEGORIES` in both `seed-data.ts` and `gyms.constants.ts`, then add the label in the web picker |
| Add a gym type | Add the value to the Prisma `GymType` enum (migration) and to `GYM_TYPES`; the `satisfies` check breaks the build if the two differ |
| Change what the scan asks the model | Edit `equipment-scan.prompt.ts` and bump `EQUIPMENT_SCAN_PROMPT_VERSION`; update the fixtures and the prompt spec |
| Build another photo-to-rows flow | Add an intake kind: [intake README](../../apps/api/src/intake/README.md#adding-a-kind), with `GymEquipmentIntakeKind` as the worked example. The analyzer is a server-only `ai.*` job ([job handlers README](../../apps/api/src/jobs/handlers/README.md), [AI README](../../apps/api/src/ai/README.md)) |
| Show the equipment elsewhere | Read `GymEquipmentService` or `GymsService`; never query the gym tables of another user |

## 5. Guardrails

- `apps/api/test/gyms/gyms.integration.spec.ts`: the HTTP contract through the real guards: `401` without a token, `403` without the exact permission on every route, `storage:write` on photo attach and remove, the `{ data }` envelope, and owner scoping.
- `apps/api/test/gyms/gyms.db.spec.ts`: the raw-SQL `gyms_user_default_uniq_idx` and `CHECK` constraints, cascade and restrict rules, and that re-seeding leaves counts unchanged and custom types untouched.
- `apps/api/test/gyms/gyms-api.db.spec.ts`: concurrent "make default" leaves one default; deleting the default promotes the oldest; a deleted gym's storage objects are gone; catalog search by alias; custom-type ownership and the in-use rule; the AI-row snapshot.
- `apps/api/test/gyms/gym-catalog.spec.ts`: the seeded catalogs are well formed (unique slugs, known capability slugs, known categories).
- `apps/api/test/gyms/gym-equipment-scan.db.spec.ts`: both reference examples run through create, attach, analyze, the real job and read-back, and yield exactly `*.expected-drafts.json`; apply merge and photo attach.
- `apps/api/test/gyms/fake-vision-server.spec.ts`: the fake server through the production OpenAI-compatible adapter.
- `apps/api/test/gyms/gym-location-privacy.spec.ts`: a source tripwire that fails when the gyms module logs or traces a coordinate or accuracy, or the scan reads them.
- `apps/api/src/gyms/scan/equipment-scan.handler.spec.ts`: chunking, terminal and retryable outcomes, deferral on a throttle, the settle safety net, zero calls with the kill switch on, and that no coordinate or gym field reaches the provider.
- `apps/api/src/gyms/scan/equipment-scan.merge.spec.ts`, `equipment-scan.mapper.spec.ts`, `equipment-scan.prompt.spec.ts`: max-not-sum, mapping, and that the prompt lists every slug.
- `apps/api/src/gyms/intake/gym-equipment.intake-kind.spec.ts`, `gym-photo-references.spec.ts`: value normalization, apply, and the photo-reference checker.
- `apps/api/test/ai/ai-jobs-server-only.spec.ts`: `ai.equipment.scan` has no node hooks.
- `apps/web/src/__tests__/infra/geolocation-browser-policy.test.ts`: the nginx policy grants `geolocation=(self)` and nothing broader.
- `apps/web/src/__tests__/components/gyms/GymLocationField.test.tsx`, `hooks/useGeolocationOnce.test.ts`: one-shot location, manual entry after a denial.
- `apps/web/src/__tests__/pages/GymScanPage.test.tsx`, `GymDetailPage.test.tsx`, `components/gyms/ScanGymButton.test.tsx`: the scan states, "Continue manually", and the disabled-with-reason button.
- `tests/e2e/specs/gyms.spec.ts`, `tests/e2e/specs/gym-scan.spec.ts`: the manual path and both reference examples against the running stack.

## 6. Design decisions

- **Maximum across batches, not the sum.** Batches of a large room overlap on the same row of machines. Summing double counts; the maximum can only undercount, and the differing counts set `quantityUncertain` so the user checks. Rejected: sum (silent inflation), first batch wins (silent loss).
- **An `other` slug instead of free text or a fuzzy match.** The model must pick from the seeded slugs or say `other` with a name. Rejected: open text matched to the catalog afterwards (a wrong guess looks confident); refusing unknown machines (the user loses a real machine). An `other` item becomes a custom equipment type when applied.
- **Draft rows live on the server.** Drafts are stored in the intake, not in the browser, so a scan survives a reload, resumes from the gym's page, and ownership, state and provenance rules are enforced in one place. Rejected: holding the draft in component state.
- **Custom equipment types are rows.** A custom type is an `equipment_types` row with `ownerUserId`, not a free-text field on the gym row. The same joins, capabilities, search and in-use rule apply to it, and a later feature can plan workouts around it. Rejected: a `name` column on `gym_equipment` (no capabilities, no reuse).
- **The database owns the default gym.** A partial unique index settles concurrent requests. Rejected: a `findFirst` pre-check (races) and a `@@unique` (would forbid several non-default gyms).
- **A scan is never retried blindly.** `maxAttempts: 1`; a throttle defers, a terminal code ends. A later batch failing keeps the earlier batches so a partial result is not thrown away.
- **Coordinates stay out of the AI request.** The scan needs no location, so the handler never loads the gym. This makes "never sent" a structural fact a test can check, not a filtering rule.
- **The accuracy is echoed, not stored.** It describes one fix, not the place; storing it would invite treating a stale number as current.

## 7. Verification

```bash
npm test --workspace=api -- gyms                 # unit and mocked integration
npm run test:db --workspace=api                  # real-Postgres tier (default index, seed, scan end to end)
npm run test:run --workspace=web                 # scan page, location field, geolocation policy
npm run typecheck --workspace=api
npm run openapi:dump && npm run openapi:lint
```

Then walk it in the app (`http://localhost:3535`, sign in at `/testing/login`):

1. As a contributor open `/gyms`, create a gym, add "Elliptical" from the picker by searching "cross", add a custom item, attach a photo, reload. Everything persists and nothing asked for AI.
2. Start the stack with the fake overlay ([section 2.12](#212-the-fake-vision-server)), choose `cardio-row-wide`, open **Scan gym**, upload `docs/examples/gym-scan/cardio-row-wide.jpg`, read the disclosure, scan. Four rows appear, the low-confidence one visible; edit the elliptical quantity, apply. The row shows "You verified" and "AI said: ×3".
3. `curl localhost:4010/__control/requests` reports the image count and nothing else.
4. Turn AI off at `/admin/settings/ai`: **Scan gym** is disabled with the reason and the manual path still works.

## History

- Photo-intake foundation: #34.
- Gym, equipment catalog and capabilities (schema and seeds): #40.
- Gym CRUD API and manual UI: #43.
- AI Scan Gym: `ai.equipment.scan`, the vision prompt, draft review and the fake vision server: #48.
- Optional GPS location on a gym: #51.
- End-to-end tests and this spec: #55.
