# Architecture

Last reviewed: 2026-09

## Contents

1. [Purpose and audience](#1-purpose-and-audience)
2. [System overview](#2-system-overview)
3. [Architecture principles](#3-architecture-principles)
4. [Technology stack](#4-technology-stack)
5. [Subsystem map](#5-subsystem-map)
6. [Data architecture](#6-data-architecture)
7. [Authorization](#7-authorization)
8. [Background work](#8-background-work)
9. [Frontend architecture](#9-frontend-architecture)
10. [Infrastructure](#10-infrastructure)
11. [Observability](#11-observability)
12. [Extension points](#12-extension-points)
13. [Related documents](#13-related-documents)

---

## 1. Purpose and audience

This repository is a template. You fork it to start a new enterprise web application on a production-grade foundation instead of an empty folder.

It establishes sign-in (Google OAuth, JWT, an email allowlist), role-based authorization, a registry-driven settings framework, object storage, a PostgreSQL-backed job queue with optional remote worker nodes, notifications, database backup and restore, an admin-governed AI platform, a first-party CLI, and OpenTelemetry observability backed by GreptimeDB.

This document is the map of how those pieces fit together today. It is written for a team (people and coding agents) that has just forked the template. Design rationale lives in `docs/specs/`; operator procedures live in `docs/runbooks/`. Each subsystem below links to both.

---

## 2. System overview

### 2.1 Components

```
   Browser (React SPA)       evopathcli CLI              Worker nodes (evopathcli node)
          │                      │                       │               │
          │ session JWT          │ pat_ token            │ nod_ token    │ presigned
          │                      │                       │ /api/nodes/*  │ GET / PUT
          ▼                      ▼                       ▼               │
   ┌──────────────────────────────────────────────────────────┐         │
   │ nginx :3535   security headers, same-origin routing       │         │
   │   /          → web                                        │         │
   │   /api       → api   (SSE routes unbuffered)              │         │
   │   /api/docs  → api   (Scalar API reference)               │         │
   └────────┬──────────────────────────────┬──────────────────┘         │
            │                              │                            │
   ┌────────▼─────────┐       ┌────────────▼─────────────────────┐      │
   │ web              │       │ api   NestJS + Fastify  :3000     │      │
   │ React 19 + MUI   │       │ controllers → services → Prisma   │      │
   │ (Vite build)     │       │ in-process job worker pool        │      │
   └──────────────────┘       └──┬────────┬────────┬────────┬────┘      │
                                 │        │        │        │           │
                                 ▼        │        ▼        ▼           │
                          PostgreSQL 16   │   AI providers  SMTP / SES, │
                          (data, job      │   (server-side  Web Push    │
                           queue, JSONB   │    calls only)              │
                           settings)      ▼                             │
                                   Object storage  ◄────────────────────┘
                                   (AWS S3, Cloudflare R2, S3-compatible)

   api ── OTLP ──► otel-collector ──► GreptimeDB :4000/:4003  (telemetry.compose.yml)
```

- The browser, the CLI and worker nodes all reach the API through nginx on one origin.
- The API is the only component that talks to AI providers, email and Web Push, and the only one with long-lived database access.
- Worker nodes hold no durable database or storage credential. They claim jobs over `/api/nodes/*` and move bytes directly against object storage through short-lived presigned URLs the API mints per job. A job that needs a database connection (the backup) receives a short-lived, job-scoped credential instead.
- Telemetry leaves the API over OTLP to an OpenTelemetry Collector, which redacts credential-bearing headers and exports to GreptimeDB (`telemetry.compose.yml`); the API reads it back over the PostgreSQL wire protocol for the telemetry explorer and AI assistant. The collector also scrapes the application's PostgreSQL itself (`postgresql` receiver, `POSTGRES_MONITOR_USER`), so database metrics land in the same store; it probes uptime and TLS expiry (`httpcheck`) and reads nginx's internal-only `stub_status` (`nginx`). See [specs/telemetry.md](specs/telemetry.md).

### 2.2 Request lifecycle

Every API request passes through the same stages, in this order:

| # | Stage | Where | What it does |
|---|---|---|---|
| 1 | nginx | `infra/nginx/nginx.conf` | Adds security headers, routes `/api` to the API. `/api/notifications/stream`, `/api/ai/responses/stream` and `/api/ai/training/stream` are unbuffered for SSE. |
| 2 | Request ID | `apps/api/src/common/middleware/request-id.middleware.ts` | Assigns a request ID and captures trace context for log correlation. |
| 3 | Maintenance gate | `apps/api/src/common/maintenance/maintenance.guard.ts` | The application's only global guard (`APP_GUARD`). Answers `503` while a maintenance window is open, except on routes marked `@AllowDuringMaintenance()`. |
| 4 | Feature gate | `apps/api/src/ai/…` (`AiEnabledGuard`) | Controller-level, on `/api/ai/*` consumer controllers only. Answers `403 AI_DISABLED` while AI is switched off. |
| 5 | Authentication | `apps/api/src/auth/guards/jwt-auth.guard.ts` | Applied by `@Auth()`. Accepts a session JWT, a `pat_` personal access token, or a `nod_` node credential (confined to `/api/nodes/*`). Rejects deactivated users. Skipped on routes marked `@Public()`. |
| 6 | Roles | `apps/api/src/auth/guards/roles.guard.ts` | Applied by `@Auth({ roles })`. The caller needs any one listed role. |
| 7 | Permissions | `apps/api/src/auth/guards/permissions.guard.ts` | Applied by `@Auth({ permissions })`. The caller needs all listed permissions. |
| 8 | Interceptors and validation | `LoggingInterceptor`, `TransformInterceptor`, `ZodValidationPipe` | Logs the request, validates input against Zod schemas, wraps success bodies in `{ data, meta }`. |
| 9 | Controller → service → Prisma | `apps/api/src/<module>/` | Controllers stay thin; services hold business logic and ownership checks; Prisma is the only data access path. |
| 10 | Exception filter | `HttpExceptionFilter` | Formats every error into the standard error envelope. |

`@Auth()` (`apps/api/src/auth/decorators/auth.decorator.ts`) also stamps the enforced roles and permissions onto the OpenAPI operation, so the "Requires" line in the API reference is generated from the same metadata the guards read. Response envelopes, pagination and error codes are described in [API.md](API.md).

---

## 3. Architecture principles

**Separation of concerns.** The web app renders and collects input; the API owns every business rule and every authorization decision. A permission check in the UI only decides what to show. The API enforces it again. See [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md).

**Same-origin hosting.** nginx serves the UI at `/`, the API at `/api` and the API reference at `/api/docs`. There is no CORS configuration to maintain, and the refresh-token cookie is first-party.

**API-first.** Every capability exists as an HTTP endpoint before it has a UI. The OpenAPI document is generated from the code (`npm run openapi:dump`), linted by Spectral in CI, and served by Scalar at `/api/docs`. It is the per-endpoint reference. See [API.md](API.md).

**Security by default.** Controllers apply `@Auth()` with the exact permission they need; public routes are marked `@Public()` explicitly. Secrets never reach the browser, and runtime-configured secrets are encrypted at rest. See [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md).

**Every long-running activity is a queue job.** Work that outlives the request or cron tick that started it is a registered `JobHandler`, enqueued through `JobsService`. A `@Cron` only decides whether work is due and enqueues it. Three recovery crons are the permanent exceptions (see [§8.3](#83-permanent-cron-exemptions)). See [specs/job-queue.md](specs/job-queue.md).

**Settings surfaces are registry-driven.** Every settings page is a card in one of two registries, rendered by one shared `SettingsHub` component. A route without a registry entry is not a settings page. See [specs/settings-ui.md](specs/settings-ui.md).

**Runtime configuration over environment variables.** Object storage, AI providers and keys, Web Push (VAPID) keys and SMTP are configured by an administrator in the UI, live, with no restart. They have no environment variables, and adding one would create a second source of truth. See [specs/storage-providers.md](specs/storage-providers.md) and [specs/ai-platform.md](specs/ai-platform.md).

**Presence is the declaration.** Optional capabilities are declared by implementing a member, never by a boolean flag. A job handler is node-eligible because it has both `nodeResultSchema` and `persistNodeResult`. An AI provider supports images because its adapter has an `images` port. A flag could disagree with the code; a member cannot. See [specs/job-queue.md](specs/job-queue.md) and [specs/ai-platform.md](specs/ai-platform.md).

---

## 4. Technology stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 24 (`.nvmrc`, `engines`), npm workspaces `apps/*` and `packages/*` |
| API | NestJS 11 on the Fastify adapter, TypeScript |
| Validation | Zod via `nestjs-zod` (not class-validator) |
| Database | PostgreSQL 16, Prisma 7 with `@prisma/adapter-pg` |
| Authentication | Passport Google OAuth 2.0, JWT access tokens, rotating refresh-token cookie |
| Web | React 19, Material UI, react-router 7, Vite |
| CLI | TypeScript, Commander (subcommands), ink (interactive menu) |
| Agent orchestration | LangGraph.js (`@langchain/langgraph`, `@langchain/core`), exact-pinned, imported only under `apps/api/src/training-agents/`; model calls stay on `AiService` |
| Observability | OpenTelemetry SDK, Pino structured logs, GreptimeDB |
| API reference | OpenAPI generated from code, Scalar UI at `/api/docs`, Spectral lint |
| Testing | Jest + Supertest (API), Vitest + React Testing Library (web and CLI), Playwright (e2e) |
| Containers | Docker, Docker Compose (`infra/compose/`) |
| Reverse proxy | nginx, same-origin routing |

---

## 5. Subsystem map

Each subsection describes one subsystem the template ships: what it does, where the code lives, how it is reached, and where to read more. Permissions refer to the matrix in [§7](#7-authorization).

### 5.1 Authentication: Google OAuth, JWT and the email allowlist

Users sign in with Google through Passport (`GET /api/auth/google`). On the callback the API checks the email against the allowlist, provisions or updates the user, issues a short-lived JWT access token (15 minutes by default) and sets a refresh token in an HttpOnly cookie. The browser receives the access token at `/auth/callback?token=…` and keeps it in memory. `POST /api/auth/refresh` rotates the refresh token on every use; the server stores only its hash.

Access is restricted to allowlisted emails. `INITIAL_ADMIN_EMAIL` bypasses the check, is seeded onto the allowlist and becomes Admin on first sign-in. Every other new user gets the Viewer role. An allowlist entry is `pending` until its owner signs in, then `claimed`; claimed entries cannot be removed. Revoke access by deactivating the user instead.

- **Code:** `apps/api/src/auth/`, `apps/api/src/allowlist/`, `apps/api/src/users/`
- **UI:** `/admin/settings/users` (Users and Allowlist tabs)
- **Permissions:** `users:read`, `users:write`, `rbac:manage`, `allowlist:read`, `allowlist:write`
- **Read more:** [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md)

### 5.2 Role-based access control

Three roles (Admin, Contributor, Viewer) grant 37 permissions named `resource:action`. Roles and permissions are rows (`roles`, `permissions`, `role_permissions`, `user_roles`), seeded from `apps/api/prisma/seed-data.ts`. A controller names the exact permission it needs in `@Auth({ permissions: [...] })`; the web app reads the same strings to decide which cards, routes and controls to show.

- **Code:** `apps/api/src/auth/guards/`, `apps/api/src/common/constants/roles.constants.ts`, `apps/api/prisma/seed-data.ts`
- **Matrix:** [§7](#7-authorization)
- **Read more:** [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md)

### 5.3 Device authorization (RFC 8628)

A device without a browser (the CLI, a script, a kiosk) calls `POST /api/auth/device/code`, shows the user a code and the verification URL `/activate`, and polls `POST /api/auth/device/token`. The user approves the request on `/activate` while signed in. The device can ask for a personal access token instead of a session (`clientInfo.tokenType: "pat"`); this is how `evopathcli login` gets a long-lived token.

- **Code:** `apps/api/src/device-auth/`
- **UI:** `/activate`
- **Permissions:** any signed-in user approves their own devices
- **Read more:** [DEVICE-AUTH.md](DEVICE-AUTH.md), [device-auth README](../apps/api/src/device-auth/README.md)

### 5.4 Personal access tokens

A personal access token (`pat_…`) is a long-lived bearer token that acts with its owner's full authority on every authenticated route. The server stores only a hash and a display prefix; the raw token is shown once. Tokens expire, and revocation is immediate.

- **Code:** `apps/api/src/pat/`
- **UI:** `/settings/tokens` ("Access Tokens")
- **Permissions:** any signed-in user manages their own tokens
- **Read more:** [personal-access-tokens.md](personal-access-tokens.md)

### 5.5 Settings framework

Settings are stored as JSONB and validated by Zod schemas in `apps/api/src/common/schemas/settings.schema.ts`. System settings are rows in `system_settings`; per-user settings are one row per user in `user_settings` (see [§6.2](#62-settings-storage)). Writes are versioned; admin configuration endpoints use an `If-Match` version check.

In the web app, every settings page is a card in a registry: `ADMIN_SECTIONS` (`/admin/settings`) or `USER_SETTINGS_SECTIONS` (`/settings`). The shared `SettingsHub` component, the Console navigation rail and the AppBar title resolver all read those registries, so they never disagree about which pages exist. A card's `permission` is the exact string the API controller enforces; a card's `feature` hides it while a platform feature (today only AI) is off. Tabs are reserved for parallel content inside one page.

- **Code:** `apps/api/src/settings/`, `apps/web/src/config/adminSections.tsx`, `apps/web/src/config/userSettingsSections.tsx`, `apps/web/src/components/settings/SettingsHub.tsx`
- **UI:** `/settings`, `/admin/settings` (inventory in [§9.2](#92-settings-pages))
- **Permissions:** `system_settings:read/write`, `user_settings:read/write`
- **Read more:** [specs/settings-ui.md](specs/settings-ui.md)

### 5.6 Object storage

Files live in an S3-compatible object store: AWS S3, Cloudflare R2, or any S3-compatible endpoint. Which one is resolved at runtime, per call, from the `storage` system-settings namespace plus an encrypted secret access key. Every consumer injects the `STORAGE_PROVIDER` token, bound to a resolving provider that delegates to an S3 client built for the configuration in force. An unconfigured deployment answers storage calls with `503`.

Uploads come in two shapes. A simple upload (`POST /api/storage/objects`, up to 100 MB) streams through the API. A resumable upload initializes a multipart upload, lets the client send parts directly to the bucket through presigned URLs, then completes it. A completed upload checks, in the same transaction, whether any registered processor applies: if none does the object is marked `ready` immediately; otherwise the object is marked `processing` and the `storage.object.process` job runs the applicable processors (for example, metadata extraction) and stores their results on the object. Profile pictures and AI outputs are storage objects too. Abandoned uploads are swept by the `storage.cleanup.stale-uploads` job.

- **Code:** `apps/api/src/storage/` (`objects/`, `config/`, `providers/`, `processing/`)
- **UI:** `/admin/settings/storage`
- **Permissions:** `storage_config:read/write` for configuration; object routes see [§7](#7-authorization)
- **Read more:** [specs/storage-providers.md](specs/storage-providers.md), [runbooks/storage-configuration.md](runbooks/storage-configuration.md)

### 5.7 Background job queue

The `jobs` table is the queue. There is no Redis or message broker. Executors claim runnable rows with one atomic `FOR UPDATE SKIP LOCKED` statement, so any number of claimants (in-process worker slots, API replicas, remote nodes) can run without coordinating with each other. Attempts are charged at claim time. Each claim carries a lease and a per-claim token; the executor renews the lease while it works, and every settle write is conditional on still holding that claim. A lease reaper requeues or fails rows whose executor died.

A job type is one `JobHandler` class that self-registers from `onModuleInit()`. `Job.type` is a plain string, so a new type needs no migration. Enqueueing the same type and subject twice is deduplicated while the first job is active. Failures retry with exponential backoff; provider rate limits defer the job on a separate budget. `job_stats_rollup` keeps lifetime counts and durations after the history purge removes old rows. The job inventory is in [§8](#8-background-work).

- **Code:** `apps/api/src/jobs/`
- **UI:** `/admin/settings/jobs`, `/admin/settings/jobs/insights`
- **Permissions:** `jobs:read`, `jobs:write`
- **Read more:** [specs/job-queue.md](specs/job-queue.md), [handlers README](../apps/api/src/jobs/handlers/README.md)

### 5.8 Worker nodes

A worker node is an `evopathcli node` process on another machine that executes node-eligible job types. It authenticates with a `nod_` credential that can reach only `/api/nodes/*`, registers, heartbeats, claims jobs under a lease, and posts a validated result back for the server to persist. Input and output bytes move directly between the node and object storage through presigned URLs. A job that needs a database connection (the backup) gets a short-lived, job-scoped credential from a secret broker; the server records the credential's handle, never its material.

Whether a structurally eligible type is actually offered to nodes is a runtime decision made at claim time (a deployment-wide broker switch, the feature's own setting, and the broker's capability probe). `JOBS_WORKER_MODE=system` claims exactly the complement, so the API and the fleet partition the queue. Health is derived from `lastHeartbeatAt`; `nodes.fleet.sweep` marks silent nodes offline and `nodes.fleet.prune` forgets old ones.

- **Code:** `apps/api/src/nodes/`, `apps/cli/src/node/`, `infra/compose/worker.compose.yml`
- **UI:** `/admin/settings/workers`
- **Permissions:** `nodes:read`, `nodes:write`
- **Read more:** [specs/worker-nodes.md](specs/worker-nodes.md), [runbooks/run-worker-nodes.md](runbooks/run-worker-nodes.md), [runbooks/node-job-secrets.md](runbooks/node-job-secrets.md)

### 5.9 `evopathcli` CLI

`apps/cli` is the first-party command-line client, built from this monorepo. It has five command groups:

| Command | Purpose |
|---|---|
| `init` | Creates `infra/compose/.env` for a new checkout (run by `npm run setup`) |
| `login`, `config` | Device-flow sign-in that stores a personal access token; CLI configuration |
| `api <method> <path>` | Generic authenticated call to any endpoint, so the CLI never goes stale |
| `deploy doctor\|install\|update\|status\|list\|about\|certs\|uninstall` | Installs and updates the application on a VPS behind a shared host proxy |
| `node config\|enroll\|register\|start\|stop\|status\|logs\|set-concurrency\|doctor\|install-deps\|service\|heap-snapshot` | Runs and manages a worker node |

In a real terminal with no arguments it opens an interactive ink menu. `evopathcli deploy` writes a state document the API reads for the About page ([§5.15](#515-about-and-deployment-info)).

- **Code:** `apps/cli/src/` (`commands/`, `deploy/`, `node/`, `tui/`)
- **Read more:** [apps/cli/README.md](../apps/cli/README.md), [specs/vps-deploy.md](specs/vps-deploy.md), [runbooks/deploy-to-vps.md](runbooks/deploy-to-vps.md)

### 5.10 AI platform

The AI platform is an admin-governed, bring-your-own-key capability over five providers: `openai`, `anthropic`, `gemini`, `azure-openai` and `openai-compatible`. It offers responses (plain, streaming, structured output, function-calling tool loops), embeddings, image generation and editing, transcription, text-to-speech and realtime voice sessions, plus background runs and usage reporting.

A feature uses AI by injecting `AiService` and calling `forUser(userId)`. That client runs one gate pipeline for every call: kill switch, provider and model enablement, capability match, key resolution (the user's own key, or the org key under `byok_with_org_fallback` or for a holder of `ai_config:write`), rate limits and output caps. It records one `ai_usage_events` row per provider round trip. Provider SDKs are imported only inside `apps/api/src/ai/providers/<provider>/`. Every provider call happens on the server; the only credential an AI route ever returns is a realtime session's ephemeral secret. Media and background runs are server-only queue jobs, never node-eligible. The web app includes an admin-only AI Playground at `/ai`.

`TrainingAgentsModule` (`apps/api/src/training-agents/`) sits above the gateway: it runs agent graphs with LangGraph.js through `LangGraphRunner`, checkpointing to two Prisma-owned tables, and never calls a provider itself. Framework telemetry is forced off in code. Per-role model choice (researcher, planner, critic, evaluator) is resolved by `TrainingModelResolver` (`training-agents/models/`) from the user's `ai.taskModels` and the read-only `UsableModelsService`; `GET /api/ai/training/models` and `POST /api/ai/training/estimate` (`ai:use`, behind `AiEnabledGuard`) return the resolution and a token estimate, never a quote.

The runtime kit (`training-agents/runtime/`, `graph/`, `nodes/`) executes one graph run as one server-only job:

- **Runs.** `POST /api/ai/training/runs` freezes the per-role models and the token cap on a `training_plan_runs` row and enqueues `ai.training.plan.run` in the same transaction. The raw-SQL partial unique index `training_plan_runs_active_per_user_uniq_idx` allows one active run per user; a second start answers `409 TRAINING_RUN_ACTIVE` with the existing run's id.
- **One path to the model.** `AgentCaller` is the only route from a graph node to `AiService` (`structured`, `respond` for free text, `withTools`); a node never holds a provider client or a key. `RunBudget` enforces the per-run token cap across all calls (`TRAINING_RUN_BUDGET_EXCEEDED`), and `ContextBudget` trims prompt sections in a fixed order.
- **Researcher.** The `research` node (`nodes/research.node.ts`, agent in `agents/researcher/`) searches with the OpenAI hosted `web_search` tool only in v1, called through `AgentCaller` like every other call. Its context is minimised (`researcher-context.ts`): demographics are included only when the user opts in to tailored research. It produces an evidence brief whose citations the server verifies (guardrail G8, `guardrails/citations.ts`): a source counts only if the run's search actually returned its URL, unverified sources and claims left without a source are dropped, and the drops are counted. It emits `research.query`, `research.source` and `research.brief` run events, which carry no prompt text. Failures are `TRAINING_RESEARCH_INSUFFICIENT` (too few verified claims or sources after one retry) and `TRAINING_RESEARCH_CONTEXT_MISSING` (no usable context).
- **Persisted events with replay.** Every lifecycle and usage event is a `training_run_events` row with a gapless per-run `seq` and carries no prompt text or key. `GET /api/ai/training/stream/:runId?after=<seq>` replays the events after `seq`, then tails by polling, so any API replica can serve it; a client disconnect does not cancel the run.
- **Checkpoints and resume.** `PrismaCheckpointSaver` writes node outputs after each node. Resume never re-runs a finished node: `POST .../resume` (from `interrupted`) and `POST .../decision` (from `awaiting_approval`) queue a new job for the same run. A lost job interrupts the run and is resumed automatically a bounded number of times.
- **Cancel and retention.** `POST .../cancel` stops a running run within one poll interval. The daily `training.runs.purge` job deletes finished runs' events and checkpoints past retention.

- **Code:** `apps/api/src/ai/` (`core/`, `providers/`, `runtime/`, `catalog/`, `keys/`, `usage/`, `config/`, `http/`)
- **UI:** admin `/admin/settings/ai`, `/admin/settings/ai/models`, `/admin/settings/ai/usage`; user `/settings/ai`, `/settings/ai/agents`; admin-only Playground `/ai`
- **Permissions:** `ai_config:read/write` (admin), `ai:use` (consumer)
- **Read more:** [specs/ai-platform.md](specs/ai-platform.md), [AI module README](../apps/api/src/ai/README.md), [runbooks/ai-configuration.md](runbooks/ai-configuration.md)

### 5.11 Notifications, email and Web Push

Every notification is an event declared once in `NOTIFICATION_EVENTS` with its channels and default. A caller raises it with `notify(eventKey, userId, payload)`. The dispatcher narrows the declared channels by admin policy (`system_settings.notifications`), then by the user's preferences, and delivers each channel through its sender. Every attempt is a `notification_deliveries` row. Mandatory events (such as a role change) ignore user preferences.

The channels are email (SMTP or SES, configured at `/admin/settings/email`), in-app (a `notifications` inbox row pushed to open tabs over an SSE stream), and Web Push (VAPID keys generated and rotated at `/admin/settings/push`). The web app ships a service worker that handles push and notification clicks.

- **Code:** `apps/api/src/notifications/`, `apps/api/src/email/`
- **UI:** `/admin/settings/notifications`, `/admin/settings/push`, `/admin/settings/email`; user `/settings/notifications`
- **Permissions:** `system_settings:read/write` (email, policy), `push:read/write` (VAPID keys)
- **Read more:** [notifications README](../apps/api/src/notifications/README.md), [specs/browser-notifications.md](specs/browser-notifications.md), [runbooks/vapid-keys.md](runbooks/vapid-keys.md)

### 5.12 Admin broadcasts

An administrator composes a message for every active user, sends it now or schedules it, and chooses channels (email, in-app, push). The `admin.broadcast.start` job freezes the audience at a cutoff and enqueues the first `admin.broadcast.chunk`; each chunk delivers one page of recipients, commits its cursor and enqueues its successor. A failed broadcast can be resumed from its committed cursor. Critical broadcasts use a mandatory event key that users cannot mute.

- **Code:** `apps/api/src/notifications/broadcasts/`
- **UI:** `/admin/settings/broadcasts`
- **Permissions:** `broadcasts:read`, `broadcasts:write`
- **Read more:** [specs/notification-broadcasts.md](specs/notification-broadcasts.md)

### 5.13 Database backup and restore

A backup is the `db.backup.run` job: `pg_dump` streams straight into object storage (never buffered), and the server reads the archive back to verify it. Backups run on a schedule (`databaseBackup` settings) or on demand. Each attempt is a `database_backup_runs` row with its own heartbeat and stale window; a partial unique index allows at most one active run. With the offload switches on, a worker node can take the dump using a brokered, SELECT-only PostgreSQL role.

A restore (`db.restore.run`) replaces the live database from a chosen backup, opening a maintenance window around the rename. A rollback undoes it; the displaced database is retained for `databaseBackup.oldDatabaseRetentionHours`, then dropped by `db.restore.old-db-drop`. Restore is a separate permission from backup. When the database role lacks a needed privilege (common on managed PostgreSQL), the API answers `guided` with paste-ready SQL instead of an error.

- **Code:** `apps/api/src/db-backup/`
- **UI:** `/admin/settings/db-backup`
- **Permissions:** `db_backup:read`, `db_backup:write`, `db_backup:restore`
- **Read more:** [specs/database-backup.md](specs/database-backup.md), [specs/database-restore.md](specs/database-restore.md), [runbooks/database-restore.md](runbooks/database-restore.md), [runbooks/postgres-client-version.md](runbooks/postgres-client-version.md), [runbooks/node-job-secrets.md](runbooks/node-job-secrets.md)

### 5.14 Maintenance mode

A maintenance window takes the application out of service on purpose. While open, every API route answers `503` with an operator message and `Retry-After`, except sign-in, health, token refresh, device activation and the maintenance endpoints themselves. The state resolves from three layers: the `MAINTENANCE_MODE` environment variable (break-glass, both directions), an in-memory override (used by the restore swap), and the persisted `maintenance` setting. The web app shows a maintenance screen and banner.

- **Code:** `apps/api/src/common/maintenance/`, `apps/web/src/components/common/MaintenanceGate.tsx`
- **UI:** `/admin/settings/maintenance`
- **Permissions:** `system_settings:read/write`
- **Read more:** [specs/maintenance-mode.md](specs/maintenance-mode.md), [runbooks/maintenance-mode.md](runbooks/maintenance-mode.md)

### 5.15 About and deployment info

`GET /api/admin/about` reports what is deployed: the API version, the fields of the state document `evopathcli deploy` writes (commit, ref, domain, proxy runtime, host facts, deploy history), a live runtime block and database liveness. It always answers `200`; a missing or malformed deploy document is reported as a field, not an error.

- **Code:** `apps/api/src/about/`
- **UI:** `/admin/settings/about` (`/admin/settings/deployment` redirects here)
- **Permissions:** `system_settings:read`
- **Read more:** [runbooks/deployment-info.md](runbooks/deployment-info.md), [specs/vps-deploy.md](specs/vps-deploy.md)

### 5.16 Encrypted credentials

Secrets configured at runtime are encrypted with AES-256-GCM under `SECRETS_ENCRYPTION_KEY` before they are stored. `CredentialsService` holds deployment-owned secrets in `credentials`, addressed by `(purpose, name)`: the SMTP password, the VAPID private key, the storage secret access key and the AI org keys. `UserCredentialsService` holds user-owned secrets in `user_credentials` under an owner-bound cipher domain, so a row moved to another user fails authentication instead of decrypting. Users' AI provider keys live in their own table, `user_ai_keys`, under a dedicated cipher purpose. No API ever returns secret material; admin screens show a masked status.

- **Code:** `apps/api/src/credentials/`, `apps/api/src/user-credentials/`, `apps/api/src/common/crypto/secret-cipher.ts`
- **Read more:** [specs/user-credentials.md](specs/user-credentials.md), [runbooks/rotate-secrets-encryption-key.md](runbooks/rotate-secrets-encryption-key.md), [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md)

### 5.17 Observability

The API is instrumented with OpenTelemetry for traces, metrics and logs, and logs structurally with Pino. The optional telemetry stack (OTel Collector + GreptimeDB) runs from `telemetry.compose.yml`, with a SQL explorer and an AI assistant over the collected data. On a VPS deployment the stack ships by default and an administrator can (re)deploy the GreptimeDB/collector containers from `/admin/settings/telemetry`, through `stack-agent` — the sidecar that holds the Docker socket so the API never has to. See [§11](#11-observability) and [specs/telemetry.md](specs/telemetry.md).

### 5.18 Template tooling

`scripts/rename.mjs` rebrands a fork (application name, repository slug, brand colours) from `packages/shared/identity.json`. `scripts/new-project.mjs` resets the release state a fork inherits. The `/new-project` and `/rename-app` skills in `.claude/skills/` drive both for a coding agent.

- **Read more:** [RENAMING.md](RENAMING.md)

### 5.19 Testing

The API uses Jest and Supertest for mocked integration tests (`*.integration.spec.ts`) and real-PostgreSQL tests (`*.db.spec.ts`, `npm run test:db`). The web app and CLI use Vitest. Playwright end-to-end tests live in `tests/e2e`; pixel-baseline visual tests live in `tests/visual`, with their harness in `apps/web/visual`. See [TESTING.md](TESTING.md).

### 5.20 Health data

Per-user health facts live in their own tables with their own permission family `health_data:read/write` (held by all three roles, withholdable per role). `health_profiles` holds one row per user: date of birth, sex at birth, height, unit system, time zone and a short bio. It is served by `GET/PUT /api/health-profile`, always for the signed-in user, and edited at `/settings/health-profile`. `measurements` is one longitudinal table of values in canonical units, described by an in-code metric registry and served by `/api/measurements`; an edit supersedes rows instead of overwriting them. The daily readiness check-in (four optional 1 to 5 scores and a note per local day) is stored as `measurements` rows too and served by `/api/check-ins`, with "today" decided by the server in the profile time zone. A reading can also come from a photo: the `body_metric_reading` intake kind (`apps/api/src/measurements/photo/`, see [5.21](#521-photo-intake)) has the server-only job `ai.health.body_metric_reading` draft values from a scale or cuff photo, and its `apply` saves the accepted ones as one entry whose rows carry server-derived provenance. Later health features build on the same permissions, read the profile through `HealthProfileService` and write values through `MeasurementsService`.

- **Code:** `apps/api/src/health-profile/`, `apps/api/src/measurements/` (photo readings in `photo/`), `apps/api/src/check-ins/`, `apps/web/src/pages/UserHealthProfilePage.tsx`
- **UI:** `/settings/health-profile`, `/health` (tiles, Daily check-in, Trend and History sections, **Read from photo**), the Today body snapshot and Readiness cards
- **Permissions:** `health_data:read`, `health_data:write`
- **Read more:** [specs/health-data.md](specs/health-data.md), [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md#7-audit-logging-and-security-tables)

### 5.21 Photo intake

A photo intake is the shared path for "share pictures instead of typing" features. `photo_intakes` holds one flow for one user: the photos attached to it (links to storage objects), the draft items an AI job read from them, and the state (`draft`, `scanning`, `ready`, `applied`, `failed`). What is being captured is a registered intake kind (`IntakeKindRegistry`): it validates the kind-specific context and each item value, names the server-only `ai.*` analyzer job, may declare `requiredPermissions` (extra `read` and `write` permissions checked on every route, fail-closed, `403` with `details.reason: MISSING_KIND_PERMISSIONS`), and writes the accepted items as real rows in the transaction that marks the intake applied. The registered kinds are `body_metric_reading` ([specs/health-data.md](specs/health-data.md#217-photo-readings)) `gym_equipment` ("Scan gym", [5.22](#522-gyms-and-equipment), analyzer `ai.equipment.scan`) and `workout_prefill` ("Prefill from photo", [5.24](#524-workout-logging), analyzer `ai.workout.prefill`); the first requires `health_data:read/write`, the second `gyms:read/write`, the third `workouts:read`, `workouts:write` and `exercises:write`, on top of `intakes:*`. `PATCH /api/intakes/:id` replaces an intake's context in `draft`, `ready` or `failed` (a source hint, for example) and answers `409` while it is `scanning` or `applied`. The chunk loop and error handling every analyzer job shares live in `apps/api/src/intake/intake-analyzer.ts`. `POST /api/intakes/:id/analyze` re-checks that the chosen model reads images and returns structured output, then enqueues the kind's analyzer job; the job stores its output through `IntakeService.replaceAiDrafts`. AI output is always a draft: the API keeps every item the model returned, records the first AI value of an edited item, and never deletes an AI item (it is rejected instead). The web kit in `apps/web/src/components/intake/` supplies photo picking with client-side downscaling, the provider disclosure and the draft review list.

- **Code:** `apps/api/src/intake/`, `apps/web/src/components/intake/`
- **Permissions:** `intakes:read`, `intakes:write`; analyze also `ai:use` behind `AiEnabledGuard`
- **Read more:** [intake/README.md](../apps/api/src/intake/README.md)

### 5.22 Gyms and equipment

A gym is a named place a user trains (type, description, notes, `isTemporary`), owned by one user; a foreign id answers `404`. The first gym becomes the default automatically, `POST /api/gyms/:id/default` moves the default, and deleting the default promotes the oldest remaining gym in the same transaction. Equipment rows (`gym_equipment`) point at an equipment type from the catalog: the seeded rows every user shares, or the user's own custom types (`custom-` slug prefix, created by `POST /api/equipment-types`, refused while gym equipment uses them). Types enable capabilities (movements), listed by `GET /api/capabilities`. A gym photo attaches an existing, ready, image-typed storage object the caller owns (`POST /api/gyms/:id/photos` with `storageObjectId`; the bytes are uploaded through `/api/storage/objects`) and can be linked to the equipment it shows. Removing a photo or a gym deletes the storage objects after the database write commits. Refusals carry a machine-readable `details.reason` (for example `GYM_LIMIT`, `DEFAULT_CONFLICT`, `EQUIPMENT_TYPE_IN_USE`, `PHOTO_ALREADY_ATTACHED`); the values and every size limit live in `apps/api/src/gyms/gyms.constants.ts`. Equipment written by AI carries an `origin`, a confidence and a write-once `originalAiValue`, so a manual gym works with AI off. Design, the scan job and the reference examples: [specs/gyms-and-equipment.md](specs/gyms-and-equipment.md).

- **Code:** `apps/api/src/gyms/` (`GymsModule`)
- **Routes:** `/api/gyms` (including `/:id/equipment` and `/:id/photos`), `/api/equipment-types`, `/api/capabilities`; details in `/api/docs` (tags "Gyms", "Equipment", "Capabilities")
- **Permissions:** `gyms:read`, `gyms:write`; photo attach and remove also need `storage:write`

### 5.23 Exercise library

The exercise library is the shared vocabulary workouts are built from: a seeded, slug-keyed catalog plus each user's own custom exercises, each with the equipment groups (AND of OR) that decide whether a gym supports it. Design, availability rules, slug permanence and how a fork adds exercises: [specs/workouts.md](specs/workouts.md#24-the-exercise-library).

- **Code:** `apps/api/src/exercises/` (`ExercisesModule`; limits and refusal reasons in `exercises.constants.ts`), `apps/web/src/pages/TrainExercisesPage.tsx`, `apps/web/src/components/train/CustomExerciseDialog.tsx`
- **Routes:** `/api/exercises` (including `/:id`, `/:id/approve` and `/:id/history`); details in `/api/docs` (group "Training", tag "Exercises")
- **UI:** `/train/exercises`
- **Permissions:** `exercises:read`, `exercises:write`; `/:id/history` needs `workouts:read`. `ExercisesModule` imports `WorkoutsModule`; `WorkoutsModule` never imports `ExercisesModule`

### 5.24 Workout logging

A workout is one logged training session of exercises and sets, stored in kilograms and metres, with at most one in progress per user (the raw-SQL partial unique index `workouts_user_in_progress_uniq_idx`). Personal records are computed on read. "Prefill from photo" drafts exercises and sets from a photo through the `workout_prefill` intake kind and the server-only job `ai.workout.prefill`. Data model, logging semantics, records, the training summary (`GET /api/workouts/summary`), the prefill design and guardrails: [specs/workouts.md](specs/workouts.md).

- **Code:** `apps/api/src/workouts/` (`WorkoutsModule`; limits and refusal reasons in `workouts.constants.ts`), `apps/web/src/pages/TrainPage.tsx`, `WorkoutPage.tsx`, `WorkoutPrefillPage.tsx`, `apps/web/src/components/train/`, `apps/web/src/components/today/TodayWorkout.tsx`
- **Routes:** `/api/workouts` (including `/summary`, `/:id/finish`, `/:id/exercises` and `/:id/sets`); details in `/api/docs` (group "Training", tag "Workouts")
- **UI:** `/train`, `/train/workouts/:workoutId`, `/train/workouts/:workoutId/prefill`, and the Today card
- **Permissions:** `workouts:read`, `workouts:write`; prefill also needs `exercises:write`

### 5.25 Training programs

A program is a user's training plan: a tree of blocks, weeks, workouts and exercise prescriptions, stored in kilograms, owner-scoped (another user's program is a 404). No AI is involved in this layer, so manual plans work with AI switched off.

- **Tree:** `Program` > `ProgramBlock` > `ProgramWeek` > `ProgramWorkout` > `ProgramExercise`. Each exercise prescription references an `Exercise` (deletion restricted) and carries sets, a rep range, optional load and RPE, and rest.
- **Immutable versions:** every content change bumps `Program.currentVersion` and writes a `ProgramVersion` row holding the full snapshot of the tree, its origin, rationale and evidence. `(programId, versionNumber)` is unique; version rows are never updated.
- **Change log:** every change writes a `ProgramChangeLog` row (kind, actor, status, from and to version, operations, citations, `revertsLogId`). It is listed newest first with keyset pagination.
- **One write chokepoint:** `ProgramsService.applyChange` is the only writer of an existing tree; manual edits (`PUT /api/programs/:id/structure`), reverts and future agent adaptations all go through it. `createWithTree` is the only other writer (version 1). The write diffs the tree against the stored rows in one transaction and bumps the version with a conditional update on `currentVersion`, so a stale `If-Match` is a 409 `TRAINING_STALE_PLAN` and nothing changes. An archived program refuses edits (`PROGRAM_ARCHIVED`).
- **Revert:** `POST /api/programs/:id/revert` restores a version's tree as a new version (`origin: revert`), or undoes the latest applied change by `changeLogId`, marking that entry `reverted`. History is never rewritten.
- **Archive, not delete:** a workout, week or block that has logged workouts linked to it is archived (`archivedAt`) instead of deleted, so history keeps its link; `DELETE /api/programs/:id` refuses with `PROGRAM_HAS_HISTORY` when any logged workout links in.
- **One active program per user:** the raw-SQL partial unique index `programs_one_active_per_user_uniq_idx` (see [§6.1](#61-prisma-models)). Lifecycle: `draft`, `active`, `paused`, `archived`, `completed`.

- **Code:** `apps/api/src/programs/` (`ProgramsModule`; contracts in `contracts/`, refusal reasons in `programs.constants.ts`)
- **Routes:** `/api/programs` (including `/:id/structure`, `/:id/activate`, `/:id/pause`, `/:id/archive`, `/:id/duplicate`, `/:id/versions`, `/:id/revert` and `/:id/change-log`); details in `/api/docs` (tag "Programs")
- **Permissions:** `programs:read`, `programs:write`

---

## 6. Data architecture

### 6.1 Prisma models

The schema is `apps/api/prisma/schema.prisma`. Its block comments carry per-column reasoning. All 43 models, grouped by subsystem:

| Subsystem | Model | Table | Purpose |
|---|---|---|---|
| Identity | `User` | `users` | User account, profile, active flag |
| Identity | `UserIdentity` | `user_identities` | OAuth identity (provider + subject) linked to a user |
| Identity | `AllowedEmail` | `allowed_emails` | Allowlist entry, `pending` or `claimed` |
| Identity | `RefreshToken` | `refresh_tokens` | Hashed refresh tokens, rotated on use |
| Identity | `PersonalAccessToken` | `personal_access_tokens` | Hashed `pat_` tokens with display prefix and expiry |
| Identity | `DeviceCode` | `device_codes` | RFC 8628 device authorization requests |
| Identity | `AuditEvent` | `audit_events` | Security-relevant action log |
| RBAC | `Role` | `roles` | Admin, Contributor, Viewer |
| RBAC | `Permission` | `permissions` | The 37 `resource:action` permissions |
| RBAC | `RolePermission` | `role_permissions` | Role-to-permission grants |
| RBAC | `UserRole` | `user_roles` | User-to-role assignments |
| Settings | `SystemSettings` | `system_settings` | Keyed JSONB rows for deployment settings |
| Settings | `UserSettings` | `user_settings` | One JSONB settings document per user |
| Secrets | `Credential` | `credentials` | Encrypted deployment-owned secrets by `(purpose, name)` |
| Secrets | `UserCredential` | `user_credentials` | Encrypted user-owned secrets, owner-bound cipher domain |
| Storage | `StorageObject` | `storage_objects` | File metadata, status, storage key, processing results |
| Storage | `StorageObjectChunk` | `storage_object_chunks` | Multipart upload part tracking |
| Notifications | `Notification` | `notifications` | In-app inbox rows |
| Notifications | `NotificationDelivery` | `notification_deliveries` | One row per channel delivery attempt |
| Notifications | `PushSubscription` | `push_subscriptions` | Browser Web Push subscriptions |
| Notifications | `NotificationBroadcast` | `notification_broadcasts` | Admin broadcasts, audience cutoff and cursor |
| Jobs | `Job` | `jobs` | The queue: type, payload, status, attempts, lease, claim token |
| Jobs | `JobStatsRollup` | `job_stats_rollup` | Lifetime per-type counts and durations |
| Nodes | `WorkerNode` | `worker_nodes` | Registered worker nodes, declared types and concurrency |
| Nodes | `NodeCredential` | `node_credentials` | Hashed `nod_` credentials |
| Nodes | `JobNodeSecret` | `job_node_secrets` | Handle (never material) of a per-job brokered credential |
| Backup | `DatabaseBackupRun` | `database_backup_runs` | One row per backup or restore attempt, own heartbeat |
| AI | `AiModel` | `ai_models` | Model catalog per `(provider, modelId)`, capabilities, enablement |
| AI | `UserAiKey` | `user_ai_keys` | Encrypted BYOK key per `(userId, provider)`, reachable models |
| AI | `AiRun` | `ai_runs` | Background AI runs (response, image, transcription, speech) |
| AI | `AiUsageEvent` | `ai_usage_events` | One row per provider round trip, tokens, key source |
| AI | `TrainingPlanRun` | `training_plan_runs` | One agent run: `kind`, `trigger`, `status`, `stage`, frozen `roleModels` and `tokenCap`, `usage`, `result`, `pendingDecision`, `resumeCount`, `jobIds`; `programId` is a plain column (no foreign key); at most one active run per user, enforced by the raw-SQL partial unique index `training_plan_runs_active_per_user_uniq_idx` |
| AI | `TrainingRunEvent` | `training_run_events` | Replayable run event with a per-run gapless `seq` (unique with `runId`), `type`, `stage`, key-free `data`; cascade on the run |
| AI | `TrainingRunCheckpoint` | `training_run_checkpoints` | Graph checkpoint per `(threadId, checkpointNs, checkpointId)`, node outputs only, no foreign key |
| AI | `TrainingRunCheckpointWrite` | `training_run_checkpoint_writes` | Pending writes and interrupts of a checkpoint, keyed by plain `threadId` |
| Health | `HealthProfile` | `health_profiles` | One row per user: date of birth, sex at birth, height (mm), unit system, time zone, bio, version |
| Health | `Measurement` | `measurements` | One reading per row in the metric's canonical unit: entry, metric key, method, origin, revision chain (`supersedesId`), soft delete; daily check-in scores are rows with `localDate` set |
| Intake | `PhotoIntake` | `photo_intakes` | One photo-to-draft flow per row: kind, status, kind-specific context, chosen provider and model, analyze job, error, result metadata |
| Intake | `PhotoIntakePhoto` | `photo_intake_photos` | Link from an intake to a `storage_objects` row, unique per `(intakeId, storageObjectId)`, with sort order |
| Intake | `DraftItem` | `draft_items` | One reviewable item: origin, status, confidence, uncertainty, source photos, `userVerified`, current `value`, write-once `originalAiValue` |
| Gyms | `Gym` | `gyms` | One place a user trains: name, type, optional coordinates, `isDefault` (at most one per user, enforced by the raw-SQL partial unique index `gyms_user_default_uniq_idx`), `isTemporary` |
| Gyms | `EquipmentType` | `equipment_types` | Equipment catalog row keyed by a permanent `slug`: category, aliases; `ownerUserId` null for seeded rows, set for a user's custom equipment |
| Gyms | `Capability` | `capabilities` | A movement an equipment type enables, keyed by a permanent `slug`: movement pattern and primary muscles |
| Gyms | `EquipmentTypeCapability` | `equipment_type_capabilities` | Join of equipment type to capability (composite key) |
| Gyms | `GymEquipment` | `gym_equipment` | Equipment present in a gym: type, quantity (1 to 99), brand, model, origin, confidence, `userVerified`, write-once `originalAiValue` |
| Gyms | `GymPhoto` | `gym_photos` | Link from a gym to a `storage_objects` row, with caption and taken-at time |
| Gyms | `GymEquipmentPhoto` | `gym_equipment_photos` | Join of a gym equipment row to the gym photos that show it (composite key) |
| Training | `Exercise` | `exercises` | Exercise keyed by a permanent `slug`: muscles, movement pattern, tracking mode, `origin` (`seed`, `user`, `ai`), `status` (`active`, `pending_review`), nullable `proposedByRunId` (no foreign key); `ownerUserId` null for the seeded library, set for a user's custom exercise |
| Training | `ExerciseRequirement` | `exercise_requirements` | One option of one requirement group: `groupIndex`, and an equipment type or a capability (a CHECK allows exactly one); groups are ANDed, options inside a group ORed |
| Training | `Workout` | `workouts` | One logged session: `date`, `status` (`in_progress`, `completed`), start and end times, `durationSeconds`, optional `gymId` (set null when the gym is deleted), `readinessSnapshot` JSON, optional `programWorkoutId` (foreign key to `program_workouts`, set null on delete); at most one `in_progress` row per user, enforced by the raw-SQL partial unique index `workouts_user_in_progress_uniq_idx` |
| Training | `WorkoutExercise` | `workout_exercises` | One exercise in a workout at a dense 0-based `position`, with an optional equipment type used; the exercise reference restricts deletion of an exercise in use |
| Training | `WorkoutPhoto` | `workout_photos` | Link from a workout to a `storage_objects` row (unique per object, cascade on both sides) with an optional caption; written when a `workout_prefill` intake is applied |
| Training | `SetLog` | `set_logs` | One set: `setNumber` (dense from 1, unique per workout exercise), `weightKg`, `reps`, time, `distanceMeters`, RPE, RIR, rest, `isWarmup`, `completed`, `painFlag`; value ranges guarded by the `set_logs_ranges_chk` CHECK |
| Training | `Program` | `programs` | One training plan per row: `name`, `goal`, `status` (`draft`, `active`, `paused`, `archived`, `completed`), `source`, `autonomy` (`autonomous`, `ask_first`), optional `gymId` (set null when the gym is deleted), `intake` JSON, `currentVersion`; at most one `active` row per user, enforced by the raw-SQL partial unique index `programs_one_active_per_user_uniq_idx` |
| Training | `ProgramBlock` | `program_blocks` | A phase of a program at a `position`, with optional `focus`; `archivedAt` set instead of deletion when logged history exists |
| Training | `ProgramWeek` | `program_weeks` | A week of a block (`weekNumber`, `isDeload`); cascade on the block; archived like blocks |
| Training | `ProgramWorkout` | `program_workouts` | A planned session in a week: `position`, optional `weekday` (1 to 7), estimated minutes; logged workouts link to it through `workouts.program_workout_id` (set null on delete) |
| Training | `ProgramExercise` | `program_exercises` | One prescription: exercise, `position`, `isPriority`, target sets, rep range, optional load (kg) and RPE, rest, `loadGuidance`, evidence refs; value ranges guarded by the `program_exercises_ranges_chk` CHECK |
| Training | `ProgramVersion` | `program_versions` | Immutable full snapshot of a program's tree per `versionNumber` (unique with `programId`), with `origin`, rationale, evidence, optional plain `runId` |
| Training | `ProgramChangeLog` | `program_change_log` | One change to a program: `kind`, `actor`, `status` (`applied`, `reverted`, ...), from and to version, `operations`, `citations`, `revertsLogId`, `seenAt`; indexed by `(programId, createdAt DESC)` |

Conventions: UUID primary keys, `timestamptz` timestamps, JSONB for extensible shapes, cascade deletes from `users` where the data belongs to the user. Users are deactivated, not deleted.

Six indexes exist only in hand-written migration SQL because Prisma cannot express a partial unique index: `jobs_active_dedup_uniq_idx` (job deduplication while `pending`/`running`), `database_backup_runs_active_uniq_idx` (at most one active backup run), `gyms_user_default_uniq_idx` (one default gym per user), `workouts_user_in_progress_uniq_idx` (one in-progress workout per user), `training_plan_runs_active_per_user_uniq_idx` (one active training run per user) and `programs_one_active_per_user_uniq_idx` (one active program per user). This is intentional schema drift. Do not add a `@@unique` to the models to "fix" it.

### 6.2 Settings storage

`system_settings` holds three rows, each keyed:

| Key | Contents | Edited at |
|---|---|---|
| `global` | The namespaced system settings document below | Per-namespace admin pages and `/api/system-settings` |
| `email` | Email transport (`ses` or `smtp`) and sender settings; the SMTP password is in `credentials` | `/admin/settings/email` |
| `webPush` | `{ enabled, publicKey, subject }`; the private key is in `credentials` | `/admin/settings/push` |
| `telemetry_connection` | Stored GreptimeDB connection; own version counter; not reachable through `/api/system-settings`. A custom (literal) host stores the whole row (host, PG port, database, reader/admin usernames) and its own credentials wholly. An automatic host (`{ host: null }`), or an absent row, means the `GREPTIME_*` deployment default applies wholly — port, database, logins and passwords included. See [specs/telemetry.md §8](specs/telemetry.md#8-runtime-connection). | `/admin/settings/telemetry` (Connection section) |

Namespaces of the `global` document (`systemSettingsSchema`):

| Namespace | Holds |
|---|---|
| `notifications` | Deployment policy: `browserEnabled`, `disabledEvents` |
| `jobs` | History retention and purge, stuck-job threshold |
| `nodes` | Heartbeat staleness, offline retention, `jobSecretBrokerEnabled` |
| `databaseBackup` | Schedule, retention, stale window, restore rollback mode, `nodeOffloadEnabled` |
| `maintenance` | Window state, message, `allowAdmins` |
| `storage` | Provider, bucket, region, endpoint, access key ID, path style (secret key is in `credentials`) |
| `ai` | Kill switch, key policy, per-provider settings, hosted tools, limits, usage retention |

Every read completes missing namespaces from built-in defaults, so the stored document is always whole.

`user_settings.value` namespaces (`userSettingsSchema`): `theme`, `profile` (display name, image source, uploaded image), and the optional `dataTables`, `navigation`, `notifications` (per-event channel preferences) and `ai` (default model, `taskModels` per training role, and `training` limits). An absent optional namespace means "use the defaults".

---

## 7. Authorization

### 7.1 Roles

| Role | Intended for |
|---|---|
| Admin | Operators. Holds every permission. |
| Contributor | Standard users who may also use AI. |
| Viewer | Least privilege. The default role for every new user. |

`ai:use` is withheld from Viewer so that a brand-new account cannot spend the deployment's org AI key without an administrator deciding it should. Grant it to a specific Viewer with a `role_permissions` row, or promote the account to Contributor.

### 7.2 Permission matrix

This is the single home for the matrix. Source: `ROLE_PERMISSIONS` in `apps/api/prisma/seed-data.ts`.

| Permission | Admin | Contributor | Viewer | Gates |
|---|:-:|:-:|:-:|---|
| `system_settings:read` | ✓ | | | Read system settings, email, notification policy, maintenance, About; reach `/admin/settings`; view the telemetry services status |
| `system_settings:write` | ✓ | | | Change system settings, email, notification policy; open or close maintenance; (re)deploy the telemetry services |
| `user_settings:read` | ✓ | ✓ | ✓ | Read own settings and own uploaded profile picture |
| `user_settings:write` | ✓ | ✓ | ✓ | Change own settings; upload or remove own profile picture |
| `users:read` | ✓ | | | List and view users; reach `/admin/settings` |
| `users:write` | ✓ | | | Update users (for example, activation) |
| `rbac:manage` | ✓ | | | Assign roles |
| `allowlist:read` | ✓ | | | View the allowlist |
| `allowlist:write` | ✓ | | | Add or remove allowlist entries |
| `storage:read` | ✓ | ✓ | ✓ | List, get and download storage objects |
| `storage:write` | ✓ | ✓ | | Upload objects, update metadata, delete own objects |
| `storage:delete_any` | ✓ | | | Delete another user's object (except their profile image) |
| `jobs:read` | ✓ | | | Inspect the job queue and insights |
| `jobs:write` | ✓ | | | Retry, reset, delete jobs; reset insight history |
| `nodes:read` | ✓ | | | View worker nodes and node credentials |
| `nodes:write` | ✓ | | | Register nodes, mint and revoke `nod_` credentials, claim jobs |
| `db_backup:read` | ✓ | | | View backup policy, runs, preflight |
| `db_backup:write` | ✓ | | | Change policy; start, cancel, delete backups |
| `db_backup:restore` | ✓ | | | Restore a backup or roll a restore back |
| `broadcasts:read` | ✓ | | | View broadcasts |
| `broadcasts:write` | ✓ | | | Create, schedule, send, resume broadcasts |
| `push:read` | ✓ | | | View Web Push configuration |
| `push:write` | ✓ | | | Generate, rotate, enable, remove VAPID keys |
| `storage_config:read` | ✓ | | | View object-storage configuration |
| `storage_config:write` | ✓ | | | Change storage configuration, test it, create the bucket |
| `ai_config:read` | ✓ | | | View AI configuration, model catalog, usage report |
| `ai_config:write` | ✓ | | | Change AI configuration, admin keys, models; refresh the catalog |
| `ai:use` | ✓ | ✓ | | Call AI and manage own AI keys (`/api/ai/*` except `GET /api/ai/config`) |
| `telemetry:read` | ✓ | | | View the telemetry policy and store status; reach `/admin/settings/telemetry` |
| `telemetry:write` | ✓ | | | Change telemetry policy (retention, query bounds, the AI assistant); save, test or reset the GreptimeDB connection |
| `telemetry:query` | ✓ | | | Run explorer queries, export results, use the telemetry AI assistant (with `ai:use`), view the telemetry dashboard |
| `health_data:read` | ✓ | ✓ | ✓ | Read own health data (`GET /api/health-profile`, `GET /api/measurements*`, `GET /api/check-ins*`); reach `/settings/health-profile` |
| `health_data:write` | ✓ | ✓ | ✓ | Change own health data (`PUT /api/health-profile`, `POST/PATCH/DELETE /api/measurements`, `PUT/DELETE /api/check-ins/:date`) |
| `intakes:read` | ✓ | ✓ | ✓ | Read own photo intakes and their draft items (`GET /api/intakes*`); a kind's own `requiredPermissions.read` is also needed (`body_metric_reading`: `health_data:read`, `gym_equipment`: `gyms:read`, `workout_prefill`: `workouts:read`) |
| `intakes:write` | ✓ | ✓ | ✓ | Create, edit, apply and discard own photo intakes (`POST/PATCH/DELETE /api/intakes*`); `POST /api/intakes/:id/analyze` also needs `ai:use`, and a kind's own `requiredPermissions.write` is also needed (`body_metric_reading`: `health_data:write`, `gym_equipment`: `gyms:write`, `workout_prefill`: `workouts:write` and `exercises:write`) |
| `gyms:read` | ✓ | ✓ | ✓ | Read own gyms, their equipment and the equipment catalog (`GET /api/gyms*`, `GET /api/equipment-types`, `GET /api/capabilities`) |
| `gyms:write` | ✓ | ✓ | ✓ | Create, edit and delete own gyms, equipment and custom equipment types (`POST/PATCH/DELETE /api/gyms*`, `/api/equipment-types*`); gym photo attach and remove also need `storage:write` |
| `exercises:read` | ✓ | ✓ | ✓ | Read the exercise library and own custom exercises (`GET /api/exercises*`) |
| `exercises:write` | ✓ | ✓ | ✓ | Create, edit, approve and delete own custom exercises (`POST/PATCH/DELETE /api/exercises*`, `POST /api/exercises/:id/approve`) |
| `workouts:read` | ✓ | ✓ | ✓ | Read own workouts, exercises and sets (`GET /api/workouts*`) |
| `workouts:write` | ✓ | ✓ | ✓ | Start, edit, finish and delete own workouts, their exercises and sets (`POST/PATCH/DELETE /api/workouts*`) |
| `programs:read` | ✓ | ✓ | ✓ | Read own training programs, versions and change log (`GET /api/programs*`) |
| `programs:write` | ✓ | ✓ | ✓ | Create, edit, activate, pause, archive, duplicate, revert and delete own programs (`POST/PATCH/PUT/DELETE /api/programs*`) |

**Note on `storage:*`.** Every `/api/storage/objects` route requires `storage:read` (list, get, download) or `storage:write` (uploads, metadata updates, delete). Ownership is enforced on top: a caller may act only on their own objects unless they also hold `storage:delete_any`, which lifts the ownership check for delete on every object except another user's profile image (removed only via `DELETE /api/user-settings/profile-image` by its owner).

Separate permission families (`push:*`, `nodes:*`, `storage_config:*`, `ai_config:*`, `db_backup:restore`, `telemetry:*`, `health_data:*`, `intakes:*`, `gyms:*`, `exercises:*`, `workouts:*`, `programs:*`) exist because each gates something with a distinct blast radius. Folding them into `system_settings:*` would hand that authority to anyone granted routine settings access. See [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md) for the design.

---

## 8. Background work

### 8.1 Job-type inventory

All 28 registered job types. Handler paths are relative to `apps/api/src/`. A type is node-eligible when its handler carries both `nodeResultSchema` and `persistNodeResult`.

| Type | Handler | What it does | Node-eligible |
|---|---|---|:-:|
| `ai.catalog.refresh` | `ai/catalog/ai-catalog-refresh.handler.ts` | Syncs one provider's model catalog with the admin key; daily and on admin request | No |
| `ai.response.run` | `ai/runtime/ai-response-run.handler.ts` | Executes one background AI response | No |
| `ai.image.generate` | `ai/runtime/ai-image-generate.handler.ts` | One image generation or edit; outputs become the user's storage objects | No |
| `ai.audio.transcribe` | `ai/runtime/ai-audio-transcribe.handler.ts` | Streams a user's recording to the provider; stores the transcript on the run | No |
| `ai.audio.speech` | `ai/runtime/ai-audio-speech.handler.ts` | Text-to-speech; the audio becomes the user's storage object | No |
| `ai.usage.purge` | `ai/usage/ai-usage-purge.handler.ts` | Deletes `ai_usage_events` past `ai.usageRetentionDays`, in batches; daily | No |
| `ai.health.body_metric_reading` | `measurements/photo/body-metric-reading.handler.ts` | Reads a scale or blood-pressure-cuff photo into pending draft readings for a `body_metric_reading` intake | No |
| `ai.keys.recheck` | `ai/keys/ai-keys-recheck.handler.ts` | Re-verifies stale user keys for one provider, refreshes reachable models | No |
| `ai.equipment.scan` | `gyms/scan/equipment-scan.handler.ts` | "Scan gym": sends a `gym_equipment` photo intake's photos to the user's vision model in batches of 16 and stores the equipment drafts for review | No |
| `ai.workout.prefill` | `workouts/prefill/workout-prefill.handler.ts` | "Prefill from photo": sends a `workout_prefill` photo intake's photos (machine placard, notebook, whiteboard) to the user's vision model in chunks of 16 and stores one exercise draft per line, with the written sets converted to kg | No |
| `ai.training.plan.run` | `training-agents/runtime/training-plan-run.handler.ts` | Executes one training agent graph run with checkpoints; profile 25 minutes, 1 attempt; a resume is a new job for the same run | No |
| `training.runs.purge` | `training-agents/runtime/handlers/training-runs-purge.handler.ts` | Deletes finished runs' events and checkpoints past retention, then old run rows; enqueued by a daily 05:30 cron that only enqueues; profile 30 minutes, 3 attempts | No |
| `job.history.purge` | `jobs/handlers/job-history-purge.handler.ts` | Deletes old finished jobs after folding them into `job_stats_rollup` | No |
| `example.echo` | `jobs/handlers/example-echo.handler.ts` | Worked server-only example: logs its payload | No |
| `example.checksum` | `jobs/handlers/example-checksum.handler.ts` | Worked node-eligible example: hashes a storage object | Yes |
| `auth.token.cleanup` | `auth/handlers/token-cleanup.handler.ts` | Deletes expired or revoked refresh tokens and expired PATs | No |
| `nodes.fleet.sweep` | `nodes/handlers/node-fleet-sweep.handler.ts` | Marks nodes with stale heartbeats offline | No |
| `nodes.fleet.prune` | `nodes/handlers/node-fleet-prune.handler.ts` | Forgets nodes offline longer than `nodes.offlineRetentionDays` | No |
| `admin.broadcast.start` | `notifications/broadcasts/handlers/broadcast-start.handler.ts` | Starts a broadcast: freezes the audience, enqueues the first chunk | No |
| `admin.broadcast.chunk` | `notifications/broadcasts/handlers/broadcast-chunk.handler.ts` | Delivers one page of recipients, enqueues its successor | No |
| `storage.cleanup.stale-uploads` | `storage/handlers/storage-cleanup.handler.ts` | Cleans up abandoned uploads, aborting billed multipart parts | No |
| `storage.object.process` | `storage/handlers/storage-object-process.handler.ts` | Runs registered post-upload processors on one object and marks it `ready`/`failed` | No |
| `db.backup.run` | `db-backup/handlers/db-backup-run.handler.ts` | Streams `pg_dump` into object storage | Yes |
| `db.backup.sweep` | `db-backup/handlers/db-backup-sweep.handler.ts` | Releases stale backup runs, then prunes by retention | No |
| `db.restore.run` | `db-backup/handlers/db-restore-run.handler.ts` | Restores the database from a backup | No |
| `db.restore.old-db-drop` | `db-backup/handlers/db-restore-old-db-drop.handler.ts` | Drops databases a restore displaced once their retention closes | No |
| `device-auth.code.cleanup` | `device-auth/handlers/device-code-cleanup.handler.ts` | Deletes expired device codes | No |
| `telemetry.retention.apply` | `telemetry/handlers/telemetry-retention.handler.ts` | Sets GreptimeDB's database-level TTL to `telemetry.retentionDays`; daily and on policy change | No |
| `telemetry.stack.deploy` | `telemetry/stack/telemetry-stack-deploy.handler.ts` | Starts GreptimeDB and the collector through `stack-agent`, on admin request | No |

Every `ai.*` type is server-only permanently: no AI key is ever brokered to a worker node. `db.backup.run` is offered to nodes only when `nodes.jobSecretBrokerEnabled` and `databaseBackup.nodeOffloadEnabled` are both on and the broker can mint a role.

Scheduled types are enqueued by small `@Cron` tasks that only decide whether work is due (for example `apps/api/src/jobs/tasks/job-history-purge.task.ts`, using the shared helper `apps/api/src/jobs/housekeeping.enqueue.ts`).

### 8.2 Execution profile and lease

- A handler may declare `profile: { maxRuntimeMs, maxAttempts }`; otherwise `JOBS_JOB_TIMEOUT_MS` and `JOBS_MAX_ATTEMPTS` apply.
- The lease length is derived from `maxRuntimeMs`. Neither executor can choose its own lease.
- The renewal interval is a clamped fraction of the lease, also derived. There is no `leaseMs` or `heartbeatMs` to declare.
- Both executors renew through `JobLeaseService`; settle writes match the claim token, so a stale executor cannot overwrite a newer claim.
- The lease reaper (`JOBS_REAPER_ENABLED`) requeues or fails rows whose lease passed or whose claim is implausible.

### 8.3 Permanent cron exemptions

Three crons do their work inline instead of enqueuing a job. The list is enforced by `apps/api/test/jobs/cron-enqueue-only.spec.ts`.

| Task | Why it cannot be a job |
|---|---|
| `apps/api/src/jobs/tasks/job-stuck-reset.task.ts` | The lease reaper. Recovery that depends on the queue it recovers is not recovery. |
| `apps/api/src/jobs/tasks/temp-file-janitor.task.ts` | Sweeps this process's local disk, which another replica or a node cannot reach. |
| `apps/api/src/nodes/tasks/node-secret-sweep.task.ts` | Revokes brokered node credentials. A wedged queue must not leak live credentials. |

Read more: [specs/job-queue.md](specs/job-queue.md), [specs/worker-nodes.md](specs/worker-nodes.md), [handlers README](../apps/api/src/jobs/handlers/README.md).

---

## 9. Frontend architecture

### 9.1 Routes

Routes are declared in `apps/web/src/App.tsx`.

| Access | Routes |
|---|---|
| Public | `/login`, `/auth/callback`, `/testing/login` (development builds only) |
| Signed in | `/` (Today), `/health` (latest body and vital values with quick entry; see [specs/health-data.md](specs/health-data.md#214-quick-entry-and-the-health-page)), `/train`, `/train/exercises` and `/train/workouts/:workoutId` (workout logging and the exercise library; see [§5.23](#523-exercise-library) and [§5.24](#524-workout-logging)), `/gyms` (see [§5.22](#522-gyms-and-equipment)), `/activate` (device approval), `/settings` hub and its pages |
| Admin | `/admin/settings` hub (`system_settings:read` or `users:read`) and its pages; `/ai` (AI Playground: `ai:use` and `ai_config:read`, AI enabled) |
| Redirects | `/admin` → `/admin/settings`, `/admin/users` → `/admin/settings/users`, `/admin/settings/deployment` → `/admin/settings/about`; unknown paths → `/` |

`ProtectedRoute` establishes that someone is signed in. `RequirePermission` wraps each gated page with the same permission string its registry card declares and its API controller enforces. `RequireAiEnabled` redirects AI pages while AI is off. `MaintenanceGate` swaps the app for a maintenance screen while a window is open.

### 9.2 Settings pages

Every settings page, from `apps/web/src/config/adminSections.tsx` and `apps/web/src/config/userSettingsSections.tsx`. Groups and cards are append-only: the hub and rail render them in declaration order.

| Route | Title | Group | Permission | Feature gate |
|---|---|---|---|---|
| `/admin/settings/email` | Email | General | `system_settings:read` | |
| `/admin/settings/notifications` | Notifications | General | `system_settings:read` | |
| `/admin/settings/push` | Web Push | General | `push:read` | |
| `/admin/settings/storage` | Storage | General | `storage_config:read` | |
| `/admin/settings/maintenance` | Maintenance | General | `system_settings:read` | |
| `/admin/settings/users` | Users & Allowlist | Access | `users:read` | |
| `/admin/settings/jobs` | Jobs | Operations | `jobs:read` | |
| `/admin/settings/jobs/insights` | Job Insights | Operations | `jobs:read` | |
| `/admin/settings/workers` | Worker Nodes | Operations | `nodes:read` | |
| `/admin/settings/db-backup` | Database Backup | Operations | `db_backup:read` | |
| `/admin/settings/broadcasts` | Broadcasts | Operations | `broadcasts:read` | |
| `/admin/settings/about` | About | Operations | `system_settings:read` | |
| `/admin/settings/ai` | AI | AI | `ai_config:read` | none (the page that turns AI on) |
| `/admin/settings/ai/models` | AI Models | AI | `ai_config:read` | `ai` |
| `/admin/settings/ai/usage` | AI Usage | AI | `ai_config:read` | `ai` |
| `/admin/settings/telemetry` | Telemetry | Observability | `telemetry:read` | none (the page that turns telemetry on) |
| `/admin/settings/telemetry/explorer` | Telemetry Explorer | Observability | `telemetry:query` | `telemetry` |
| `/admin/settings/telemetry/dashboard` | Telemetry Dashboard | Observability | `telemetry:query` | `telemetry` |
| `/settings/profile` | Profile | Account | | |
| `/settings/appearance` | Appearance | Account | | |
| `/settings/notifications` | Notifications | Account | | |
| `/settings/tokens` | Access Tokens | Security | | |
| `/settings/ai` | AI Keys | Security | `ai:use` | `ai` |
| `/settings/ai/agents` | Training agents | AI | `ai:use` | `ai` |
| `/settings/health-profile` | Health Profile | Health | `health_data:read` | |

Cards gate reachability; pages gate their own write controls (for example, a `jobs:read` holder without `jobs:write` sees disabled retry buttons). The Users & Allowlist page keeps two tabs because they are parallel views of one question; `allowlist:read` gates the Allowlist tab's content.

### 9.3 Layout and breakpoint

The layout switches between a phone treatment (bottom navigation, compact AppBar, drill-down settings list) and a wider treatment (navigation rail, card grid) at MUI's `sm` breakpoint, 600px. Five gates move together: `showRail` in `apps/web/src/components/common/Layout.tsx`, the self-gate in `components/navigation/BottomNav.tsx`, `<main>`'s bottom padding in `Layout.tsx`, and `isCompactWindow` in both `components/settings/SettingsHub.tsx` and `components/navigation/AppBar.tsx`. Change one only after checking all five. See [specs/settings-ui.md](specs/settings-ui.md).

Destinations are declared once, in `apps/web/src/config/destinations.ts`; the rail, the bottom bar and the user menu all read that list. Four are `primary`: Today, Train, Health and Gyms. They make up the phone bottom bar, and `PRIMARY_DESTINATION_LIMIT` (4) caps how many may be, because more labelled tabs do not fit at 360px; a test enforces the ceiling. The other destinations (Settings, Console, AI) are not in the bottom bar. On phones they are entries in the user menu; at `sm` and up they sit in the rail, with Console pinned at its foot.

### 9.4 Contexts and API client

| Context | File | Provides |
|---|---|---|
| `ThemeContextProvider` | `apps/web/src/contexts/ThemeContext.tsx` | Light, dark or system theme preference |
| `AuthProvider` | `apps/web/src/contexts/AuthContext.tsx` | Current user, enabled sign-in providers, sign-in and sign-out |
| `NotificationProvider` | `apps/web/src/contexts/NotificationContext.tsx` | In-app inbox and the SSE notification stream |
| `AiConfigProvider` | `apps/web/src/contexts/AiConfigContext.tsx` | The one `GET /api/ai/config` answer: whether AI is on, key policy, enabled providers |

All HTTP calls go through `ApiService` in `apps/web/src/services/api.ts`. It resolves the base URL (`VITE_API_BASE_URL`, default `/api`), attaches the in-memory access token, refreshes it once on `401`, unwraps the `{ data }` envelope, and recognizes the maintenance `503` centrally. Feature-specific clients (`services/jobs.ts`, `services/ai.ts`, `services/storage.ts` and others) are thin wrappers over it. `services/sse.ts` opens event streams against the same base URL.

---

## 10. Infrastructure

### 10.1 Compose files

All files live in `infra/compose/` and are layered with repeated `-f` flags from that folder.

| File | Purpose | When used |
|---|---|---|
| `base.compose.yml` | Core services: `nginx`, `api`, `web`. No database service. | Always |
| `dev.compose.yml` | Hot reload, source volumes, exposed ports | Local development |
| `devdb.compose.yml` | Opt-in PostgreSQL 16 container (`db`) for development | Local development without a shared database |
| `telemetry.compose.yml` | OpenTelemetry Collector and GreptimeDB standalone | When you want traces, metrics and logs locally |
| `prod.compose.yml` | Resource limits, restart policies | Production |
| `vps.compose.yml` | Publishes nothing on a public interface; the app sits behind a shared host proxy. Also adds `stack-agent`, the only service that holds the Docker socket — it lets the admin UI (re)deploy the telemetry containers with no shell step. See [specs/telemetry.md §10](specs/telemetry.md#10-deploying-the-stack-stack-agent). | VPS deployment via `evopathcli deploy`, after `prod.compose.yml` |
| `vps.telemetry.compose.yml` | Hardens the telemetry stack for a VPS: no collector host ports, GreptimeDB's Postgres wire port on `127.0.0.1` only | VPS deployment, after `telemetry.compose.yml` and `vps.compose.yml` (always layered — the telemetry stack ships with every VPS deployment) |
| `test.compose.yml` | Disposable PostgreSQL (`db-test`, host port 5433) | Real-database test runs |
| `worker.compose.yml` | Worker node containers from the published image; scale with `--scale worker=N` | Running a worker fleet |
| `worker.build.compose.yml` | Builds the worker image from source | Developing the worker itself |

Typical commands:

```bash
cd infra/compose
docker compose -f base.compose.yml -f dev.compose.yml up
docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml up
docker compose -f base.compose.yml -f dev.compose.yml -f telemetry.compose.yml up
docker compose -f base.compose.yml -f prod.compose.yml up
```

### 10.2 Networks

`base.compose.yml` defines a private bridge network, `app-network`, for `nginx`, `api` and `web`. The `api` service also joins `devnet`, an external network you create once per host (`docker network create devnet`). A PostgreSQL server shared by several apps on that host lives on `devnet`. With `devdb.compose.yml`, the database is the `db` service instead, so `.env` must set `POSTGRES_HOST=db`.

### 10.3 nginx routing

`infra/nginx/nginx.conf` is the single origin:

| Location | Upstream | Notes |
|---|---|---|
| `/api/notifications/stream` | api | Buffering off for SSE |
| `/api/ai/responses/stream` | api | Buffering off for SSE |
| `/api/ai/training/stream` | api | Buffering off for SSE (training run event replay, `GET /api/ai/training/stream/:runId`) |
| `/api/admin/telemetry/assistant/stream` | api | Buffering off for SSE (telemetry AI assistant) |
| `/api` | api | Includes `/api/docs` and `/api/openapi.json` |
| `/` | web | The React app |
| `/nginx-health` | nginx | Proxy health probe |

Security headers are set at server level: `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security` and a Content-Security-Policy. nginx's `add_header` replaces rather than merges, so a location that adds its own header must repeat the security headers.

### 10.4 Environment variables

The reference for every variable is [`infra/compose/.env.example`](../infra/compose/.env.example). Create `.env` from it with `npm run setup`, which builds the CLI and runs `evopathcli init`. The policy:

- **Database.** Set `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` and `POSTGRES_SSL`. `DATABASE_URL` is constructed at runtime; do not set it. Use the `npm run prisma:*` scripts, never bare `npx prisma`, so the URL is built for you.
- **Runtime-configured features have no variables.** Object storage, AI, Web Push and SMTP are configured in the admin UI and stored in `system_settings` plus encrypted `credentials`. Never add `STORAGE_PROVIDER`, `S3_BUCKET`, `OPENAI_API_KEY` or similar.
- **`SECRETS_ENCRYPTION_KEY`** encrypts those runtime secrets. It is required for a working deployment.
- **Process tuning** (`JOBS_*`, `NODE_*`, `DB_BACKUP_SCHEDULE_ENABLED`) controls what this process runs, not deployment policy. Deployment policy is a system setting.
- **`MAINTENANCE_MODE`** is a break-glass override; see [runbooks/maintenance-mode.md](runbooks/maintenance-mode.md).

The API does not migrate on startup. Run `npm run prisma:migrate` and `npm run prisma:seed` inside the `api` container after the first start and after each upgrade.

---

## 11. Observability

| Signal | Mechanism | Destination |
|---|---|---|
| Traces | OpenTelemetry Node SDK with Node auto-instrumentations (health probes excluded) | OTLP → otel-collector → GreptimeDB |
| Metrics | OpenTelemetry metrics exporter | OTLP → otel-collector → GreptimeDB |
| Logs | Pino structured JSON (`apps/api/src/common/logger/`), pretty-printed in development; also exported over OTLP | stdout, and OTLP → otel-collector → GreptimeDB |

- Instrumentation starts in `apps/api/src/instrumentation.ts`, before the application loads. It runs only when `OTEL_ENABLED=true` (the telemetry overlay sets it on the `api` service) and exports to `OTEL_EXPORTER_OTLP_ENDPOINT`.
- A second, independent switch — the `telemetry.enabled` system setting — decides whether the SDK's output is actually exported, checked at export time by a runtime gate (`apps/api/src/common/otel/telemetry-gate.ts`) that starts closed and converges across a fleet within about five seconds of an administrator's change. See [specs/telemetry.md §2](specs/telemetry.md#2-the-two-switches).
- The collector (`infra/otel/otel-collector-config.yaml`) redacts credential-bearing attributes (`Authorization`, `Cookie`, `Set-Cookie`, query strings) before anything reaches GreptimeDB, and authenticates to it as a write-only user.
- The collector also scrapes the host (`hostmetrics` over a read-only `/hostfs` mount), its own pipeline counters and a subset of GreptimeDB's `/metrics`, into their own tables, and probes uptime and TLS expiry of the app, the API and the public origin (`httpcheck`) and nginx's connection counters (`nginx` over an internal `:8081` listener). See [specs/telemetry.md §11.2](specs/telemetry.md#112-data-sources-what-is-collected-and-why-no-docker-stats).
- `AppMetricsModule` (`apps/api/src/common/otel/`, global) is the one place first-party application metrics (`app.*`: jobs, backups, auth, AI, notifications) are defined; features record through `AppMetricsService`. See [specs/telemetry.md §11.13](specs/telemetry.md#1113-application-metrics).
- Each log line carries the request ID and trace ID assigned by the request-ID middleware, so a log line leads to its trace.
- Never log secrets. The AI platform, credential stores and auth guards keep key material out of logs, spans and error bodies by design.
- Administrators query GreptimeDB with SQL, export results, and ask an AI assistant about them, from the Telemetry Explorer (`/admin/settings/telemetry/explorer`, `telemetry:query`) — see [specs/telemetry.md](specs/telemetry.md).
- A fixed Telemetry Dashboard (`/admin/settings/telemetry/dashboard`, `telemetry:query`) gives a health verdict, tiles and timelines with no SQL required — see [specs/telemetry.md §11](specs/telemetry.md#11-dashboard).
- GreptimeDB dashboard: http://localhost:14000/dashboard when `telemetry.compose.yml` is running.

Health endpoints (public, reachable during maintenance):

| Endpoint | Checks |
|---|---|
| `GET /api/health/live` | The process is running |
| `GET /api/health/ready` | The process can reach the database |
| `GET /api/health` | Full check of all dependencies |

---

## 12. Extension points

| To add | See |
|---|---|
| An API endpoint | [DEVELOPMENT.md](DEVELOPMENT.md) |
| A settings page or setting | [specs/settings-ui.md](specs/settings-ui.md) |
| A background job type | [jobs/handlers/README.md](../apps/api/src/jobs/handlers/README.md) |
| A photo-intake kind | [intake/README.md](../apps/api/src/intake/README.md) |
| A notification event | [notifications/README.md](../apps/api/src/notifications/README.md) |
| AI in a feature | [ai/README.md](../apps/api/src/ai/README.md) |
| An AI provider | [specs/ai-platform.md](specs/ai-platform.md) |
| A user key type (bring your own key) | [specs/user-credentials.md](specs/user-credentials.md) |
| A post-upload storage processor | [processors/README.md](../apps/api/src/storage/processing/processors/README.md) |
| A worker node executor | [executors/README.md](../apps/cli/src/node/executors/README.md) |

---

## 13. Related documents

Every document in this repository, with its audience and a suggested reading order, is listed in [README.md](README.md).
