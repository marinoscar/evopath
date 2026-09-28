# Maintenance Mode

> **Status:** shipped · **Code:** `apps/api/src/common/maintenance/`, `apps/web/src/components/common/MaintenanceGate.tsx`, `apps/web/src/services/maintenance.ts` · **API:** `/api/admin/maintenance` (see `/api/docs`) · **Admin UI:** `/admin/settings/maintenance` · **Runbook:** [maintenance-mode.md](../runbooks/maintenance-mode.md)

Maintenance mode takes the application out of service on purpose. While a
window is open, every API route answers `503` with an operator-supplied message
and a `Retry-After` header. A small, fixed set of routes stays reachable so an
operator can sign in, probe health and close the window again.

## 1. Purpose

A window serves two callers:

1. **Planned work.** An upgrade, a migration or a configuration change that an
   operator wants to make with nobody writing to the database.
2. **The database restore's swap.** A restore renames the live database. For
   those seconds there is no database under the expected name, so requests
   must already be stopped, and stopping them cannot depend on reading that
   database.

The second caller is why this is more than a boolean in a settings row. The
state is resolved from three layers (§2.1), and each layer covers a failure
the other two cannot.

Operator procedures (opening and closing a window, the environment
break-glass, recovering from an `allowAdmins: false` lockout) live in the
[runbook](../runbooks/maintenance-mode.md).

## 2. How it works

### 2.1 Three layers

`MaintenanceModeService.resolve()` combines the layers in this order:

```
env override  ??  in-memory override  ??  persisted setting
```

| Layer | Source | Purpose |
|---|---|---|
| Environment | `MAINTENANCE_MODE`, read from `process.env` on every resolve | Break-glass in both directions. Works when the database or the API cannot. |
| In-memory | `setInMemoryOverride({ enabled, message?, allowAdmins? })` | The restore swap's layer. Set before the rename, cleared (`null`) after. Not reachable over HTTP. |
| Persisted | `maintenance` namespace of `system_settings` | The normal path. Survives restarts. |

The layers combine with `??`, never `||`. `false` is a meaningful value at the
first two layers, and `||` would turn "forced off" into "ask the next layer".

`message` and `allowAdmins` resolve **independently of `enabled`**, from the
highest layer that supplies them. The environment layer carries only a
boolean, so a window forced open from the environment still shows the stored
message and honours the stored `allowAdmins`. `startedAt` and `startedById`
always come from the persisted layer.

### 2.2 The persisted layer

The `maintenance` namespace holds:

| Key | Type | Notes |
|---|---|---|
| `enabled` | boolean | Default `false`. |
| `message` | string, 1–1000 chars | Default `DEFAULT_MAINTENANCE_MESSAGE` (names no product). |
| `allowAdmins` | boolean | Default `true`. Admins signed in with a session JWT bypass the window. |
| `startedAt` | ISO datetime or `null` | Stamped by the server when a window opens. |
| `startedById` | UUID or `null` | The admin who opened it. |

- It is read through `SystemSettingsService.getMaintenancePolicy()`, which
  **does not create the row** (a per-request read must not write) and **may
  throw**. `readPersisted` catches the throw, because a failed read is an
  expected outcome during the swap.
- A failed read falls back to the last value this process saw, then to the
  seeded defaults (`enabled: false`).
- The read is cached for five seconds (`MAINTENANCE_PERSISTED_CACHE_MS`). The
  instance that handles a write invalidates its own cache synchronously; other
  instances converge within the window. `GET /api/admin/maintenance` passes
  `fresh: true` and bypasses the cache.
- Writes go through `SystemSettingsService.patchSettings()`, which owns the
  merge, unknown-key preservation and the version counter.

### 2.3 The environment override

`MAINTENANCE_MODE` accepts exactly two values:

- `true` forces the window open, even with an unreadable database.
- `false` forces it shut. This is the recovery from a window opened with
  `allowAdmins: false`.

Only the literal strings `'true'` and `'false'` count. Anything else (unset,
`1`, `0`, `yes`, `on`, `off`, `TRUE`) means *no override*, and
`readEnvOverride()` returns `null`. The value is read from `process.env`, not
through `ConfigService`, so it cannot depend on a successful configuration
load. A change needs a restart.

### 2.4 The guard

`MaintenanceGuard` is registered as a global `APP_GUARD`, so it runs before
any route-level guard. At that point `request.user` does not exist yet, so the
guard verifies the bearer token itself with its own `JwtService` and reads the
`roles` claim.

- **It never populates `request.user`.** `JwtAuthGuard` still does the real
  authentication afterwards.
- **A token that fails verification means "not an admin"**, never a `401`.
  The caller gets the `503` that is actually true.
- **`pat_` and `nod_` bearers never get the admin bypass**, whatever
  `allowAdmins` says. They are opaque, resolving them needs a database round
  trip, and they belong to unattended clients that should back off.
- Exemption is checked **before** the admin bypass. A `pat_` bearer can still
  call `GET`/`PUT /api/admin/maintenance`, so an operator can close a window
  from a shell.

`MaintenanceModule` registers its own `JwtModule.registerAsync` against the
same `jwt.secret` and does **not** import `AuthModule`. It does not re-export
its `JwtModule`. `app.module.ts` aliases the guard with `useExisting`, so the
instance is built in `MaintenanceModule`'s context.

### 2.5 The 503 contract

Every blocked response carries:

| Field | Value |
|---|---|
| `details.reason` | `'MAINTENANCE_MODE'` (`MAINTENANCE_ERROR_MARKER`). The web client mirrors this constant in `apps/web/src/services/maintenance.ts`; changing it is a wire-contract change. |
| `details.retryAfterSeconds` and `Retry-After` header | `MAINTENANCE_RETRY_AFTER_SECONDS` (30). Fixed, not an estimate. |
| `details.allowAdmins` | Lets a client choose between "come back later" and "sign in as an administrator". |
| `message` | The resolved operator message. |

The marker must live under `details`. `common/filters/http-exception.filter.ts`
rebuilds every error body from a fixed allowlist (`statusCode`, `code`,
`message`, `details`, `timestamp`, `path`) and always derives `code` from the
status. The guard sets `Retry-After` on the Fastify reply before it throws;
the filter preserves it.

On the web, `services/api.ts` recognises the marker on the shared error path
and `MaintenanceGate` swaps the whole subtree for the maintenance page. A
`503` without the marker keeps its normal error behaviour. The admin page at
`/admin/settings/maintenance` is the one route the gate never covers.

### 2.6 Health probes

| Probe | During a window | Reason |
|---|---|---|
| `GET /api/health/live` | `200` | The process is not hung. An orchestrator must not restart it mid-upgrade. |
| `GET /api/health/ready` | `503`, checked **before** the DB probe | Drain the instance, for the reason that is actually true. |
| `GET /api/health` | unchanged | A diagnostic. Reports what its dependencies say. |

The whole health controller carries `@AllowDuringMaintenance()`. The
readiness `503` carries the marker but **no `Retry-After`**; that header is
the guard's contract with API clients. `resolve()` never throws, so a
database outage cannot turn the probe into a `500`.

### 2.7 Routes reachable during a window

Exactly this set, marked with `@AllowDuringMaintenance()`:

| Route | Why |
|---|---|
| `GET /api/health`, `/live`, `/ready` | Orchestrators and load balancers. |
| `GET /api/auth/providers`, `/google`, `/google/callback` | Signing in. A window nobody can sign in to cannot be ended. |
| `POST /api/auth/refresh` | Staying signed in through a long window. |
| `GET /api/auth/me` | The maintenance page needs to know whether the viewer is an admin. |
| `POST /api/auth/logout`, `/logout-all` | Signing out is never unavailable. |
| `GET /api/auth/device/activate`, `POST /api/auth/device/authorize` | The browser half of RFC 8628, driven by a signed-in human. |
| `POST /api/auth/test/login` | Non-production only. |
| `GET`/`PUT /api/admin/maintenance` | The switch that closes the window. |
| `GET /api/admin/about` | Read-only deployment report, most needed when a deploy has failed. Still gated on `system_settings:read`. |

Not exempt: `POST /api/auth/device/code` and `POST /api/auth/device/token`.
**A CLI cannot log in while a window is open.** Use the web UI, an existing
PAT, or the environment break-glass.

`/api/docs` and `/api/openapi.json` are mounted directly on Fastify by
`openapi/register-docs-routes.ts`, outside Nest's router. No Nest guard sees
them, so they stay readable during a window. This is intentional.

`@AllowDuringMaintenance()` is not `@Public()`. Exemption is reachability
only: `@Auth()` still runs, so a caller without `system_settings:write` gets
a `403` during a window.

### 2.8 Audit and provenance

Every `PUT` writes an audit row: `action` is `maintenance:enable` or
`maintenance:disable`, `targetType` is `maintenance`, `targetId` is `global`,
and `meta` carries `previouslyEnabled` plus only the fields the write set. The
shared `system_settings:patch` row is written too.

Opening a window stamps `startedAt` and `startedById`; closing one clears
both. Re-sending `enabled: true` with a new message is an edit, not a new
window, and keeps the original start. Neither field is accepted from the
request body.

## 3. Configuration and permissions

| Setting | Where |
|---|---|
| `maintenance.enabled`, `.message`, `.allowAdmins` | `system_settings` (§2.2) |
| `MAINTENANCE_MODE` | Environment. `true`/`false` only; restart required (§2.3) |

Permissions: `system_settings:read` for `GET`, `system_settings:write` for
`PUT`. There is no maintenance-specific permission (§6). The role matrix lives
in [ARCHITECTURE.md](../ARCHITECTURE.md).

| Route | Purpose | Permission |
|---|---|---|
| `GET /api/admin/maintenance` | Effective state plus each contributing layer (uncached) | `system_settings:read` |
| `PUT /api/admin/maintenance` | Open, edit or close the window (`enabled`, optional `message`, `allowAdmins`) | `system_settings:write` |

## 4. Extending it in a fork

- **A new route is blocked by default.** Do nothing and it answers `503`
  during a window. That is the safe default.
- **To keep a route reachable**, add `@AllowDuringMaintenance()` to the
  handler or controller, then add the route to the expected set in
  `test/maintenance/maintenance-reachable-set.integration.spec.ts`. The test
  fails until you do, which is where the change gets justified.
- **To hold traffic from inside the server** (as the restore swap does), call
  `MaintenanceModeService.setInMemoryOverride({ enabled: true, ... })` before
  the risky step and `setInMemoryOverride(null)` in a `finally`. The override
  is process-local and unaudited, so keep it to short internal windows.
- **A client** should check `details.reason === 'MAINTENANCE_MODE'` rather
  than the status code, and honour `Retry-After`.

## 5. Guardrails

| Invariant | Test |
|---|---|
| Layer precedence; only `'true'`/`'false'` count (table-driven over `1`, `0`, `yes`, `no`, `TRUE`, `False`, `on`, `off`, `''`); audit rows | `apps/api/src/common/maintenance/maintenance-mode.service.spec.ts` |
| Never populates `request.user`; `pat_`/`nod_` never bypass | `apps/api/src/common/maintenance/maintenance.guard.spec.ts` |
| `MaintenanceModule` does not import `AuthModule` (module-graph walk) | `apps/api/src/common/maintenance/maintenance.module.spec.ts` |
| Readiness answers `503` before the DB probe runs | `apps/api/src/health/health.controller.spec.ts` |
| Marker survives the real exception filter; `Retry-After`; env override end to end | `apps/api/test/maintenance/maintenance.integration.spec.ts` |
| Exact reachable set, enumerated from the router; `/api/docs` stays readable | `apps/api/test/maintenance/maintenance-reachable-set.integration.spec.ts` |

## 6. Design decisions

- **Three layers, not one flag.** A persisted flag is unreadable during the
  restore swap it exists for. An in-memory flag does not survive the restart
  it was often set for. `allowAdmins: false` can lock out its own fix, so the
  environment is the third layer.
- **No dedicated permission.** A maintenance window *is* a system setting,
  stored in the `maintenance` namespace. `system_settings:write` already means
  "may change global application behaviour". A `maintenance:manage`
  permission would protect nothing more, and would let an administrator hold
  `system_settings:write` yet be unable to end a window.
- **A guard, not middleware.** Middleware runs before Nest resolves the
  handler, so it cannot read `@AllowDuringMaintenance()`. The exemption list
  would become a path-matching table kept apart from the routes.
- **Own `JwtModule`, not `AuthModule`.** Importing `AuthModule` pulls the
  whole authentication graph behind a guard in front of every request. One
  refactor away from a circular import, whose failure is an app that does not
  boot.
- **No `request.user` from the guard.** That would be a second authentication
  path that skips the disabled-user check and the PAT lookup.
- **No `401` for an unverifiable token.** The application is out of service;
  the caller is not the problem.
- **Five-second cache.** An uncached read adds a query to every request, for
  an answer that is almost always "no". Synchronous invalidation on write
  hides the delay from the operator who made the change.
- **Built separately from the restore.** The global guard touches every
  request; it was reviewed and tested on its own before the restore consumed
  it.

## 7. Verification

```bash
cd apps/api
npm test -- maintenance health.controller
```

By hand, with the app running:

1. `PUT /api/admin/maintenance` with `{"enabled": true, "message": "Upgrading"}`.
2. As a non-admin (or with a `pat_` token), call any other route: expect
   `503`, `details.reason: "MAINTENANCE_MODE"` and `Retry-After: 30`.
3. `GET /api/health/live` answers `200`; `GET /api/health/ready` answers `503`.
4. The web app shows the maintenance page; an admin session carries on.
5. `PUT /api/admin/maintenance` with `{"enabled": false}` closes the window.

## History

- #256 declared the `maintenance` system-settings namespace and reserved the
  `Maintenance` OpenAPI tag.
- #257 (epic #254) added the service, the global guard, the admin API, the
  health semantics and the reachable-set test.
- #258 added the web client gate and the mirrored marker.
- #285 made the database restore swap the in-memory layer's caller.
- #401 made `GET /api/admin/about` reachable during a window.
