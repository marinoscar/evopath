# Health Records

> **Status:** in progress (the document store and the keep-or-delete choice are shipped; the rest of the epic is planned) · **Code:** `apps/api/src/health-documents/`, `apps/api/src/intake/`, `apps/api/src/measurements/photo/`, `apps/web/src/components/intake/` · **API:** `/api/intakes/*` (see `/api/docs`; the documents API is planned) · **Admin UI:** none · **Runbook:** none yet · **Recipe:** [the intake README](../../apps/api/src/intake/README.md)

Health Records turns the per-user [health data](health-data.md) into a complete, user-owned health record. Every health file a user hands the system becomes a `HealthDocument` with the user's keep-or-delete choice. Values read from those files keep a link to their source document, and the record can grow (lab results, exports, a health summary for the training planner) without the user ever losing control of the files.

## 1. Purpose

### The epic

- **Blood work** extracted from lab report PDFs and images, reviewed by the user before it is saved.
- **PDFs for body metrics**, next to the scale and cuff photos that exist today.
- **A keep-or-delete choice at every upload.** Keep is the default. A Health Documents settings page lists and manages what is kept.
- **Full value history** with the source document of each value.
- **Export** to JSON, CSV, XLSX and PDF.
- **An opt-in, AI-written health summary** for the training planner. No raw lab value leaves the summary boundary.

Out of scope: sharing with clinicians, EHR or FHIR integration, medication tracking, AI diagnosis.

### What the document store is

- It is the first-class record of "a health document": one row per uploaded file of a health intake kind.
- It carries the retention the user chose, the file's metadata and, once the file is erased, the time it was erased.
- It is the foundation the later parts build on: extraction, history links, the settings page and export all read `HealthDocument`.

It is not a second file store. The bytes stay in the [storage](storage-providers.md) object the row points to; `HealthDocument` holds the choice and the link.

## 2. How it works

### 2.1 Health document model

`HealthDocument` (`health_documents`, `apps/api/prisma/schema.prisma`):

| Field | Meaning |
|---|---|
| `id`, `userId` | Owner; the row is deleted with the user (`ON DELETE CASCADE`) |
| `kind` | `body_metric` or `lab_report` (`HEALTH_DOCUMENT_KINDS`); plain text, open to extension |
| `storageObjectId` | The stored file; `ON DELETE SET NULL`, and `null` once the file is deleted |
| `originalName`, `mimeType`, `sizeBytes` | Copied from the storage object when the file is attached |
| `retention` | `keep` (default) or `delete_after_processing` (`FILE_RETENTIONS`) |
| `intakeId` | The intake the file came through; `ON DELETE SET NULL`, so a document outlives its intake |
| `documentDate` | Nullable date of service or collection; no H1 code writes it |
| `fileDeletedAt` | Set when the purge erased the file |
| `createdAt`, `updatedAt` | Timestamps |

Indexes: `(user_id, created_at)`, `storage_object_id`, `intake_id`. `photo_intakes` gains `retention` (`keep` by default), the choice recorded on the intake. The constants live in `apps/api/src/health-documents/health-document.constants.ts`, plain data with no Nest or Prisma import.

### 2.2 Which uploads become documents

An intake kind opts in with `IntakeKind.healthDocumentKind` (`apps/api/src/intake/intake-kind.interface.ts`). For such a kind:

- Attaching a file writes the `photo_intake_photos` link and the `HealthDocument` in one transaction. The document takes name, type and size from the storage object.
- The `body_metric_reading` kind declares `healthDocumentKind = 'body_metric'`.
- Kinds that do not declare it (gym equipment, workout prefill) create no document and ignore retention.

### 2.3 The retention choice

- `POST /api/intakes` takes `retainFiles` (boolean). Omitted means `true`: an intake created without it stores `retention = keep`.
- `POST /api/intakes/:id/photos` may carry its own `retainFiles`. Omitted, the file takes the intake's retention. This is the per-file override.
- `PATCH /api/intakes/:id` with `{ retainFiles }` changes the intake's retention and that of every document it holds whose file still exists, in one transaction. A body with only `retainFiles` leaves `context` as it is; any other body replaces `context` as before.
- The change is allowed only while the intake is editable (before apply), so the choice is final once the values are saved.
- The intake view reports `retention` and `retainFiles`; each photo reports `healthDocumentId` and `retention`.
- The web control (`RetainFilesControl`) reads "Keep this file in <product> after processing", is checked by default and renders only for a health intake kind. Helper text says that unchecking erases the file once the values are saved. The Read from photo dialog sends the choice on create, on every attach, and as a `PATCH` when the user changes it.

### 2.4 Lifecycle

```
attach  ->  HealthDocument(retention, intake_id)
apply   ->  measurements written  +  purge job enqueued   (one transaction)
discard ->  intake deleted        +  purge job enqueued   (one transaction)
job     ->  ObjectsService.delete  ->  file_deleted_at set, storage_object_id null
```

- **Apply and discard** enqueue one `health.document.purge` job per `delete_after_processing` document whose file still exists, through `JobsService.enqueueWithin` inside the same transaction. The intent commits with the apply (after the kind's writes) or the discard, and no worker claims the job earlier. A discard reads the documents before the delete, because the delete sets their `intake_id` to null.
- **The job** (`health-documents/handlers/health-document-purge.handler.ts`, payload `{ healthDocumentId }`):
  1. Reads the document. A missing, already purged or `keep` document is a no-op.
  2. Hard-deletes the storage object through `ObjectsService.delete` as the owner. An object that is already gone counts as deleted.
  3. Stamps `file_deleted_at` and nulls `storage_object_id`, conditional on `file_deleted_at IS NULL`.
  4. Writes the audit row and counts the purge.
- **Idempotent.** A duplicate job or a rerun changes nothing; enqueue uses `skipDedup` because a unique violation would abort the apply transaction.
- **Retried.** A storage failure counts `failed` and rethrows, so the queue retries. The profile is `{ maxRuntimeMs: 5 min, maxAttempts: 8 }`.
- **Never rolls back measurements.** The purge runs after the apply committed and never touches measurement rows.
- **Server-only.** The handler has neither `nodeResultSchema` nor `persistNodeResult`: deleting objects from the deployment's storage is a privilege a worker node must never hold.
- **Detach.** Removing a file from an intake (`DELETE /api/intakes/:id/photos/:storageObjectId`) deletes its document with the link, in one transaction. The file was never processed, and the existing cleanup may delete the object.
- **Keep.** A `keep` document is never purged. It survives discard and stays until a later part of the epic lets the user delete it.

### 2.5 The `health_documents` reference checker

`HealthDocumentObjectReferences` registers with `StorageObjectReferences`. `IntakeService.deleteUnreferencedObjects` asks every checker before it deletes an object after a discard or a detach. The checker answers "referenced" for an object when any document has `storage_object_id` equal to it and `file_deleted_at` null. That covers:

- **Every `keep` document.** A kept file must survive the intake's discard.
- **Every `delete_after_processing` document whose file still exists.** Its deletion belongs to the purge job alone. The best-effort cleanup would otherwise race the job and could delete the object without `file_deleted_at` ever being set, leaving a document that claims a file it no longer has, with no audit row and no metric.

Once `file_deleted_at` is set, the document holds nothing. A failing check keeps the object (`StorageObjectReferences` fails safe).

### 2.6 Provenance

- The body-metric kind writes `sourceRef.healthDocumentId` on each saved reading: the document of the first photo the reading was read from, else the intake's first document. Rows saved before H1 have none.
- The document row stays after its file is erased, so the link never dangles.
- `MeasurementView.fileDeleted` is `true` when the reading's document has `file_deleted_at` set, `false` when it still has a file and `null` when the reading names no document.
- History shows a **File deleted** chip instead of **View photo** for an erased file. The values and provenance stay.

### 2.7 Observability, audit and security

- **Span attribute.** `health.document.retention` carries the mode on the intake routes (create, change, discard, apply) and on the purge job's span.
- **Metric.** `app.health.documents.purges` (counter, attribute `outcome` of `purged` or `failed`); see [telemetry.md](telemetry.md).
- **Audit.** A successful purge writes `health:document:delete`, `targetType` `health_document`, `targetId` the document id, `meta` with the storage object id, the intake id, a file count and `reason: delete_after_processing`. Never a file name or content. The write is best effort: an audit failure is logged and does not retry a purge that already erased the file.
- **Logs.** Ids and counts only. A file name never reaches a log line, a span, an audit row or an error message.
- **Ownership.** The intake routes are owner-scoped, so another user's intake, photo or document id is a `404`. The purge deletes the object as its owner.
- **Permissions.** The intake kind requires `health_data:read` and `health_data:write` on top of `intakes:*` ([health-data.md 2.17](health-data.md#217-photo-readings)).

### 2.8 Planned: blood work from lab reports

Placeholder. Lab report PDFs and images become `lab_report` documents, an AI job drafts the values, the user reviews them and the saved results link their document. This section records the extraction flow, the result model and its validation when it ships.

### 2.9 Planned: PDFs for body metrics

Placeholder. The `body_metric` kind accepts PDFs next to photos. This section records the accepted types and size limits when it ships.

### 2.10 Planned: Health Documents settings page and documents API

Placeholder. A registry-driven settings card ([settings-ui.md](settings-ui.md)) lists the user's documents, shows each one's retention and lets the user download or delete a kept file. This section records the routes, permissions and the delete flow when it ships.

### 2.11 Planned: value history with source document

Placeholder. The full history of a value links to its source document, including the file-deleted state. This section records the history API when it ships.

### 2.12 Planned: export

Placeholder. JSON, CSV, XLSX and PDF export of the health record, as a queue job. This section records the formats, the job and the download flow when it ships.

### 2.13 Planned: AI health summary for the training planner

Placeholder. An opt-in summary the training planner reads in place of raw values, so no raw lab value leaves the summary boundary. This section records the consent, the summary shape and the agent wiring when it ships.

## 3. Configuration and permissions

- No environment variable and no system setting. Storage is configured at runtime in the admin UI ([storage-providers.md](storage-providers.md)).
- Retention is chosen per intake and per file by the user.
- **Permissions.** No permission of its own. The routes are the generic intake routes, gated by `intakes:*` plus the kind's `health_data:read` and `health_data:write`.
- **Job type.** `health.document.purge`, permanent, server-only; listed in [ARCHITECTURE.md](../ARCHITECTURE.md) and [job-queue.md](job-queue.md).
- **Audit action.** `health:document:delete`.
- **Metric.** `app.health.documents.purges`.

Routes that carry the choice (details in `/api/docs`, tag "Intakes"):

| Route | What changes |
|---|---|
| `POST /api/intakes` | Accepts `retainFiles` (default `true`) |
| `PATCH /api/intakes/:id` | Accepts `retainFiles` alone or with `context`; changes the intake and its documents |
| `POST /api/intakes/:id/photos` | Accepts a per-file `retainFiles`; creates the document for a health kind |
| `DELETE /api/intakes/:id/photos/:storageObjectId` | Deletes the file's document with the link |
| `POST /api/intakes/:id/apply` | Enqueues the purges in the apply transaction |
| `DELETE /api/intakes/:id` | Enqueues the purges in the discard transaction |
| `GET /api/measurements` | Each reading carries `fileDeleted` |

## 4. Extending it in a fork

**Make another intake kind a health kind.** Set `healthDocumentKind` on the kind and add the value to `HEALTH_DOCUMENT_KINDS` when it is new. Attach, retention, purge and the reference checker then apply with no other change. In `apply`, read `healthDocuments` from the apply arguments and write `healthDocumentId` into the saved provenance, as `body-metric-reading.kind.ts` does. On the web, add the kind to `HEALTH_INTAKE_KINDS` (`apps/web/src/services/intake.ts`) so `RetainFilesControl` renders for it. The kind recipe is in [the intake README](../../apps/api/src/intake/README.md).

**Add another holder of a stored file.** A feature that keeps a storage object registers its own checker with `StorageObjectReferences`, as `HealthDocumentObjectReferences` does.

## 5. Guardrails

- `apps/api/test/health-data/health-documents.db.spec.ts`: on real Postgres, the default `keep`, purge after apply and after discard, a kept file surviving discard, detach removing the document, a purge failure retried with the measurements intact, `retainFiles` changes before apply, and another user's `404`.
- `apps/api/src/health-documents/handlers/health-document-purge.handler.spec.ts`: permanent type, server-only, profile, idempotence, failure rethrown and counted, audit carrying no file name.
- `apps/api/src/health-documents/health-document-object-references.spec.ts`: the checker holds only files that still exist and fails safe.
- `apps/api/src/intake/intake.service.spec.ts`: the retention, attach, detach, discard and apply paths.
- `apps/api/src/measurements/measurements.service.spec.ts`: `fileDeleted` on the measurement view.
- `apps/api/src/common/otel/app-metrics.service.spec.ts`: the purge counter and its outcome label.
- `apps/api/test/jobs/cron-enqueue-only.spec.ts` and `apps/api/test/jobs/on-event-no-io.spec.ts`: no long-running work outside the queue.
- `apps/web/src/__tests__/components/intake/RetainFilesControl.test.tsx`: checked by default, helper text, health kinds only.
- `apps/web/src/__tests__/components/health/PhotoReadDialog.test.tsx` and `apps/web/src/__tests__/components/health/MeasurementHistoryProvenance.test.tsx`: the choice reaches the requests, and **File deleted** replaces **View photo**.
- `tests/visual/specs/health-photo-read.spec.ts`: the photo-step baseline includes the keep-or-delete control.

## 6. Design decisions

**One row per file, not a flag on the intake.** The choice is per file, and a document must outlive its intake (`intake_id` is set to null). A flag on the intake would vanish with it.

**Keep is the default.** Erasing is irreversible, so the user opts in to it. Rejected: delete by default, which loses data on a missed click.

**The purge is a queue job.** A storage outage is retried and the intent is never lost. Rejected: deleting inline after the apply commits (a failure loses the intent) and a detached call (violates the queue rule).

**Enqueued inside the apply or discard transaction.** The intent commits with the change, and the job cannot run before the measurements exist. Rejected: enqueue after commit, where a crash between commit and enqueue loses the purge.

**The checker holds unpurged `delete_after_processing` files too.** One deleter per file keeps the audit row, the counter and `file_deleted_at` truthful. Rejected: letting the intake cleanup delete them, which races the job.

**Choice is final at apply.** The values are saved and the provenance is fixed, so changing retention afterwards would need the documents API. Rejected: letting `PATCH` change retention of an applied intake.

**The document row survives the purge.** Provenance must not dangle, and history shows "File deleted". Rejected: deleting the row with the file, which would orphan `healthDocumentId`.

**Server-only purge.** A worker node must never hold the privilege to delete objects from the deployment's storage.

## 7. Verification

```bash
npx jest --config apps/api/test/jest.config.js --rootDir apps/api src/health-documents src/intake
export POSTGRES_HOST=localhost POSTGRES_PORT=5432 POSTGRES_USER=postgres POSTGRES_PASSWORD=postgres POSTGRES_DB=evopath_test
cd apps/api && npx jest --config ./test/jest.config.js --testRegex 'test/health-data/health-documents\.db\.spec\.ts$' --runInBand
npm run test:run --workspace=web -- RetainFilesControl
```

In a running app, with AI on:

1. Open Health, **Read from photo**, and confirm "Keep this file in <product> after processing" is checked.
2. Uncheck it, read a photo and save. The job `health.document.purge` appears in the job history and succeeds.
3. History shows **File deleted** for the new entry. `GET /api/measurements` reports `fileDeleted: true` for its readings.
4. The audit log holds `health:document:delete` with no file name.

## History

- #184: the Health Records epic.
- #185: `health_documents` table and `photo_intakes.retention`, `retainFiles` on the intake API, `IntakeKind.healthDocumentKind`, the `health.document.purge` job, the `health_documents` reference checker, `sourceRef.healthDocumentId` and `fileDeleted`, the `health:document:delete` audit action and the purge counter, the keep-or-delete control, and this spec.
