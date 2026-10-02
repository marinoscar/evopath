# Health Records

> **Status:** shipped (the document store, the keep-or-delete choice, PDFs for body metrics, the lab catalog, the lab report API, the documents API, blood-work history, the export API and the AI health summary are all shipped) · **Code:** `apps/api/src/health-documents/`, `apps/api/src/intake/`, `apps/api/src/measurements/photo/`, `apps/api/src/measurements/lab-report/`, `apps/api/src/health-export/`, `apps/api/src/health-summary/`, `apps/web/src/components/intake/` · **API:** `/api/intakes/*`, `/api/measurements/lab-reports/*`, `/api/health/documents/*`, `/api/health/exports`, `/api/ai/training/health-summary` (see `/api/docs`) · **Admin UI:** none · **Runbook:** none yet · **Recipe:** [the intake README](../../apps/api/src/intake/README.md)

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
| `documentDate` | Nullable date of service or collection; the `lab_report` apply writes the newest collection date (2.10) |
| `fileDeletedAt` | Set when the purge erased the file |
| `createdAt`, `updatedAt` | Timestamps |

Indexes: `(user_id, created_at)`, `storage_object_id`, `intake_id`. `photo_intakes` gains `retention` (`keep` by default), the choice recorded on the intake. The constants live in `apps/api/src/health-documents/health-document.constants.ts`, plain data with no Nest or Prisma import.

### 2.2 Which uploads become documents

An intake kind opts in with `IntakeKind.healthDocumentKind` (`apps/api/src/intake/intake-kind.interface.ts`). For such a kind:

- Attaching a file writes the `photo_intake_photos` link and the `HealthDocument` in one transaction. The document takes name, type and size from the storage object.
- The `body_metric_reading` kind declares `healthDocumentKind = 'body_metric'`, and `lab_report` declares `'lab_report'` (2.10).
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
- **The job** (`health-documents/handlers/health-document-purge.handler.ts`, payload `{ healthDocumentId, reason? }`; `reason` defaults to `delete_after_processing`, and `user_delete` comes from an owner delete, 2.11):
  1. Reads the document. A missing or already purged document is a no-op, and so is a `keep` document unless the reason is `user_delete`.
  2. Hard-deletes the storage object through `ObjectsService.delete` as the owner. An object that is already gone counts as deleted.
  3. Stamps `file_deleted_at` and nulls `storage_object_id`, conditional on `file_deleted_at IS NULL`.
  4. Writes the audit row and counts the purge.
- **Idempotent.** A duplicate job or a rerun changes nothing; enqueue uses `skipDedup` because a unique violation would abort the apply transaction.
- **Retried.** A storage failure counts `failed` and rethrows, so the queue retries. The profile is `{ maxRuntimeMs: 5 min, maxAttempts: 8 }`.
- **Never rolls back measurements.** The purge runs after the apply committed and never touches measurement rows.
- **Server-only.** The handler has neither `nodeResultSchema` nor `persistNodeResult`: deleting objects from the deployment's storage is a privilege a worker node must never hold.
- **Detach.** Removing a file from an intake (`DELETE /api/intakes/:id/photos/:storageObjectId`) deletes its document with the link, in one transaction. The file was never processed, and the existing cleanup may delete the object.
- **Keep.** A `keep` document is never purged by apply or discard. It survives discard and stays until its owner deletes it (2.11).

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
- **Audit.** A successful purge writes `health:document:delete`, `targetType` `health_document`, `targetId` the document id, `meta` with the storage object id, the intake id, a file count and the reason (`delete_after_processing`, or `user_delete` for an owner delete, 2.11). Never a file name or content. The write is best effort: an audit failure is logged and does not retry a purge that already erased the file.
- **Logs.** Ids and counts only. A file name never reaches a log line, a span, an audit row or an error message.
- **Ownership.** The intake routes are owner-scoped, so another user's intake, photo or document id is a `404`. The purge deletes the object as its owner.
- **Permissions.** The intake kind requires `health_data:read` and `health_data:write` on top of `intakes:*` ([health-data.md 2.17](health-data.md#217-photo-readings)).

### 2.8 Blood work: lab results

A lab analyte is a metric registry entry in the `lab` category, not a table: results are `measurements` rows, written and read through `/api/measurements` behind `health_data:read`/`health_data:write`, with the same revisions, soft deletes and owner scope ([health-data.md 2.8 to 2.13](health-data.md#28-metric-registry)).

**Catalog.** 92 analytes in `apps/api/src/measurements/metric-registry.ts`, each with a permanent snake_case `key`, `label`, `panel`, canonical unit, accepted units, hard bounds, display `decimals`, `aliases` and `siUnit`. `GET /api/measurements/metrics` publishes them with `panel`, `aliases` and `siUnit` (null for non-lab metrics); every entry of `units[]` also carries `decimals`, the display precision of a value shown in that unit (the unit's own when it declares one, else the metric's).

| Panel | Keys |
|---|---|
| `lipids` | `total_cholesterol`, `ldl_cholesterol`, `hdl_cholesterol`, `triglycerides`, `non_hdl_cholesterol`, `apob`, `chol_hdl_ratio`, `ldl_hdl_ratio`, `tg_hdl_ratio`, `vldl_cholesterol`, `lipoprotein_a` |
| `glycemic` | `fasting_glucose`, `hba1c`, `fasting_insulin`, `eag`, `c_peptide` |
| `cbc` | `hemoglobin`, `hematocrit`, `rbc_count`, `wbc_count`, `platelet_count`, `mcv`, `mch`, `mchc`, `rdw`, `mpv`, `neutrophils_pct`, `lymphocytes_pct`, `monocytes_pct`, `eosinophils_pct`, `basophils_pct`, `neutrophils_abs`, `lymphocytes_abs`, `monocytes_abs`, `eosinophils_abs`, `basophils_abs`, `immature_granulocytes_pct` |
| `cmp` | `alt`, `ast`, `alp`, `total_bilirubin`, `albumin`, `creatinine`, `egfr`, `bun`, `sodium`, `potassium`, `calcium`, `chloride`, `co2`, `total_protein`, `globulin`, `albumin_globulin_ratio`, `bun_creatinine_ratio`, `anion_gap`, `direct_bilirubin`, `ggt`, `magnesium`, `phosphorus`, `ldh`, `amylase`, `lipase`, `uacr`, `cystatin_c` |
| `thyroid` | `tsh`, `free_t4`, `free_t3`, `total_t4`, `total_t3`, `tpo_antibodies` |
| `iron` | `ferritin`, `serum_iron`, `tibc`, `transferrin_saturation` |
| `other` | `vitamin_d_25oh`, `vitamin_b12`, `hs_crp`, `testosterone_total`, `testosterone_free`, `cortisol`, `uric_acid`, `folate`, `zinc`, `psa`, `estradiol`, `shbg`, `dhea_s`, `lh`, `fsh`, `prolactin`, `esr`, `homocysteine` |

**Differential naming.** A differential prints each cell type twice, so the percentage and the absolute count are separate keys that never share a name: `neutrophils_pct` and `neutrophils_abs`, and likewise lymphocytes, monocytes, eosinophils and basophils; `immature_granulocytes_pct` is the percentage only. A bare name ("Neutrophils", "Lymph", "Eos") resolves to the percentage key, as most reports print it. A bare name printed with a count unit (`10^3/µL`) is then flagged by the unit check, because the percentage analyte does not allow that unit, and the user maps it to the `_abs` key. Names that say "Absolute", "Abs" or "Count" resolve to the `_abs` key.

**Lipoprotein(a).** `lipoprotein_a` is a catalog analyte in `nmol/L` only. A mass result (`mg/dL`) is not converted, because the factor depends on the apo(a) isoform: it is kept, flagged `uncertain` and refused at apply until the user rejects it or re-enters it in `nmol/L`.

**Canonical units.** The US conventional unit, for every user (mg/dL, ng/mL, U/L, `10^3/µL`, HbA1c in `%`; the five unitless ratios, `albumin_globulin_ratio`, `bun_creatinine_ratio` and the lipid ratios `chol_hdl_ratio` (cholesterol/HDL), `ldl_hdl_ratio` and `tg_hdl_ratio` (triglyceride/HDL), use the unit `ratio`, which a result printed without a unit takes); `displayUnit` does not follow the metric/imperial preference, because labs in metric countries print either convention. SI units are accepted alternatives with analyte-specific factors where molar mass matters (glucose mmol/L x 18.02, cholesterols x 38.67, triglycerides x 88.57, creatinine µmol/L / 88.42, BUN as urea mmol/L / 0.357, vitamin D nmol/L / 2.496, and so on). HbA1c in mmol/mol uses the IFCC-NGSP master equation, `% = mmol/mol / 10.929 + 2.15`, published as a unit `factor` plus `offset`. Lab units are compared through the unit normaliser (below). Conversions are pinned on known values in `apps/api/src/measurements/lab-catalog.spec.ts` (glucose 100 mg/dL = 5.55 mmol/L, HbA1c 6.5 % = 48 mmol/mol).

**Unit normaliser.** `normalizeLabUnit(unit)` in `metric-registry.ts` turns a printed unit into a comparison key, never shown or stored. `unitFor` compares the key of the printed unit with the key of each accepted unit, so a portal's spelling matches the catalog's. It folds:

- case, whitespace, compatibility forms (`m²` to `m2`, `m^2` to `m2`) and a trailing `/` left by a wrapped unit;
- micro: `µ`, `μ` and `u`;
- `unit` and `units` to `U` (`unit/L` is `U/L`);
- powers of ten: `10^3`, `10*3`, `10E3`, `x10E3`, `x10^3` and `X10(3)` are the same;
- counts per microlitre: `K`, `thou` and `thousand` mean `10^3`, `M`, `mil` and `million` mean `10^6`, and `/mm3` and `/cumm` mean `/µL` (so `K/uL`, `x10E3/uL` and `10^3/mm3` all match `10^3/µL`).

A spelling the rules cannot derive is declared per analyte in `unitAliases` (printed spelling to one of the analyte's units, checked at load; never published as a unit to pick). `egfr` carries `{ 'mL/min': 'mL/min/1.73m²' }` for a PDF that wraps the unit after `mL/min/`. Both rules are pinned in `lab-catalog.spec.ts`.

**SI unit and display precision.** Every analyte names its `siUnit`, always one of its accepted units: the SI alternative where the conventions differ (mmol/L for glucose and the lipids, µmol/L for creatinine, bilirubin and uric acid, mmol/mol for HbA1c, g/L for hemoglobin, albumin and ApoB, `10^9/L` and `10^12/L` for cell counts, nmol/L or pmol/L for vitamins and hormones, µg/L for ferritin, L/L for hematocrit), and the canonical unit where they agree (U/L enzymes, mmol/L electrolytes, mIU/L TSH, mg/L hs-CRP, `%` transferrin saturation, fL, eGFR). The SI unit declares its own `decimals` (glucose and BUN mmol/L 1; lipids mmol/L 2; creatinine, bilirubin and uric acid µmol/L 0; HbA1c mmol/mol 0; vitamin D nmol/L 0; B12 pmol/L 0; total testosterone nmol/L 1; cortisol nmol/L 0; free T4 and free T3 pmol/L 1; insulin pmol/L 0; iron µmol/L 1). Pure helpers in the registry: `labDisplayUnit(metric, labUnits)` (the SI unit when `si`, else canonical; non-lab metrics always canonical), `unitDecimals(key, unit)` and `toDisplayUnit(key, canonicalValue, targetUnit)` (inverse conversion, rounded to that unit's precision; display only). Pinned in `lab-catalog.spec.ts`: LDL 124 mg/dL = 3.21 mmol/L, creatinine 1.0 mg/dL = 88 µmol/L, HbA1c 6.5 % = 48 mmol/mol, glucose 100 mg/dL = 5.6 mmol/L at 1 decimal (5.55 at 2).

**Lab unit preference.** `health_profiles.lab_units` (`labUnits`: `conventional`, the default, or `si`; [health-data.md](health-data.md)) chooses the unit lab results are **shown** in: the web app and the export convert canonical values with the catalog's factors at display time. Storage never changes: values and reference limits stay canonical, entry still accepts any listed unit, and switching the preference rewrites no row. Body and vital metrics keep following `unitSystem`.

**Alias lookup.** `resolveLabAnalyte(name)` returns the analyte whose key, label or alias matches after folding case, accents, spaces and punctuation ("LDL-C", "LDL Cholesterol", "Low density lipoprotein" all give `ldl_cholesterol`; "Chol/HDL Ratio", "TC/HDL" and "Cholesterol/HDL-C Ratio" give `chol_hdl_ratio`, "LDL/HDL Ratio" gives `ldl_hdl_ratio`, "TG/HDL" and "Triglyceride/HDL Ratio" give `tg_hdl_ratio`; "Lp(a)" and "Lipoprotein (a)" give `lipoprotein_a`), or undefined; it never guesses. Loading the registry throws if one folded alias names two analytes.

**Per-result context.** Four nullable `measurements` columns hold what the lab printed, on the event rather than the catalog: `referenceLow` and `referenceHigh` (canonical unit), `referenceText` (at most 100 characters, for ranges such as `<100` or `negative`) and `flag` (`low`, `normal`, `high`, `critical`, `unknown`). `origin` and `method` (`lab`, `point_of_care` and others) are unchanged.

**API rules.**

- A reading's limits are sent in the reading's `unit` and converted with the value. `referenceLow` must not exceed `referenceHigh` when both are set. The four fields are refused on body and vital metrics.
- One report is one entry: 1 to 150 lab readings under one `entryId` (`MAX_LAB_READINGS_PER_ENTRY`, one collection date of a report). Lab and body/vital readings never share an entry.
- An edit (a new revision) copies range and flag forward unless the body changes them; `null` clears one. The range rule is checked on the merged reading.
- `GET /api/measurements` lists lab rows only with `category=lab` or a lab `metricKey`; the default list and `latest` stay body and vital. `series` accepts a lab key.
- Values, ranges and notes never reach a log line or an issue message; the delete audit row carries the reading count only.
- Lab results are on the training agents' never-send list (`labs` in `apps/api/src/training-agents/context/never-send.ts`): the context loaders select metric keys explicitly, and the data-minimisation canary seeds lab rows with range context to prove it.

Lab report PDFs and page photos are read into these rows by the `lab_report` intake kind ([2.10](#210-lab-report-extraction)).

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

### 2.10 Lab report extraction

A lab report the user receives as a PDF (a patient portal) or on paper (photographed page by page) is transcribed by AI, reviewed by the user and saved as one lab entry per collection date with full provenance. It is the `lab_report` kind of the shared intake ([the intake README](../../apps/api/src/intake/README.md)).

**The kind** (`apps/api/src/measurements/lab-report/lab-report.kind.ts`):

| Member | Value |
|---|---|
| `kind` | `lab_report` (permanent) |
| `acceptedInputs`, `maxPhotos` | `['image', 'pdf']`, 10 (a PDF counts as one; 20 pages each) |
| `healthDocumentKind` | `lab_report`: each file is a health document with the keep-or-delete choice (2.3 to 2.5) |
| `analyzeJobType`, `aiFeature` | `ai.health.lab_report`, `lab_report` (its own administrator-assigned model: vision input and structured output, plus file input for a PDF) |
| `requiredPermissions` | `health_data:read` / `health_data:write` on top of `intakes:*` |
| `itemKinds` | `['result']` |

**Flow.** `POST /api/intakes { kind: 'lab_report', retainFiles? }`, attach the PDF or photos, `POST /api/intakes/:id/analyze`. The job drafts one pending item per printed result, each with its own `collectionDate`, and writes the report date and `labName` into the intake's `context`. The user reviews (accept, edit, reject, add, accept all, accept high confidence), may correct the report date with `PATCH /api/intakes/:id { context }` or an item's date with `PATCH /api/intakes/:id/items/:itemId`, decides on each result that is already saved (the duplicate warning), then `POST /api/intakes/:id/apply`.

**Multi-date reports.** A report is either one date or a trend table (analytes as rows, collection dates as columns). The prompt has the model identify the layout and emit one result per analyte and date cell, each with that cell's `collectionDate`; empty cells are skipped.

**Non-results and wrapped units (prompt version 3, `LAB_REPORT_PROMPT_VERSION`).** A cell that prints no result ("NOT APPLICABLE", "SEE NOTE", "TNP", "Cancelled", "Pending", "N/A", `--`) is never emitted, and a unit that wraps onto the next line of a cell ("mL/min/" over "1.73m2", "x10E3/" over "uL") is joined into one unit and never leaks into `referenceText`. The mapper backs the prompt: `isNonResult` drops any result with no number whose printed text says there is none, and `resultMeta.nonResultsDropped` counts them, so they never block apply with "no numeric value". A non-result is empty text, or text that starts with a non-result phrase ("NOT APPLICABLE (CALC)", "N/A*"), or contains one as a whole token with nothing that reads like a result; this holds for matched and unmatched analytes alike. A genuine qualitative result ("negative", "<0.5", ">90", "trace") is kept. `resultsTruncated` counts only the cap on results returned. Printed demographics (birth date, age) and order, print or report-generated dates are never a result date, and a date is never invented.

**Context** (`labReportContextSchema`, strict, optional): `collectionDate`, the **report date** (`YYYY-MM-DD`, a real date, not before 1900, not after tomorrow UTC), and `labName` (at most 120 characters). The report date is a fallback: it dates only the results without their own date. The job sets it to the model's report-level date when valid, else to the one date every dated result shares, else leaves it. The job overwrites a field only when it read one; a field it could not read keeps the intake's value.

**Draft item value** (`labReportValueSchema`, strict; every field but `match` defaults to null on input):

| Field | Meaning |
|---|---|
| `analyteKey` | A lab catalog key, or null = **unmatched** |
| `nameAsPrinted` | The analyte name as printed (a user-added result without one gets the analyte label) |
| `value`, `unit` | The number and its unit; canonical once matched and convertible |
| `collectionDate` | The result's own collection date (`YYYY-MM-DD`, not before 1900, not in the future), or null = the report date applies. An invalid date the model returned is discarded to null, the item flagged `uncertain` with the note "Date not read". A draft saved without the field parses as null; the user can set or clear it |
| `valueText` | A non-numeric result as printed (`negative`, `<0.5`); shown, never saved |
| `originalValue`, `originalUnit` | What the report printed, kept when the value is converted |
| `referenceLow`, `referenceHigh`, `referenceText`, `flag` | The printed range and the lab's flag; limits in `unit` |
| `panel` | The analyte's panel once matched, else a printed heading that names a panel, else null |
| `match` | `matched`, `suggested`, `user_mapped` or `unmatched` |

**Matching is the server's.** The prompt asks for a `matchedKey`, but the server never trusts it blindly (`lab-report.mapper.ts`):

1. `resolveLabAnalyte(nameAsPrinted)` (2.8). A hit is `matched`; a model key that disagrees is ignored and counted (`resultMeta.hintsIgnored`).
2. Otherwise, a model key that is a valid lab key is used as a **suggestion**: `match: 'suggested'`, the item `uncertain` with the note "Matched from the AI's suggestion: confirm the analyte".
3. Otherwise the result is `unmatched`, `uncertain`, with the note "Not in the lab catalog: map it to an analyte or reject it".

On every user write, `normalizeValue` recomputes `match` from the printed name and the key (`matched` when the name resolves to the key, `user_mapped` otherwise, `unmatched` without a key), fills a missing unit with the canonical one and refuses a unit the analyte does not allow, a value outside its hard bounds or reversed limits (400, `details.issues` naming `value.<field>`).

**Name matching.** `resolveLabAnalyte` first folds the name (case, accents, punctuation) and looks it up among labels and aliases. When that fails it retries after stripping qualifiers at either end of the name (`LAB_NAME_QUALIFIERS`: `lvl`, `level`, `serum`, `ser`, `plasma`, `blood`, `bld`, `whole blood`, `total`, `calc`, `calculated`) and a printed "Normal Range: ..." suffix, fewest removals first, and keeps a stripped form only when it still resolves, so "Glucose Lvl" and "Albumin Lvl" resolve while "Total Protein" and "Bilirubin, Total" keep their own keys. A name the catalog lacks stays unmatched.

**Units.** A matched result in an accepted alternative unit is converted with its limits (glucose 5.4 mmol/L is drafted as 97.2973 mg/dL, 3.9 to 5.5 as 70.2703 to 99.0991), and `originalValue`/`originalUnit` keep 5.4 mmol/L. A unit the analyte does not allow, a missing number or an out-of-range value is kept, flagged `uncertain` and `low`, and refused at apply until edited or rejected.

**Never silently dropped.** Every result the model returned is a draft (up to 250 per answer, `LAB_REPORT_MAX_RESULTS`; more is counted in `resultMeta.resultsTruncated`). An accepted unmatched result refuses the apply with **409 `UNRESOLVED_ANALYTES`**, `details.itemIds` listing every such item and `details.count`; nothing is written and the intake stays `ready`. A pending one is already refused by `PENDING_ITEMS`. The user maps it (`PATCH /api/intakes/:id/items/:itemId` with `value.analyteKey`, or the map route below, which also corrects every same-named result) or rejects it (one by one, or all at once with the reject-unmatched route below).

**Apply** (inside the intake transaction; a throw rolls everything back):

- Accepted items are grouped by **effective date**: the item's own `collectionDate`, else the report date, else none (the time of apply). One lab entry is written per group, each row `method: 'lab'`, with `referenceLow`, `referenceHigh`, `referenceText` and `flag`.
- Other refusals, all at once as a 400 with `details.issues` (one entry per issue, its path naming the item and field): no numeric value, a unit or value the analyte does not allow, reversed limits, the same analyte accepted twice **within one date group**, more than 150 results (`MAX_LAB_READINGS_PER_ENTRY`) in one date group. The caps and the duplicate rule apply per date, and their messages name the date. A duplicate is reported on **every** occurrence, not only the second, and its message reads "<analyte> appears more than once on <date>; reject one of them or change its date". Messages name the analyte, the field and the rule, never a value.
- The checks are one function, `labApplyIssues` (`lab-report-issues.ts`), shared by apply and the issues route below. See the issue codes there.
- `measuredAt` of an entry is its date at noon UTC (never later than now); the undated group is the time of apply.
- `measuredAtSource` is `collection_date` when every entry is dated, `apply_time` when none is and `mixed` otherwise.
- Every health document of the intake gets `documentDate` = the newest dated group's date.
- The intake module then enqueues the purge of `delete_after_processing` files (2.4).
- The response is `{ entryId, entryIds, entries, items, measuredAtSource, documentDate }`. `entries` is `[{ entryId, collectionDate, items }]`, newest date first and the undated entry last; `entryId` is the first entry's (kept for older clients), `entryIds` lists them all and `items` is every saved row. When every item was rejected, `entryId` is null, `entryIds` and `entries` are empty and `measuredAtSource` is null.

**Map once (`POST /api/measurements/lab-reports/:intakeId/map`).** A trend report prints the same analyte once per date, so a correction to one result usually holds for all of them. Body `{ itemId, analyteKey?, unit? }` (strict; at least one of the two; `analyteKey` must be a lab catalog key); response `{ items, skipped }`: `items` are the results now corrected (the clicked one, even when unchanged, then its changed siblings, in review order) and `skipped` is `[{ itemId, message }]`, the siblings left unchanged and the rule each would break (never a value). Guarded by `health_data:write` and `intakes:write`; another user's intake, one of another kind, or an unknown `itemId` is 404; an applied intake is 409 (`ALREADY_APPLIED`). Everything runs in one transaction under a `FOR UPDATE` lock on the intake row, so an apply sees every change or none (`lab-report-map.service.ts`).

- **Same-named.** Another `result` item of the intake that is not rejected and whose printed name folds (`foldAnalyteName`) to the clicked item's. A clicked item without a printed name has no siblings.
- **Analyte.** Applied to the clicked item and to every same-named result except one the user already mapped to a **different** analyte (user-added, or an AI item carrying `originalAiValue`, with a key that differs). Pending results stay pending; unmatched and suggested ones are covered.
- **Unit**, after the analyte step. Applied to the clicked item and to every same-named result that has the same analyte, was **printed** with the same unit (the unit the model read, kept in `originalAiValue` after a user edit) and still holds its printed number in its printed unit. A sibling whose unit or number the user changed is left alone. Each target keeps its printed number and limits and reads them in the new unit; the normal path converts them to canonical.
- **Writes** match an item `PATCH`: the kind's validation and `normalizeValue` (`match` recomputed, bounds and units checked), `userVerified` set, `originalAiValue` kept on the first edit, `status` untouched, and a value equal to the stored one is not written. A sibling that validation refuses is left entirely unchanged and listed in `skipped`; a refusal of the clicked item is the 400 the `PATCH` would answer.

**Reject unmatched (`POST /api/measurements/lab-reports/:intakeId/reject-unmatched`).** No body; response `{ items }`, the results it rejected (empty when none). It rejects, in one transaction under the same lock, every non-rejected `result` item whose `analyteKey` is null. A suggested, matched or user-mapped result carries a key and is never touched. Only `status` changes, so the review's restore (`PATCH /api/intakes/:id/items/:itemId` with `{ status: 'pending' }`) works on it. Same guards, 404 and 409 as the map route (`lab-report-reject-unmatched.service.ts`).

**Issues (`GET /api/measurements/lab-reports/:intakeId/issues`).** Answers `{ items: [{ itemId, issues: [{ code, field, message }] }] }`: every non-rejected result (pending or accepted) with at least one issue, in review order, checked as if all were accepted. Apply and the route share `labApplyIssues`, so the route lists what apply would refuse before the user presses Save. Guarded by `health_data:read` and `intakes:read`; another user's intake, or one of another kind, is 404.

| Code | Meaning | `field` |
|---|---|---|
| `INVALID_RESULT` | The stored value is not a lab result | null |
| `UNMATCHED` | No catalog analyte | `analyteKey` |
| `UNIT_NOT_ALLOWED` | A unit the analyte does not allow | `unit` |
| `NO_VALUE` | No numeric value | `value` |
| `OUT_OF_RANGE` | Outside the analyte's hard bounds | `value` |
| `REFERENCE_ORDER` | `referenceLow` above `referenceHigh` | `referenceLow` |
| `DUPLICATE_ON_DATE` | The same analyte more than once on one effective date; reported on every such result | `analyteKey` |
| `DATE_CAP` | More than 150 results on one effective date; listed on each of them | null |

Apply maps the issues to its two refusals: any `UNMATCHED` is the 409 `UNRESOLVED_ANALYTES`; otherwise any other issue is the 400 with `details.issues`. An unmatched result takes no part in the per-date checks.

**Review UI** (`apps/web/src/components/health/LabReportReview.tsx`, `LabReportDialog.tsx`). Results are grouped by effective date, newest first, each group headed by its date and result count; the undated group comes last and says it is saved with today's date. Two bulk buttons sit above the list: "Accept all" (with a confirmation while low-confidence results are pending) and "Accept high confidence" (`POST /api/intakes/:id/items/accept-all` with `{ "only": "high_confidence" }`: pending, confidence `high`, not `uncertain`; disabled at zero). Each row shows its date and the item editor has a date field that sets or clears it. The header field is the **Report date**, used for results without their own date; the optional laboratory name stays beside it. After apply the message counts the entries ("Saved 85 results on 5 dates").

- **Mapping.** An unmatched row carries a "Map to an analyte" picker. Picking an analyte calls the map route, so every same-named result is mapped, and the review says "Mapped N results named “…” to <analyte>" (plus a count of the ones that could not be mapped). An edit that changes a row's analyte or unit saves the row with the item `PATCH`, then calls the map route with the change when same-named results exist, and says "Updated N other results named “…”".
- **Reject unmatched.** A "Reject unmatched (n)" button sits in the top toolbar beside the two accept buttons, and the "not in the lab catalog" save hint offers the same action. Both ask "Reject N results that are not in the lab catalog?" first. A rejected row can still be restored.
- **Needs attention.** A row with an issue from the issues route carries a "Needs attention" badge. Its reasons appear on tap or click, plus a hover tooltip on pointer devices.
- **Filter bar.** A sticky bar above the list has a search box (matches the printed name, the analyte label, its aliases and the panel) and single-select chips: Needs attention, Unmatched, Already saved, Pending. It shows "Showing X of Y" and a "Clear filters" action, and an empty state when nothing matches. The bulk actions are unaffected by the filters: they act on the whole report.
- **Not saved yet.** The "Not saved yet" panel (the refusal from a Save attempt) links each reason to its row and has "Show rows that need attention", which applies the Needs attention filter.
- **Save hint.** The save hint has a show-rows button that does the same.
- **Already-saved results.** A row that repeats a saved result carries an "Already saved" badge (with the saved date) and two choices: **Skip** rejects the draft (persisted, so nothing is written) and **Save again** keeps it (a choice held for the review session). A compact bar replaces the list of duplicates ("N results are already saved") with **Skip all** and **Save all N again**. Save is blocked, with the hint "Decide on N already-saved results", until each duplicate has a decision; there is no "Save anyway". A decision can be changed before saving, and a skipped row can be restored. The route has no bulk reject, so Skip all rejects each row with one item `PATCH`.

**Provenance** (`measurements.source_ref`, `lab-report-source-ref.ts`):

| Row from | `origin` | `sourceRef` |
|---|---|---|
| An AI item | `ai` | `{ kind: 'lab_report', intakeId, draftItemId, storageObjectIds, healthDocumentId, aiDraft, confidence, userEdited, originalAiValue?, nameAsPrinted, originalValue, originalUnit, match, collectionDate, labName }` |
| A user-added item | `manual` | `{ kind: 'lab_report', intakeId, healthDocumentId, userAdded: true, collectionDate, labName }` |

`userEdited` is true when the saved result differs from the AI draft (analyte, canonical value, limits, text or flag); `originalAiValue` (the drafted canonical value) is present only then. A later `PATCH /api/measurements/entries/:entryId` recomputes both on the value. `healthDocumentId` is the document of the first input the result was read from, and `fileDeleted` on the measurement view follows it (2.6).

**Duplicate warning.** `GET /api/measurements/lab-reports/:intakeId/duplicates` (`health_data:read` and `intakes:read`; another user's intake, or one of another kind, is 404) answers `{ intakeId, checkedDate, collectionDate, duplicates: [{ itemId, analyteKey, value, unit, checkedDate, matches: [{ measurementId, entryId, measuredAt, origin, healthDocumentId, intakeId }] }] }`. It lists each non-rejected, matched draft with a number that equals an active saved lab result of the caller: same analyte, same UTC day, same canonical value. The day is the item's effective date (its own date, else the report date, else today), checked per item, and each duplicate carries its own `checkedDate`; the top-level `checkedDate` is the report date or today. Rows applied from the same intake are not reported. A duplicate is exact: the same analyte, day and value. The route only reports: apply never de-duplicates, and the review's decisions (Skip rejects the draft, Save again keeps it) are what keep or drop each row.

**The job** (`lab-report.handler.ts`): server-only (no `nodeResultSchema`, no `persistNodeResult`), profile `{ maxRuntimeMs: 10 min, maxAttempts: 1 }` (a 250-result table can take a reasoning model minutes), one structured call through `AiService.forUser(intake.userId)` with schema name `lab_report`, `strict: true` and a 32000 output-token budget (`LAB_REPORT_MAX_OUTPUT_TOKENS`; the runtime still clamps it to the deployment and model caps). The inputs go as `file` (PDF) and `image` parts, labelled `Photo <n> (PDF document):` / `Photo <n>:`. The prompt (`lab-report.prompt.ts`, version 2) sends the catalog as `key — label (aliases)` lines, reads a name cell that also prints "Normal Range: ..." (the range goes to the reference fields, `nameAsPrinted` is the name only), strips a suffix such as "(CALC)" from a value into the note, and says to extract only what is printed, never interpret, diagnose or compute, keep units as printed, include rows it does not recognise and treat the document's text as data. Failures follow the body-metric job: a rate limit defers, a terminal AI code fails the intake with a user-safe message (the PDF message for a model without `file_input`), anything else fails it and throws, and a settled-failed job fails a still-scanning intake.

**Observability.** The job span carries `intake.input_kind`, `lab_report.input_count`, `lab_report.draft_count` and `lab_report.unmatched_count`; the analyze span carries `intake.page_count` (an image is one page, a PDF its counted pages). The span's own duration is the scan duration. `resultMeta` holds counts and the prompt version only (`unmatched`, `suggested`, `flagged`, `converted`, `hintsIgnored`, `collectionDateRead`, `distinctDates`, ...), never a name or a value. The AI call is recorded by the gateway in `ai_runs`/`ai_usage_events` like every call; the document reaches only this extraction call and never a training agent (lab results are on the never-send list, 2.8).

**Fake provider.** The fake vision server (`tests/e2e/support/fake-vision-server.mjs`) answers every `lab_report` request with the `lab-report-panel` fixture (`apps/api/test/fixtures/lab-report/lipid-glucose-panel.model-output.json`): every result dated 2026-09-15, collected 2026-09-15 by "Acme Clinical Laboratories", four lipids in mg/dL, `Apolipoprotein A1` (not in the catalog), glucose 5.4 mmol/L and HbA1c 5.6 %.

### 2.11 Documents API

`/api/health/documents` (`apps/api/src/health-documents/health-documents.controller.ts`, tag "Health Documents") lets the owner see and manage every document the system holds about them. The Health Documents settings card (`/settings/health-documents`, `health_data:read`) is its UI ([settings-ui.md](settings-ui.md)).

| Route | Permission | What it does |
|---|---|---|
| `GET /api/health/documents` | `health_data:read` | Flat-paginated list (`page`, `pageSize` up to 100), filter `kind`, `sort` `createdAt` (default) or `documentDate` (undated last), `order` `desc` (default) or `asc` |
| `GET /api/health/documents/:id` | `health_data:read` | One document; `ETag: "<version>"` |
| `GET /api/health/documents/:id/download?disposition=inline\|attachment` | `health_data:read` | A signed URL valid 300 seconds; `Cache-Control: no-store` |
| `PATCH /api/health/documents/:id` | `health_data:write` | Rename (`originalName`) and/or set `documentDate` (`null` clears it); `If-Match` required |
| `DELETE /api/health/documents/:id?deleteValues=true\|false` | `health_data:write` | Delete the file, or the record of a file already gone; `If-Match` required |

**Ownership.** Every route reads and writes only the caller's rows. Another user's id, or an unknown one, is a `404` on every route.

**Item.** `id`, `kind`, `originalName`, `mimeType`, `sizeBytes` (decimal string), `documentDate` (`YYYY-MM-DD` or null), `createdAt` (upload time), `updatedAt`, `retention`, `valueCount`, `fileAvailable`, `fileDeletedAt`, `fileDeletionPending`, `intakeId`, `version`.

- `valueCount` counts the caller's active measurements (not superseded, not deleted) whose `sourceRef.healthDocumentId` names the document. One grouped query per page on `source_ref->>'healthDocumentId'`, scoped by `user_id`.
- `fileAvailable` is `storageObjectId != null && fileDeletedAt == null`.
- `fileDeletionPending` is `true` while a `health.document.purge` job for the document is pending or running (one job query per page).

**Concurrency.** `health_documents.version` (default 1) is incremented by every write: a rename or date change, an owner delete, a retention change through the intake, the lab report's collection date and the purge. PATCH and DELETE require `If-Match` with it (bare `4`, `"4"` or `W/"4"`). A missing or unparseable header is a `400` with `details.reason: IF_MATCH_REQUIRED`. A stale one is a `412 PRECONDITION_FAILED` with `details.reason: HEALTH_DOCUMENT_STALE` and `details.currentVersion`, and nothing changes. The check is a conditional write on `version`; the read before it only tells `404` from `412`.

**Rename.** The name is sanitised before it is stored. Control characters and the Unicode direction marks that can disguise an extension are removed, `/` and `\` become `_`, and whitespace is collapsed and trimmed. The result is 1 to 255 characters (`health-document-names.ts`). Only the document's name changes, never the storage object's.

**Download.** The service signs the owner's storage object (`status: ready`) through the storage provider's `getSignedDownloadUrl` with `expiresIn: 300` and a `Content-Disposition` it builds itself:

- `filename="…"` is a printable-ASCII fallback with no `"`, `\`, `%` or `;`.
- `filename*=UTF-8''…` is the exact sanitised name, RFC 5987 encoded.
- `inline` is honoured only for PDFs and raster images; any other type is signed as `attachment`.

The body is `{ url, expiresIn, expiresAt, disposition, fileName, mimeType }`. The URL never reaches a log line or a span. Refusals are a `409` with `details.reason`:

- `HEALTH_DOCUMENT_FILE_DELETED`: the file was erased.
- `HEALTH_DOCUMENT_FILE_DELETION_PENDING`: a purge is queued or running.
- `HEALTH_DOCUMENT_FILE_NOT_READY`: the object is missing or its upload is not complete.

**Delete.** One transaction:

1. Read the document, `404` if not the caller's, `412` if stale.
2. With `deleteValues=true`, soft-delete (`deletedAt`) the caller's active measurements whose `sourceRef.healthDocumentId` is the document, and only those.
3. Then one of two paths:
   - **The file still exists (`scope: file`).** Bump `version` and enqueue `health.document.purge` with payload `{ healthDocumentId, reason: 'user_delete' }` (`skipDedup`). The job erases the file whatever its retention (a `user_delete` purge skips the `kept` no-op) and stamps `file_deleted_at`. The row stays, so provenance never dangles, and it lists as metadata only: "file deleted on …".
   - **The file is already gone (`scope: record`).** Delete the row. Measurements keep `sourceRef.healthDocumentId`, and `fileStatesOf` reads a missing document as a deleted file, so they report `fileDeleted: true`.
4. Write `health:document:delete` with `meta` `{ documentId, valuesDeleted, scope, reason: 'user_delete' }`, never a name.

The response is `{ id, scope, jobId, valuesDeleted }`. Values kept without `deleteValues` stay, now with `fileDeleted: true` once the purge ran. Soft-deleted values disappear from history and remain only as counted rows.

**Observability.** `app.health.documents.downloads` (attribute `disposition`) and `app.health.documents.deletes` (attributes `scope` and `values` of `kept` or `deleted`), see [telemetry.md](telemetry.md). Spans carry `health.document.id` and, on delete, `health.document.delete_scope` and `health.document.values_deleted`. Logs carry ids and counts only.

**Web page.** `/settings/health-documents` (`apps/web/src/pages/UserHealthDocumentsPage.tsx`) is the Health Documents card in the Health group of `USER_SETTINGS_SECTIONS`, its own destination rather than a tab on Health Profile. Card and route are gated on `health_data:read`.

- **List.** A `DataTable`: a grid at desktop width and cards below `sm`. Each row shows the name, kind, file type, size, document date, upload date, retention, value count and file status ("Available", "Deleting…" or "File deleted on …"). The kind filter, the document and upload date sort and the pagination are sent to the API; nothing is filtered in the browser. CSV export is off.
- **View.** The dialog fetches an `inline` URL when it opens and shows a PDF in an `<iframe>` and an image in an `<img>`, with "Open in a new tab" always offered. The page's CSP has no `frame-src`, so a PDF served from another origin (an S3 bucket) does not render in the frame; the new-tab link is the fallback.
- **Download.** Fetches an `attachment` URL and hands it to the browser.
- **Rename or set date.** Sends only the changed fields with `If-Match`.
- **Delete.** A confirmation dialog with the checkbox "Also delete the N values extracted from this document", hidden when `valueCount` is 0. A row whose file is already gone says it removes the record.
- **Concurrency.** A `412` on rename or delete closes the dialog, refreshes the list and tells the user the document changed.
- **Permissions in the page.** View and Download are disabled while the file is deleted or being deleted. Without `health_data:write`, Rename and Delete are disabled with the reason shown under the menu item, and an info alert explains why. Signed URLs live in component state only.

### 2.12 Blood-work history: biomarker summary, series and revisions

The biomarker views read lab results through three routes, all owner-scoped behind `health_data:read` (a foreign id is a `404`). Values and limits are canonical; the web app converts for display.

**Summary.** `GET /api/health/biomarkers/summary` (`apps/api/src/measurements/biomarkers/`, tag `Measurements`) returns one item per lab analyte with at least one active result, in catalog order (panel, then analyte):

```
{ items: [{ analyteKey, label, panel, unit,
            latest:   { measurementId, value, measuredAt, flag, referenceLow, referenceHigh, referenceText },
            previous: { ...same } | null,
            delta: number | null,        // latest.value - previous.value, 4 decimals
            count: number }] }           // active results of the analyte
```

- `panel` keeps one panel; `outOfRange=true` keeps analytes whose **latest** flag is `low`, `high` or `critical`. Unknown parameters are a `400`.
- One query, whatever the catalog size: `row_number()` and `count(*)` over `PARTITION BY metric_key`, ordered `measured_at DESC, created_at DESC, id DESC` (the list order), keeping ranks 1 and 2. The `WHERE` carries `user_id` and the active-row predicate as columns, so superseded revisions and soft-deleted entries are never ranked or counted.
- Latency is covered by the existing HTTP metrics; no value reaches a log.

**Series.** `GET /api/measurements/series` with a lab `metricKey` adds `referenceLow`, `referenceHigh`, `referenceText` and `flag` to each point: ranges differ between events, so a chart draws the band per point. Body, vital and wellness points keep their shape (the fields are absent).

**Detail table.** `GET /api/measurements?metricKey=<lab key>` (or `category=lab`) already returns every active result with `origin`, `method`, range, flag, `sourceRef.healthDocumentId` and `fileDeleted` ([2.6](#26-provenance)). A kept document is opened through the documents API ([2.11](#211-documents-api)); `fileDeleted: true` shows **File deleted**.

**Revisions.** `GET /api/measurements/:id/revisions` returns every revision of one reading, newest (current) first: the `GET /api/measurements` item shape plus `supersededAt` (null for the current one) and `createdAt`. `id` may name any revision. A reading's revisions share its `entryId` and `metricKey` (an edit supersedes in place, one row per metric per entry), so the chain is one owner-scoped query rather than a walk of `supersedesId`. A deleted reading is a `404`. The route works for body and vital readings too.

### 2.13 Export

A user can take their health record out as JSON, CSV, Excel or a PDF report for a doctor. Code: `apps/api/src/health-export/`.

**Request.** `POST /api/health/exports` (`health_data:read`; exporting reads the record and changes nothing) with a strict body:

| Field | Rule |
|---|---|
| `format` | `json`, `csv` (a zip of one CSV per dataset), `xlsx` or `pdf` |
| `from`, `to` | `YYYY-MM-DD`, real dates, inclusive, `from` not after `to`, at most 3660 days, `to` not after tomorrow (UTC) |
| `datasets` | 1 to 8 distinct of `profile`, `body` (weight, body fat, waist), `vitals` (blood pressure, resting heart rate), `labs`, `wellness` (the four check-in scores, titled "Wellness / mood"), `documents` (an index of kept documents), `progress_photos` (an index of progress photos), `memories` (the user's active AI memories: `id`, `category`, `content`, `source`, `created_at`; current state, not ranged; #325, [ai-memory.md](ai-memory.md)) |
| `includeHistory` | Default `false`: also export superseded revisions |
| `labUnits` | Optional, `conventional` or `si`. Omitted = the caller's profile `labUnits` (`conventional` without a profile), resolved when the export is requested and stored on the job payload |

It answers `202` with the export (`status: pending`). At most 3 exports per user may be pending or running (`429` otherwise). The job is enqueued with `skipDedup`: two exports of different formats are different work.

**No export table.** The export id is the `health.export` job id. The job has `subjectType: 'user'`, `subjectId` the owner and the request on its payload; when the file is committed the job writes `payload.result` (`storageObjectId`, `fileName`, `mimeType`, `sizeBytes`, `rowCounts`, `completedAt`, `expiresAt`). The file itself is an ordinary `storage_objects` row owned by the user (`uploadedById`), `ready`, with `metadata.source: health_export`, under the key `exports/<userId>/<exportId>.<ext>` (`EXPORTS_KEY_PREFIX`, on `STORAGE_KEY_PREFIXES`).

**Status and download.**

| Route | Answers |
|---|---|
| `GET /api/health/exports/:id` | The export: `id`, `status`, `format`, `from`, `to`, `datasets`, `includeHistory`, `labUnits`, `createdAt`, `completedAt`, `expiresAt`, `fileName`, `sizeBytes`, `rowCounts`, `error`, `download`. `404` for an id that is not the caller's export |
| `GET /api/health/exports` | `{ items }`: the caller's 20 most recent exports, newest first; `download` is always null |

`status` is derived: `pending` or `running` from the job; `ready` when `payload.result` is present, its storage object still exists and `expiresAt` is in the future; `expired` when the result is present but the file is gone or past its expiry; `failed` otherwise. A failed export reports a fixed message, never the job's `lastError`.

While `ready`, `GET /api/health/exports/:id` mints `download: { url, expiresAt }`: a signed GET valid for 5 minutes (`HEALTH_EXPORT_DOWNLOAD_URL_TTL_SECONDS`), with `Content-Disposition: attachment; filename="<fileName>"`. Every call mints a fresh URL; the URL is never logged or stored. `fileName` is `<app>-health-<from>-<to>.<ext>`, where `<app>` is `APP_NAME` from `packages/shared` as a lowercase slug and `<ext>` is `json`, `zip`, `xlsx` or `pdf`. The service checks the name against `^[a-z0-9-]+\.(json|zip|xlsx|pdf)$` before it goes into the header.

**What is exported.** `collectHealthExport` (`health-export-data.ts`) reads the owner's rows once, read-only:

- **Range.** A wellness score is matched on its `localDate` (the user's day); every other reading on `measuredAt` in `[from 00:00Z, to+1 00:00Z)`; a document on `documentDate`, else its upload time. The profile is not ranged.
- **Soft-deleted rows are never exported.** Superseded rows only with `includeHistory`, and never the earlier revisions of a reading that was later deleted (the deletion covers its history).
- **Documents:** kept files only (`retention = keep`, file not erased), metadata only: id, kind, file name, type, size, document date, upload time.
- **Units.** Values are in the metric's canonical unit, named in the column (`weight_kg`, `Weight (kg)`), whatever the display preference. Lab results follow the export's `labUnits`: with `si`, `value`, `reference_low` and `reference_high` are converted to the analyte's SI unit and rounded to that unit's `decimals` (`convertLabRow`, through `toDisplayUnit`); with `conventional`, or where SI equals the canonical unit, the stored values are written as they are. Each lab row's `unit` names the unit used. A job queued before the field existed reads as `conventional`.
- **Shape.** Body, vitals and wellness are one row per entry (the readings saved together, side by side) with `revision`, `status` (`current` or `superseded`) and `entry_id`; with history, each superseded revision is its own row. Labs are one row per result with panel, analyte, value, unit, reference low and high, the range as printed, flag, method and origin. Profile is one row: name, date of birth, age, sex at birth, height (cm), unit system, time zone.

**Formats** (`writers/`, each a stream; nothing is buffered whole):

| Format | File |
|---|---|
| JSON | `{ schemaVersion: 1, exportedAt, range: { from, to }, includeHistory, labUnits, profile, datasets: { <dataset>: [rows] } }` (`labUnits` is additive; the version stays 1). `profile` is null unless selected; `datasets` holds the other selected datasets, rows keyed by column key. `healthExportJsonFileSchema` (`writers/json.writer.ts`) is the contract |
| CSV | A zip with `<dataset>.csv` per selected dataset: RFC 4180, CRLF, a header of column keys, a UTF-8 BOM. A text cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`; numeric columns are left alone. The helpers are shared with the telemetry export (`common/export/csv.ts`); the zip is written by `archiver` |
| XLSX | exceljs streaming writer: one sheet per dataset (titles; "Wellness / mood" becomes `Wellness - mood`), a bold header frozen at row 1 with the unit in each column header, numbers as numbers. exceljs never writes a string as a formula |
| PDF | pdfkit, A4: a header (name; age and sex at birth only with the profile dataset; period; generation date; with the labs dataset, "Lab units: US conventional" or "Lab units: SI"); **Latest biomarkers**, the latest result per analyte grouped by panel with value, unit, reference range and flag, values and range in the export's `labUnits` (lab trends too); **Trends**, a sparkline and the last 8 readings of weight, body fat, waist, blood pressure, resting heart rate and repeated LDL, HDL, triglycerides, HbA1c and fasting glucose; **Vitals and body summary**, latest, 30-day average, min, max and count; **Wellness / mood**, 7- and 30-day averages of the check-in scores, the windows ending on `to`; **Documents**, the kept-document index. Active readings only. Every page carries "Generated by <APP_NAME> from user-entered and AI-extracted data. Not a medical record." and a page number. Helvetica covers Latin-1; another character in user text prints as `?` |

**The job** (`handlers/health-export.handler.ts`, payload `{ userId, format, from, to, datasets, includeHistory, labUnits }`):

1. Parses the payload; the subject must equal `userId`. An attempt that finds `payload.result` already set does nothing.
2. Reads the datasets, renders the format and streams it to the storage provider, counting bytes on the way.
3. In one transaction, upserts the storage object (by key) and writes `payload.result`.
4. After commit: audits, records the metrics and notifies `health.export_ready`.

A failure deletes whatever was written (best effort), records a failed attempt and rethrows; on the last attempt the user is notified `health.export_failed`. The key is derived from the job id, so a retry overwrites the same object. Profile `{ maxRuntimeMs: 15 min, maxAttempts: 2 }`. **Server-only**: it reads several tables mid-computation, and its input is a health record a worker node must not receive.

**Expiry.** `HealthExportPurgeTask` (`tasks/health-export-purge.task.ts`) is a daily 03:00 `@Cron` that only enqueues `health.export.purge` through `enqueueHousekeepingJob`. The job deletes every storage object under `exports/` created more than 7 days ago: bytes, then row. A provider failure keeps that row, the run finishes the rest and then fails, so the queue retries. Profile `{ maxRuntimeMs: 30 min, maxAttempts: 3 }`, server-only. The export then reads `expired`.

**Deletion with the user.** The file is a storage object the user owns, so the user data reset (`collectUserObjectIds`) and the factory reset delete it with the user's other files. The user data reset also deletes the user's pending `health.export` jobs ([user-data-reset.md](user-data-reset.md)).

**Notifications.** `health.export_ready` and `health.export_failed`, `browser` and `push`, on by default, not mandatory. The payload is `{ exportId, format }`; the link opens `/health`.

**Observability, audit and security.**

- **Audit.** A committed export writes `health:export:create`, `targetType` `health_export`, `targetId` the export id, `meta` with `format`, `datasets`, `includeHistory`, `rowCounts` and `sizeBytes`. Never a value, a file name or a URL. Best effort: an audit failure is logged and does not fail the export.
- **Metrics.** `app.health.exports` (counter, `format`, `outcome` `completed` or `failed`), `app.health.export.duration` (seconds) and `app.health.export.size` (bytes, completed only); see [telemetry.md](telemetry.md).
- **Span attributes.** `health.export.format`, `health.export.datasets`, `health.export.size_bytes` on the job's span.
- **Logs.** Ids, formats and counts only.

### 2.14 AI health summary for the training planner

An opt-in, AI-written summary of the user's health data that the training planner and evaluator read in place of raw values. No raw lab value, blood pressure reading, document or file name crosses the summary boundary. How the agents use it is in [ai-training-plans.md §2.14](ai-training-plans.md#214-the-opt-in-health-summary).

**Consent.**

- "Use my health data in training plans", per user, **off by default**. Stored in `health_summary_settings` (`enabled`, `consented_at`); no row is off. It has its own table rather than a key of `user_settings.value` because a change is audited and has side effects that the generic settings `PATCH` would bypass.
- `PUT /api/ai/training/health-summary/consent` with `{ enabled }` turns it on or off and writes the audit row `health_summary:consent` (`meta: { enabled }`, no health data).
- **On:** a summary is queued at once, and later training runs include it.
- **Off:** the pending summary job is deleted, a job already running stores nothing (it re-reads the consent), and later runs omit the summary. The stored history is kept for the owner to see.
- Every `GET` response carries what turning it on shares (`sharing.shared`), what it never shares (`sharing.neverShared`) and which model provider will process it (`sharing.processor`, from the `health_summary` feature's resolution), so the toggle can show them before the user decides.

**The digest** (`health-summary/health-digest.ts`, pure, server-only). The summary job's model input, copied field by field from an allow-list:

| Section | What |
|---|---|
| `profile` | Age in whole years at the newest input, sex at birth |
| `labs` | Per panel, per analyte: the latest and the previous value with date, flag and numeric reference range; the catalog key and canonical unit |
| `vitals` | Blood pressure and resting heart rate: the latest reading, the 30-day average and the average of the 60 days before |
| `body` | Weight (latest, 8-week least-squares trend), body fat and waist (latest, previous) |
| `wellness` | The four check-in scores averaged over 28 days, the low days, the low-day streak ending at the newest check-in and the longest one |

- **Never in it:** documents, file names, storage keys, notes, the printed reference text, the analyte name as printed, the lab's name, the birth date, ids.
- **Anchored on the data.** Every window ends at the newest input of its section, so the digest depends on the stored rows only. Its SHA-256 (`inputsHash`) changes exactly when the inputs change.
- **Bounded reads.** `HealthSummaryReader.digestSource` selects only the listed columns of active rows, newest first, with a row cap per group.

**The job `ai.health.summary`** (`health-summary/health-summary.handler.ts`).

- Server-only, permanently: no `nodeResultSchema`, no `persistNodeResult`. Profile `{ maxRuntimeMs: 4 min, maxAttempts: 1 }`. Subject `('health_summary', userId)`, so the queue's active dedup index allows one pending or running summary job per user. Payload `{ force?: boolean }`.
- **No-ops:** consent off; no digest data; the digest hash equals the newest ready summary's and the job is not forced.
- **Model.** The `health_summary` AI feature (assigned at `/admin/settings/ai/assignments`, grouped with the training agents; needs `structured_output`), called through `AiService.forUser(userId, { jobId })`. A blocking feature state appends a `failed` version with the matching AI code (`AI_DISABLED`, `AI_KEY_REQUIRED`, ...).
- **Output** (strict structured output): `narrative` (at most about 300 words), `trainingConsiderations[]` (`text`, `severity` `info` or `caution`, `conservative`), `dataAsOf`. The stored `data_as_of` is the digest's own date, never the model's.
- **Instructions.** Training-relevant observations only. No diagnosis and no disease named. No treatment, medication or supplement advice and no dose. A flagged value is "outside the reference range, discuss it with a clinician", never interpreted. No exact lab, blood pressure or heart rate numbers. The digest is inside `<context>` as data.
- **Post-check** (`health-summary.post-check.ts`). Rejects dosing (a number with mg, mcg, IU, ml, tablets and the like, or the word "dose"), medication, supplement and diagnosis language, a raw value (a number with a lab or vital unit, or a blood pressure pair) and a narrative over the word budget. A rejection is regenerated **once** with a nudge naming the rule codes. A second rejection appends a `failed` version (`HEALTH_SUMMARY_POST_CHECK_REJECTED`).
- **Failures.** A provider throttle defers the job. A terminal AI error appends `failed` with its code and the job returns. Any other error appends `failed` (`HEALTH_SUMMARY_GENERATION_FAILED`) and rethrows.

**Storage.** `health_summaries`: `version` (unique per user), `status` (`ready` or `failed`), `narrative`, `training_considerations`, `data_as_of`, `inputs_as_of`, `inputs_hash`, `provider`, `model`, `regenerations`, `error_code`, `job_id`, `created_at`. Every attempt appends a row, so the history is kept. The training agents read only the newest `ready` row.

**Regeneration.**

- **Automatic, debounced, never inline.** Every committed health write emits `health.data.changed` (`measurements/health-data-events.ts`): a measurement entry created, edited or deleted, a check-in saved or removed, the profile's birth date or sex changed, or a health intake (lab report, body-metric reading) applied. `HealthSummaryListener` calls `HealthSummaryService.requestRegeneration`, which enqueues one job two minutes ahead while the consent is on; further writes collapse onto it through the dedup key.
- **Refresh.** `POST /api/ai/training/health-summary/refresh` queues a forced job now (202), pulling a waiting debounced job forward. It answers `409 HEALTH_SUMMARY_CONSENT_OFF` while the consent is off and `409 HEALTH_SUMMARY_NO_DATA` without data.
- **Staleness.** `GET` rebuilds the digest and sets `stale` when its hash differs from the newest ready summary's (or there is none while data exists), whether the consent is off, AI is off or a job is still waiting.

**API** (`/api/ai/training/health-summary`, behind `AiEnabledGuard`):

| Route | Permission | Response |
|---|---|---|
| `GET /api/ai/training/health-summary` | `ai:use` + `health_data:read` | The view below |
| `PUT /api/ai/training/health-summary/consent` | `ai:use` + `health_data:write` | Body `{ enabled: boolean }` (strict); the updated view |
| `POST /api/ai/training/health-summary/refresh` | `ai:use` + `health_data:write` | 202 with the view (`pending: true`) |

The view (`HealthSummaryView`, wrapped in `{ data }`):

```
{
  enabled: boolean,
  consentedAt: string | null,
  sharing: {
    shared: string[],
    neverShared: string[],
    modelState: 'ready' | 'auto' | 'no_key' | 'no_models' | 'missing_capability' | 'web_search_disabled' | 'ai_disabled',
    processor: { provider, modelId, displayName } | null
  },
  summary: {
    version, narrative,
    trainingConsiderations: [{ text, severity: 'info' | 'caution', conservative }],
    dataAsOf: 'YYYY-MM-DD' | null, createdAt, provider, model
  } | null,
  lastAttempt: { version, status: 'ready' | 'failed', errorCode, createdAt } | null,
  hasData: boolean,
  stale: boolean,
  pending: boolean
}
```

**Observability.** Metrics `app.health.summary.generations` (outcome `ready`, `rejected`, `failed`, `skipped`, `deferred`), `app.health.summary.duration`, `app.health.summary.regenerations`, `app.health.summary.post_check_rejections` and `app.health.summary.tokens` (`token_type`); see [telemetry.md](telemetry.md). The job's span carries `health_summary.outcome`, the regeneration and rejection counts and the token totals. The gateway records the call in `ai_runs` and `ai_usage_events` as for every AI call.

**Web.** The opt-in lives as a "Health data in training plans" section at the bottom of `/settings/ai/agents` (`apps/web/src/components/training/HealthSummarySection.tsx`, wired in `pages/UserAgentModelsPage.tsx`).

- The switch is off by default. Turning it on opens a confirmation dialog that lists the data shared, the data never shared and the processing provider (from `sharing`); turning it off is immediate.
- It shows the narrative and the considerations (Info or Caution; a conservative one reads "Turns on conservative mode").
- It shows the pending, stale and failed states, and a "Refresh summary" button.
- The section is hidden without `health_data:read` and read-only without `health_data:write`.

**Security.** No summary text, digest or prompt in any log line, span, metric or error; log lines carry ids, versions and rule codes. Every route is owner-scoped. A user data reset deletes the consent and every summary.

## 3. Configuration and permissions

- No environment variable and no system setting. Storage is configured at runtime in the admin UI ([storage-providers.md](storage-providers.md)).
- The PDF page cap is a constant (`INTAKE_PDF_MAX_PAGES`, 20) that a kind may override with `maxPdfPages`. It bounds the cost of one AI request, like the 16-inputs-per-request cap.
- Retention is chosen per intake and per file by the user.
- **Permissions.** No permission of its own. The intake routes are gated by `intakes:*` plus the kind's `health_data:read` and `health_data:write`; the documents API (2.11) by `health_data:read` (reads, download) and `health_data:write` (rename, delete); the export routes (2.13) by `health_data:read`. The health summary routes (2.14) require `ai:use` plus `health_data:read` (view) or `health_data:write` (consent, refresh).
- **Job types.** `health.document.purge`, `ai.health.lab_report`, `ai.health.summary`, `health.export` and `health.export.purge`, permanent, server-only; listed in [ARCHITECTURE.md](../ARCHITECTURE.md) and [job-queue.md](job-queue.md).
- **AI features.** `lab_report`, assigned a model by the administrator at `/admin/settings/ai` like the other photo features; `health_summary`, grouped with the training agents.
- **Per-user setting.** "Use my health data in training plans" (`health_summary_settings`), off by default; no system setting.
- **Lab report routes.** `GET /api/measurements/lab-reports/:intakeId/duplicates` and `GET .../issues` require `health_data:read` and `intakes:read`; `POST .../map` and `POST .../reject-unmatched` require `health_data:write` and `intakes:write`.
- **Audit actions.** `health:document:delete`, `health:export:create`, `health_summary:consent`.
- **Metrics.** `app.health.documents.purges`, `app.health.documents.downloads`, `app.health.documents.deletes`, `app.health.exports`, `app.health.export.duration`, `app.health.export.size`; `app.health.summary.*` (2.14).
- **Download link lifetime.** A constant, `HEALTH_DOCUMENT_DOWNLOAD_TTL_SECONDS` (300).
- **Export permissions.** `health_data:read` on all three export routes. Export constants (retention 7 days, URL lifetime 5 minutes, range 3660 days, 3 in flight) are code constants in `health-export.constants.ts`; no environment variable and no system setting.
- **Storage prefix.** `exports/` (`EXPORTS_KEY_PREFIX`).
- **Dependencies.** `pdfkit` (the PDF report) and `archiver` (the CSV zip) in `apps/api`.

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
| `POST /api/intakes` with `kind: 'lab_report'` | A lab report intake (2.10); apply may answer 409 `UNRESOLVED_ANALYTES` and writes one entry per collection date |
| `POST /api/intakes/:id/items/accept-all` | Optional body `{ "only": "high_confidence" }` accepts only confident, certain pending items (any intake kind) |
| `GET /api/measurements/lab-reports/:intakeId/duplicates` | The duplicate warning for a lab report under review |
| `GET /api/measurements/lab-reports/:intakeId/issues` | `{ items: [{ itemId, issues: [{ code, field, message }] }] }`: what apply would refuse, per non-rejected result (2.10) |
| `POST /api/measurements/lab-reports/:intakeId/map` | `{ itemId, analyteKey?, unit? }` → `{ items, skipped }`: maps or re-reads a result and its same-named results (2.10) |
| `POST /api/measurements/lab-reports/:intakeId/reject-unmatched` | → `{ items }`: rejects every result with no analyte; restore through the item `PATCH` (2.10) |
| `GET /api/health/documents`, `GET /api/health/documents/:id` | The caller's documents, with value counts and file state (2.11) |
| `GET /api/health/documents/:id/download` | A 300-second signed URL with a safe `Content-Disposition` |
| `PATCH /api/health/documents/:id` | Rename and document date; `If-Match` required |
| `DELETE /api/health/documents/:id` | Queues the `user_delete` purge, or removes the record of an erased file; `deleteValues=true` soft-deletes its values; `If-Match` required |
| `POST /api/health/exports` | Queues an export (`202`); `health_data:read` |
| `GET /api/health/exports` | The caller's recent exports |
| `GET /api/health/exports/:id` | Status; a 5-minute signed download URL while ready |

## 4. Extending it in a fork

**Make another intake kind a health kind.** Set `healthDocumentKind` on the kind and add the value to `HEALTH_DOCUMENT_KINDS` when it is new. Attach, retention, purge and the reference checker then apply with no other change. In `apply`, read `healthDocuments` from the apply arguments and write `healthDocumentId` into the saved provenance, as `body-metric-reading.kind.ts` does. On the web, add the kind to `HEALTH_INTAKE_KINDS` (`apps/web/src/services/intake.ts`) so `RetainFilesControl` renders for it. The kind recipe is in [the intake README](../../apps/api/src/intake/README.md).

**Let another intake kind read PDFs.** Declare `acceptedInputs = ['image', 'pdf']` (and `maxPdfPages` for a cap other than 20). The attach, analyze and model checks then apply with no other change. In the kind's analyzer job, build the content parts with `intakeInputPart` or `numberedInputParts` so a PDF goes out as a `file` part, and read the photos' `storageObject.mimeType`. On the web, the picker's `accept` follows the kind (a separate task of #186).

**Add another holder of a stored file.** A feature that keeps a storage object registers its own checker with `StorageObjectReferences`, as `HealthDocumentObjectReferences` does.

## 5. Guardrails

- `apps/api/test/health-data/health-documents.db.spec.ts`: on real Postgres, the default `keep`, purge after apply and after discard, a kept file surviving discard, detach removing the document, a purge failure retried with the measurements intact, `retainFiles` changes before apply, and another user's `404`.
- `apps/api/src/health-documents/handlers/health-document-purge.handler.spec.ts`: permanent type, server-only, profile, idempotence, failure rethrown and counted, audit carrying no file name.
- `apps/api/src/health-documents/health-document-object-references.spec.ts`: the checker holds only files that still exist and fails safe.
- `apps/api/src/health-documents/health-documents.service.spec.ts`, `health-document-names.spec.ts` and `dto/health-document.dto.spec.ts`: owner scoping, the per-page facts (one grouped count, one job query), the download TTL, disposition and refusals, `If-Match` parsing and `412`, both delete paths, rename sanitising and the `Content-Disposition` builder.
- `apps/api/test/health-data/health-documents-api.integration.spec.ts`: the RBAC matrix (401, 403 without the exact permission, 404 for another user's id) on every documents route, `If-Match` 400 and 412, `ETag`, and the no-store download link. `apps/api/test/openapi/openapi-document.spec.ts` pins the routes and their permissions.
- `apps/api/test/health-data/health-documents-api.db.spec.ts`: on real Postgres and real file storage, the caller-only list with value counts, `404` everywhere for another user, delete through the purge (provider `exists()` false) with values kept and `fileDeleted: true`, record removal, `deleteValues=true` on exactly that document, stale `If-Match`, and the download TTL and `Content-Disposition`.
- `apps/api/src/intake/intake.service.spec.ts`: the retention, attach, detach, discard and apply paths.
- `apps/api/src/measurements/measurements.service.spec.ts`: `fileDeleted` on the measurement view.
- `apps/api/src/common/otel/app-metrics.service.spec.ts`: the purge counter and its outcome label.
- `apps/api/test/jobs/cron-enqueue-only.spec.ts` and `apps/api/test/jobs/on-event-no-io.spec.ts`: no long-running work outside the queue.
- `apps/api/src/health-summary/health-digest.spec.ts`: the digest's allow-list, windows anchored on the data, and its hash.
- `apps/api/src/health-summary/health-summary.post-check.spec.ts`, `health-summary.prompt.spec.ts`: the rejected language and the pinned instructions.
- `apps/api/src/health-summary/health-summary.handler.spec.ts`: the job with a scripted provider (schema, a rejection regenerated once then failed, consent off, unchanged inputs, kill switch, throttle, nothing logged). `health-summary.service.spec.ts`: consent, debounce, refresh, staleness.
- `apps/api/src/measurements/health-data-events.spec.ts`: `health.data.changed` after each committed health write.
- `apps/api/test/ai/health-summary.integration.spec.ts`: the routes' RBAC, validation, refusals and kill switch.
- `apps/api/test/health-data/health-summary.db.spec.ts`: on real Postgres, one debounced job per burst of writes, none with the consent off, append-only history, the newest ready summary used, consent off cancelling the job, the cascade.
- `apps/web/src/__tests__/pages/UserAgentModelsHealthSummary.test.tsx`: the section on `/settings/ai/agents`: off by default, the confirmation dialog before turning on, immediate turn off, the summary, considerations and states, hidden and read-only by permission.
- `apps/web/src/__tests__/hooks/useHealthSummary.test.ts`: the view query, the consent and refresh mutations.
- The training canary suites ([ai-training-plans.md §5](ai-training-plans.md#5-guardrails)): no raw value reaches an agent, opted in or not.
- `apps/api/src/intake/intake-inputs.spec.ts`, `intake-input-inspector.spec.ts`, `intake-kind.registry.spec.ts` and `intake-analyzer.spec.ts`: the `acceptedInputs` default and validation, the magic-byte sniff, page counting in the clear and in object streams (and a decompression bomb), the bounded reads, and the `image` / `file` part mapping.
- `apps/api/src/intake/intake.service.spec.ts`: a PDF on an image-only kind, renamed files, the page, size and unreadable refusals, the re-check at analyze and the `file_input` refusal with nothing queued.
- `apps/api/test/health-data/measurements-photo.integration.spec.ts`: over HTTP with the fake AI provider, a PDF attach with its `application/pdf` document, the four refusals with no provider call, the model without `file_input`, and the job sending the PDF as one `file` input.
- `apps/api/src/measurements/lab-catalog.spec.ts`: the lab catalog panel by panel, conversions pinned on known values in every alternative unit, round trips, unit spellings, alias lookup and alias uniqueness.
- `apps/api/src/measurements/dto/measurement.dto.spec.ts`, `measurements.service.spec.ts` and `apps/api/test/health-data/measurements.integration.spec.ts`: range conversion and ordering, lab-only fields, lab entry size and mixing, revisions keeping or clearing range and flag, and lab routes in the permission matrix.
- `apps/api/test/health-data/measurements-lab.db.spec.ts`: on real Postgres, the four columns, a lab panel created, read back, listed only with `category=lab`, and edited with range and flag kept.
- `apps/api/src/training-agents/testing/canary-prisma.ts`: lab rows with range context in the data-minimisation canary.
- `apps/api/test/health-data/health-documents.db.spec.ts` and `measurements-photo.db.spec.ts`: on real Postgres and real file storage, PDF retention (purge after apply, keep through discard), refusals with no link or document, and a PDF read end to end with `sourceRef.healthDocumentId`.
- `apps/api/src/measurements/lab-report/*.spec.ts`: the value, context and conversion rules; server-side matching with the model key only as a suggestion and unmatched rows kept; the prompt's safety sentences; `normalizeValue`; apply's 409 `UNRESOLVED_ANALYTES`, range, flag, provenance, `userEdited`, one entry per date with the per-date cap and duplicate rule and `measuredAtSource`; qualifier stripping in `resolveLabAnalyte`; the job's request, context fill, span attributes and failure paths.
- `apps/api/test/health-data/lab-report.db.spec.ts`: on real Postgres and real file storage, the fixture PDF drafted with the unmatched row, apply refused then saved, an edited row, glucose stored canonically, a user-mapped row, a multi-date apply, an item date edit, the per-date duplicate warning on re-import and the purge after apply.
- `apps/api/test/ai/ai-kill-switch.integration.spec.ts` and `ai-jobs-server-only.spec.ts` pick up `ai.health.lab_report` from the registry; `apps/api/test/gyms/fake-vision-server.spec.ts` covers the `lab_report` fixture route.
- `apps/web/src/__tests__/components/intake/RetainFilesControl.test.tsx`: checked by default, helper text, health kinds only.
- `apps/web/src/__tests__/components/health/PhotoReadDialog.test.tsx` and `apps/web/src/__tests__/components/health/MeasurementHistoryProvenance.test.tsx`: the choice reaches the requests, and **File deleted** replaces **View photo**.
- `tests/visual/specs/health-photo-read.spec.ts`: the photo-step baseline includes the keep-or-delete control.
- `apps/api/src/health-export/writers/writers.spec.ts`: JSON valid against the version 1 schema; the CSV zip read back with a strict RFC 4180 reader, the BOM and the formula guard (`=`, `+`, `-`, `@`, tab, CR) with numbers untouched; the workbook re-opened with exceljs (sheets, bold frozen header with units); the PDF read as text from an uncompressed build (sections, values, the footer on every page).
- `apps/api/src/health-export/handlers/health-export.handler.spec.ts` and `health-export-purge.handler.spec.ts`: permanent types, server-only, profiles, the key, one commit for object and result, audit without values, notification on the last failed attempt only, the purge keeping a row the provider refused.
- `apps/api/test/health-data/health-export.integration.spec.ts`: `health_data:read` on every route, 401 and 403, validation with nothing queued, the in-flight `429`, owner scoping, both types server-only.
- `apps/api/test/health-data/health-export.db.spec.ts`: on real Postgres and real files, the range, dataset and owner filters, deleted rows never exported, history only on request, kept documents only, the owner-only attachment URL, collection by a data reset, and the 7-day purge.
- `apps/api/test/jobs/cron-enqueue-only.spec.ts`: names `health-export/tasks/health-export-purge.task.ts` and keeps it enqueue-only.

## 6. Design decisions

**One row per file, not a flag on the intake.** The choice is per file, and a document must outlive its intake (`intake_id` is set to null). A flag on the intake would vanish with it.

**Keep is the default.** Erasing is irreversible, so the user opts in to it. Rejected: delete by default, which loses data on a missed click.

**The purge is a queue job.** A storage outage is retried and the intent is never lost. Rejected: deleting inline after the apply commits (a failure loses the intent) and a detached call (violates the queue rule).

**Enqueued inside the apply or discard transaction.** The intent commits with the change, and the job cannot run before the measurements exist. Rejected: enqueue after commit, where a crash between commit and enqueue loses the purge.

**The checker holds unpurged `delete_after_processing` files too.** One deleter per file keeps the audit row, the counter and `file_deleted_at` truthful. Rejected: letting the intake cleanup delete them, which races the job.

**Choice is final at apply.** The values are saved and the provenance is fixed, so changing retention afterwards would need the documents API. Rejected: letting `PATCH` change retention of an applied intake.

**The document row survives the purge.** Provenance must not dangle, and history shows "File deleted". Rejected: deleting the row with the file, which would orphan `healthDocumentId`.

**Server-only purge.** A worker node must never hold the privilege to delete objects from the deployment's storage.

**An owner delete reuses the purge job.** One deleter per file keeps the audit row, the counter and `file_deleted_at` truthful, and a storage outage is retried. The job takes a `reason`, and `user_delete` erases a kept file. Rejected: deleting the object inline in the request (a failure loses the intent) and flipping the document's retention to `delete_after_processing` (it would rewrite the user's upload-time choice).

**The document row outlives an owner's file delete; a second delete removes it.** A document whose file is gone lists as metadata only, so history stays explainable, and the user can still remove that entry. Values that named it keep `healthDocumentId` and read `fileDeleted: true`, because a missing document counts as a deleted file. Rejected: removing the row with the file, which loses "file deleted on …" for kept values.

**A `version` column for `If-Match`.** The same integer-version convention as the programs and settings resources. Rejected: `updatedAt` as the ETag, which is clock-based and not what [API.md](../API.md) documents.

**412 for a stale `If-Match`.** It is the status HTTP defines for a failed precondition. The exception filter maps it to `PRECONDITION_FAILED`. Older resources answer `409` and keep doing so.

**Short-lived signed URL, not a streaming proxy.** The bytes go straight from storage to the browser, and the API holds no file in memory. The 300-second lifetime and `no-store` limit what a leaked URL is worth. Rejected: streaming through the API (memory and egress for no gain) and the default one-hour presign.

**Each kind opts in to PDFs.** `acceptedInputs` defaults to images, so a kind whose analyzer never expected a document cannot receive one by accident. Rejected: accepting PDFs everywhere once the gateway could carry them.

**Magic bytes of the stored object, not the declared type.** The MIME type is whatever the uploader said. Reading the stored bytes is the only check that holds for a renamed file. Rejected: trusting the MIME type or the file extension.

**Attach-time checks, repeated at analyze.** The user hears about a bad file when attaching it, not after a scan. The analyze re-check keeps the guarantee for older links. Rejected: checking only in the job, which would report a refused file after the user started a scan.

**A page counter instead of a PDF library.** One bounded, conservative number does not justify a parser dependency (pdf-lib is unmaintained, pdf.js is large). Rejected: skipping the cap, which leaves a 500-page report free to run up a provider bill.

**A constant page cap.** The cap bounds request cost, as the 16-input cap does, and a kind can override it in code. Rejected: an environment variable (runtime-configured features never get one) and a system setting (no intake settings block exists to hold it).

**The export id is the job id; no export table.** The request, the outcome (`payload.result`) and the status already live on the job, and the file is a storage object the user owns, so resets and the bucket purge find it with no new code. The user data reset follows the same pattern (`payload.result`). Rejected: a `health_exports` table, a second record of what the job row says. Cost: an export disappears from the list when the job history purge removes its job row (by default long after its file expired).

**The export reads the health tables directly.** One read-only pass over the profile, measurements and documents gives every format the same snapshot, with the columns the export needs (including superseded rows, which no service returns). Rejected: going through `MeasurementsService`, whose reads are paginated, active-only and capped at 1000 points per series.

**Expiry by a purge over rows, not a bucket listing.** The storage interface has no list operation, and the row is what the status route reads. Rejected: a bucket lifecycle rule, which an operator would have to configure for every provider.

**A short-lived URL minted on each read.** A 5-minute URL handed out only to the owner, never stored or logged. Rejected: proxying the bytes through the API (holds a request for the whole download) and long-lived URLs (a leaked link outlives the session).

**The capability error reuses `AI_CAPABILITY_UNSUPPORTED`.** Clients already handle the AI platform's reasons; `details.capability` and `details.inputKind` say what to do. Rejected: a new intake-only code for the same condition.

**The server matches analytes, the model only suggests.** A model can name a plausible key for a row it misread. The catalog's aliases are reviewed data; the model's key is used only when the printed name matches nothing, and then shown as a suggestion to confirm. Rejected: trusting `matchedKey`, and dropping rows the catalog does not know.

**Unmatched rows block apply.** A result silently left out of a report is worse than a refusal the user must answer. Rejected: saving matched rows and dropping the rest, and a catch-all "other" analyte.

**Document-level fields live in the intake context.** The collection date belongs to the report, not to a row, and the user must be able to correct it before apply; `PATCH /api/intakes/:id` already does that. Rejected: a document draft item, which would mix two shapes in one review list.

**Duplicates warn, never de-duplicate.** Two results with the same analyte, day and value can be legitimate (a repeat draw), and only the user knows. The review asks for one decision per duplicate (Skip or Save again, or one choice for all) and blocks Save until each is made. Rejected: skipping matching rows at apply, and a one-click "Save anyway" that accepted every copy unseen.

**One map route for analyte and unit.** A trend report repeats a printed name once per date, and a correction to one row is nearly always right for the rest. The server picks the siblings and writes them under one lock, so the web never loops over rows and an apply never sees half a correction. Rejected: a client-side loop of item `PATCH` calls.

**A dedicated AI feature.** An administrator may want a stronger model for multi-page reports than for a scale display. Rejected: reusing `body_metric_reading`.

## 7. Verification

```bash
npx jest --config apps/api/test/jest.config.js --rootDir apps/api src/health-documents src/intake src/measurements/photo test/health-data/measurements-photo.integration
export POSTGRES_HOST=localhost POSTGRES_PORT=5432 POSTGRES_USER=postgres POSTGRES_PASSWORD=postgres POSTGRES_DB=evopath_test
cd apps/api && npx jest --config ./test/jest.config.js --testRegex 'test/health-data/(health-documents|measurements-photo)\.db\.spec\.ts$' --runInBand
npm run test:run --workspace=web -- RetainFilesControl
npx jest --config apps/api/test/jest.config.js --rootDir apps/api src/measurements/lab-report test/ai/ai-kill-switch
cd apps/api && npx jest --config ./test/jest.config.js --testRegex 'test/health-data/lab-report\.db\.spec\.ts$' --runInBand
npx jest --config apps/api/test/jest.config.js --rootDir apps/api src/health-documents test/health-data/health-documents-api.integration
cd apps/api && npx jest --config ./test/jest.config.js --testRegex 'test/health-data/health-documents-api\.db\.spec\.ts$' --runInBand
npx jest --config apps/api/test/jest.config.js --rootDir apps/api src/measurements/biomarkers test/health-data/measurements.integration
cd apps/api && npx jest --config ./test/jest.config.js --testRegex 'test/health-data/biomarkers-summary\.db\.spec\.ts$' --runInBand
npx jest --config apps/api/test/jest.config.js --rootDir apps/api src/health-export test/health-data/health-export.integration
cd apps/api && npx jest --config ./test/jest.config.js --testRegex 'test/health-data/health-export\.db\.spec\.ts$' --runInBand
npx jest --config apps/api/test/jest.config.js --rootDir apps/api src/health-summary test/ai/health-summary.integration
cd apps/api && npx jest --config ./test/jest.config.js --testRegex 'test/health-data/health-summary\.db\.spec\.ts$' --runInBand
npm run test:run --workspace=web -- UserAgentModelsHealthSummary useHealthSummary
```

In a running app, with AI on:

1. Open Health, **Read from photo**, and confirm "Keep this file in <product> after processing" is checked.
2. Uncheck it, read a photo and save. The job `health.document.purge` appears in the job history and succeeds.
3. History shows **File deleted** for the new entry. `GET /api/measurements` reports `fileDeleted: true` for its readings.
4. The audit log holds `health:document:delete` with no file name.
5. With a model that has file input, read a smart-scale PDF report: the readings appear for review, and the saved entry links a document whose type is `application/pdf`.
6. Attach a PDF of more than 20 pages, or a text file renamed to `.pdf`: the attach is refused before any scan.
7. With the fake AI provider, create a `lab_report` intake, attach a PDF and analyze: seven results appear, `Apolipoprotein A1` unmatched. Accept all and apply: 409 `UNRESOLVED_ANALYTES`. Reject it and apply: one lab entry dated 2026-09-15 (`entries` has one element), glucose in mg/dL. A second import of the same report lists five duplicates at `GET /api/measurements/lab-reports/<id>/duplicates`.
8. `GET /api/health/documents` lists the report and the scale photo with their value counts. `GET …/:id/download` returns a URL that opens the file for 5 minutes. `DELETE …/:id` with the item's `version` as `If-Match` queues `health.document.purge`. Once it ran, the item shows `fileAvailable: false` and its readings report `fileDeleted: true`. A second `DELETE` removes the item.
9. `POST /api/health/exports` with `{"format":"pdf","from":"2026-01-01","to":"2026-09-30","datasets":["profile","labs","wellness"]}`: a `health.export` job runs, a "Your health export is ready" notification arrives, and `GET /api/health/exports/{id}` returns `ready` with a download URL whose file ends with the "Not a medical record." footer. The audit log holds `health:export:create` with row counts only.
10. At `/settings/ai/agents`, switch on "Health data in training plans" and confirm the dialog: `PUT /api/ai/training/health-summary/consent` returns `enabled: true`, an `ai.health.summary` job runs and the narrative appears. The audit log holds `health_summary:consent` with `meta.enabled` only. Switch it off: the change is immediate.

## History

- #184: the Health Records epic.
- #185: `health_documents` table and `photo_intakes.retention`, `retainFiles` on the intake API, `IntakeKind.healthDocumentKind`, the `health.document.purge` job, the `health_documents` reference checker, `sourceRef.healthDocumentId` and `fileDeleted`, the `health:document:delete` audit action and the purge counter, the keep-or-delete control, and this spec.
- #186: PDFs for body metrics. Adds `IntakeKind.acceptedInputs` and `maxPdfPages`, magic-byte and page-count checks at attach and analyze, the `file_input` refusal, PDFs as `file` parts, the `intake.input_kind` span attribute and body-metric prompt version 2 (API).
- #187: the lab analyte catalog (39 analytes, seven panels, affine unit conversion, `resolveLabAnalyte`), the `referenceLow`, `referenceHigh`, `referenceText` and `flag` columns on `measurements`, lab entries and the `category` list filter on `/api/measurements` (API).
- #188: lab report extraction (API): the `lab_report` intake kind and AI feature, the `ai.health.lab_report` job and prompt, server-side analyte matching and unit conversion, the `UNRESOLVED_ANALYTES` refusal, lab-report provenance and `documentDate`, the duplicate-warning route, analyzer context in `replaceAiDrafts`, `intake.page_count`, and the fake provider's lab report fixture.
- #189: blood-work history (API): `GET /api/health/biomarkers/summary`, per-point range and flag on lab series, `GET /api/measurements/:id/revisions`.
- #190: the documents API (`/api/health/documents`), `health_documents.version`, the `user_delete` purge reason, the download and delete counters, and `412 PRECONDITION_FAILED`.
- #191: the health data export API (H7): `/api/health/exports`, the `health.export` and `health.export.purge` jobs, the `exports/` prefix, the JSON, CSV, XLSX and PDF writers, the `health:export:create` audit action, the export metrics and notifications.
- #192: the opt-in AI health summary (API): `health_summary_settings` and `health_summaries`, the `health_summary` AI feature, the digest, the `ai.health.summary` job with its post-check, `health.data.changed` and the debounced regeneration, `/api/ai/training/health-summary`, the `health_summary:consent` audit action, the `app.health.summary.*` metrics, and the planner and evaluator wiring ([ai-training-plans.md §2.14](ai-training-plans.md#214-the-opt-in-health-summary)).
- #234: the lab unit preference: `health_profiles.lab_units` and `labUnits` on `/api/health-profile`, `siUnit` and per-unit `decimals` in the lab catalog with the `labDisplayUnit`/`toDisplayUnit` helpers, and `labUnits` on `POST /api/health/exports` (labs dataset, JSON top level, PDF values and header) (API).
- #305: multi-date lab reports: a `collectionDate` per result, prompt version 2, one lab entry per date at apply, per-date duplicate checks, the metabolic panel analytes, qualifier stripping in `resolveLabAnalyte`, the high-confidence bulk accept and the date-grouped review.
- #307: the lipid ratio analytes (`chol_hdl_ratio`, `ldl_hdl_ratio`, `tg_hdl_ratio`) and `POST /api/measurements/lab-reports/:intakeId/map`: an analyte or unit correction applied to every same-named result, with the review's map picker and carried edits.
- #308: per-row Skip and Save again for results that are already saved, the Skip all and Save all again bar, and the save block until each is decided (web).
- #309: the expanded lab catalog (92 analytes: CBC indices, differential percentage and absolute, metabolic, kidney, lipid, glycemic, thyroid and hormone extras, `lipoprotein_a` in nmol/L), the differential naming rule and the per-date cap raised to 150.
- #310: the unit normaliser and per-analyte `unitAliases`, lab report prompt version 3 (wrapped units joined, non-result cells never emitted) and the mapper's `nonResultsDropped`.
- #311: `POST /api/measurements/lab-reports/:intakeId/reject-unmatched` and the review's "Reject unmatched (n)" action.
- #317: `GET /api/measurements/lab-reports/:intakeId/issues` and the shared `labApplyIssues`, the wider mapper non-result rule, and the review's Needs attention badges, filter bar and attention links.
