# Health Data

> **Status:** shipped (health profile, measurements) · **Code:** `apps/api/src/health-profile/`, `apps/api/src/measurements/` · **API:** `/api/health-profile`, `/api/measurements/*` (see `/api/docs`, tags "Health Profile" and "Measurements") · **Admin UI:** none (user page `/settings/health-profile`) · **Runbook:** none · **Recipe:** [section 4](#4-extending-it-in-a-fork)

Health data is per-user data an app built from this template interprets in context: a weight or a heart rate reads differently with an age, a sex at birth and a height, and its day boundaries depend on a time zone. It lives in its own tables, behind its own permission family (`health_data:read`, `health_data:write`), and is only ever reachable by its owner. It has two parts. The **health profile** is one row per user with date of birth, sex at birth, height, unit system, time zone and a short bio. **Measurements** are one longitudinal table of values (weight, body fat, waist, blood pressure, resting heart rate, and daily wellness scores) with a unit, a method, a source and a history of corrections, described by an in-code metric registry. Later health features add tables and routes under the same permissions, read the profile through `HealthProfileService` and write values through `MeasurementsService`.

## 1. Purpose

- **What it is.** The person-level facts every health feature needs: age (from date of birth), sex at birth, height in millimetres, the unit system the person enters and reads values in, and the IANA time zone that decides which calendar day a value belongs to.
- **What it is not.**
  - Not the account profile. Display name and image stay in `user_settings.value.profile` at `/settings/profile`.
  - Not a preference document. It is typed columns the server computes with, not a `user_settings` namespace.
  - Not a medical record. The bio is free context for the person and, later, an AI coach.
  - Not administered. There is no admin route to another user's profile.
- **Problem it solves.** A fork that records health values needs somewhere to keep the facts that give them meaning, and a permission that lets a deployment govern access to health data without also blocking someone from changing their theme.
- **Measurements: what they are.** One generic store for every health value, so a new metric is a registry entry, not a migration and not a new table. Values are kept in one canonical unit per metric, edits keep the history, and how a value was measured (`method`) is kept apart from how it entered the system (`origin`).
- **Measurements: what they are not.** Not a table per metric, not a place that stores the unit a client displayed, and not writable on behalf of another user. Daily wellness scores are defined in the registry but are not accepted or listed by `/api/measurements`; a check-ins feature owns them.

## 2. How it works

### 2.1 Data model

`HealthProfile` (`health_profiles`), 1:1 with `User`, `onDelete: Cascade`.

| Column | Type | Meaning |
|---|---|---|
| `userId` | uuid, unique | Owner. The unique index is what makes a concurrent first save lose. |
| `dateOfBirth` | `date`, null | Calendar date, no time. |
| `sexAtBirth` | text, null | `female`, `male` or `prefer_not_to_say`. |
| `heightMm` | integer, null | Height in whole millimetres. |
| `unitSystem` | text, default `metric` | `metric` or `imperial`. Display and entry preference. |
| `timeZone` | text, null | IANA name, for example `Europe/Madrid` or `UTC`. |
| `bio` | text, null | Free text, at most 1000 characters. |
| `version` | integer, default 1 | Optimistic-concurrency counter, incremented on every change. |
| `createdAt`, `updatedAt` | `timestamptz` | |

Two storage choices worth knowing:

- **Height is integer millimetres.** An inch is exactly 25.4 mm, so 5 ft 10 in is 1778 mm exactly, while 177.8 cm drifts as a float.
- **`dateOfBirth` is date-only.** Prisma returns a `date` column as a `Date` at UTC midnight. The service parses with `Date.UTC` and serializes with `toISOString().slice(0, 10)`; nothing goes through local time, so a leap-day birthday is not shifted on a server outside UTC (`apps/api/src/health-profile/health-profile.validation.ts`).

### 2.2 Reading

`GET /api/health-profile` returns the caller's profile. A user who never saved one gets a `200` with every field `null`, `unitSystem: "metric"`, `version: 0` and `updatedAt: null`. No row is created by reading.

### 2.3 Saving

`PUT /api/health-profile` is a **full replace**. Only `unitSystem` is required; an omitted nullable field is stored as `null`. The body is validated by a strict Zod schema, so an unknown property is a `400`, not a silently dropped field.

| Field | Rule |
|---|---|
| `dateOfBirth` | `YYYY-MM-DD`, a real calendar date, not in the future, not more than 120 years ago |
| `sexAtBirth` | `female`, `male`, `prefer_not_to_say` or null |
| `heightMm` | integer from 500 to 2500, or null |
| `unitSystem` | `metric` or `imperial`, required |
| `timeZone` | trimmed, an IANA name `Intl.DateTimeFormat` accepts (`UTC` is valid, an empty string is not), or null |
| `bio` | trimmed, at most 1000 characters; an empty string is stored as null |

"Not in the future" is measured against UTC+14, the earliest calendar date on Earth. A person born today in Auckland has a birth date that is still tomorrow in UTC; a UTC-only check would refuse a true answer.

Validation messages name the rule, never the submitted value.

### 2.4 Concurrency

The optional `If-Match: <version>` header is the version from the last read (`0` when no profile exists). A mismatch is a `409`. A malformed value (not a non-negative integer, quotes allowed) is a `400`. Without the header the save overwrites unconditionally.

The check is enforced by the write, not only by the read before it:

| Situation | Mechanism | Result |
|---|---|---|
| No row yet | `create` with `version: 1` | The second of two concurrent first saves hits the `user_id` unique index (`P2002`) and gets `409` |
| Row exists | `updateMany` where `userId` and the `version` that was read, with `version` incremented | If the row moved on since the read, zero rows match and the caller gets `409` |

The service uses create-if-absent plus a version-guarded `updateMany` rather than `upsert`: an `upsert` would let the loser of a concurrent first save overwrite the winner.

### 2.5 Audit

After the transaction commits, the service writes one `audit_events` row: action `health_profile:update`, `targetType` `health_profile`, `targetId` the user id, `meta.fields` the names of the fields whose value changed. Never a value, never the bio.

- A save that changes nothing writes no row.
- The write is best-effort: a failure is logged (field names only) and the request still succeeds.

### 2.6 Web

The Health Profile card sits in the **Health** group of `USER_SETTINGS_SECTIONS` and opens `/settings/health-profile`. Card and route are gated on `health_data:read`; a user without it does not see the card and the route redirects to `/`. Inside the page, every input is disabled without `health_data:write`.

- **Height.** Metric edits centimetres; imperial edits feet and inches. Both convert to integer millimetres with the exact 25.4 mm per inch. Switching units re-shows the converted value without saving.
- **Time zone.** An autocomplete over `Intl.supportedValuesOf('timeZone')`; a free-text field when that is unavailable. With no saved zone, the browser's zone is pre-filled as a suggestion the user still has to save.
- **Default units.** With no saved profile, imperial for `en-US` locales, metric otherwise.
- **Conflict.** A `409` shows "This profile changed elsewhere. Reload to continue." and keeps the edits on screen.

### 2.7 Measurement data model

`Measurement` (`measurements`), many per `User`, `onDelete: Cascade`.

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid | One reading. |
| `userId` | uuid | Owner. Every query filters on it. |
| `entryId` | uuid | Readings saved together share it. Not a foreign key; it groups rows. |
| `metricKey` | text | A registry key. A plain string, not an enum. |
| `value` | float | In the metric's canonical unit. |
| `unit` | text | The canonical unit, always. |
| `measuredAt` | `timestamptz` | When the reading was taken. |
| `localDate` | `date`, null | The person's local calendar day; reserved for daily metrics. The measurements API leaves it null and copies it forward on edit. |
| `method` | text, default `unspecified` | How it was measured. A plain string. |
| `origin` | text, default `manual` | How it entered the system: `manual`, `calculated`, `ai` or `device`. A plain string. |
| `notes` | text, null | Free text, at most 500 characters. |
| `sourceRef` | JSON, null | Server-written provenance (for example the draft an AI value came from). |
| `revision` | integer, default 1 | 1 for a first write, `+1` per edit. |
| `supersedesId` | uuid, null, unique | The row this one replaced. Self foreign key, `ON DELETE RESTRICT`. |
| `supersededAt` | `timestamptz`, null | Set on a row when an edit replaces it. |
| `deletedAt` | `timestamptz`, null | Set on a row when its entry is deleted. |
| `createdAt`, `updatedAt` | `timestamptz` | |

Indexes: `(userId, metricKey, measuredAt desc)` for latest and series, `(userId, entryId)` for entry operations, `(userId, localDate)`, and the unique `supersedes_id`. There is no partial index and no raw SQL: the "active" rule is a query predicate ([2.10](#210-active-rows-and-revisions)).

### 2.8 Metric registry

`apps/api/src/measurements/metric-registry.ts` is pure data and pure functions, with no Nest or Prisma imports. It owns the vocabulary of `metricKey`, `method` and the allowed units; the Zod schemas are built on it. Each metric carries `key`, `label`, `category` (`body`, `vital` or `wellness`), `canonicalUnit`, `units` (each with a `factor`), `displayUnit` per unit system, hard `min`/`max` in the canonical unit, `decimals` for display, allowed `methods`, an optional `scale` and a `daily` flag.

| Key | Category | Canonical unit | Other units | Bounds (canonical) | Decimals | Methods (besides `unspecified`) |
|---|---|---|---|---|---|---|
| `weight` | body | `kg` | `lb` (x 0.45359237) | 20 to 500 | 1 | `scale`, `smart_scale`, `clinical`, `other` |
| `body_fat_pct` | body | `%` | none | 2 to 70 | 1 | `smart_scale`, `bia`, `skinfold`, `dexa`, `air_displacement`, `hydrostatic`, `other` |
| `waist_circumference` | body | `cm` | `in` (x 2.54) | 30 to 250 | 1 | `tape`, `other` |
| `bp_systolic` | vital | `mmHg` | none | 60 to 260 | 0 | `bp_cuff`, `clinical`, `wearable`, `other` |
| `bp_diastolic` | vital | `mmHg` | none | 30 to 160 | 0 | `bp_cuff`, `clinical`, `wearable`, `other` |
| `resting_hr` | vital | `bpm` | none | 25 to 220 | 0 | `wearable`, `bp_cuff`, `manual_pulse`, `other` |
| `energy`, `sleep_quality`, `muscle_soreness`, `stress` | wellness | `score` | none | 1 to 5 | 0 | `self_report` only; `daily`, with a `scale` of low and high labels |

The shared method list is `unspecified`, `scale`, `smart_scale`, `bia`, `dexa`, `air_displacement`, `skinfold`, `hydrostatic`, `tape`, `bp_cuff`, `manual_pulse`, `wearable`, `clinical`, `self_report`, `other`.

**Canonical storage.** A client may send a value in any unit the metric allows (`{ value: 208.4, unit: "lb" }`). The server converts once with `toCanonical`, rounds to 4 decimals and stores the canonical value with the canonical unit. Every response returns canonical values. Bounds are checked after conversion. Display code converts back and rounds to `decimals`.

**Catalog endpoint.** `GET /api/measurements/metrics` returns `{ metrics, methods }`: the registry as JSON, with conversion factors, bounds, decimals, allowed methods and `scale` (null when absent), plus the method list with labels. A client reads conversion data from it and keeps no second copy.

### 2.9 Entries and write rules

Readings saved together (a blood-pressure pair; weight with body fat and waist) share an `entryId` and one `measuredAt`. Create, edit and delete work on a whole entry and are atomic.

`POST /api/measurements` takes `measuredAt` (default now), `notes` and 1 to 6 `readings` of `{ metricKey, value, unit?, method? }`, and answers `201` with `{ entryId, items }`. The body is strict Zod: an unknown property is a `400`. A `400` names every failing field under `details.issues` ([API.md](../API.md#errors)), never the submitted value.

| Rule | Detail |
|---|---|
| `metricKey` | A body or vital metric. A wellness or unknown key is refused |
| Duplicates | One `metricKey` at most once per request |
| `unit` | One the metric allows; omitted means canonical |
| `method` | One the metric allows; omitted means `unspecified` |
| `value` | Finite, and inside the bounds after conversion |
| Blood pressure | `bp_systolic` and `bp_diastolic` together or not at all, systolic above diastolic |
| `measuredAt` | ISO 8601 with offset, at most 5 minutes ahead of the server clock, not before 1900-01-01 |
| `notes` | Trimmed, at most 500 characters; an empty string is stored as null |

**Method versus origin.** `method` is per reading and is how the value was physically obtained. `origin` is how it entered the system. Clients can never set `origin` or `sourceRef`: the strict schema rejects them, and the HTTP route always writes `origin: manual`. Server code that records provenance (an accepted AI draft) calls `MeasurementsService.createEntryInTransaction(tx, userId, input, { origin, sourceRef })` inside its own transaction. Its `input` must already be parsed with `createMeasurementEntrySchema`, so it is canonical.

### 2.10 Active rows and revisions

`PATCH /api/measurements/entries/:entryId` takes at least one of `measuredAt`, `notes` (`null` clears them) and `readings`. In one transaction it:

1. Loads the entry's active rows. None means `404`.
2. Merges the changes: readings not mentioned are copied unchanged, a mentioned `metricKey` must already be in the entry, and the blood-pressure rule is checked on the merged result.
3. Stamps `supersededAt` on every old row.
4. Inserts new rows with `revision + 1` and `supersedesId` set to the old row. Provenance (`origin`, `sourceRef`) is copied forward.

No value is ever changed in place, so the original stays in the table. `edited` in a response is `revision > 1`.

`DELETE /api/measurements/entries/:entryId` sets `deletedAt` on every active row and answers `204`. Repeating it, or naming another user's entry, is `404`.

**Active predicate.** A row is active when `supersededAt IS NULL AND deletedAt IS NULL`. It is one constant, `ACTIVE` in `apps/api/src/measurements/measurement-active.ts`, spread next to the owner filter (`where: { userId, ...ACTIVE }`) in every read. A read without it is a defect.

### 2.11 Concurrency

There is no `If-Match` on measurements. Two concurrent edits of one entry cannot both win:

- The stamp is `updateMany` on the old ids with `supersededAt: null`. A count different from the number of rows loaded means another request got there first, and the caller gets `409`.
- The unique index on `supersedes_id` catches the remaining race: the loser's insert fails with `P2002`, mapped to `409`.

A `409` means reload the entry and try again.

### 2.12 Reading

| Read | Behaviour |
|---|---|
| List | Active body and vital rows, newest `measuredAt` first, ties by insertion time. Filters `metricKey`, `from`, `to`; `page` and `pageSize` (default 20, max 100); flat pagination shape. `from` later than `to` is a `400` |
| Latest | One item per body and vital metric in registry order, each with `latest` and `previous` (null where absent). Reflects edits and deletes |
| Series | `metricKey` required (any registry metric), `from` and `to` (default: the last 180 days ending now), range at most 5 years. Points ascending with `{ id, measuredAt, value, method, origin }`. At most 1000 points: when more match, the newest 1000 are kept and `truncated` is true |

### 2.13 Audit and privacy

After a successful delete the service writes one `audit_events` row, best-effort: action `measurement_entry:delete`, `targetType` `measurement_entry`, `targetId` the `entryId`, `meta.readingCount` only. No value and no notes. Create and edit write no audit row; the revision chain is the history. Values and notes never reach a log line or an error message; failures log ids and counts.

## 3. Configuration and permissions

There are no settings keys and no environment variables. Storage, AI and other runtime services are not involved.

### Permissions

Both are held by Admin, Contributor and Viewer: the data is the user's own, self-service like `user_settings:*`. A deployment withholds it from a role by removing the `role_permissions` row. The matrix is in [ARCHITECTURE.md](../ARCHITECTURE.md#72-permission-matrix).

| Permission | Enforced by |
|---|---|
| `health_data:read` | `GET /api/health-profile`; every `GET /api/measurements*` route; the Health Profile card; the `/settings/health-profile` route |
| `health_data:write` | `PUT /api/health-profile`; `POST`, `PATCH` and `DELETE` on `/api/measurements`; the enabled state of the form's inputs |

An existing deployment gets the two permissions and their grants by re-running `npm run prisma:seed` (from `apps/api`, or through the API container as in the development loop); the seed upserts, so it adds the new rows without duplicating grants. Until then, every user of that deployment receives `403` from the health routes and does not see the card.

### Routes

| Route | Permission | Behaviour |
|---|---|---|
| `GET /api/health-profile` | `health_data:read` | The caller's profile, or the empty profile with `version: 0` |
| `PUT /api/health-profile` | `health_data:write` | Full replace; optional `If-Match`; `409` on version conflict; returns the saved profile |
| `GET /api/measurements/metrics` | `health_data:read` | The metric registry and method list |
| `POST /api/measurements` | `health_data:write` | Create one entry; `201 { entryId, items }` |
| `GET /api/measurements` | `health_data:read` | Active body and vital rows, newest first, filtered and paginated |
| `GET /api/measurements/latest` | `health_data:read` | Latest and previous reading per body and vital metric |
| `GET /api/measurements/series` | `health_data:read` | Ascending chart points for one metric, at most 1000 |
| `PATCH /api/measurements/entries/:entryId` | `health_data:write` | Supersede the entry's rows; `404` if none active; `409` on a concurrent edit |
| `DELETE /api/measurements/entries/:entryId` | `health_data:write` | Soft-delete the entry; `204`; `404` if none active |

The measurement routes are owner scoped: an entry belonging to someone else is a `404`, never a `403`. The literal routes (`metrics`, `latest`, `series`) are declared before the parameterised ones.

Per-endpoint detail, schemas and error responses: `/api/docs` (`npm run openapi:dump`).

## 4. Extending it in a fork

### Read the profile from another feature

`HealthProfileModule` exports `HealthProfileService`. Import the module and inject the service; do not query `health_profiles` from another module.

- `getTimeZone(userId)` returns the IANA zone or `null`. A feature that groups values by day uses it and falls back explicitly when it is `null`.
- `get(userId)` returns the mapped profile (or the empty profile).

### Add another health feature

1. Put its tables in the schema with `userId` and `onDelete: Cascade`, like `HealthProfile`.
2. Gate its routes on `health_data:read` and `health_data:write`. Add a new permission only when the feature needs a grant a deployment must be able to withhold independently.
3. Take the user id from `@CurrentUser('id')`. Never accept a user id parameter.
4. Keep values and free text out of logs, exception messages and audit `meta`; audit field names only.
5. Add its settings or page card to a registry ([settings-ui.md](settings-ui.md)), with `permission` set to the exact string the controller enforces.
6. Extend this spec: a subsection in section 2, its routes in section 3, its tests in section 5.

### Add a metric

Appending an entry to `METRICS` in `apps/api/src/measurements/metric-registry.ts` is the whole change; no migration is needed.

1. Give it a unique `key` (permanent once rows carry it), `label`, `category`, `canonicalUnit`, `units` with `factor` to the canonical unit, `displayUnit`, hard `min`/`max`, `decimals` and allowed `methods`. Add a new method to `MEASUREMENT_METHODS` only if the shared list lacks it.
2. Put it in the `body` or `vital` category for `/api/measurements` to accept it; a `wellness` entry is not accepted there.
3. If it must be submitted with another metric, add the cross-field rule beside `bloodPressureProblem` in `apps/api/src/measurements/dto/measurement.dto.ts`, and check it in the service's merged-entry step too.
4. Update the catalog snapshot in `apps/api/src/measurements/metric-registry.spec.ts` and the table in [2.8](#28-metric-registry).
5. `latest` lists every body and vital metric, so the new one appears there automatically.

### Write measurements from another feature

`MeasurementsModule` exports `MeasurementsService`. Import the module; do not query `measurements` from another module.

- To record values on the server with provenance, parse the input with `createMeasurementEntrySchema`, open a transaction and call `createEntryInTransaction(tx, userId, input, { origin, sourceRef })`. The metric registry is importable directly.
- Every read of `measurements` spreads `ACTIVE` next to the owner filter.

### Add a profile field

Add the column, the field to `healthProfileInputSchema` and the response DTO, and the name to `HEALTH_PROFILE_FIELDS` (`apps/api/src/health-profile/dto/health-profile.dto.ts`), which drives changed-field detection for the audit. The form in `apps/web/src/components/settings/HealthProfileSettings.tsx` gets the input.

## 5. Guardrails

| Test | Enforces |
|---|---|
| `apps/api/src/health-profile/dto/health-profile.dto.spec.ts` | Every validation rule above, trimming, empty bio to null, strict unknown properties |
| `apps/api/src/health-profile/health-profile.validation.spec.ts` | Date-only parsing, the UTC+14 and 120-year bounds, IANA validation |
| `apps/api/src/health-profile/health-profile.service.spec.ts` | Default profile, create and update, version increments, `If-Match` conflict, changed-field detection, no audit when nothing changes, audit failure swallowed, `getTimeZone` |
| `apps/api/src/health-profile/health-profile.controller.spec.ts` | `If-Match` parsing |
| `apps/api/test/health-data/health-profile.integration.spec.ts` | `401`, `403`, `200`, `400`, `409`, the response envelope, only the caller's row, the bio never echoed |
| `apps/api/test/health-data/health-profile.db.spec.ts` | Unique `user_id`, cascade delete, leap-day round trip, exactly one of two concurrent first saves wins |
| `apps/api/src/measurements/metric-registry.spec.ts` | The catalog against the table in 2.8, method subsets, conversion round trips, bounds after conversion |
| `apps/api/src/measurements/dto/measurement.dto.spec.ts` | Every write and query rule in 2.9 and 2.12, strict unknown properties (`origin`, `sourceRef`), the blood-pressure rule |
| `apps/api/src/measurements/measurements.service.spec.ts` | Create, edit copy-forward and provenance carry-over, conflict on a count mismatch, delete and audit, the owner filter and `ACTIVE` in every read |
| `apps/api/test/health-data/measurements.integration.spec.ts` | `401`, `403`, `404`, `400`, `201`, `200`, `204` per route, the envelope, `details.issues`, `/latest` not captured by `:entryId` |
| `apps/api/test/health-data/measurements.db.spec.ts` | The four indexes, unique `supersedes_id`, supersede-not-overwrite, exactly one of two concurrent edits wins (`409`), latest after edit and delete, audit with count only, other users get `404`, newest 1000 of 1200 series points, cascade with the user |
| `apps/api/test/openapi/openapi-document.spec.ts` | Every `/api/measurements*` operation is gated on a `health_data` permission |
| `apps/api/src/common/filters/http-exception.filter.spec.ts` | Validation `400`s name fields under `details.issues` and never echo a value |
| `apps/api/test/prisma/seed-data.spec.ts` | Both permissions are seeded and granted to all three roles |
| `apps/web/src/__tests__/components/settings/HealthProfileSettings.test.tsx` | Unit-switch conversion, disabled state without write, validation messages, `409` handling |
| `apps/web/src/__tests__/config/userSettingsSections.test.ts` | The card is in group Health after Security and declares `health_data:read` |
| `apps/web/src/__tests__/App.test.tsx` | The route redirects a user without `health_data:read` |

## 6. Design decisions

- **A dedicated table, not a `user_settings` namespace.** That document is UI preferences with a parity test between schema and defaults. Health values need column constraints and server-side computation (age, day boundaries), and a different lifecycle (export, retention).
- **Not columns on `users`.** `users` is identity and auth, read on every request. Health data should be separable without touching it.
- **Its own permission family.** Reusing `user_settings:*` would force a deployment to block theme changes to withhold health data. The card's `permission` must be the exact string the controller enforces, so the two have to be the same grant.
- **Not a tab on `/settings/profile`.** The Settings UI Pattern forbids a settings page as a new tab; it is a card in its own Health group.
- **Height as integer millimetres.** Exact for both metric and imperial entry.
- **Version-guarded write instead of `upsert`.** An upsert cannot report a lost race on the first save; create-if-absent plus a guarded `updateMany` can.
- **One generic `measurements` table, not a table per metric.** A new metric (a DEXA region, a lab analyte) would otherwise need a migration, and a cross-metric timeline would be a union.
- **Plain strings, not Prisma enums, for `metricKey`, `method` and `origin`.** Adding a value to an enum needs a migration and a deploy order, the same reason `Job.type` is a string. The registry and Zod are the guard.
- **Supersede instead of edit in place or a history table.** A revision table needs copy logic for the same effect. Superseding rows keep the current value one predicate away.
- **A query predicate, not a partial index, for "active".** The repository already carries two intentional raw-SQL index drifts and does not add a third. A plain composite index serves the reads.
- **Canonical storage, not the client's unit.** Mixed units in one column make every aggregate wrong. Factors are published by the catalog endpoint, so the web app has no second copy.
- **Entry-level edit and delete.** A blood-pressure pair edited row by row can be left half-edited.
- **`Float`, not `Decimal`.** Conversion already produces non-decimal values; the API rounds to 4 decimals.
- **`origin` and `sourceRef` are server-only.** A client that could send them could label a typed value as AI or device data.

## 7. Verification

```bash
npm test --workspace=api -- health-profile measurements metric-registry health-data seed-data http-exception openapi-document
npm run test:db --workspace=api -- health-profile measurements
npm run test:run --workspace=web -- HealthProfile userSettingsSections
npm run openapi:dump && npm run openapi:lint
```

Manually, signed in as any seeded role:

1. `GET /api/health-profile` for a new user answers `200` with `version: 0`.
2. `PUT` a valid body: `version` is `1`; a second `PUT` gives `2`; a `PUT` with `If-Match: 1` after that gives `409`.
3. `PUT` a future date of birth: `400`.
4. Open `/settings`: the Health group has a Health Profile card. Save 5 ft 10 in, reload, and it reads back as 5 ft 10 in; switch to metric and it shows 177.8 cm.
5. Query `audit_events` for `health_profile:update`: `meta.fields` lists names only.
6. `POST /api/measurements` with weight `208.4` in `lb`: `201`, one item with a canonical `value` of about `94.5327` in `kg`, `origin: "manual"`, `revision: 1`.
7. `GET /api/measurements/latest` shows it; `PATCH` its `entryId` to `210` `lb`: `revision: 2`, `edited: true`; `GET /api/measurements?metricKey=weight` lists one row.
8. `POST` weight `5` in `kg`: `400` with `details.issues` naming `readings.0.value`. `POST` a body with `origin`: `400`.
9. `DELETE` the entry: `204`; a second `DELETE`: `404`. Query `audit_events` for `measurement_entry:delete`: `meta` is `{ "readingCount": 1 }`.
10. Sign in as a second user and `PATCH` or `DELETE` the first user's `entryId`: `404`.

## History

- #47: health profile table, `health_data:read/write`, `GET/PUT /api/health-profile`, the Health Profile settings card and page, and this spec.
- #50: `measurements` table, metric registry and catalog endpoint, `/api/measurements` create, list, latest, series, edit and delete, and the validation `details.issues` shape.
