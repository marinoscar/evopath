# Worker Nodes

> **Status:** shipped · **Code:** `apps/api/src/nodes/`, `apps/api/src/jobs/contracts/`, `apps/api/src/storage/storage-job-input.ts`, `apps/cli/src/node/` · **API:** `/api/nodes/*`, `/api/node-credentials`, `/api/admin/nodes/*` (see `/api/docs`) · **Admin UI:** `/admin/settings/workers` · **Runbooks:** [Running worker nodes](../runbooks/run-worker-nodes.md), [Node job secrets](../runbooks/node-job-secrets.md) · **Recipes:** [Job handlers](../../apps/api/src/jobs/handlers/README.md), [Node executors](../../apps/cli/src/node/executors/README.md)

A worker node is a process, usually `appctl node start` on a machine the deployment may not own, that pulls node-eligible jobs off this API's queue, runs them, and reports results back. It authenticates with a `nod_` credential confined to `/api/nodes/*`, holds no durable database or storage access, reads and writes object bytes through presigned URLs, and receives any per-job secret in memory only, for the life of one lease. The server keeps every decision that matters: which types a node may claim, how long it may hold them, whether a result is valid, and when a silent node is declared offline.

## 1. Purpose

Nodes move CPU- or IO-heavy work off the API process without giving the machine running it the authority of the API. An app built from this template gets:

- A second executor for the existing job queue ([job-queue.md](job-queue.md)). The same claim statement, lease, retry and settle machinery applies; the node plane only decides *who is asking*, *what may they have*, and *is what they sent real*.
- A narrow credential family (`nod_`) whose leak means "can pretend to be a worker", not "owns the deployment".
- A data plane where object bytes never pass through the API.
- A fleet lifecycle: registration, heartbeats, derived health, automatic offline marking, retention pruning, and an admin view of every node.

What it is not:

- Not a general remote-execution system. A node runs only types whose server handler declares node eligibility (`nodeResultSchema` + `persistNodeResult`) and for which the CLI has an executor.
- Not a place for provider credentials. AI jobs (`ai.*`) are permanently server-only, so a user's or the org's AI key is never brokered to a node.
- No model manifest or fleet-wide version pinning. A node on an older CLI keeps working because the server validates every result against its own schema.

Two node-eligible types ship today: `example.checksum` (the reference) and `db.backup.run` (the first type that needs a brokered credential).

## 2. How it works

### Model

| Table / model | Holds |
|---|---|
| `worker_nodes` (`WorkerNode`) | Identity (`createdById` + `name`, unique together), `hostname`, `platform`, `cliVersion`, declared `eligibleTypes` and `concurrency`, self-reported `capabilities` (JSONB), `registeredAt`, `lastHeartbeatAt`, operator `status` |
| `node_credentials` (`NodeCredential`) | sha256 hash of a `nod_` token, display prefix, owner, nullable `expiresAt`, `revokedAt`, `lastUsedAt` |
| `job_node_secrets` (`JobNodeSecret`) | One row per brokered per-job credential: broker `kind`, the credential's **handle** (never its material), `expiresAt`, `revokedAt`; unique on `(jobId, kind)` |
| `jobs.claimed_by_node_id` | The node holding a job; `onDelete: SetNull` |

`NodeStatus` is `online` | `draining` | `offline` | `disabled`. Health (`healthy` / `stale` / `offline`) is never stored; it is derived at read time (see Derived health).

Per-column reasoning lives in the block comments of `apps/api/prisma/schema.prisma`.

### Node credentials

A `nod_` token is a separate token family, not a personal access token. It mirrors `PersonalAccessToken` on purpose: 32 bytes of `randomBytes`, sha256 at rest, a short display prefix, the raw value shown exactly once, and a fire-and-forget `lastUsedAt`. `apps/api/src/nodes/node-credential.service.ts` beside `apps/api/src/pat/pat.service.ts` shows every divergence, and there is exactly one:

- **`expiresAt` is nullable.** `null` means "never expires; authenticate until revoked". A PAT's forced expiry nudges a human to rotate. On an unattended node it produces a whole fleet going dark when a timer nobody scheduled fires. The route allowlist already bounds a leak, so a mandatory expiry buys nothing. An operator can still set `expiresInDays`.
- **Revocation is the control, and it is immediate.** `revokedAt` is re-read from the row on every authentication; there is no cache and no TTL.
- Treating `expiresAt: null` as "expired at the epoch" is the most damaging bug this service could have, so it has its own test group at unit and integration level.

Ownership on revoke is folded into the lookup (`findFirst({ where: { id, userId } })`), so "not yours" and "does not exist" are the same code path and cannot be told apart. A caller who could distinguish them could enumerate other users' credential ids.

`NodeCredentialModule` is `@Global` and imports only `PrismaModule`, like `PatModule`, because `JwtAuthGuard` injects `NodeCredentialService` everywhere `@Auth()` appears. It is a separate module from `NodesModule` by dependency weight: `NodesModule` imports the jobs services, and putting that behind a guard that runs on every request would create a module cycle.

### Route allowlist

A `nod_` token reaches `/api/nodes` and paths beneath it. Everything else is `403`. The check lives in `apps/api/src/auth/guards/jwt-auth.guard.ts`, next to the `pat_` branch, not in the credential service.

- **Prefix boundary, not `startsWith`.** The path (query string stripped) must be exactly `/api/nodes` or begin with `/api/nodes/`. `/api/nodesX`, `/api/nodes-other` and `/api/nodescrape` are refused.
- **The URL is read as `originalUrl ?? url`**, covering both Fastify and Express. A request with no resolvable URL is refused: an allowlist that cannot classify a request fails closed.
- **The raw path, not route metadata.** A path exists before routing and cannot be forgotten the way a `@NodeRoute()` decorator could.
- **Route check before validation.** Inside the `nod_` branch the guard refuses a non-node route *before* calling `validateToken`. Validating first would stamp `lastUsedAt` on a probe (leaking token liveness into the operator's own credential listing) and spend database work on a request that was never going to be allowed.
- **`/api/node-credentials` is not on the allowlist.** Self-management is credential minting; a leaked token that could mint more would make revocation useless. Managing node credentials needs a session or a `pat_` token.
- **Maintenance mode.** `MaintenanceGuard.OPAQUE_BEARER_PREFIXES` lists `pat_` and `nod_`, so a node credential never gets the `allowAdmins` bypass during a maintenance window, even with an admin owner. `maintenance.guard.spec.ts` asserts the list contains the `NODE_TOKEN_PREFIX` constant the service mints, so the three files that must agree on the prefix cannot drift. See [maintenance-mode.md](maintenance-mode.md).

Everything mounted under `/api/nodes` is reachable by an unattended, possibly months-old credential on someone else's machine. Add a route there only if that is the intended blast radius.

### Registration and reattach

`POST /api/nodes/register` is idempotent on `(owner, name)`: find, reattach if present, else create; on a concurrent `P2002`, re-read and reattach. It answers `200` with `reattached` either way, never `201`. Reattach refreshes `hostname`, `platform`, `cliVersion`, `eligibleTypes`, `concurrency` and `capabilities`, and sets the node `online`.

- Without idempotence every container restart leaks a new row, and within a week the fleet page is a list of ghosts. That is why a node's name belongs in its config file rather than being generated at startup.
- **A fresh heartbeat warns but proceeds** (last-writer-wins, with a log line naming both hosts). The common cause is a container recreated before its last heartbeat aged out; refusing would turn a normal restart into a startup failure.
- **`disabled` survives re-registration**, so `docker restart` cannot undo an operator's kill switch. `draining` does not survive: a re-registered process holds nothing to drain.
- An empty `eligibleTypes` is legal ("I can run nothing yet"). `concurrency` is 1–64; `eligibleTypes` holds at most 100 entries.

### Heartbeat and status ownership

`POST /api/nodes/{id}/heartbeat` stamps `lastHeartbeatAt` and may refresh `concurrency` and `capabilities`. A runtime `appctl node set-concurrency` takes effect this way.

A node may report `online` or `offline` about itself. It can never report or clear `draining` or `disabled`; those are operator state. Liveness has exactly one writer: claim does not stamp `lastHeartbeatAt`.

`POST /api/nodes/{id}/deregister` marks the node `offline`. It does **not** requeue held jobs: nothing proves the work stopped. Held jobs return through the lease reaper, the same path a crashed node takes.

A node id belonging to another owner answers `403`, not `404`. Node ids are printed in logs and config files, and the realistic failure is a credential paired with the wrong id; `404` would send the operator to re-register and leak a duplicate row.

### Claim

`POST /api/nodes/{id}/claim` calls `JobClaimService.claim({ executor: 'node', nodeId, … })`, the same single `UPDATE … FOR UPDATE SKIP LOCKED … RETURNING` the in-process worker uses. Filters:

1. **Requested types are intersected with the row's `eligibleTypes`.** A node can only narrow, never widen.
2. **The limit is clamped to the node's `concurrency`, read live off the row.** A larger request is capped, not refused.
3. **Types the server does not offer to nodes are dropped with a warning.** The offer set is `NodeOffloadService.offeredTypes()` (`apps/api/src/jobs/node-offload.service.ts`): node-eligible types (`JobHandlerRegistry` derives eligibility from `nodeResultSchema` + `persistNodeResult`), minus any type whose `nodeSecretBroker` cannot issue here (`nodes.jobSecretBrokerEnabled` off, or the broker's `usable()` probe fails), minus any type whose handler's `nodeOffloadEnabled()` answers false. All run at claim time; none mutates the registry. Letting a node claim a type it cannot settle creates a loop of refused results, reaped leases and burned attempts.

`JobWorker`'s `system` mode claims the **complement** of the same offer set, so the fleet and the API server partition the queue by construction ([job-queue.md](job-queue.md), §2 Worker modes).

- A `disabled` node gets `403`: its answer will not change by polling.
- A `draining` node gets an empty list: it is in a normal state and must keep heartbeating and renewing while it finishes.

The claim response carries, per assignment, `{ job, params, renewIntervalMs, claimToken }`. `claimToken` sits beside the job DTO, not inside it (`dto/node-response.dto.ts`). `params` is a separate bag so a server-minted value is never mistaken for a column. The lease length is derived by `resolveJobLeaseMs` in `job.worker.ts`, the single derivation both executors read.

### Lease and claim token

`assertJobHeldByNode` guards every route that speaks for a held job: `renew`, `result`, `failure`, `download-url`, `upload-url` and `secret`. It requires:

1. `claimedByNodeId` is this node,
2. `status` is `running`,
3. the row has a lease,
4. the lease is unexpired,
5. when the caller quotes a `claimToken`, the row still carries exactly that token.

A failed check answers `409`. `409` means "the server's state moved on; drop the work". `400` would invite the node to fix and resend forever.

Conditions 1–4 stop a node whose machine slept, whose lease was reaped and whose job was re-claimed elsewhere from persisting a stale result over the newer run. Condition 5 covers the case where the "other executor" is the same node: two worker slots holding one job under one `claimedByNodeId`, where the older slot could renew, settle, get an upload URL for the newer slot's output key, or be handed a database credential under a lease that is not its own.

- The server hands out the token in the claim response; the node quotes it back on all six routes. `dto/claim-token.field.ts` is the shared field definition.
- **Optional on the wire.** A node on an older CLI sends no token, and the guard falls back to conditions 1–4. Rolling upgrades never break; such a node's own stale slot stays ambiguous until it upgrades. `renew` and `download-url` default an absent body to `{}`; all four body-bearing routes publish `required: false`.
- **Renewal re-asserts the conditions in its own `WHERE` clause**, so a renewal racing a reap cannot keep the reaper away from a run that is no longer this node's.
- **Settle is conditional on the claim too.** `JobTerminalService` writes only while the row still carries the claim (`heldClaimWhere`, see [job-queue.md](job-queue.md)). If the claim moves between the read guard and the write, the settle answers `claim-lost`, which `NodesService` maps to the same `409`, even after `persistNodeResult` has run.

Node-chosen lease lengths and retries are not accepted. `willRetry` on a failure report is accepted and ignored; the response reports what the server decided.

### Result and failure ingestion

`POST /api/nodes/{id}/jobs/{jobId}/result`, in this order:

1. `assertJobHeldByNode`.
2. `400` if the posted `type` differs from the job's. An id and a type agreeing is a statement; two ids agreeing is a coincidence.
3. `400` if the handler lacks the `nodeResultSchema`/`persistNodeResult` pair.
4. `handler.nodeResultSchema.parse(body.result)` → `400` with the Zod issues in `details`. A manual parse, because which schema applies is known only after the job row is read. Issues go in `details` because `http-exception.filter.ts` rebuilds error bodies from a fixed key allowlist.
5. `handler.persistNodeResult(job, parsed)`. On throw, route through `completeFailed` and answer `500`: once the server starts persisting, it owns the retry.
6. `completeSucceeded`.

`POST …/failure` passes `{ rateLimited, retryAfterMs }` to `completeFailed`, which treats them exactly like a thrown `RateLimitError`: it defers without charging an attempt and trips this server's own throttle gate.

The node plane never writes terminal rows itself. `JobClaimService` and `JobTerminalService` are the only claim and settle paths for both executors.

### Data plane

A node holds no storage credentials. Two routes, both `nodes:write` and both behind `assertJobHeldByNode`, mint what it needs:

| Route | Mints |
|---|---|
| `POST /api/nodes/{id}/jobs/{jobId}/download-url` | A short-lived signed **GET** for the job's input object |
| `POST /api/nodes/{id}/jobs/{jobId}/upload-url` | A short-lived signed **PUT** to a key the **server** chose, returned with the key |

The node talks to the storage provider directly; no object bytes enter the API process.

- **`POST`, not `GET`**, because they mint a credential. A `GET` URL is what proxies, CDNs and traces write down.
- **Expiry.** `storage.signedUrlExpiry` (from `SIGNED_URL_EXPIRY`, default 3600s) is honoured when stricter, clamped to 900s when not, with a 60s floor (`NODE_SIGNED_URL_MAX_TTL_SECONDS`, `NODE_SIGNED_URL_MIN_TTL_SECONDS`). A node needing longer asks again while it holds the lease. There is no node-only env var.
- **The URL is never logged** by any component. `test/nodes/node-data-plane.integration.spec.ts` asserts it across a real request.
- **Minted on demand, not in the claim response.** A node claiming its whole `concurrency` would otherwise age the last job's URL before that job starts.
- **Input resolution is internal.** The download resolves through `resolveStorageObjectInput` (`apps/api/src/storage/storage-job-input.ts`), not `ObjectsService.getDownloadUrl`, whose per-user ownership check would compare against the node's owner and wrongly `403` every cross-user job. What bounds a node is the lease: exactly the input of exactly the job it holds, for as long as it holds it. `NodesModule` imports `StorageProvidersModule`, not `StorageModule`, which keeps the wrong method out of reach.
- **Input failures are named.** `resolveStorageObjectInput` returns a `StorageObject` with a non-empty `storageKey` or throws one of three reasons, answered over HTTP as `422` with `details.reason` and `details.retryable: false`. The node should report the job failed.

  | `reason` | Meaning |
  |---|---|
  | `missing_subject_id` | The job names no subject |
  | `input_object_not_found` | The subject id names no row |
  | `input_object_has_no_storage_key` | The row exists but holds no key |

  It is a plain function taking the Prisma client, shared by the in-process handler (`JobsModule`) and the data plane (`NodesModule`), and it throws a transport-agnostic error.

#### Upload keys

- The default key is `node-outputs/{jobId}/{uuid}`: a validated path parameter plus a fresh `randomUUID()`. A node cannot overwrite anything, and output traces to its job without a lookup table.
- A handler may override it with `deriveOutputKey(job): Promise<string>` when the artifact's location is part of its contract. `db.backup.run` returns its run row's `buildBackupStorageKey(at, runId)` key. The derivation must be idempotent per job: a node asks for an upload URL more than once, and each call must return the same key. The backup does this with a unique `jobId` on its run row.
- A node-supplied `key` is refused with `400` naming the field, before any derivation runs.
- A derived key that fails `SAFE_STORAGE_KEY` is refused with `500` and no URL. Nothing the node sent reached that string.
- Minting creates no `storage_objects` row. Recording output is `persistNodeResult`'s job; the node reports the key back in its result.

`StorageProvider.getSignedPutUrl(key, options?)` provides the single-shot PUT (`PutObjectCommand` in the S3 provider). `test/nodes/node-checksum-data-plane.db.spec.ts` implements the whole provider interface locally, so adding a provider method without implementing it everywhere stops compilation.

### Per-job secrets

A job type whose remote executor needs a credential declares `nodeSecretBroker` on its handler (`apps/api/src/jobs/job-secret-broker.ts`). The node calls `POST /api/nodes/{id}/jobs/{jobId}/secret` while holding the lease:

- The credential is issued per job, bounded by the job's lease, returned once, held in the node's memory only, and revoked when the job settles.
- The server stores the credential's handle in `job_node_secrets`, never its material. A second request for the same job and broker extends the existing grant rather than minting another.
- `403` when `nodes.jobSecretBrokerEnabled` is off, `404` when the type declares no broker, `503` when the broker cannot mint right now.
- Three layers revoke a grant: the job-settle listener, the ten-minute `node-secret-sweep` cron (`apps/api/src/nodes/tasks/node-secret-sweep.task.ts`, a permanent queue exemption), and, for the PostgreSQL broker, `VALID UNTIL` enforced by the database.

The node's own `nod_` token is the one credential a node persists; it is an identity, not a job-scoped grant. The mechanism is designed in full against its first consumer in [database-backup.md](database-backup.md); operators audit issued roles with [node-job-secrets.md](../runbooks/node-job-secrets.md).

### Capability probing

The worst node failure is starting cleanly and then failing every job it claims, charging each an attempt. At startup the CLI probes what the machine can do (`apps/cli/src/node/capabilities.ts`) and compares it with what its eligible types need (`JOB_TYPE_REQUIREMENTS`):

- A missing **required** capability → hard exit (code `70`), naming the capability and the type.
- A missing **degradable** capability → warn and continue.

| Type | Required | Degradable |
|---|---|---|
| `db.backup.run` | `binary:pg_dump` | `binary:psql` |

The probe result is reported as `capabilities` on register and heartbeat and shown on the fleet page. A node also needs a network route to PostgreSQL for `db.backup.run`; `appctl node doctor --db-host` checks it as a warning. Heap tuning, the memory watchdog and the pre-OOM valve are operator concerns, described in [Running worker nodes](../runbooks/run-worker-nodes.md).

### Result contracts

`GET /api/nodes/job-types` lists every node-eligible type with its `nodeResultSchema` converted by `z.toJSONSchema()`, so a client validates against the schema this server enforces. The schemas live in `apps/api/src/jobs/contracts/`. `resultSchema` is `null`, never `{}`, when a schema has no JSON Schema form; `{}` would mean "anything is valid". The type is still listed because it is still claimable.

The route is a literal under `/nodes` and is declared before any `:id` route; otherwise `ParseUUIDPipe` answers `400 "Validation failed (uuid is expected)"`.

### Derived health

`deriveNodeHealth` (`apps/api/src/nodes/node-lifecycle.service.ts`):

| Health | When |
|---|---|
| `offline` | `status` is `offline` |
| `healthy` | Last heartbeat within `nodes.staleHeartbeatSeconds` |
| `stale` | Otherwise, including a node that has never heartbeated |

List and detail reads call it with the same policy, so they cannot disagree. Per-node job counts come from one `groupBy(['claimedByNodeId', 'status'])`, not a count per node, because the fleet page polls.

### Fleet sweep and prune

A crashed node never deregisters, so without a sweep its row stays `online` forever and retention (which selects `offline`) never reaches it. The two jobs are a pair with an order. Both crons only decide whether work is due and enqueue; the handlers in `apps/api/src/nodes/handlers/` do the work.

| Job type | Cron (task file) | Kill switch | What it does |
|---|---|---|---|
| `nodes.fleet.sweep` | Every 10 min (`tasks/node-stale-offline.task.ts`) | `NODE_STALE_OFFLINE_ENABLED` | Marks `online`/`draining` nodes `offline` when silent past the cutoff |
| `nodes.fleet.prune` | Daily at 03:00 (`tasks/node-offline-prune.task.ts`) | `NODE_OFFLINE_PRUNE_ENABLED` | Deletes `offline` nodes past `nodes.offlineRetentionDays` that hold no `running` job |

The kill switch is read before the enqueue, never inside the handler, so a job queued by one replica is not dropped by another with the switch off.

**Sweep.** One `updateManyAndReturn`:

```
UPDATE worker_nodes SET status = 'offline'
 WHERE status IN ('online', 'draining')
   AND (last_heartbeat_at < cutoff
        OR (last_heartbeat_at IS NULL AND registered_at < cutoff))
```

- `cutoff = now − staleHeartbeatSeconds × offlineStaleMultiplier` (defaults 90s × 4 = 6 min). "Offline" is always a whole number of stale windows after "stale", in the same units.
- The `registered_at` arm catches a node that registered and never heartbeated; `NULL < cutoff` is never true in SQL.
- `disabled` is never transitioned. `offline` is cleared by re-registration, so sweeping a disabled node would let a restart bring it back online and enabled.
- It raises `nodes.node_offline` once per node it actually flipped, to holders of `nodes:read` (see [browser-notifications.md](browser-notifications.md)). That is why it returns rows rather than a count.

**Prune.** Selects `offline` rows aged by `last_heartbeat_at`, or by `registered_at` when never heartbeated (mirroring the sweep's arms), excludes any node still holding a `running` job, then deletes. The `DELETE` re-asserts the full predicate, so a node that re-registered in between is left alone. The `running` exclusion is not about safety (`SetNull` makes deletion safe); it avoids manufacturing a `running` job owned by nobody. A skipped node is taken on a later day, after the reaper settles its job.

**Admin delete differs.** `DELETE /api/admin/nodes/{id}` removes a node even if it holds running jobs: an administrator has looked, and is usually freeing a dead node's stuck jobs. Jobs are neither deleted nor requeued by hand; `SetNull` clears the pointer and the reaper does the rest.

### Reference node-eligible types

| Type | Input | Output | Notes |
|---|---|---|---|
| `example.checksum` | `subjectType: 'storage_object'` + id, via download URL | `{ sha256, bytes }` merged into `StorageObject.metadata` | Pure compute, no native dependency. `process` and `persistNodeResult` share one private write so the stored result cannot depend on which executor ran it. |
| `db.backup.run` | None (`requiresInput = false`); a brokered read-only PostgreSQL role instead | Archive streamed to a single-shot signed PUT at the derived key; node reports size, digest and key | Offered only when `nodes.jobSecretBrokerEnabled`, `databaseBackup.nodeOffloadEnabled` and the broker's `usable()` all agree. The **server** reads the archive back before setting `verified_at`. A node-run backup has no heartbeat of its own; the backup's stale sweep asks the job's lease. |

## 3. Configuration and permissions

### Settings (`nodes` namespace)

| Key | Default | Meaning |
|---|---|---|
| `nodes.staleHeartbeatSeconds` | `90` | Heartbeat age at which a node stops counting as healthy (5–86400) |
| `nodes.offlineStaleMultiplier` | `4` | Stale windows before the sweep marks a node offline (1–100) |
| `nodes.offlineRetentionDays` | `30` | How long an offline node's row is kept (1–3650) |
| `nodes.jobSecretBrokerEnabled` | `false` | Whether any per-job credential may be brokered to a node |

`databaseBackup.nodeOffloadEnabled` (default `false`) additionally gates `db.backup.run`; see [database-backup.md](database-backup.md).

### Environment variables

- `NODE_STALE_OFFLINE_ENABLED` — whether this process enqueues the fleet sweep. Only `false` disables.
- `NODE_OFFLINE_PRUNE_ENABLED` — whether this process enqueues the prune. Only `false` disables. Useless without the sweep.
- `NODE_SECRET_SWEEP_ENABLED` — whether this process runs the per-job secret revocation cron. Only `false` disables.
- `SIGNED_URL_EXPIRY` — the application-wide signed URL lifetime; node URLs are clamped to 60–900s.

CLI-side settings (`APPCTL_*`, including `APPCTL_HEAP_LIMIT_MB`) are documented in [apps/cli/README.md](../../apps/cli/README.md#running-a-worker-node).

### Permissions

`nodes:read` for every read, `nodes:write` for every write. Claiming, renewing and minting a signed URL are writes. Both are seeded Admin-only. `nodes:*` is split from `jobs:*` because "what work is queued" and "which machines are attached" are different questions. The permission matrix lives in [ARCHITECTURE.md](../ARCHITECTURE.md).

### API surface

**`/api/nodes/*`** — reachable by a `nod_` credential, or a session/PAT holding `nodes:*`; scoped to the caller's own nodes.

| Route | Purpose | Permission |
|---|---|---|
| `POST /api/nodes/register` | Register or reattach on `(owner, name)`; `200` with `reattached` | `nodes:write` |
| `GET /api/nodes/job-types` | Node-eligible types with result JSON Schemas | `nodes:read` |
| `GET /api/nodes` | List the caller's nodes | `nodes:read` |
| `GET /api/nodes/{id}` | One node | `nodes:read` |
| `POST /api/nodes/{id}/deregister` | Mark offline; held jobs are not requeued | `nodes:write` |
| `POST /api/nodes/{id}/heartbeat` | Liveness, optional `status`/`concurrency`/`capabilities` | `nodes:write` |
| `POST /api/nodes/{id}/claim` | Claim up to `concurrency` jobs under a lease | `nodes:write` |
| `POST /api/nodes/{id}/jobs/{jobId}/renew` | Extend the lease | `nodes:write` |
| `POST /api/nodes/{id}/jobs/{jobId}/download-url` | Signed GET for the job's input | `nodes:write` |
| `POST /api/nodes/{id}/jobs/{jobId}/upload-url` | Signed PUT plus the server-chosen key | `nodes:write` |
| `POST /api/nodes/{id}/jobs/{jobId}/secret` | Issue the job's brokered credential | `nodes:write` |
| `POST /api/nodes/{id}/jobs/{jobId}/result` | Submit a validated result; settles the job | `nodes:write` |
| `POST /api/nodes/{id}/jobs/{jobId}/failure` | Report failure (`rateLimited` defers) | `nodes:write` |

**`/api/node-credentials`** — session or `pat_` only; a `nod_` token cannot reach it.

| Route | Purpose | Permission |
|---|---|---|
| `POST /api/node-credentials` | Mint a credential; raw token shown once | `nodes:write` |
| `GET /api/node-credentials` | List the caller's credentials, masked | `nodes:read` |
| `DELETE /api/node-credentials/{id}` | Revoke; effective on the node's next request | `nodes:write` |

The listing is `nodes:read`, not a bare `@Auth()` like the PAT listing: it is fleet inventory, and the Workers card is gated on `nodes:read`.

**`/api/admin/nodes/*`** — Admin role plus the permission; every owner. A different prefix, so it sits outside the `nod_` allowlist by construction.

| Route | Purpose | Permission |
|---|---|---|
| `GET /api/admin/nodes` | Every node, with owner email and derived health | `nodes:read` |
| `GET /api/admin/nodes/{id}` | One node | `nodes:read` |
| `DELETE /api/admin/nodes/{id}` | Delete the node; its jobs are unclaimed, not deleted | `nodes:write` |
| `GET /api/admin/nodes/credentials` | Every node credential, with owner | `nodes:read` |
| `DELETE /api/admin/nodes/credentials/{id}` | Revoke any credential | `nodes:write` |

The `credentials` literals are declared before `:id`; Nest matches in declaration order, and `:id` first would answer `400 "uuid is expected"`. The rule is "every literal above every parameterised route".

## 4. Extending it in a fork

Making a job type runnable on a node takes two halves:

1. **Server handler** — give it `nodeResultSchema` and `persistNodeResult` (both, never one), and put the schema in `apps/api/src/jobs/contracts/`. Route `process` and `persistNodeResult` through one write method, as `example-checksum.handler.ts` does. Full recipe: [apps/api/src/jobs/handlers/README.md](../../apps/api/src/jobs/handlers/README.md).
2. **CLI executor** — implement `JobExecutor` and register it in `defaultExecutors()`. `execute` returns the result and throws to fail. Recipe: [apps/cli/src/node/executors/README.md](../../apps/cli/src/node/executors/README.md).

Optional, only when the default is wrong:

- Declare native dependencies in `JOB_TYPE_REQUIREMENTS` (and `PROBED_BINARIES`) in `apps/cli/src/node/capabilities.ts`, with required and degradable tiers.
- `deriveOutputKey(job)` when the output location is part of the artifact's contract. It must be idempotent per job.
- `nodeSecretBroker` when the executor needs a credential no presigned URL can provide. It must mint per job, bounded by the lease, and store only a handle.
- `nodeOffloadEnabled()` when a deployment should be able to keep a structurally eligible type on the server.

Do not add a `nodeEligible` flag; eligibility is derived. Do not make an `ai.*` type node-eligible.

## 5. Guardrails

| Test | Enforces |
|---|---|
| `apps/api/src/auth/guards/jwt-auth.guard.spec.ts` | Allowlist, prefix-boundary paths, route check before `validateToken` (spy), untouched `pat_`/JWT branches |
| `apps/api/test/nodes/node-credential.integration.spec.ts` | `403` for a `nod_` token on `/api/users`, `/api/admin/jobs`, `/api/node-credentials` with an admin owner; RBAC; show-once; `lastUsedAt` stamped on allowed routes |
| `apps/api/src/nodes/node-credential.service.spec.ts` | Four rejection paths; `expiresAt: null` group |
| `apps/api/src/common/maintenance/maintenance.guard.spec.ts` | `OPAQUE_BEARER_PREFIXES` contains `NODE_TOKEN_PREFIX` |
| `apps/api/test/auth/pat-universality.integration.spec.ts` | A PAT stays universal (why nodes need their own family) |
| `apps/api/src/nodes/nodes.service.spec.ts` | Register-or-reattach incl. `P2002`; the three claim filters; lease guard's five conditions one at a time across `renew`/`result`/`failure` |
| `apps/api/test/nodes/nodes.integration.spec.ts` | `409` on late submission, Zod issues in `details`, `claimToken` round trip, `400` for a non-uuid token |
| `apps/api/test/nodes/node-claim-contention.db.spec.ts` | Real Postgres: a node and the in-process worker never claim the same row |
| `apps/api/src/nodes/node-data-plane.service.spec.ts` | Guard reached, server-derived key, expiry clamp both ways, three input reasons, stale `claimToken` refused on both URL routes |
| `apps/api/test/nodes/node-data-plane.integration.spec.ts` | `job-types` route order, valid JSON Schemas, `409`/`400`/`422`, no signed URL in logs |
| `apps/api/test/nodes/node-checksum-data-plane.db.spec.ts` | Real Postgres: `example.checksum` end to end through a local signing provider |
| `apps/api/src/jobs/handlers/example-checksum.handler.spec.ts` | Both executors leave the same row |
| `apps/api/src/storage/storage-job-input.spec.ts` | Three input failures, each naming the job |
| `apps/api/src/nodes/node-secret-broker.service.spec.ts`, `apps/api/test/nodes/node-job-secret.integration.spec.ts` | Secret route outcomes (`403`/`404`/`503`), lease-bounded grants |
| `apps/cli/src/node/executors/db-backup-run.test.ts` | The backup executor imports no config writer (secret never persisted) |
| `apps/cli/src/node/capabilities.test.ts` | Required vs. degradable capability outcomes |
| `apps/api/test/nodes/node-fleet-lifecycle.spec.ts` | Sweep then prune in sequence: crashed node, never-heartbeated node, `disabled` untouched, busy node deferred |
| `apps/api/test/nodes/node-fleet-lifecycle.db.spec.ts` | Real Postgres: `NULL < cutoff` is not true, `SetNull`, reaper requeues a deleted node's job |
| `apps/api/src/nodes/handlers/node-fleet-sweep.handler.spec.ts`, `node-fleet-prune.handler.spec.ts` | The statements each handler sends |
| `apps/api/src/nodes/tasks/node-stale-offline.task.spec.ts`, `node-offline-prune.task.spec.ts` | Kill switches; crons only enqueue |
| `apps/api/src/nodes/nodes-admin.service.spec.ts` | One `groupBy` (call count); list and detail agree on health |
| `apps/api/test/nodes/nodes-admin.integration.spec.ts` | `/credentials` resolves before `:id`; Admin-only RBAC on all five routes |

The prefix-boundary cases (`/api/nodesX`, `/api/nodes-other`, `/api/nodes/`) are direct guard invocations, because those paths `404` in the router whatever the guard decides.

## 6. Design decisions

- **A separate token family, not a PAT.** A PAT carries its owner's full authority on every route by documented design, and whoever mints node credentials is an Admin. A leaked worker token would equal a leaked admin session.
- **Rejected: a `scopes` column on PATs.** It makes the published "PAT works everywhere" guarantee conditional on data, forces a lookup before the route check (reintroducing the `lastUsedAt` oracle), and grows scope strings without bound. A prefix makes the restriction a fact about the token's type, checkable before any I/O.
- **The allowlist lives in the guard, not the service.** The guard has the request and runs before any handler; the service has more than one caller. A security rule in two places eventually disagrees with itself.
- **Rejected: a separate claim query for nodes.** It would start identical to `JobClaimService`'s and diverge on the first fix, then double-claim under contention while every mocked test passed.
- **Rejected: proxying bytes through the API.** The API's memory, event loop and egress would scale with fleet work, and long transfers would hold interactive connections open against every timeout in the stack.
- **Rejected: giving nodes storage credentials.** A bucket-wide, non-expiring capability in a config file. A signed URL is one object, one verb, minutes.
- **Rejected: letting the node choose the upload key.** A signed PUT overwrites exactly its key; a key from the body is a write primitive over the whole bucket.
- **Rejected: a one-part multipart upload instead of a signed PUT.** It needs the part ETag in every result contract, leaks billable in-progress uploads when a node dies, and makes the server hold per-job `uploadId` state.
- **Rejected: a `keyPrefix` string or claim-time keys.** A prefix cannot express `buildBackupStorageKey(at, runId)` or create the run row; claim-time keys age like claim-time URLs.
- **Rejected: a shared `packages/job-contracts` workspace.** Importing TypeScript source widens `apps/api`'s `rootDir` and breaks `node dist/main`; Jest would not transform it; CI would need a build step. `packages/shared/index.js` records the details. HTTP serves the schema the server actually enforces.
- **Rejected: an independent "offline after N minutes" setting.** Two unrelated notions of liveness that drift the first time the heartbeat interval changes.
- **Rejected: pruning without the sweep, or sweeping `disabled`, or pruning busy nodes.** Respectively: the prune never sees a crashed node; a restart undoes a kill switch; a `running` job owned by nobody.
- **Rejected: a stored health or job-count column.** Correct at write time, silently wrong afterwards.
- **Rejected: requeueing on deregister.** Nothing proves the work stopped; the lease reaper is the one tested path.
- **Rejected: a domain-specific reference type** (thumbnails, transcodes). Each forces a native dependency on every fork. SHA-256 over a stored object needs only `node:crypto` and exercises the full data plane.

## 7. Verification

```bash
cd apps/api && npm test -- nodes
cd apps/api && npm run test:db -- nodes      # real-Postgres suites
cd apps/cli && npx vitest run src/node
npm run openapi:dump && npm run openapi:lint  # root scripts
```

End to end, following [Running worker nodes](../runbooks/run-worker-nodes.md):

1. `appctl node enroll`, then `appctl node register`, then `appctl node doctor`.
2. `appctl node start`. The node appears at `/admin/settings/workers` as healthy.
3. Upload a file and enqueue `example.checksum` against it. The job moves to `running` claimed by the node, then `succeeded`; the object's metadata gains `sha256` and `bytes`.
4. Stop the node without deregistering. After roughly `staleHeartbeatSeconds` it shows `stale`; after the next sweep past `staleHeartbeatSeconds × offlineStaleMultiplier` it shows `offline`.
5. Call any non-node route (for example `GET /api/users`) with the `nod_` token: `403`.

## History

- Epic #254: worker node fleet. #255 deferred the node schema relations.
- #267: `nod_` credentials and the guard allowlist.
- #268: control plane (register, heartbeat, claim, renew, result, failure).
- #269: presigned data plane, `example.checksum`, result contracts over HTTP.
- #270: fleet sweep and prune; #276: CLI capability probe; #274: CLI executors.
- Epic #345: #348 `deriveOutputKey`; #349 per-job secret broker; #351/#352 `db.backup.run` on nodes; #353 fleet crons converted to queue jobs.
- #364: claim token on the node control plane. #477: claim-conditional settle writes.
