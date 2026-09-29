# Health Data

> **Status:** shipped (health profile) · **Code:** `apps/api/src/health-profile/` · **API:** `/api/health-profile` (see `/api/docs`, tag "Health Profile") · **Admin UI:** none (user page `/settings/health-profile`) · **Runbook:** none · **Recipe:** [section 4](#4-extending-it-in-a-fork)

Health data is per-user data an app built from this template interprets in context: a weight or a heart rate reads differently with an age, a sex at birth and a height, and its day boundaries depend on a time zone. It lives in its own tables, behind its own permission family (`health_data:read`, `health_data:write`), and is only ever reachable by its owner. Today the feature is the **health profile**: one row per user with date of birth, sex at birth, height, unit system, time zone and a short bio. Later health features add tables and routes under the same permissions and read the profile through `HealthProfileService`.

## 1. Purpose

- **What it is.** The person-level facts every health feature needs: age (from date of birth), sex at birth, height in millimetres, the unit system the person enters and reads values in, and the IANA time zone that decides which calendar day a value belongs to.
- **What it is not.**
  - Not the account profile. Display name and image stay in `user_settings.value.profile` at `/settings/profile`.
  - Not a preference document. It is typed columns the server computes with, not a `user_settings` namespace.
  - Not a medical record. The bio is free context for the person and, later, an AI coach.
  - Not administered. There is no admin route to another user's profile.
- **Problem it solves.** A fork that records health values needs somewhere to keep the facts that give them meaning, and a permission that lets a deployment govern access to health data without also blocking someone from changing their theme.

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

## 3. Configuration and permissions

There are no settings keys and no environment variables. Storage, AI and other runtime services are not involved.

### Permissions

Both are held by Admin, Contributor and Viewer: the data is the user's own, self-service like `user_settings:*`. A deployment withholds it from a role by removing the `role_permissions` row. The matrix is in [ARCHITECTURE.md](../ARCHITECTURE.md#72-permission-matrix).

| Permission | Enforced by |
|---|---|
| `health_data:read` | `GET /api/health-profile`; the Health Profile card; the `/settings/health-profile` route |
| `health_data:write` | `PUT /api/health-profile`; the enabled state of the form's inputs |

An existing deployment gets the two permissions and their grants by re-running `npm run prisma:seed` (from `apps/api`, or through the API container as in the development loop); the seed upserts, so it adds the new rows without duplicating grants. Until then, every user of that deployment receives `403` from the health routes and does not see the card.

### Routes

| Route | Permission | Behaviour |
|---|---|---|
| `GET /api/health-profile` | `health_data:read` | The caller's profile, or the empty profile with `version: 0` |
| `PUT /api/health-profile` | `health_data:write` | Full replace; optional `If-Match`; `409` on version conflict; returns the saved profile |

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

## 7. Verification

```bash
npm test --workspace=api -- health-profile health-data/health-profile.integration seed-data
npm run test:db --workspace=api -- health-profile
npm run test:run --workspace=web -- HealthProfile userSettingsSections
npm run openapi:dump && npm run openapi:lint
```

Manually, signed in as any seeded role:

1. `GET /api/health-profile` for a new user answers `200` with `version: 0`.
2. `PUT` a valid body: `version` is `1`; a second `PUT` gives `2`; a `PUT` with `If-Match: 1` after that gives `409`.
3. `PUT` a future date of birth: `400`.
4. Open `/settings`: the Health group has a Health Profile card. Save 5 ft 10 in, reload, and it reads back as 5 ft 10 in; switch to metric and it shows 177.8 cm.
5. Query `audit_events` for `health_profile:update`: `meta.fields` lists names only.

## History

- #47: health profile table, `health_data:read/write`, `GET/PUT /api/health-profile`, the Health Profile settings card and page, and this spec.
