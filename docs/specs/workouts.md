# Exercise Library and Workout Logging

> **Status:** shipped (exercise library, custom exercises, workout logging, personal records, training summary, AI "Prefill from photo") · **Code:** `apps/api/src/exercises/`, `apps/api/src/workouts/`, `apps/web/src/pages/Train*.tsx`, `apps/web/src/pages/Workout*.tsx`, `apps/web/src/components/train/`, `apps/web/src/components/today/TodayWorkout.tsx` · **API:** `/api/exercises/*`, `/api/workouts/*` (see `/api/docs`, group "Training", tags "Exercises" and "Workouts"; the prefill uses the "Intakes" routes) · **Admin UI:** none (user pages `/train`, `/train/exercises`, `/train/workouts/:workoutId`, `/train/workouts/:workoutId/prefill`) · **Runbook:** none (AI setup: [ai-configuration](../runbooks/ai-configuration.md)) · **Recipe:** [section 4](#4-extending-it-in-a-fork)

A workout is one logged training session: the exercises done, and for each the sets with weight, reps, time or distance. Exercises come from a seeded library that knows which equipment each one needs, or from the user's own custom exercises. Every piece of data is logged by hand first. **Prefill from photo** is an optional shortcut on top: the user shares a photo of a machine placard, a notebook page or a whiteboard, a server-only AI job drafts the exercises and sets, and the user reviews, edits and applies them. Prefilled sets arrive uncompleted, so nothing counts as done work until the user checks it off. Personal records are computed when a workout is read, never stored.

## 1. Purpose

- **What it is.**
  - The place a user records what they trained, with fast entry while training and a history to look back on.
  - A shared, slug-keyed exercise library whose availability follows the equipment of a gym ([gyms-and-equipment.md](gyms-and-equipment.md)).
  - "Last time" and personal-record feedback computed from the user's own history.
  - The second worked example of the photo-intake kit ([intake README](../../apps/api/src/intake/README.md)) and of a vision `ai.*` job.
- **What it is not.**
  - Not a training program. A workout is ad hoc; only `WorkoutsService.startPrefilled` writes `programWorkoutId`, when the training-programs layer starts a planned workout and records a `program_sessions` link (see [ARCHITECTURE.md §5.25](../ARCHITECTURE.md#525-training-programs)).
  - Not AI coaching. AI only reads a photo into a draft; it never suggests, plans or judges a workout.
  - Not shared between users. A workout, its sets and photos, and custom exercises belong to one user; a foreign id answers `404`.
  - Not AI-dependent. Every flow works with AI off, without a key and without a vision model.

## 2. How it works

### 2.1 Data model

| Table | Holds |
|---|---|
| `exercises` | The library: permanent `slug`, `name`, `primaryMuscles`, `secondaryMuscles`, `movementPattern`, `trackingMode`, `isUnilateral`, `isBodyweight`, `aliases`. `ownerUserId` is null for a seeded row and the owner's id for a custom exercise; `origin` is `seed`, `user` or `ai`; `status` is `active` or `pending_review` |
| `exercise_requirements` | What an exercise needs: rows sharing a `groupIndex`, each naming an equipment type or a capability |
| `workouts` | One session: `name`, local calendar `date`, `status` (`in_progress`, `completed`), `startedAt`, `endedAt`, `durationSeconds`, optional `gymId`, `notes`, `readinessSnapshot`, optional `programWorkoutId` (set by `startPrefilled`) |
| `workout_exercises` | An exercise inside a workout: dense 0-based `position`, optional equipment type actually used, `notes` |
| `set_logs` | One set: `setNumber`, `weightKg`, `reps`, `durationSeconds`, `distanceMeters`, `rpe`, `rir`, `restSeconds`, `isWarmup`, `completed`, `completedAt`, `painFlag`, `painNote`, `notes` |
| `workout_photos` | A photo attached to a workout: a unique link to a `storage_objects` row, `caption` |

The columns, relations and delete rules are in `apps/api/prisma/schema.prisma` (models `Exercise` to `SetLog`); the table inventory is in [ARCHITECTURE.md](../ARCHITECTURE.md#61-prisma-models). The migrations are `add_exercise_library`, `fix_exercise_primary_muscles_check`, `add_workout_logging` and `add_workout_photos`.

- Deleting a user cascades to their workouts and custom exercises. Deleting a workout cascades to its exercises, sets and photo links. Deleting a gym sets `workouts.gymId` to null. An exercise is `Restrict`ed while a workout uses it (`EXERCISE_IN_USE`).
- Value ranges (`set_logs_ranges_chk`, the status, name-length and position checks) are `CHECK` constraints written in the migration SQL, mirrored by the Zod bounds in `apps/api/src/workouts/workouts.constants.ts` (`SET_BOUNDS`). Every limit and refusal reason of the two modules lives in that file and in `apps/api/src/exercises/exercises.constants.ts`.
- `programWorkoutId` and `exercises.proposedByRunId` are deliberately not foreign keys.
- Vocabularies (muscles, movement patterns, tracking modes) live in `apps/api/src/common/constants/training.constants.ts`.

### 2.2 One workout in progress

At most one workout per user is `in_progress`. The database decides, not the service:

- `workouts_user_in_progress_uniq_idx` is a raw-SQL partial unique index (`(user_id) WHERE status = 'in_progress'`) that exists only in the migration SQL. Prisma cannot express it. Never declare it as `@@unique` and never replace it with a `findFirst` pre-check.
- `POST /api/workouts` catches the unique violation and answers `200` with the winning workout and `existing: true`; a new workout answers `201` with `existing: false`. Two racing starts therefore return the same workout.
- Finishing a workout frees the slot. An in-progress workout is never auto-finished.

### 2.3 Units: kilograms and metres

- The API stores and returns `weightKg` (up to 3 decimals) and `distanceMeters` (up to 2). Decimals come back as JSON numbers.
- The display unit is the Health Profile `unitSystem`, not a setting of its own: `imperial` reads pounds, otherwise kilograms. The web converts in `apps/web/src/utils/units.ts` (kilograms per pound is exactly `0.45359237`; the typed value is rounded to 0.001 kg).
- Because storage is canonical, switching the unit system changes what is displayed and never a stored value. A weight typed as 135 lb is stored as 61.235 kg and reads 135.0 lb again.
- Every API consumer (CLI, another client) speaks kilograms; the API never converts.

### 2.4 The exercise library

- **Catalog.** The seeded library is `EXERCISE_CATALOG` in `apps/api/prisma/seed-data.ts`, written one exercise per line in a compact notation documented above `EXERCISE_LINES`. `npm run prisma:seed` upserts it by `slug` and re-syncs each seeded exercise's requirement rows; it never touches a custom exercise and throws when a catalog slug is already taken by a user-owned one.
- **A slug is permanent once seeded.** Workout entries, prefill drafts and the prefill vocabulary key on it. Rename the display `name` freely; never rename or reuse a `slug`.
- **Requirement groups (AND of OR).** Rows sharing a `groupIndex` are alternatives (any one satisfies the group). Every group must be satisfied. Each row names an equipment type or a capability, never both (a `CHECK`). `-` in the seed notation means no requirement, so the exercise is always available (bodyweight, outdoor).
- **Availability.** `ExerciseAvailabilityService` evaluates the groups against a gym's equipment types and the capabilities they enable. `GET /api/exercises?gymId=` marks each item `available` and lists `missing` (the option names of the first unsatisfied group); `availableOnly=true` (which requires `gymId`) filters to the available ones. The web picker hides unavailable exercises until **Show all**, which shows them with what they need.
- **Custom exercises.** A user creates, edits and deletes their own (slug `custom-<8 random characters>`, at most 200 per user, `origin` `user`). A library row is read-only (`LIBRARY_EXERCISE_READ_ONLY`); a foreign custom exercise answers `404`.
- **Review status.** An exercise with `status` `pending_review` is hidden from lists and refused by `POST /api/workouts/:id/exercises` (`EXERCISE_PENDING_REVIEW`) until its owner approves it (`POST /api/exercises/:id/approve`) or deletes it. Prefill creates its custom exercises `active` (the user already reviewed the draft).
- **Tracking modes.** `weight_reps`, `bodyweight_reps`, `time` and `distance_time` decide which fields the logger shows and whether the exercise can earn records ([section 2.7](#27-personal-records)).
- **Outdoor cardio.** `outdoor_run`, `outdoor_walk` and `hike` are seeded with pattern `cardio`, tracking mode `distance_time`, body part `full_body` and no equipment requirement, so they are available at any gym or none. Search aliases: `outdoor_run` jog, jogging, run, running; `outdoor_walk` walk, walking, stroll; `hike` hiking, trail walk. Their slugs are permanent: finishing a workout credits activity goals by slug ([activity-goals.md](activity-goals.md#24-workout-auto-credit)).
- **Cardio prescriptions.** A plan prescribes a `time` or `distance_time` exercise as a total duration and/or distance for the session (a **cardio** prescription: `targetDurationSeconds` 60 to 36,000 s, `targetDistanceMeters` 100 to 100,000 m, no reps) instead of sets and reps. The shapes, the per-tracking-mode rule and the `PRESCRIPTION_SHAPE_MISMATCH` refusal are in [ARCHITECTURE.md §5.25](../ARCHITECTURE.md#525-training-programs). Starting a planned cardio workout (`WorkoutsService.startPrefilled`) creates the prescribed number of sets (one when the plan leaves it open) with no values: no reps, no load, and no duration or distance copied in. The target is shown from the plan, and what the user logs on those sets is what the plan's signals grade ([training-signals.md](training-signals.md#22-definitions)).

### 2.5 Logging semantics

- **Ownership.** Every route filters by the caller's id. A workout, exercise entry, set or custom exercise of another user answers `404`. The gym must be the caller's; the exercise a library exercise or the caller's own active custom one.
- **Start.** `POST /api/workouts` takes an optional name, date, gym and start time; `date` defaults to today in the Health Profile time zone (UTC when unset) and must be within 2 days of the server's today (`WORKOUT_DATE_OUT_OF_RANGE`); `gymId` defaults to the user's default gym when omitted, while an explicit `gymId: null` starts a workout with no gym and is never overridden by the default. Times more than 5 minutes in the future are refused (`TIME_IN_FUTURE`).
- **Readiness snapshot.** At start the workout copies today's check-in by value from `CheckInsService` (null when there is none), so later edits of the check-in do not rewrite history. It never blocks starting.
- **Per-workout lock.** Writes to a workout's exercises and sets first take `SELECT ... FOR UPDATE` on the workout row (`workout-lock.ts`). That serializes `setNumber` allocation, the limits (30 exercises per workout, 40 sets per exercise) and the dense renumbering after a delete or reorder.
- **Dense numbering.** Exercise `position` is dense from 0 and `setNumber` dense from 1 per exercise. Adding appends; deleting or moving renumbers, so the numbers never have gaps.
- **Adding a set.** An omitted `weightKg`, `reps`, `durationSeconds` or `distanceMeters` is copied from the previous set of the exercise, so a second identical set is one tap.
- **Completing a set.** `completed: true` stamps `completedAt` and, when the set has no `restSeconds`, derives it from the workout's previous completion only if that was under 15 minutes ago (`REST_DERIVATION_WINDOW_SECONDS`). `completed: false` clears `completedAt`. Null clears a value.
- **Working set.** A completed, non-warm-up set. Totals (`setCount`, `volumeKg` = sum of weight x reps) count working sets only; warm-ups and uncompleted sets never count. The stricter rule the records use is in [section 2.7](#27-personal-records).
- **Discomfort flag.** `painFlag` (with an optional `painNote`) marks a set. It informs the user and never excludes the set from totals or records.
- **Finish.** `POST /api/workouts/:id/finish` is idempotent (a completed workout is returned unchanged). It sets `endedAt` (default now) and `durationSeconds`, deletes uncompleted sets that hold no value, and keeps uncompleted sets that do. The response carries the `summary` (totals and `summary.prs`). After the finish commits the `workout.finished` event credits the user's activity goals ([activity-goals.md](activity-goals.md#24-workout-auto-credit)).
- **Quick cardio log.** `POST /api/workouts/quick-cardio` (`workouts:write`) logs a gym-free walk, run or hike in one call (`QuickCardioService`):
  - Body (strict): `exerciseKey` (`outdoor_walk`, `outdoor_run` or `hike`), `durationSeconds` (integer, 60 to 36,000) and/or `distanceMeters` (above 0, at most 100,000, two decimals; at least one of the two is required), optional `performedAt` (ISO datetime with offset, default now) and optional `note` (at most 280 characters, stored as the workout notes).
  - `performedAt` is when the activity ended and must not be in the future (5 minutes of clock skew tolerated, 400 `TIME_IN_FUTURE`) nor more than 7 days ago (400 `PERFORMED_AT_OUT_OF_RANGE`). `startedAt` is `performedAt` minus the duration; `date` is the local day of `performedAt` in the Health Profile time zone.
  - One transaction creates a **completed** workout with `gymId` null, one exercise and one completed set carrying the duration and/or distance. It is created finished, so the one-in-progress index never sees it and it works while another workout is in progress.
  - **Plan link.** When the active plan has a planned workout on that local day that holds the exercise, the workout points at it through `programWorkoutId` and the response's `linkedProgramWorkoutId` carries its id; otherwise it is an extra session and the field is null. The resolution is read-only (`plannedWorkoutContaining`, which reuses the `resolveToday` occurrence rule). No `program_sessions` row is written, because that row snapshots a prescription at start and this workout was never started from the plan; the signals then grade it against the live plan's targets.
  - After commit it emits `workout.finished` exactly as a finish does, so activity goals are credited ([activity-goals.md](activity-goals.md#24-workout-auto-credit)) and the coach reacts.
  - The response is `201 { workout, linkedProgramWorkoutId }`; the workout has the shape `GET /api/workouts/:id` returns.
  - Web: the Today workout card's "Log a walk / run" opens `QuickCardioSheet` (a bottom sheet below `sm`, a dialog otherwise) with the activity, minutes and/or distance in the Health Profile unit, when, and a note.
- **Editing afterwards.** A workout can be edited in progress or completed (`PATCH /api/workouts/:id`): name, notes, gym, date and times; `endedAt` and `durationSeconds` apply to a completed workout only (`WORKOUT_NOT_COMPLETED`); a changed `startedAt` or `endedAt` without `durationSeconds` recomputes the duration. Sets can be edited or deleted after finishing, and records recompute on the next read.
- **Deleting.** `DELETE /api/workouts/:id` removes the workout and, after the delete commits, best effort, the storage objects of its photos that no other row holds (`WorkoutPhotoStorageService`, the same rule as gym photos).

### 2.6 History: last time and the training summary

- **Last time.** `GET /api/exercises/:id/history` (permission `workouts:read`) returns the caller's `lastTime` (the sets of the most recent workout with a completed set of that exercise, preferring the given gym), `recent` workouts (top set and best estimated 1RM each) and all-time `records`. `beforeDate` or `workoutId` bounds the history, so a workout in progress sees only what came before it. The route lives in `ExercisesController` and is served by `WorkoutHistoryService`; `ExercisesModule` imports `WorkoutsModule`, never the reverse.
- **Training summary.** `GET /api/workouts/summary` feeds the Today card (`TodayWorkout`): the workout in progress (or null), the last completed workout with totals and up to three top lifts, the number of completed workouts in the ISO week (Monday to Sunday) containing today, and the days since the last workout. `?today=YYYY-MM-DD` is the client's local day; it must be within 2 days of the server's today or the request is a `400` with `details.reason: TODAY_OUT_OF_RANGE`. It carries no record data, which keeps it cheap. The pure rules (`isoWeekStart`, `daysBetween`, `topLifts`) are in `workout-summary.ts`.

### 2.7 Personal records

- **Computed on read.** No table stores a record. `WorkoutHistoryService` derives each completed set's `prs` against the user's earlier working sets, and the workout views carry `summary.prs` (the best set per record type per exercise). An edit or delete therefore never leaves a stale record.
- **The rules.** A record is one of `first_time`, `weight`, `reps` (at that weight or heavier) and `e1rm` (Epley estimated one-rep max, 1 to 12 reps). Ties are not records. The working-set definition, the exact comparisons and the formulas live only in [`workout-records.ts`](../../apps/api/src/workouts/workout-records.ts) (pure functions, no Nest or Prisma imports); this spec does not restate them.
- **Prior history** of a workout is every working set of the same exercise in the caller's other completed workouts earlier by `(date, startedAt)`, aggregated in SQL per exercise and weight (one grouped query per call, never one per set), plus the earlier sets inside the workout itself.
- **Scope.** Only `weight_reps` and `bodyweight_reps` exercises earn records; time and distance exercises never do. Every query joins through `workouts.user_id` so another user's sets never enter a comparison.

### 2.8 Photos and storage references

- Bytes never pass through the workout routes. The browser uploads to `POST /api/storage/objects`; a photo becomes a `workout_photos` row only when a prefill is applied, which attaches every photo of the intake to the workout.
- One object is one photo (`workout_photos.storage_object_id` is unique); an object another workout already holds is skipped.
- `WorkoutPhotoObjectReferences` (`workouts/intake/workout-photo-references.ts`) registers with `StorageObjectReferences` so discarding an intake keeps an object that became a workout photo. The mechanism is documented once in the [intake README](../../apps/api/src/intake/README.md#6-keep-photos-other-features-use).
- The workout views carry `photos` (`id`, `storageObjectId`, `caption`, `createdAt`).

### 2.9 The `workout_prefill` intake kind

"Prefill from photo" is one registered intake kind, `workout_prefill` (`workouts/intake/workout-prefill.intake-kind.ts`). The kit contract (lifecycle, `IntakeKind` members, `apply` inside one transaction, `replaceAiDrafts`, error reasons, ownership) is owned by the [intake README](../../apps/api/src/intake/README.md); this section lists only what is specific to workouts.

| Member | Value |
|---|---|
| `kind` | `workout_prefill` (permanent once intakes carry it) |
| context | `{ workoutId, sourceHint? }`, strict; the workout must be the caller's and `in_progress` or `completed` (else `404`). `sourceHint` is `machine_placard`, `notebook` or `whiteboard`, given to the model as a hint, never a fact; `PATCH /api/intakes/:id` changes it. The intake's subject is the workout, so `GET /intakes?kind=workout_prefill&subjectId=<workoutId>` resumes an unfinished prefill |
| `analyzeJobType` | `ai.workout.prefill` |
| `maxPhotos` | 32 |
| `itemKinds` | `exercise` |
| `requiredPermissions` | read `workouts:read`, write `workouts:write` and `exercises:write` (apply may create a custom exercise), on top of `intakes:*` |
| draft value | `workoutPrefillValueSchema` (`workouts/intake/workout-prefill.value.ts`): `exerciseSlug` (library slug, own custom slug, or null), `name`, `rawText` (the line as transcribed), and up to 12 `sets` in kilograms and metres |

**Apply** (one transaction, every write through `tx`):

1. The workout row is locked with the same lock every exercise and set write takes. A workout deleted meanwhile is a `404` and the intake stays unapplied for a retry.
2. Every intake photo becomes a workout photo.
3. Each accepted item resolves its exercise: the slug's library or own custom exercise; else an active exercise with the same name (case and punctuation insensitive, aliases included); else a new custom exercise named after the item (`full_body`, `isolation`, tracking mode inferred from the sets), created once per name per apply.
4. It is appended as a workout exercise with its sets numbered from 1, **all uncompleted**. Past the 30-exercise cap the rest are skipped and counted.

The apply result is `{ workoutId, exercisesAdded, setsAdded, skipped, photosAttached }`. Rejected items never reach apply. An AI item cannot be deleted; it is rejected instead, so its provenance survives, and an edited item keeps the first AI value in `originalAiValue` (rules in the [intake README](../../apps/api/src/intake/README.md#provenance-fields)).

### 2.10 The prefill job

`ai.workout.prefill` (`workouts/prefill/workout-prefill.handler.ts`) is enqueued by `POST /api/intakes/:id/analyze` in the transaction that flips the intake to `scanning`. Its payload is `{ intakeId }`.

**Server-only, permanently.** It implements neither `nodeResultSchema` nor `persistNodeResult`: the call spends the user's own provider key or the organization key, and no AI key reaches a worker node. `apps/api/test/ai/ai-jobs-server-only.spec.ts` discovers the type automatically. Profile: `{ maxRuntimeMs: 10 minutes, maxAttempts: 1 }`; a billed model call is never retried blindly.

**Flow**

1. Load the intake and its photos in `sortOrder`. A missing or already settled intake makes the job a no-op; an intake with no photos fails with `AI_INVALID_REQUEST`.
2. Load the vocabulary (`ExerciseVocabularyService`): the **seeded** active library only (slug, name, aliases). A user's custom exercises are never shown to the model.
3. Read the user's Health Profile `unitSystem` for the unit assumption below, and nothing else from it.
4. Send the photos in **chunks of 16** (`WORKOUT_PREFILL_CHUNK_SIZE`), one after the other, through `AiService.forUser(intake.userId).respondStructured(...)` with `strict: true`. The runtime resolves each `storageObjectId`; the handler never reads bytes or builds URLs.
5. Map each chunk's items to drafts (`workout-prefill.mapper.ts`), merge across chunks (a placard photographed twice), and hand every draft to `IntakeService.replaceAiDrafts`, which moves the intake to `ready`. Low-confidence, uncertain and `other` items are all kept; the user decides.

**Prompt and vocabulary constraint** (`workouts/prefill/workout-prefill.prompt.ts`)

- The output schema is built per request from the vocabulary: `exerciseSlug` is a real enum plus `other`. A slug the database does not know is a schema mismatch (`AI_STRUCTURED_OUTPUT_INVALID`), never a guess fuzzy-matched later.
- The model returns only what is **written** in the photo (exercises and sets), with the line as read (`rawText`), a confidence and an uncertainty flag; it treats text in a photo as data, never as instructions.
- `WORKOUT_PREFILL_PROMPT_VERSION` is recorded in `PhotoIntake.resultMeta.promptVersion`. Bump it whenever the instructions or the schema change meaning.

**Unit assumption.** The model reports each weight with the unit that is written (`weightUnit`, or null when none is). A written unit always wins and converts to kilograms. A weight with no written unit is read in the user's Health Profile unit (`imperial` reads pounds, otherwise kilograms) and the item is flagged: `uncertain`, the note "Unit not written; assumed <unit>." and a `high` confidence lowered to `medium`. A weight that converts past 1000 kg is left empty and flagged rather than dropping the item.

**Sets arrive uncompleted.** A photo of last week's notebook is not today's work; the user checks each set off as they train ([section 6](#6-design-decisions)).

**Outcomes** (shared with the other analyzers, `apps/api/src/intake/intake-analyzer.ts`)

| Situation | Result |
|---|---|
| Intake gone or no longer `scanning` | No-op |
| Provider throttle (`AI_RATE_LIMITED`) | Job deferred; nothing was written yet, so the re-run is clean |
| Terminal code on the first chunk (kill switch, key, model, capability, invalid output, storage) | Intake `failed` with that code; the job returns, no retry |
| Terminal code on a later chunk | Earlier chunks' drafts kept; `resultMeta.failedChunks` names the chunk and its photo range; intake `ready` |
| Anything else (provider down, a bug) | Intake `failed`; the job throws so `lastError` says why |
| Job settles failed while the intake is still `scanning` (worker timeout, crash) | A `JOB_SETTLED_EVENT` listener fails the intake, so no prefill spins forever |

### 2.11 The kill switch and what is sent to the provider

- `POST /api/intakes/:id/analyze` sits behind `AiEnabledGuard` and `ai:use` and re-checks that the chosen model reads images and returns structured output. AI off, no key or no vision model answers with the AI platform's reasons (see the [AI platform spec](ai-platform.md)). Switching AI off mid-job ends it with the terminal code and the intake `failed`.
- **Sent:** the prefill instructions, the seeded exercise vocabulary, the optional source hint, and per photo a `Photo N:` label with the image.
- **Never sent:** the workout's name, notes, sets or gym; the user's identity or email; the Health Profile (only its unit is read, on the server, to interpret weights); any key; custom exercises.
- Keys stay server-side ([AI platform rules](../../CLAUDE.md#mandatory-ai-platform-rules)). The web page names the provider, model and whose key pays before the first photo is sent (`AiVisionDisclosure`).

### 2.12 Manual-first guarantees

- Starting a workout, picking or searching exercises, creating a custom exercise, logging and editing sets, finishing, editing and deleting use no AI route and no AI permission. A viewer role holds `workouts:*` and can log.
- **Prefill from photo** is disabled with a plain-language reason when the user lacks a permission (`workouts:write`, `exercises:write`, `intakes:write`, `storage:write`, `ai:use`) or AI is off, has no key or has no vision model (`apps/web/src/components/train/prefillAvailability.ts`). The API is the gate; the page only explains.
- The prefill page always offers **Continue manually**, and an empty result shows a "Nothing recognized" state with the same way out.
- AI output is a draft: reviewable, editable, deletable by rejection, with confidence, uncertainty, the "AI guess" tag and the line as read always shown; a low-confidence item is never collapsed or dropped.

### 2.13 Reference examples and the fake vision server

Two fixtures show the prefill end to end.

| Example | Photo | Model output the fake returns | Expected result |
|---|---|---|---|
| A machine placard | [`leg-curl-placard.jpg`](../examples/gym-scan/leg-curl-placard.jpg) (shared with the gym scan) | [`placard.model-output.json`](../../apps/api/test/fixtures/workout-prefill/placard.model-output.json) | [`placard.expected-drafts.json`](../../apps/api/test/fixtures/workout-prefill/placard.expected-drafts.json) |
| A handwritten notebook page | any small image (the fake ignores pixels) | [`notebook.model-output.json`](../../apps/api/test/fixtures/workout-prefill/notebook.model-output.json) | built per unit by `notebookExpectedDrafts` in `apps/api/test/fixtures/workout-prefill.fixtures.ts` |

The placard shows a confident exercise read from placard text. The notebook shows an unreadable line kept at low confidence, and weights without a unit read in the Health Profile unit and flagged.

The fake vision server (`tests/e2e/support/fake-vision-server.mjs`, overlay `infra/compose/fake-ai.compose.yml`) serves these as the fixtures `workout-placard` and `workout-notebook`. Setup, control endpoints and why fixtures are chosen by the control endpoint rather than by image hash are in [gyms-and-equipment.md](gyms-and-equipment.md#212-the-fake-vision-server).

### 2.14 Observability

- The job logs ids, counts, durations and chunk outcomes only; never prompt text, photo content, URLs, image bytes or keys. `PhotoIntake.resultMeta` records `promptVersion`, `chunks`, `photoCount`, `sourceKind`, `suggestedName`, `ignoredNotes`, `assumedWeightUnit` and `failedChunks`.
- The model call runs through the AI platform's gate pipeline, so it is recorded like any AI call (`ai_runs`, `ai_usage_events`, tied to the job by `jobId`) with no key material. The job appears in the job queue history like any other job type ([job-queue.md](job-queue.md)).
- Workout routes add no metrics or spans of their own beyond the platform's HTTP telemetry ([telemetry.md](telemetry.md)).

## 3. Configuration and permissions

**Settings and environment.** None. The feature adds no environment variable and no settings page. AI, the vision model and the key policy are configured at runtime ([ai-configuration runbook](../runbooks/ai-configuration.md)); storage at `/admin/settings/storage`. The display unit follows the Health Profile ([health-data.md](health-data.md)).

**Permissions.** The matrix is in [ARCHITECTURE.md](../ARCHITECTURE.md#7-authorization); all three seeded roles hold `exercises:*`, `workouts:*` and `intakes:*`.

| Permission | Guards |
|---|---|
| `exercises:read` | Reading the library and own custom exercises |
| `exercises:write` | Creating, editing, approving and deleting own custom exercises; also required by the prefill kind |
| `workouts:read` | Reading own workouts and the summary; `GET /api/exercises/:id/history` |
| `workouts:write` | Starting, editing, finishing and deleting own workouts, their exercises and sets |
| `storage:write` | Uploading photos for a prefill (a viewer lacks it) |
| `intakes:read`, `intakes:write` | The intake routes a prefill uses |
| `ai:use` | Also required by `POST /api/intakes/:id/analyze`, behind `AiEnabledGuard` (a viewer lacks it) |

The `workout_prefill` kind declares `requiredPermissions`, so the generic intake routes cannot become a side door around `workouts:*` and `exercises:write`: a missing permission is a `403` with `details.reason: MISSING_KIND_PERMISSIONS`. See the [security architecture](../SECURITY-ARCHITECTURE.md).

**Routes.** Compact table; parameters, bodies and responses are in `/api/docs` (`npm run openapi:dump`).

| Route | Permission |
|---|---|
| `GET`, `POST /api/exercises`; `GET`, `PATCH`, `DELETE /api/exercises/:id` | `exercises:read` (reads), `exercises:write` |
| `POST /api/exercises/:id/approve` | `exercises:write` |
| `GET /api/exercises/:id/history` | `workouts:read` |
| `POST`, `GET /api/workouts`; `GET /api/workouts/:id` | `workouts:write` (start), `workouts:read` |
| `POST /api/workouts/quick-cardio` | `workouts:write` |
| `GET /api/workouts/summary` (`?today=`) | `workouts:read` |
| `PATCH`, `DELETE /api/workouts/:id`; `POST .../finish` | `workouts:write` |
| `POST .../exercises`; `PATCH`, `DELETE .../exercises/:weId` | `workouts:write` |
| `POST .../exercises/:weId/sets`; `PATCH`, `DELETE .../sets/:setId` | `workouts:write` |
| `POST /api/intakes` (`kind: workout_prefill`), photos, items, `apply`, `DELETE` | `intakes:write` plus the kind's `workouts:write`, `exercises:write` |
| `POST /api/intakes/:id/analyze` | `intakes:write`, `ai:use`, the kind's write permissions; `AiEnabledGuard` |

Refusals carry `details.reason` (values in `WORKOUT_REFUSALS` and `EXERCISE_REFUSALS`, in the two constants files; intake reasons in the intake README).

## 4. Extending it in a fork

| To | Do |
|---|---|
| Add an exercise to the library | Append a line to `EXERCISE_LINES` in `apps/api/prisma/seed-data.ts` with a new permanent `slug`, existing muscles, a movement pattern and requirement groups over existing equipment or capability slugs (an unknown one makes the seed throw), then `npm run prisma:seed`. The prefill vocabulary picks it up on the next load. `apps/api/test/exercises/exercise-catalog.spec.ts` guards the shape |
| Change a display name or alias | Edit the seed line and re-seed. Never change a `slug` |
| Add a tracking mode or muscle | Extend `training.constants.ts` and `seed-data.ts` together, then the web logger for the new fields; the compile-time checks flag a drift |
| Add or change a record type | Edit `workout-records.ts` (formulas, `PR_TYPES`), the records tests and the web chips; nothing is stored, so no migration or backfill is needed |
| Change what the prefill asks the model | Edit `workout-prefill.prompt.ts` and bump `WORKOUT_PREFILL_PROMPT_VERSION`; update the fixtures and the prompt spec |
| Build another photo-to-rows flow | Add an intake kind: [intake README](../../apps/api/src/intake/README.md#adding-a-kind), with `WorkoutPrefillIntakeKind` and `GymEquipmentIntakeKind` as worked examples. The analyzer is a server-only `ai.*` job ([job handlers README](../../apps/api/src/jobs/handlers/README.md), [AI README](../../apps/api/src/ai/README.md)) |
| Read workouts from another feature | Inject `WorkoutHistoryService` (exported by `WorkoutsModule`); never query the workout tables of another user. `WorkoutsModule` must never import `ExercisesModule` |
| Start a workout from a plan | Call `WorkoutsService.startPrefilled` inside your own transaction and write your link row there, as `TrainingTodayService.start` does |

## 5. Guardrails

- `apps/api/test/exercises/exercises.integration.spec.ts`: the HTTP contract through the real guards: `401` without a token, `403` without the exact permission on every route, the `{ data }` envelope, and owner scoping.
- `apps/api/test/exercises/exercises.db.spec.ts`: `CHECK` constraints and foreign keys, the seed (idempotent, custom rows untouched), availability against real seeded rows, custom exercises.
- `apps/api/test/exercises/exercise-catalog.spec.ts`: the seeded catalog is well formed (unique slugs, known muscles, patterns and requirement slugs).
- `apps/api/test/workouts/workouts.integration.spec.ts`: the workouts HTTP contract (permissions on every route, envelope, `200` versus `201` on start, owner scoping).
- `apps/api/test/workouts/workouts.db.spec.ts`: the raw-SQL `workouts_user_in_progress_uniq_idx`, `CHECK` constraints, foreign keys, owner scoping, dense set and exercise ordering, the kilogram round trip, dates and the readiness snapshot, editing a completed workout.
- `apps/api/test/workouts/quick-cardio.integration.spec.ts`, `quick-cardio.db.spec.ts`: the quick-log HTTP contract (permission, bounds, `TIME_IN_FUTURE`, `PERFORMED_AT_OUT_OF_RANGE`) and, on real Postgres, the completed gym-free workout, the plan link without a `program_sessions` row, and logging beside an in-progress workout.
- `apps/web/src/__tests__/components/today/QuickCardioSheet.test.tsx`: the sheet's checks and refusals.
- `apps/api/test/workouts/workout-rules.spec.ts`: pure mapper rules (totals, rest derivation, dense renumbering) and DTO bounds.
- `apps/api/test/workouts/workout-records.spec.ts`: the record formulas and the working-set rule on raw sets.
- `apps/api/test/workouts/workout-history.db.spec.ts`, `workout-history.integration.spec.ts`: the SQL aggregation agrees with the pure functions; last time, recent and all-time records; another user's sets never enter a comparison.
- `apps/api/test/workouts/workout-summary.spec.ts`, `workout-summary.db.spec.ts`, `workout-summary.integration.spec.ts`: ISO-week and top-lift rules, the summary against a real database, and `TODAY_OUT_OF_RANGE`.
- `apps/api/test/workouts/workout-prefill.db.spec.ts`: example A yields exactly `placard.expected-drafts.json` through the real job; apply order, uncompleted dense sets, custom-exercise reuse, the 30-exercise cap, a workout deleted before apply, foreign workouts, and the photo-reference rule.
- `apps/api/test/workouts/workout-prefill.integration.spec.ts`: the intake routes for the kind, including `MISSING_KIND_PERMISSIONS`.
- `apps/api/src/workouts/prefill/workout-prefill.handler.spec.ts`, `workout-prefill.mapper.spec.ts`, `workout-prefill.prompt.spec.ts`: chunking, terminal and retryable outcomes, deferral on a throttle, the settle safety net, zero calls with the kill switch on, unit conversion and the assumed-unit flag, and that the prompt lists every seeded slug.
- `apps/api/src/workouts/intake/workout-prefill.intake-kind.spec.ts`: value normalization and apply.
- `apps/api/test/ai/ai-jobs-server-only.spec.ts`: `ai.workout.prefill` has no node hooks.
- `apps/web/src/__tests__/pages/TrainPage.test.tsx`, `TrainExercisesPage.test.tsx`, `WorkoutPage.test.tsx`, `WorkoutPagePrs.test.tsx`, `WorkoutPagePrefill.test.tsx`, `WorkoutPrefillPage.test.tsx`: the pages, record chips, and the prefill states including "Continue manually".
- `apps/web/src/__tests__/components/train/`, `components/today/TodayWorkout.test.tsx`, `utils/units.test.ts`, `utils/workoutFormat.test.ts`: the picker, set row, last-time line, disabled-with-reason prefill button, the Today card and unit conversion.
- `tests/e2e/specs/workouts.spec.ts`, `tests/e2e/specs/workout-prefill.spec.ts`: the manual path and both reference examples against the running stack.

## 6. Design decisions

- **Personal records are computed on read.** A stored record must be invalidated on every edit, delete and back-dated entry, and it drifts. Computing from the user's own sets in one grouped SQL query stays correct by construction and costs one query per call. Rejected: a `personal_records` table (staleness, backfill), a running maximum on the exercise entry (wrong after a delete).
- **Kilograms and metres are canonical.** One stored unit means comparisons, records and totals never convert, and a unit switch never rewrites data. Rejected: storing the typed unit per set (mixed-unit arithmetic everywhere), converting in the API (every client would depend on the profile).
- **Exercise requirements are groups of alternatives.** "Needs a bench and either dumbbells or a barbell" is AND of OR and is what real exercises need. Rejected: a flat equipment list (cannot say "either"), a free-text requirement (no availability), requiring a specific equipment type only (a capability such as "loadable barbell station" covers several types).
- **Prefilled sets are uncompleted.** A photo shows what was planned or done at some other time. Completed sets would inflate volume and records with work not done today and could award records for numbers the user never lifted. The user checks each set off, which also gives the honest `completedAt`.
- **The database owns the in-progress slot.** A partial unique index settles concurrent starts. Rejected: a `findFirst` pre-check (races) and a `@@unique` (would forbid several completed workouts).
- **A prefill is never retried blindly.** `maxAttempts: 1`; a throttle defers, a terminal code ends. A later chunk failing keeps the earlier chunks so a partial result is not thrown away.
- **Custom exercises stay out of the AI request.** They are personal data, so the model sees the seeded library only; a custom name is resolved on apply, where an `other` item named like one reuses it. This makes "never sent" a structural fact.
- **Unit assumptions are shown, not hidden.** A weight with no written unit takes the profile unit and is flagged uncertain with a visible note, so a wrong guess costs one edit, not a silent 2.2 times error.
- **A per-workout row lock.** Set numbers, limits and renumbering all depend on the sibling rows; one `FOR UPDATE` on the parent is simpler and safer than several unique-index retry loops. Rejected: optimistic retries on `setNumber`.

## 7. Verification

```bash
npm test --workspace=api -- workouts exercises     # unit and mocked integration
npm run test:db --workspace=api                    # real-Postgres tier (in-progress index, seed, prefill end to end)
npm run test:run --workspace=web                   # pages, logger components, units
npm run typecheck --workspace=api
npm run typecheck --workspace=web
npm run openapi:dump && npm run openapi:lint
cd tests/e2e && npx playwright test workouts workout-prefill   # needs the local stack (see TESTING.md)
```

Then walk it in the app (`http://localhost:3535`, sign in at `/testing/login` as a contributor):

1. Create a gym with adjustable dumbbells and a bench ([gyms-and-equipment.md](gyms-and-equipment.md)). On Today, start a workout. In the picker the leg press is absent; **Show all** lists it with what it needs. Add the dumbbell bench press, log three sets, finish. The summary and the history row appear; nothing asked for AI.
2. Switch the Health Profile between metric and imperial: displayed weights convert, stored values do not change.
3. Log a second workout with heavier sets: the "Last time" line shows and the record chips appear; reload keeps them.
4. `GET /api/workouts/summary?today=2000-01-01` answers `400` with `details.reason: TODAY_OUT_OF_RANGE`.
5. Start the stack with the fake overlay, choose `workout-placard` (`curl -X POST localhost:4010/__control/next -d '{"fixture":"workout-placard"}'`), open **Prefill from photo** on a workout, upload `docs/examples/gym-scan/leg-curl-placard.jpg`, read the disclosure and analyze. "Leg curl" appears with a High badge and "read as: LEG CURL"; apply. The exercise is in the workout with no completed sets and the photo under Photos.
6. Turn AI off at `/admin/settings/ai`: **Prefill from photo** is disabled with the reason and logging still works.

## History

- Exercise library: schema, seed and custom exercises: #62.
- Workout, exercise entry and set schema and API: #65.
- Workout logging UI on `/train`: #66.
- "Last time" and personal records: #67.
- AI Prefill from photo: `ai.workout.prefill`, the vision prompt, draft review and workout photos: #68.
- Today page card and `GET /api/workouts/summary`: #69.
- End-to-end tests and this spec: #70.
- Epic #260 (cardio and everyday activity): outdoor walk and hike exercises: #261; duration and distance prescriptions on the plan contract and in Today: #262; cardio completion in the signals and the plan UI: #263; the quick "Log a walk / run" and explicit null gym on start: #264.
