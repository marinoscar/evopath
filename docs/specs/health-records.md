# Health Records

> **Status:** in progress (the document store, the keep-or-delete choice and PDFs for body metrics are shipped; the rest of the epic is planned) · **Code:** `apps/api/src/health-documents/`, `apps/api/src/intake/`, `apps/api/src/measurements/photo/`, `apps/web/src/components/intake/` · **API:** `/api/intakes/*` (see `/api/docs`; the documents API is planned) · **Admin UI:** none · **Runbook:** none yet · **Recipe:** [the intake README](../../apps/api/src/intake/README.md)

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

### 2.8 Blood work: lab results

A lab analyte is a metric registry entry in the `lab` category, not a table: results are `measurements` rows, written and read through `/api/measurements` behind `health_data:read`/`health_data:write`, with the same revisions, soft deletes and owner scope ([health-data.md 2.8 to 2.13](health-data.md#28-metric-registry)).

**Catalog.** 39 analytes in `apps/api/src/measurements/metric-registry.ts`, each with a permanent snake_case `key`, `label`, `panel`, canonical unit, accepted units, hard bounds, display `decimals` and `aliases`. `GET /api/measurements/metrics` publishes them with `panel` and `aliases`.

| Panel | Keys |
|---|---|
| `lipids` | `total_cholesterol`, `ldl_cholesterol`, `hdl_cholesterol`, `triglycerides`, `non_hdl_cholesterol`, `apob` |
| `glycemic` | `fasting_glucose`, `hba1c`, `fasting_insulin` |
| `cbc` | `hemoglobin`, `hematocrit`, `rbc_count`, `wbc_count`, `platelet_count`, `mcv` |
| `cmp` | `alt`, `ast`, `alp`, `total_bilirubin`, `albumin`, `creatinine`, `egfr`, `bun`, `sodium`, `potassium` |
| `thyroid` | `tsh`, `free_t4`, `free_t3` |
| `iron` | `ferritin`, `serum_iron`, `tibc`, `transferrin_saturation` |
| `other` | `vitamin_d_25oh`, `vitamin_b12`, `hs_crp`, `testosterone_total`, `testosterone_free`, `cortisol`, `uric_acid` |

**Canonical units.** The US conventional unit, for every user (mg/dL, ng/mL, U/L, `10^3/µL`, HbA1c in `%`); `displayUnit` does not follow the metric/imperial preference, because labs in metric countries print either convention. SI units are accepted alternatives with analyte-specific factors where molar mass matters (glucose mmol/L x 18.02, cholesterols x 38.67, triglycerides x 88.57, creatinine µmol/L / 88.42, BUN as urea mmol/L / 0.357, vitamin D nmol/L / 2.496, and so on). HbA1c in mmol/mol uses the IFCC-NGSP master equation, `% = mmol/mol / 10.929 + 2.15`, published as a unit `factor` plus `offset`. Lab units also match case-insensitively and with `u` or `μ` for `µ`. Conversions are pinned on known values in `apps/api/src/measurements/lab-catalog.spec.ts` (glucose 100 mg/dL = 5.55 mmol/L, HbA1c 6.5 % = 48 mmol/mol).

**Alias lookup.** `resolveLabAnalyte(name)` returns the analyte whose key, label or alias matches after folding case, accents, spaces and punctuation ("LDL-C", "LDL Cholesterol", "Low density lipoprotein" all give `ldl_cholesterol`), or undefined; it never guesses. Loading the registry throws if one folded alias names two analytes.

**Per-result context.** Four nullable `measurements` columns hold what the lab printed, on the event rather than the catalog: `referenceLow` and `referenceHigh` (canonical unit), `referenceText` (at most 100 characters, for ranges such as `<100` or `negative`) and `flag` (`low`, `normal`, `high`, `critical`, `unknown`). `origin` and `method` (`lab`, `point_of_care` and others) are unchanged.

**API rules.**

- A reading's limits are sent in the reading's `unit` and converted with the value. `referenceLow` must not exceed `referenceHigh` when both are set. The four fields are refused on body and vital metrics.
- One report is one entry: 1 to 40 lab readings under one `entryId`. Lab and body/vital readings never share an entry.
- An edit (a new revision) copies range and flag forward unless the body changes them; `null` clears one. The range rule is checked on the merged reading.
- `GET /api/measurements` lists lab rows only with `category=lab` or a lab `metricKey`; the default list and `latest` stay body and vital. `series` accepts a lab key.
- Values, ranges and notes never reach a log line or an issue message; the delete audit row carries the reading count only.
- Lab results are on the training agents' never-send list (`labs` in `apps/api/src/training-agents/context/never-send.ts`): the context loaders select metric keys explicitly, and the data-minimisation canary seeds lab rows with range context to prove it.

Still planned: lab report PDFs and images become `lab_report` documents, an AI job drafts the values with `resolveLabAnalyte`, the user reviews them, and the saved results link their document.

### 2.9 PDFs for body metrics

Clinics, smart scales and body-composition scans (DEXA, InBody) hand out PDFs. The `body_metric_reading` kind reads them next to photos, so the user no longer screenshots a report.

**Declaring support.** `IntakeKind.acceptedInputs` (`apps/api/src/intake/intake-kind.interface.ts`) is `['image']` when omitted, or `['image', 'pdf']`. `IntakeKindRegistry.register` refuses an empty list, an unknown entry or a duplicate. `body_metric_reading` declares `['image', 'pdf']`; `gym_equipment` and `workout_prefill` stay image-only.

**Accepted types and limits.**

| Input | MIME type | Size cap | Other cap |
|---|---|---|---|
| Image | `image/png`, `image/jpeg`, `image/gif`, `image/webp` | 20 MiB (`AI_STORAGE_INPUT_IMAGE_MAX_BYTES`) | none |
| PDF | `application/pdf` | 50 MiB (`AI_STORAGE_INPUT_FILE_MAX_BYTES`) | 20 pages (`INTAKE_PDF_MAX_PAGES`, or the kind's `maxPdfPages`) |

A PDF counts as one of the kind's `maxPhotos` (4 for body metrics) and as one input towards the analyzer's 16-inputs-per-request chunk.

**Validation at attach** (`IntakeService.attachPhoto`, cheapest first):

1. The declared type must be one the kind accepts. A PDF on an image-only kind is 400 `UNSUPPORTED_MEDIA_TYPE`.
2. The recorded size must be within the cap: 400 `OBJECT_TOO_LARGE`.
3. `IntakeInputInspector` (`apps/api/src/intake/intake-input-inspector.ts`) reads the stored object back through `STORAGE_PROVIDER`: the first 1024 bytes of an image, the whole PDF (bounded by 50 MiB).
   - The magic bytes must agree with the declared type: a PNG, JPEG, GIF or WebP signature for an image, a `%PDF-` header within the first 1024 bytes for a PDF. A mismatch (a text file renamed to `.pdf`) is 400 `UNSUPPORTED_MEDIA_TYPE` with `details.contentMismatch: true`.
   - A PDF's pages are counted. Over the cap is 400 `TOO_MANY_PAGES` (`details.pages`, `details.maxPages`); an uncountable PDF is 400 `PDF_UNREADABLE`.

Nothing is linked and no `HealthDocument` is written for a refused file.

**Re-check at analyze.** `POST /api/intakes/:id/analyze` repeats the checks before it queues anything. Each attached file must still be a type the kind accepts, and each PDF is read and counted again. The attach is the one way a file joins an intake and a stored object never changes, so this only catches links made before a kind changed its declaration. It keeps "no provider call for a refused file" true however the link was made.

**Model capability.** With a PDF attached, analyze asks the model gate for `file_input` on top of `vision_input` and `structured_output`, and requires the `file` input modality. A model without them is refused before anything is queued:

- the code is `AI_CAPABILITY_UNSUPPORTED` (400), with `details.capability: 'file_input'` and `details.inputKind: 'pdf'`;
- the message is "Your AI model can't read PDFs; choose a model with file input or upload an image.";
- no job is queued and no provider is called.

If the model loses the capability between analyze and the job, the runtime refuses the `file` part before any provider call. The job then fails the intake with the same message.

**Analyzer.** `intakeInputPart` (`apps/api/src/intake/intake-analyzer.ts`) maps an image to `{ type: 'image', storageObjectId, detail: 'high' }` and a PDF to `{ type: 'file', storageObjectId }`. It sends no file name and no URL: the AI runtime resolves the object under the owner's authorization and delivers it through the provider's existing strategy (presigned URL, upload or inline). The body-metric job labels a PDF `Photo <n> (PDF document):`. Its prompt (version 2) reads a report's printed measurements the same way as a display, and treats the report's text as data. The fake AI provider serves the `smart-scale-report` fixture (`apps/api/test/fixtures/body-metric/`) for the PDF path.

**Retention.** A PDF on a health kind becomes a `HealthDocument` with `mimeType` `application/pdf`. The keep-or-delete choice, the purge job and the reference checker apply to it exactly as to a photo (2.3 to 2.5).

**Page counting without a library.** `countPdfPages` (`apps/api/src/intake/intake-inputs.ts`) counts `/Type /Page` objects, never `/Pages`. It looks in the file as stored and inside each Flate-compressed object stream, which it inflates with Node's zlib under a 64 MiB budget. It errs high, never low: an incremental update that rewrote a page may be counted twice. A file with no countable page object (an encrypted object stream, a damaged file, a stream over the inflate budget) is refused as unreadable, never waved through.

**Observability and security.**

- The span attribute `intake.input_kind` is `image`, `pdf` or `mixed`. It is set on attach, on analyze and on the `ai.health.body_metric_reading` job.
- No PDF byte, file name or presigned URL reaches a log line, a span, an error or a stored row. The bytes the inspector reads live in memory for that call only.

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
- The PDF page cap is a constant (`INTAKE_PDF_MAX_PAGES`, 20) that a kind may override with `maxPdfPages`. It bounds the cost of one AI request, like the 16-inputs-per-request cap.
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
| `POST /api/intakes/:id/photos` | Accepts a per-file `retainFiles`; creates the document for a health kind; accepts `application/pdf` for `body_metric_reading` and refuses `TOO_MANY_PAGES` and `PDF_UNREADABLE` |
| `POST /api/intakes/:id/analyze` | With a PDF attached, re-checks it and requires a model with `file_input` |
| `DELETE /api/intakes/:id/photos/:storageObjectId` | Deletes the file's document with the link |
| `POST /api/intakes/:id/apply` | Enqueues the purges in the apply transaction |
| `DELETE /api/intakes/:id` | Enqueues the purges in the discard transaction |
| `GET /api/measurements` | Each reading carries `fileDeleted` |

## 4. Extending it in a fork

**Make another intake kind a health kind.** Set `healthDocumentKind` on the kind and add the value to `HEALTH_DOCUMENT_KINDS` when it is new. Attach, retention, purge and the reference checker then apply with no other change. In `apply`, read `healthDocuments` from the apply arguments and write `healthDocumentId` into the saved provenance, as `body-metric-reading.kind.ts` does. On the web, add the kind to `HEALTH_INTAKE_KINDS` (`apps/web/src/services/intake.ts`) so `RetainFilesControl` renders for it. The kind recipe is in [the intake README](../../apps/api/src/intake/README.md).

**Let another intake kind read PDFs.** Declare `acceptedInputs = ['image', 'pdf']` (and `maxPdfPages` for a cap other than 20). The attach, analyze and model checks then apply with no other change. In the kind's analyzer job, build the content parts with `intakeInputPart` or `numberedInputParts` so a PDF goes out as a `file` part, and read the photos' `storageObject.mimeType`. On the web, the picker's `accept` follows the kind (a separate task of #186).

**Add another holder of a stored file.** A feature that keeps a storage object registers its own checker with `StorageObjectReferences`, as `HealthDocumentObjectReferences` does.

## 5. Guardrails

- `apps/api/test/health-data/health-documents.db.spec.ts`: on real Postgres, the default `keep`, purge after apply and after discard, a kept file surviving discard, detach removing the document, a purge failure retried with the measurements intact, `retainFiles` changes before apply, and another user's `404`.
- `apps/api/src/health-documents/handlers/health-document-purge.handler.spec.ts`: permanent type, server-only, profile, idempotence, failure rethrown and counted, audit carrying no file name.
- `apps/api/src/health-documents/health-document-object-references.spec.ts`: the checker holds only files that still exist and fails safe.
- `apps/api/src/intake/intake.service.spec.ts`: the retention, attach, detach, discard and apply paths.
- `apps/api/src/measurements/measurements.service.spec.ts`: `fileDeleted` on the measurement view.
- `apps/api/src/common/otel/app-metrics.service.spec.ts`: the purge counter and its outcome label.
- `apps/api/test/jobs/cron-enqueue-only.spec.ts` and `apps/api/test/jobs/on-event-no-io.spec.ts`: no long-running work outside the queue.
- `apps/api/src/intake/intake-inputs.spec.ts`, `intake-input-inspector.spec.ts`, `intake-kind.registry.spec.ts` and `intake-analyzer.spec.ts`: the `acceptedInputs` default and validation, the magic-byte sniff, page counting in the clear and in object streams (and a decompression bomb), the bounded reads, and the `image` / `file` part mapping.
- `apps/api/src/intake/intake.service.spec.ts`: a PDF on an image-only kind, renamed files, the page, size and unreadable refusals, the re-check at analyze and the `file_input` refusal with nothing queued.
- `apps/api/test/health-data/measurements-photo.integration.spec.ts`: over HTTP with the fake AI provider, a PDF attach with its `application/pdf` document, the four refusals with no provider call, the model without `file_input`, and the job sending the PDF as one `file` input.
- `apps/api/src/measurements/lab-catalog.spec.ts`: the lab catalog panel by panel, conversions pinned on known values in every alternative unit, round trips, unit spellings, alias lookup and alias uniqueness.
- `apps/api/src/measurements/dto/measurement.dto.spec.ts`, `measurements.service.spec.ts` and `apps/api/test/health-data/measurements.integration.spec.ts`: range conversion and ordering, lab-only fields, lab entry size and mixing, revisions keeping or clearing range and flag, and lab routes in the permission matrix.
- `apps/api/test/health-data/measurements-lab.db.spec.ts`: on real Postgres, the four columns, a lab panel created, read back, listed only with `category=lab`, and edited with range and flag kept.
- `apps/api/src/training-agents/testing/canary-prisma.ts`: lab rows with range context in the data-minimisation canary.
- `apps/api/test/health-data/health-documents.db.spec.ts` and `measurements-photo.db.spec.ts`: on real Postgres and real file storage, PDF retention (purge after apply, keep through discard), refusals with no link or document, and a PDF read end to end with `sourceRef.healthDocumentId`.
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

**Each kind opts in to PDFs.** `acceptedInputs` defaults to images, so a kind whose analyzer never expected a document cannot receive one by accident. Rejected: accepting PDFs everywhere once the gateway could carry them.

**Magic bytes of the stored object, not the declared type.** The MIME type is whatever the uploader said. Reading the stored bytes is the only check that holds for a renamed file. Rejected: trusting the MIME type or the file extension.

**Attach-time checks, repeated at analyze.** The user hears about a bad file when attaching it, not after a scan. The analyze re-check keeps the guarantee for older links. Rejected: checking only in the job, which would report a refused file after the user started a scan.

**A page counter instead of a PDF library.** One bounded, conservative number does not justify a parser dependency (pdf-lib is unmaintained, pdf.js is large). Rejected: skipping the cap, which leaves a 500-page report free to run up a provider bill.

**A constant page cap.** The cap bounds request cost, as the 16-input cap does, and a kind can override it in code. Rejected: an environment variable (runtime-configured features never get one) and a system setting (no intake settings block exists to hold it).

**The capability error reuses `AI_CAPABILITY_UNSUPPORTED`.** Clients already handle the AI platform's reasons; `details.capability` and `details.inputKind` say what to do. Rejected: a new intake-only code for the same condition.

## 7. Verification

```bash
npx jest --config apps/api/test/jest.config.js --rootDir apps/api src/health-documents src/intake src/measurements/photo test/health-data/measurements-photo.integration
export POSTGRES_HOST=localhost POSTGRES_PORT=5432 POSTGRES_USER=postgres POSTGRES_PASSWORD=postgres POSTGRES_DB=evopath_test
cd apps/api && npx jest --config ./test/jest.config.js --testRegex 'test/health-data/(health-documents|measurements-photo)\.db\.spec\.ts$' --runInBand
npm run test:run --workspace=web -- RetainFilesControl
```

In a running app, with AI on:

1. Open Health, **Read from photo**, and confirm "Keep this file in <product> after processing" is checked.
2. Uncheck it, read a photo and save. The job `health.document.purge` appears in the job history and succeeds.
3. History shows **File deleted** for the new entry. `GET /api/measurements` reports `fileDeleted: true` for its readings.
4. The audit log holds `health:document:delete` with no file name.
5. With a model that has file input, read a smart-scale PDF report: the readings appear for review, and the saved entry links a document whose type is `application/pdf`.
6. Attach a PDF of more than 20 pages, or a text file renamed to `.pdf`: the attach is refused before any scan.

## History

- #184: the Health Records epic.
- #185: `health_documents` table and `photo_intakes.retention`, `retainFiles` on the intake API, `IntakeKind.healthDocumentKind`, the `health.document.purge` job, the `health_documents` reference checker, `sourceRef.healthDocumentId` and `fileDeleted`, the `health:document:delete` audit action and the purge counter, the keep-or-delete control, and this spec.
- #186: PDFs for body metrics. Adds `IntakeKind.acceptedInputs` and `maxPdfPages`, magic-byte and page-count checks at attach and analyze, the `file_input` refusal, PDFs as `file` parts, the `intake.input_kind` span attribute and body-metric prompt version 2 (API).
- #187: the lab analyte catalog (39 analytes, seven panels, affine unit conversion, `resolveLabAnalyte`), the `referenceLow`, `referenceHigh`, `referenceText` and `flag` columns on `measurements`, lab entries and the `category` list filter on `/api/measurements` (API).
