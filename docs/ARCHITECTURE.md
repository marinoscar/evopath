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
| 4 | Feature gate | `apps/api/src/ai/…` (`AiEnabledGuard`) | Controller-level, on `/api/ai/*`, `/api/coach/*` and `/api/memories` consumer controllers only. Answers `403 AI_DISABLED` while AI is switched off. |
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

A failed sign-in redirects to `/auth/callback?error=<code>` with a code from a closed set, and the web app shows a fixed explanation screen with a way to try a different account ([sign-in failure contract](SECURITY-ARCHITECTURE.md#sign-in-failure-contract)).

Access is restricted to allowlisted emails. `INITIAL_ADMIN_EMAIL` bypasses the check, is seeded onto the allowlist and becomes Admin on first sign-in. Every other new user gets the Viewer role. An allowlist entry is `pending` until its owner signs in, then `claimed`; claimed entries cannot be removed. Revoke access by deactivating the user instead.

- **Code:** `apps/api/src/auth/`, `apps/api/src/allowlist/`, `apps/api/src/users/`
- **UI:** `/admin/settings/users` (Users and Allowlist tabs)
- **Permissions:** `users:read`, `users:write`, `rbac:manage`, `allowlist:read`, `allowlist:write`
- **Read more:** [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md)

### 5.2 Role-based access control

Three roles (Admin, Contributor, Viewer) grant 44 permissions named `resource:action`. Roles and permissions are rows (`roles`, `permissions`, `role_permissions`, `user_roles`), seeded from `apps/api/prisma/seed-data.ts`. A controller names the exact permission it needs in `@Auth({ permissions: [...] })`; the web app reads the same strings to decide which cards, routes and controls to show.

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

Administrators alone choose models: the `ai.assignments` system setting names a default model and one per feature (photo features and training agents), and `AiFeatureModelResolver` (`apps/api/src/ai/assignments/`) resolves each feature for a caller (assignment, default, automatic pick, else a blocking state); `GET /api/ai/features` exposes it. A feature uses AI by injecting `AiService` and calling `forUser(userId)`. That client runs one gate pipeline for every call: kill switch, provider and model enablement, capability match, key resolution (the user's own key, or the org key under `byok_with_org_fallback` or for a holder of `ai_config:write`), rate limits and output caps. It records one `ai_usage_events` row per provider round trip. Provider SDKs are imported only inside `apps/api/src/ai/providers/<provider>/`. Every provider call happens on the server; the only credential an AI route ever returns is a realtime session's ephemeral secret. Media and background runs are server-only queue jobs, never node-eligible. The web app includes an admin-only AI Playground at `/ai`.

`TrainingAgentsModule` (`apps/api/src/training-agents/`) sits above the gateway: it runs agent graphs with LangGraph.js through `LangGraphRunner`, checkpointing to two Prisma-owned tables, and never calls a provider itself. Framework telemetry is forced off in code. Per-role model choice (researcher, planner, critic, evaluator) is resolved by `TrainingModelResolver` (`training-agents/models/`) through the shared `AiFeatureModelResolver` from the administrator's `ai.assignments` and the read-only `UsableModelsService`; users choose no model; `GET /api/ai/training/models` and `POST /api/ai/training/estimate` (`ai:use`, behind `AiEnabledGuard`) return the resolution and a token estimate, never a quote.

The runtime kit (`training-agents/runtime/`, `graph/`, `nodes/`) executes one graph run as one server-only job:

- **Runs.** `POST /api/ai/training/runs` freezes the per-role models and the token cap on a `training_plan_runs` row and enqueues `ai.training.plan.run` in the same transaction. The raw-SQL partial unique index `training_plan_runs_active_per_user_uniq_idx` allows one active run per user; a second start answers `409 TRAINING_RUN_ACTIVE` with the existing run's id.
- **One path to the model.** `AgentCaller` is the only route from a graph node to `AiService` (`structured`, `respond` for free text, `withTools`); a node never holds a provider client or a key. `RunBudget` enforces the per-run token cap across all calls (`TRAINING_RUN_BUDGET_EXCEEDED`), and `ContextBudget` trims prompt sections in a fixed order.
- **Researcher.** The `research` node (`nodes/research.node.ts`, agent in `agents/researcher/`) searches with the OpenAI hosted `web_search` tool only in v1, called through `AgentCaller` like every other call. Its context is minimised (`researcher-context.ts`): demographics are included only when the user opts in to tailored research. It produces an evidence brief whose citations the server verifies (guardrail G8, `guardrails/citations.ts`): a source counts only if the run's search actually returned its URL, unverified sources and claims left without a source are dropped, and the drops are counted. It emits `research.query`, `research.source` and `research.brief` run events, which carry no prompt text. A research shortfall never fails a run: after the web attempts, or at once when web search is off or refused, a tool-less knowledge call produces claims from established principles, and the brief's server-set `basis` (`web_verified`, `web_partial`, `model_knowledge`) records it (the `research.brief` event carries it). The failure is `TRAINING_RESEARCH_CONTEXT_MISSING` (no usable context); `TRAINING_RESEARCH_INSUFFICIENT` is legacy, on old runs only.
- **Persisted events with replay.** Every lifecycle and usage event is a `training_run_events` row with a gapless per-run `seq` and carries no prompt text or key. `GET /api/ai/training/stream/:runId?after=<seq>` replays the events after `seq`, then tails by polling, so any API replica can serve it; a client disconnect does not cancel the run.
- **Checkpoints and resume.** `PrismaCheckpointSaver` writes node outputs after each node. Resume never re-runs a finished node: `POST .../resume` (from `interrupted`) and `POST .../decision` (from `awaiting_approval`) queue a new job for the same run. A lost job interrupts the run and is resumed automatically a bounded number of times.
- **Cancel and retention.** `POST .../cancel` stops a running run within one poll interval. The daily `training.runs.purge` job deletes finished runs' events and checkpoints past retention.

The `create` graph (`create` and `revise` runs) is `prepare_context` → `research` → `plan` → `guardrails` → `critique` → route → `finalize`, with pure routes in `graph/routes.ts`. `guardrails/` holds the deterministic rules G0 to G10, `context/never-send.ts` the one list of data no agent receives, and `nodes/finalize.node.ts` writes through the programs chokepoint (`ProgramsService.createWithTree` or `applyChange`). `POST /api/ai/training/estimate` returns the "what will be sent" summary. Ship rule, guardrail table, warning codes and finalize failures: [specs/ai-training-plans.md §2.2](specs/ai-training-plans.md#22-graphs-and-the-run-state-machine), [§2.4](specs/ai-training-plans.md#24-context-and-the-never-send-list) and [§2.6](specs/ai-training-plans.md#26-guardrails).

**Continuous evaluation.** The evaluate graph (`graph/evaluate-graph.ts`) reviews the active plan against what the person did and adjusts it inside a server-enforced envelope (`guardrails/envelope.ts`, G10). It is an ordinary `ai.training.plan.run` job of kind `evaluate`, started by `training-agents/evaluation/` (`workout_finished`, `weekly`, `missed_sessions` and `manual` triggers) and the hourly `training.evaluation.sweep` job ([§8.1](#81-job-type-inventory)). A plan's `autonomy` decides between applying at once and a proposal resolved by `POST /api/ai/training/runs/:runId/decision`; `POST /api/programs/:id/revert` undoes a change and `POST /api/programs/:id/autonomy/resume` clears a safety pause. Triggers, gates, limits, nodes, the E1 to E10 envelope, safety stops and notifications: [specs/ai-training-plans.md §2.6](specs/ai-training-plans.md#26-guardrails), [§2.7](specs/ai-training-plans.md#27-autonomy) and [§2.8](specs/ai-training-plans.md#28-continuous-evaluation).

**Quick adaptation.** `TrainingAdaptationModule` (`apps/api/src/training-adaptation/`) adjusts one workout to today's time, soreness, energy and equipment. `POST /api/ai/training/adaptations` stores a `workout_adaptations` row and enqueues the server-only job `ai.training.adapt.run`, which runs the adapt graph (`training-agents/graph/adapt-graph.ts`) on a `training_plan_runs` row of kind `adapt`. The routes under `/api/ai/training/adaptations` sit behind `AiEnabledGuard` plus `ai:use`; applying a result as a workout also needs `workouts:write` and as a plan change `programs:write`. Per-route detail: `/api/docs`.

**Agent usage.** `TrainingUsageModule` (`apps/api/src/training-usage/`) reports tokens, model and key source by node and role: `GET /api/ai/training/runs/:runId/usage` for one run and `GET /api/ai/training/usage?month=YYYY-MM` for a UTC month (`AiEnabledGuard` plus `ai:use`, caller-scoped in SQL). The run view carries the per-run token `cap`. The web shows `AgentUsagePanel` on run screens and a monthly section on `/settings/ai`. Attribution, cap behaviour and `typical`: [specs/ai-training-plans.md §2.12](specs/ai-training-plans.md#212-usage-by-agent-role).

- **Code:** `apps/api/src/ai/` (`core/`, `providers/`, `runtime/`, `catalog/`, `keys/`, `usage/`, `config/`, `http/`)
- **Plan screens.** The web app starts a `create` run from the intake wizard at `/train/plans/new` and follows it at `/train/plans/runs/:runId`. The wizard shows the estimate's `sentData` per agent, the token range and the cap before Start, and sends only the intake. The run view (`hooks/useTrainingRun.ts`) folds the stream into a view model idempotently by `seq` (`utils/reduceRunEvents.ts`) and reconnects with `?after=` the last contiguous `seq`, so a reload or a dropped connection replays without duplicates. Leaving the page never cancels the run. A plan's "Revise with AI" box starts a `revise` run. Every AI affordance is hidden while AI is off or without `ai:use`, and the two AI routes redirect to `/train/plans`.
- **UI:** admin `/admin/settings/ai`, `/admin/settings/ai/models`, `/admin/settings/ai/assignments`, `/admin/settings/ai/usage`; user `/settings/ai`, `/settings/ai/agents` (read-only), `/train/plans/new`, `/train/plans/runs/:runId`; admin-only Playground `/ai`
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

Per-user health facts live in their own tables with their own permission family `health_data:read/write` (held by all three roles, withholdable per role). `health_profiles` holds one row per user: date of birth, sex at birth, height, unit system, lab unit preference (US conventional or SI, display only), time zone and a short bio. It is served by `GET/PUT /api/health-profile`, always for the signed-in user, and edited at `/settings/health-profile`. `measurements` is one longitudinal table of values in canonical units, described by an in-code metric registry (body, vital, wellness and lab analytes) and served by `/api/measurements`; an edit supersedes rows instead of overwriting them. The daily readiness check-in (four optional 1 to 5 scores and a note per local day) is stored as `measurements` rows too and served by `/api/check-ins`, with "today" decided by the server in the profile time zone. A reading can also come from a photo: the `body_metric_reading` intake kind (`apps/api/src/measurements/photo/`, see [5.21](#521-photo-intake)) has the server-only job `ai.health.body_metric_reading` draft values from a scale or cuff photo, and its `apply` saves the accepted ones as one entry whose rows carry server-derived provenance. Lab results can come from a lab report the same way: the `lab_report` intake kind (`apps/api/src/measurements/lab-report/`, [specs/health-records.md](specs/health-records.md#210-lab-report-extraction)) has `ai.health.lab_report` transcribe a PDF or page photos, refuses apply while an unmatched analyte is accepted, and saves one lab entry per collection date (a trend report carries a date per result); `GET /api/measurements/lab-reports/:intakeId/duplicates` warns about results already saved and `GET .../issues` lists what apply would refuse per result. The files behind those readings are `health_documents` rows ([specs/health-records.md](specs/health-records.md#211-documents-api)), listed, renamed, downloaded through a 300-second signed URL and deleted by their owner at `/api/health/documents`. An opt-in AI health summary (`apps/api/src/health-summary/`, [specs/health-records.md](specs/health-records.md#214-ai-health-summary-for-the-training-planner)) turns the stored data into one short summary the training planner and evaluator read instead of raw values: the per-user consent lives in `health_summary_settings` (off by default), every committed health write emits `health.data.changed`, and while the consent is on that queues one debounced server-only `ai.health.summary` job, which appends a version to `health_summaries`; `/api/ai/training/health-summary` (`ai:use` plus `health_data:*`) serves the consent, the summary and its staleness. Later health features build on the same permissions, read the profile through `HealthProfileService` and write values through `MeasurementsService`. The health data export (`apps/api/src/health-export/`, [specs/health-records.md](specs/health-records.md#213-export)) is the read-only exception: `POST /api/health/exports` (`health_data:read`) queues the server-only `health.export` job, which reads the profile, measurements and kept-document index directly and writes a JSON, CSV zip, XLSX or PDF file under the `exports/` storage prefix, kept 7 days.

- **Code:** `apps/api/src/health-profile/`, `apps/api/src/measurements/` (photo readings in `photo/`), `apps/api/src/check-ins/`, `apps/web/src/pages/UserHealthProfilePage.tsx`, `apps/web/src/pages/UserHealthDocumentsPage.tsx`
- **UI:** `/settings/health-profile`, `/settings/health-documents`, `/health` (tiles, Daily check-in, Trend and History sections, **Read from photo**), the Today body snapshot and Readiness cards
- **Permissions:** `health_data:read`, `health_data:write`
- **Read more:** [specs/health-data.md](specs/health-data.md), [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md#7-audit-logging-and-security-tables)

### 5.21 Photo intake

A photo intake is the shared path for "share pictures instead of typing" features. `photo_intakes` holds one flow for one user: the photos attached to it (links to storage objects), the draft items an AI job read from them, and the state (`draft`, `scanning`, `ready`, `applied`, `failed`). What is being captured is a registered intake kind (`IntakeKindRegistry`): it validates the kind-specific context and each item value, names the server-only `ai.*` analyzer job, may declare `requiredPermissions` (extra `read` and `write` permissions checked on every route, fail-closed, `403` with `details.reason: MISSING_KIND_PERMISSIONS`), and writes the accepted items as real rows in the transaction that marks the intake applied. The registered kinds are `body_metric_reading` ([specs/health-data.md](specs/health-data.md#217-photo-readings)), `lab_report` ([specs/health-records.md](specs/health-records.md#210-lab-report-extraction), analyzer `ai.health.lab_report`), `gym_equipment` ("Scan gym", [5.22](#522-gyms-and-equipment), analyzer `ai.equipment.scan`) and `workout_prefill` ("Prefill from photo", [5.24](#524-workout-logging), analyzer `ai.workout.prefill`); the first two require `health_data:read/write`, `gym_equipment` `gyms:read/write`, `workout_prefill` `workouts:read`, `workouts:write` and `exercises:write`, on top of `intakes:*`. `PATCH /api/intakes/:id` replaces an intake's context in `draft`, `ready` or `failed` (a source hint, for example) and answers `409` while it is `scanning` or `applied`. The chunk loop and error handling every analyzer job shares live in `apps/api/src/intake/intake-analyzer.ts`. `POST /api/intakes/:id/analyze` re-checks that the chosen model reads images and returns structured output, then enqueues the kind's analyzer job; the job stores its output through `IntakeService.replaceAiDrafts`. AI output is always a draft: the API keeps every item the model returned, records the first AI value of an edited item, and never deletes an AI item (it is rejected instead). The web kit in `apps/web/src/components/intake/` supplies photo picking with client-side downscaling, the provider disclosure and the draft review list.

- **Code:** `apps/api/src/intake/`, `apps/web/src/components/intake/`
- **Permissions:** `intakes:read`, `intakes:write`; analyze also `ai:use` behind `AiEnabledGuard`
- **Read more:** [intake/README.md](../apps/api/src/intake/README.md)

### 5.22 Gyms and equipment

A gym is a named place a user trains (type, description, notes, `isTemporary`), owned by one user; a foreign id answers `404`. The first gym becomes the default automatically, `POST /api/gyms/:id/default` moves the default, and a temporary gym (the hotel flow's) is never the default, and deleting the default promotes the oldest remaining permanent gym in the same transaction. Equipment rows (`gym_equipment`) point at an equipment type from the catalog: the seeded rows every user shares, or the user's own custom types (`custom-` slug prefix, created by `POST /api/equipment-types`, refused while gym equipment uses them). Types enable capabilities (movements), listed by `GET /api/capabilities`. A gym photo attaches an existing, ready, image-typed storage object the caller owns (`POST /api/gyms/:id/photos` with `storageObjectId`; the bytes are uploaded through `/api/storage/objects`) and can be linked to the equipment it shows. Removing a photo or a gym deletes the storage objects after the database write commits. Refusals carry a machine-readable `details.reason` (for example `GYM_LIMIT`, `DEFAULT_CONFLICT`, `EQUIPMENT_TYPE_IN_USE`, `PHOTO_ALREADY_ATTACHED`); the values and every size limit live in `apps/api/src/gyms/gyms.constants.ts`. Equipment written by AI carries an `origin`, a confidence and a write-once `originalAiValue`, so a manual gym works with AI off. Design, the scan job and the reference examples: [specs/gyms-and-equipment.md](specs/gyms-and-equipment.md).

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

A workout is one logged training session of exercises and sets, stored in kilograms and metres, with at most one in progress per user (the raw-SQL partial unique index `workouts_user_in_progress_uniq_idx`). Personal records are computed on read. "Prefill from photo" drafts exercises and sets from a photo through the `workout_prefill` intake kind and the server-only job `ai.workout.prefill`. `POST /api/workouts/quick-cardio` logs a finished gym-free walk, run or hike in one call (no gym, linked to that day's planned session when the plan holds the exercise, no `program_sessions` row). Finishing a workout, or logging one that way, also credits the user's activity goals ([5.31](#531-activity-goals)). Data model, logging semantics, records, the training summary (`GET /api/workouts/summary`), the prefill design and guardrails: [specs/workouts.md](specs/workouts.md).

- **Code:** `apps/api/src/workouts/` (`WorkoutsModule`; limits and refusal reasons in `workouts.constants.ts`), `apps/web/src/pages/TrainPage.tsx`, `WorkoutPage.tsx`, `WorkoutPrefillPage.tsx`, `apps/web/src/components/train/`, `apps/web/src/components/today/TodayWorkout.tsx`, `QuickCardioSheet.tsx`
- **Routes:** `/api/workouts` (including `/summary`, `/quick-cardio`, `/:id/finish`, `/:id/exercises` and `/:id/sets`); details in `/api/docs` (group "Training", tag "Workouts")
- **UI:** `/train`, `/train/workouts/:workoutId`, `/train/workouts/:workoutId/prefill`, and the Today card
- **Permissions:** `workouts:read`, `workouts:write`; prefill also needs `exercises:write`

### 5.25 Training programs

A program is a user's training plan: a tree of blocks, weeks, workouts and exercise prescriptions, stored in kilograms, owner-scoped (another user's program is a 404). No AI is involved in this layer, so manual plans work with AI switched off.

- **Tree:** `Program` > `ProgramBlock` > `ProgramWeek` > `ProgramWorkout` > `ProgramExercise`. Each exercise prescription references an `Exercise` (deletion restricted) and carries optional load and RPE, rest and exactly one of two shapes (below).
- **Prescription shapes.** A prescription is either **reps** (`targetSets`, `repMin`, `repMax`; no duration or distance) or **cardio** (`targetDurationSeconds` 60 to 36,000 and/or `targetDistanceMeters` 100 to 100,000, both the exercise's total for the session; `repMin` and `repMax` null; `targetSets` null or 1 to 20; `restSeconds` stays required). The exercise's tracking mode picks the shape: `weight_reps` and `bodyweight_reps` take reps, `time` takes a duration only, `distance_time` a duration and/or a distance. The rule is the pure `prescriptionMismatch` in `apps/api/src/programs/contracts/prescription.ts`, shared by the API, the guardrails, Today and the signals; the database backstop is the `program_exercises_shape_chk` CHECK. A plan write that breaks it is a 400 with `details.reason: PRESCRIPTION_SHAPE_MISMATCH` and nothing is written. A prescription saved before cardio existed is not re-checked unless it changes, so an unrelated edit or a revert of an old plan still saves.
- **Immutable versions:** every content change bumps `Program.currentVersion` and writes a `ProgramVersion` row holding the full snapshot of the tree, its origin, rationale and evidence. `(programId, versionNumber)` is unique; version rows are never updated.
- **Change log:** every change writes a `ProgramChangeLog` row (kind, actor, status, from and to version, operations, citations, `revertsLogId`). A manual edit or revert logs each changed prescription as an `edit_prescription` operation with a server-written line such as "Week 1, Outdoor walk: 20 → 30 min" (`plan-change-lines.ts`). It is listed newest first with keyset pagination.
- **One write chokepoint:** `ProgramsService.applyChange` is the only writer of an existing tree; manual edits (`PUT /api/programs/:id/structure`), reverts and future agent adaptations all go through it. `createWithTree` is the only other writer (version 1). The write diffs the tree against the stored rows in one transaction and bumps the version with a conditional update on `currentVersion`, so a stale `If-Match` is a 409 `TRAINING_STALE_PLAN` and nothing changes. An archived program refuses edits (`PROGRAM_ARCHIVED`).
- **Revert:** `POST /api/programs/:id/revert` restores a version's tree as a new version (`origin: revert`), or undoes the latest applied change by `changeLogId`, marking that entry `reverted`. History is never rewritten.
- **Archive, not delete:** a workout, week or block that has logged workouts linked to it is archived (`archivedAt`) instead of deleted, so history keeps its link; `DELETE /api/programs/:id` refuses with `PROGRAM_HAS_HISTORY` when any logged workout links in.
- **Today's workout:** the pure resolver `resolve-today.ts` picks the session from the active plan for the calendar day the client sends (its local day, never guessed by the server). A workout of plan week N occurs on the first day of that week's seven-day window whose ISO weekday matches.
  - `GET /api/training/today?date=` (`programs:read`) answers one of the kinds `no_program`, `not_started`, `program_complete` (the plan is marked `completed`, once), `rest_day` (with the next occurrence within 14 days) or `workout` (with the hydrated session and `done` when a completed workout is linked).
  - `POST /api/program-workouts/:id/start` (`programs:read` and `workouts:write`) starts the E4 logger prefilled through `WorkoutsService.startPrefilled` and writes the `ProgramSession` row with the plan version and a planned snapshot, in one transaction. It answers 201, or 200 with `existing: true` when the in-progress workout is already this planned workout (idempotent). 409 reasons in `details.reason`: `PROGRAM_NOT_ACTIVE`, `WORKOUT_IN_PROGRESS` (with `workoutId` to resume), `PROGRAM_WORKOUT_EMPTY`.
  - Prefill rules follow each exercise's `loadGuidance`: `fixed` uses the target load (else the last top set), `from_history` the last top set, `choose_start` none. Sets are uncompleted with `reps = repMin`; a cardio prescription gets its set count (one when open) as empty sets with no reps and no load. The server computes no new prescription.
  - The logged history that archives instead of deleting, and refuses `DELETE /api/programs/:id` with `PROGRAM_HAS_HISTORY`, includes `program_sessions` as well as `workouts.program_workout_id`.
- **Signals:** adherence and progress facts (`GET /api/training/signals`, `programs:read`) are computed on read by a pure aggregator; definitions and limits live in [training-signals.md](specs/training-signals.md).
- **One active program per user:** the raw-SQL partial unique index `programs_one_active_per_user_uniq_idx` (see [§6.1](#61-prisma-models)). Lifecycle: `draft`, `active`, `paused`, `archived`, `completed`.

- **Screens:** `/train/plans` lists the plans (Build manually creates a blank one). `/train/plans/:programId` shows one plan: whether it is AI-generated or manual, its rationale, "how it was made" from the version `meta`, the verified sources with evidence chips, and one week at a time. The same screen's edit mode is the manual builder and saves the whole tree with `PUT /structure` and `If-Match` as a new version; a stale version opens a reload dialog that keeps the edits copyable. `/train/plans/:programId/history` lists the versions with a diff against the previous one (`utils/planDiff.ts`), restores a version and pages the change log. None of these need AI.
- **Code:** `apps/api/src/programs/` (`ProgramsModule`; today's workout in `today/`; contracts in `contracts/`, refusal reasons in `programs.constants.ts`); web `apps/web/src/pages/Train/`, `apps/web/src/components/training/`
- **Routes:** `/api/training/today`, `/api/program-workouts/:id/start` and `/api/programs` (including `/:id/structure`, `/:id/activate`, `/:id/pause`, `/:id/autonomy/resume`, `/:id/archive`, `/:id/duplicate`, `/:id/versions`, `/:id/revert` and `/:id/change-log`); details in `/api/docs` (tag "Programs")
- **UI:** `/train/plans`, `/train/plans/:programId`, `/train/plans/:programId/history`
- **Permissions:** `programs:read`, `programs:write`

### 5.26 Admin Doctor

`GET /api/admin/doctor` runs a set of read-only checks and answers one question: is every capability of this deployment configured, reachable and healthy? Each capability's own module contributes its checks (`<module>/doctor/`), which register themselves with `DoctorCheckRegistry`. `DoctorService` runs them in parallel, skips a check whose dependency did not pass, bounds each with a timeout, caches the report for 15 seconds and always answers `200`: a failing check is a row with a `remedy` and the settings page that fixes it. No check sends, writes, spends tokens or enqueues a job. The AI category includes the per-feature model assignments (training roles included) and web search. The host-level counterpart is `evopathcli deploy doctor` ([§5.9](#59-evopathcli-cli)).

- **Code:** `apps/api/src/doctor/` (contract, registry, service, controller), `apps/api/src/*/doctor/` (the checks)
- **UI:** `/admin/settings/doctor` (`apps/web/src/pages/Admin/DoctorPage.tsx`)
- **Permissions:** `system_settings:read`
- **Read more:** [specs/doctor.md](specs/doctor.md), [runbooks/doctor.md](runbooks/doctor.md)

### 5.27 User data reset

A user can delete everything they own and keep their account. `POST /api/user-data/reset` (with the typed phrase `DELETE MY DATA`) enqueues the server-only `user.data_reset` job, which deletes the user's rows in one transaction and then their stored media. The account, roles, refresh token and audit log are kept; personal access tokens are deleted.

- **Code:** `apps/api/src/user-data/` (the per-user deletion in `user-data-purge.ts` is shared with the factory reset, §5.28)
- **UI:** `/settings/danger-zone` (`apps/web/src/pages/UserDangerZonePage.tsx`)
- **Permissions:** `user_settings:write`
- **Read more:** [specs/user-data-reset.md](specs/user-data-reset.md)

### 5.28 Admin factory reset

An administrator can return the deployment to a fresh install. `POST /api/admin/factory-reset` (with the typed phrase `FACTORY RESET`) enqueues the server-only `admin.factory_reset` job, one active reset deployment-wide. It runs seven idempotent steps, each in its own transaction: job history, every user's data (the shared per-user deletion, the actor included), custom catalog rows, worker node reassignment to the actor, other users, deployment-wide leftovers, then storage objects except backup archives. The actor's account and session, roles, system settings, deployment credentials, AI models, seeded catalogs, worker nodes, backups and the audit log are kept.

- **Code:** `apps/api/src/admin-factory-reset/`, `apps/api/src/user-data/user-data-purge.ts`
- **UI:** `/admin/settings/factory-reset` (`apps/web/src/pages/Admin/FactoryResetPage.tsx`)
- **Permissions:** `system:factory_reset` (Admin only)
- **Read more:** [specs/factory-reset.md](specs/factory-reset.md), [runbooks/factory-reset.md](runbooks/factory-reset.md)

### 5.29 First-run onboarding

A one-time welcome dialog leads into a short checklist: a Setup guide for administrators and a Get started card on Today for everyone else. `GET /api/onboarding` derives every step from real state on each request and never writes; administrator steps reuse the [Doctor](#526-admin-doctor)'s checks. The only stored facts are `welcomeSeenAt`, `checklistDismissedAt` and an optional `goal` in the `onboarding` user-settings namespace, written through `PATCH /api/user-settings`. `GET /api/admin/onboarding/metrics` adds read-only aggregate activation numbers (first completed workout within 7 days of sign-up, over eligible users) to the Setup guide. Entry points of an unconfigured feature (AI, storage, Web Push) show a feature-unavailable notice; storage's state comes from `GET /api/storage/status`.

- **Code:** `apps/api/src/onboarding/`, `apps/web/src/components/onboarding/`, `apps/web/src/pages/Admin/SetupGuidePage.tsx`
- **UI:** welcome dialog (every signed-in page), Today cards, `/admin/settings/setup`
- **Permissions:** `user_settings:read` (the endpoint); the `admin` block, the Setup guide and the metrics endpoint need `system_settings:read`; `GET /api/storage/status` needs `storage:read`
- **Read more:** [specs/onboarding.md](specs/onboarding.md)

### 5.30 AI Coach

The AI Coach (`apps/api/src/coach/`, module `CoachModule`) is an accountability coach with a chosen persona. Seven personas live in an in-code registry (`coach/personas/`), each with a style card, an intensity rubric for levels 1 to 3, a default voice and static sample lines for every moment; `GET /api/coach/personas` serves it. `resolveRegister` (`coach/personas/resolve-register.ts`) is the single answer to whether profanity is allowed: only Sarge at level 3, with the deployment's `allowProfanePersonas`, an adult user (a health-profile date of birth under 18 always refuses) and the user's opt-in. Every coach-written string passes the pure content guard `coach/guard/coach-content-guard.ts`, whose lists live in code. `GET/PUT /api/coach/settings` reads and writes the `coach` user-settings namespace with the unlock rules applied; `GET/PUT /api/admin/coach/settings` reads and writes the `coach` system setting.

The rest of the module is split by concern. A pure decision engine (`coach/planning/plan-coach-moments.ts`, no Nest or Prisma import) decides when the coach may speak; the hourly `coach.sweep` (a cron that only enqueues), `coach.workout_finished` (a finished workout) and `coach.activity_recorded` (a goal check-in, from the `activity.entry.recorded` event) run it, and `coach_states` holds each user's scheduling state (caps, pause, silence, weekly streak). `ai.coach.nudge` asks the `coach.decision` model whether to speak and what to say, runs the content guard, persists a `coach_messages` row and queues `coach.message.deliver`, which raises the notification after the write commits. Audio is made only on request (#259): `POST /api/coach/messages/:id/audio` (the **Listen** button) asks the existing `ai.audio.speech` job for a clip, `coach.audio.settle` records the result without notifying, and `coach.audio.purge` deletes audio past the retention. A learning loop (`coach/learning/`) picks each nudge's angle. `POST /api/coach/chat/stream` streams a persona-voiced chat with read-only tools (including `get_goals`) plus one pause tool, `ai.coach.weekly_review` writes the weekly review and its email, and `GET /api/admin/coach/stats` serves aggregate engagement. Progress photos are a separate module, `apps/api/src/progress-photos/` (`progress_photos`, `/api/progress-photos`, permissions `health_data:read/write`, no `AiEnabledGuard`), because the gallery works with AI off. The coach also speaks about the user's activity goals (`goal_at_risk`, `goal_hit`, once per goal per period; goals in the weekly review and its email), reading them through `GoalProgressService` ([§5.31](#531-activity-goals)). Every number a coach message quotes comes from the training signals or the goal progress; the model never supplies one. Every coach job is server-only (inventory in [§8.1](#81-job-type-inventory)).

On the web, `/coach` is the timeline (nudges, chat, reviews, photo prompts), Today carries a coach hero and card, Coach is the fourth primary destination while it is visible to the user (AI on and `ai:use`) and Gyms keeps that slot otherwise (`primaryWhenHidden` in `apps/web/src/config/destinations.ts`, see [§9.3](#93-layout-and-breakpoint)), `/settings/coach` and `/admin/settings/coach` are the settings pages ([§9.2](#92-settings-pages)), and the Coach section of the AI Model Assignments page assigns the three coach features. Notifications use four events, `coach.nudge`, `coach.celebration`, `coach.photo_prompt` and `coach.weekly_review` (the review also by email), none mandatory. A push may carry one action button, "Hear Coach", plus `data.messageId`; the service worker opens the action's link ([specs/browser-notifications.md](specs/browser-notifications.md#27-web-push)). A user's "Delete all my data" and the factory reset remove the three models and their audio and photo objects. The onboarding `ai_plan` step becomes "Meet your coach" once a plan exists, and activating a plan triggers a kickoff message ([specs/onboarding.md](specs/onboarding.md)).

- **Code:** `apps/api/src/coach/`, `apps/api/src/progress-photos/`, `apps/web/src/pages/CoachPage.tsx`, `apps/web/src/components/coach/`
- **Routes:** `/api/coach/*`, `/api/admin/coach/*`, `/api/progress-photos` (reference in `/api/docs`)
- **UI:** `/coach`, `/settings/coach`, `/health/progress-photos`; admin `/admin/settings/coach`
- **Permissions:** `ai:use` behind `AiEnabledGuard` (`/api/coach/*`; chat and `GET /api/coach/state` also need `programs:read`); `ai_config:read`/`ai_config:write`, not behind it (`/api/admin/coach/*`); `health_data:read`/`health_data:write` (`/api/progress-photos`)
- **Read more:** [specs/ai-coach.md](specs/ai-coach.md), [runbooks/ai-coach.md](runbooks/ai-coach.md)

### 5.31 Activity goals

A goal is an everyday-activity target ("walk 4 times a week", "150 minutes of cardio a week", "8,000 steps a day") that sits beside the training plan, not inside it: the plan stays one active program per user, and up to ten goals can be active at once. The user checks in by hand (I did it, minutes or steps, up to seven days back) and a finished workout credits matching goals by materialising `activity_entries` rows (source `workout`). Per local day the highest source wins (integration over workout over manual), steps count as a daily maximum and weeks start on Monday in the Health Profile time zone. The server computes progress, on-track state and streaks; the web draws them. A `workout.finished` listener keeps the derived entries current and every progress read reconciles the last 14 local days. Imported activity enters the same rules through the Android Health Connect sync ([5.32](#532-android-health-connect-sync)); other providers (Oura, Samsung Health, Apple Health) are not built. Design, counting rules, lifecycle and extension recipes: [specs/activity-goals.md](specs/activity-goals.md).

- **Code:** `apps/api/src/activity/` (`ActivityModule`; limits, refusal reasons and templates in `activity.constants.ts`; pure rules in `goal-progress.ts` and `workout-activity.ts`), `apps/web/src/pages/Train/GoalsPage.tsx`, `apps/web/src/components/goals/`, `apps/web/src/components/today/TodayGoals.tsx`
- **Routes:** `/api/goals` (including `/templates`, `/progress`, `/:id/history` and the `pause`, `resume` and `archive` actions) and `/api/activity-entries` (including `/batch`); details in `/api/docs` (tags "Goals" and "Activity entries")
- **UI:** `/train/goals` (a Train destination, not a settings page) and the Today "Goals" card
- **Permissions:** `goals:read`, `goals:write`
- **Read more:** [specs/activity-goals.md](specs/activity-goals.md)

### 5.32 Android Health Connect sync

An optional sideloaded Android app (`apps/android/`, package `com.<repo>.android`, derived from `identity.json`) pairs with the deployment and imports Health Connect data. It is a Trusted Web Activity around the web app plus a native Kotlin module that reads steps, exercise sessions, heart rate, resting heart rate, heart rate variability, weight, body fat, blood pressure and sleep, and posts them hourly to `/api/health-sync`. The phone pairs through the device flow (a `pat_` token, `DEVICE_PAT_EXPIRY_DAYS`, 90 days by default), registers a device row that links the token, and uploads idempotent syncs. Activity entries (`source: integration`, provider `health_connect:<deviceId>`) feed activity goals, measurements (`origin: device`) land in the health store and sleep in `sleep_sessions`, each upserted through a raw-SQL partial unique index. A sync with a window and status `ok` deletes the device's rows the phone no longer holds, only for the data types it names in `run.details.syncedTypes`. The request guard stamps `request.authCredential` (`jwt`, `pat` with the token id, or `node`) so the registering call can link its own token. Administrators trust the app's signing certificate at `/admin/settings/android` (the `android_app` system setting), and the public `/.well-known/assetlinks.json` lets Chrome open the app full screen. The deployment also hosts the APK itself: an administrator (or `evopathcli android publish`) uploads signed releases into object storage (`android_app_releases`, one current), users download the current one through a ten-minute signed link, and each device view says whether an update is available. The phone's self-test report is stored per device and shown at `/settings/connected-devices`. CI (`.github/workflows/android.yml`) builds the APK and publishes it to the rolling prerelease `android-latest`.

- **Code:** `apps/api/src/health-sync/`, `apps/api/src/sleep/`, `apps/api/src/android-app/` (with `doctor/`), `apps/api/src/auth/decorators/auth-credential.decorator.ts`, `apps/android/`, `apps/web/src/pages/ConnectedDevicesPage.tsx`, `apps/web/src/pages/Admin/AndroidAppPage.tsx`, `apps/web/src/components/health/SleepSection.tsx`
- **Routes:** `/api/health-sync` (devices, sync, runs, diagnostics), `/api/sleep`, `/api/admin/android-app`, `/api/admin/android-app/releases` (upload, list, make current, delete), `/api/android-app/releases/latest`, `/api/android-app/releases/:id/download-link`, `/api/android-app/download/:token` (public, token-validated), `/api/well-known/assetlinks.json` (public, served at `/.well-known/assetlinks.json` by nginx); details in `/api/docs` (tags "Health sync", "Sleep", "Android App")
- **UI:** `/settings/connected-devices`, `/admin/settings/android`, the Health page "Sleep" section
- **Permissions:** `goals:read`, `goals:write` (health sync); `health_data:read`, `health_data:write` (sleep, and measurements or sleep in a sync); `system_settings:read`, `system_settings:write` (trusted apps)
- **Read more:** [specs/health-connect-sync.md](specs/health-connect-sync.md), [runbooks/android-app.md](runbooks/android-app.md); why it is a TWA plus a native module and how to add another native capability: [specs/native-companion-architecture.md](specs/native-companion-architecture.md)


### 5.33 User memory

The coach and the training planner remember a short list of durable facts per user (`apps/api/src/memory/`, module `MemoryModule`): one sentence each, at most `memory.maxPerUser` (200) active, every one visible, editable and deletable by the user. `MemoryService` is the one writer: it validates every write against instruction-like text, links, code, secrets, financial, phone and third-party data, gates agent writes on the system and user `memory.enabled`, raises health facts to `sensitivity = health` (refused while the user's `allowHealth` is off), deduplicates (normalized exact match, then `pg_trgm` similarity above 0.8 in the same category) and enforces the cap (an extracted add evicts the oldest unpinned extracted fact; any other add is `409`). Three writers share it: the coach chat's `remember`/`forget`/`update_memory` tools (each change a `memory` SSE frame), the background `ai.memory.extract` job (5 minutes after a chat turn, deduplicated per user; extract-then-decide ADD/UPDATE/DELETE/NOOP, never touching what the user wrote), and `/api/memories`. `MemoryContextService.buildBlock` renders the read path: a delimited `<user_memories>` block marked as untrusted data, ordered pinned, injuries, goals, newest, about 1,500 tokens, into the coach chat instructions, the nudge and weekly review data text, and the planner context (training categories only). Soft-deleted and replaced facts are hard-deleted by `memory.purge` after `memory.purgeAfterDays`.

- **Code:** `apps/api/src/memory/`, `apps/api/src/coach/chat/tools/memory.tools.ts`
- **Routes:** `/api/memories`, `/api/memories/:id`, `/api/memories/:id/restore` (reference in `/api/docs`); settings through `PATCH /api/user-settings` (`memory`)
- **Permissions:** `ai:use` behind `AiEnabledGuard`; owner-scoped (a foreign id is `404 MEMORY_NOT_FOUND`)
- **Read more:** [specs/ai-memory.md](specs/ai-memory.md), [runbooks/ai-coach.md](runbooks/ai-coach.md#memory)

---

## 6. Data architecture

### 6.1 Prisma models

The schema is `apps/api/prisma/schema.prisma`. Its block comments carry per-column reasoning. All 74 models, grouped by subsystem:

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
| RBAC | `Permission` | `permissions` | The 44 `resource:action` permissions |
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
| AI | `TrainingPlanRun` | `training_plan_runs` | One agent run: `kind`, `trigger`, `status`, `stage`, frozen `roleModels` and `tokenCap`, `usage`, `result`, `pendingDecision`, `resumeCount`, `jobIds`; `programId` is a plain column (no foreign key); at most one active run per user, enforced by the raw-SQL partial unique index `training_plan_runs_active_per_user_uniq_idx`, which excludes kind `adapt` |
| AI | `TrainingRunEvent` | `training_run_events` | Replayable run event with a per-run gapless `seq` (unique with `runId`), `type`, `stage`, key-free `data`; cascade on the run |
| AI | `TrainingRunCheckpoint` | `training_run_checkpoints` | Graph checkpoint per `(threadId, checkpointNs, checkpointId)`, node outputs only, no foreign key |
| AI | `TrainingRunCheckpointWrite` | `training_run_checkpoint_writes` | Pending writes and interrupts of a checkpoint, keyed by plain `threadId` |
| Health | `HealthProfile` | `health_profiles` | One row per user: date of birth, sex at birth, height (mm), unit system, lab units (`conventional` or `si`), time zone, bio, version |
| Health | `Measurement` | `measurements` | One reading per row in the metric's canonical unit: entry, metric key, method, origin, revision chain (`supersedesId`), soft delete; daily check-in scores are rows with `localDate` set; a device reading (Health Connect sync) also carries `externalProvider`, `externalId` and `healthSyncDeviceId`, unique through the raw-SQL partial unique index `measurements_provider_external_uniq_idx`; lab results add a nullable reference range (`referenceLow`, `referenceHigh`, `referenceText`) and `flag` |
| Health | `HealthSummarySetting` | `health_summary_settings` | One row per user who set the opt-in "Use my health data in training plans and coach chat" (training plans use the AI health summary; the coach chat may read it and look up biomarker values): `enabled` (no row is off), `consentedAt` |
| Health | `HealthSummary` | `health_summaries` | The AI health summary, one row per generation attempt (append-only, `version` unique per user): status (`ready`, `failed`), narrative, training considerations, `dataAsOf`, `inputsAsOf`, `inputsHash` of the digest, provider, model, regenerations, error code, job id |
| Intake | `PhotoIntake` | `photo_intakes` | One photo-to-draft flow per row: kind, status, kind-specific context, chosen provider and model, analyze job, error, result metadata |
| Intake | `PhotoIntakePhoto` | `photo_intake_photos` | Link from an intake to a `storage_objects` row, unique per `(intakeId, storageObjectId)`, with sort order |
| Intake | `HealthDocument` | `health_documents` | A user's health document (lab report, body-metric photo): kind, file metadata, keep or delete-after-processing retention, optional intake and storage object links, `fileDeletedAt` once purged, `version` for `If-Match` |
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
| Training | `Program` | `programs` | One training plan per row: `name`, `goal`, `status` (`draft`, `active`, `paused`, `archived`, `completed`), `source`, `autonomy` (`autonomous`, `ask_first`), optional `gymId` (set null when the gym is deleted), `intake` JSON, `currentVersion`, continuous-evaluation state (`evaluationRequestedAt` the coalescing flag, `lastEvaluatedAt`, `lastWeeklyEvaluationAt`, `autonomyPausedAt` with `autonomyPausedReason` of `safety_text`, `pain_pattern` or `user_paused`); at most one `active` row per user, enforced by the raw-SQL partial unique index `programs_one_active_per_user_uniq_idx` |
| Training | `ProgramBlock` | `program_blocks` | A phase of a program at a `position`, with optional `focus`; `archivedAt` set instead of deletion when logged history exists |
| Training | `ProgramWeek` | `program_weeks` | A week of a block (`weekNumber`, `isDeload`); cascade on the block; archived like blocks |
| Training | `ProgramWorkout` | `program_workouts` | A planned session in a week: `position`, optional `weekday` (1 to 7), estimated minutes; logged workouts link to it through `workouts.program_workout_id` (set null on delete) |
| Training | `ProgramExercise` | `program_exercises` | One prescription: exercise, `position`, `isPriority`, either reps (target sets, rep range) or cardio (`targetDurationSeconds`, `targetDistanceMeters`, optional sets), optional load (kg) and RPE, rest, `loadGuidance`, evidence refs; the shape and value ranges are guarded by the `program_exercises_shape_chk` CHECK |
| Training | `ProgramVersion` | `program_versions` | Immutable full snapshot of a program's tree per `versionNumber` (unique with `programId`), with `origin`, rationale, evidence, optional plain `runId` |
| Training | `ProgramChangeLog` | `program_change_log` | One change to a program: `kind` (`created`, `adapted`, `edited`, `reverted`, `reviewed`; a `reviewed` row records an evaluation that changed nothing or a safety stop, with equal from and to version and no version bump), `actor` (`ai`, `user`, `system`), `status` (`applied`, `reverted`, ...), from and to version, `operations`, `citations`, `revertsLogId`, `seenAt`; indexed by `(programId, createdAt DESC)` |
| Training | `ProgramSession` | `program_sessions` | Link between a planned workout and the logged workout started from it: unique `workoutId` (cascade with the workout), `programWorkoutId` (set null on delete), the plan `versionNumber`, the `plannedSnapshot` JSON of the prescription taken at start, and `plannedFor` |
| Training | `WorkoutAdaptation` | `workout_adaptations` | One quick "adjust today's workout" request and its result: `status` (`queued`, `running`, and terminal states), `request`, optional `gymId` (set null when the gym is deleted), `baseRef`, `proposal`, `guardrailReport`, `criticReport`, `safety`, `models`, `runId` and `jobId` as plain columns, `errorCode`, the `applied*` columns and `expiresAt` (30 days); cascade on the user; at most one `queued` or `running` row per user, enforced by the raw-SQL partial unique index `workout_adaptations_active_per_user_uniq_idx` |
| Activity | `ActivityGoal` | `activity_goals` | One everyday-activity target: `title`, `activityKind` (`walk`, `run`, `cardio_any`, `workout_any`, `custom`), `customLabel`, `metric` (`sessions`, `minutes`, `steps`, `distance_m`), `target`, `period` (`week`, `day`), `status` (`active`, `paused`, `archived`), `startsOn`, `version`; cascade from the user; CHECKs keep the target positive, a `sessions` goal weekly and `steps` out of the kind |
| Activity | `ActivityEntry` | `activity_entries` | One unit of activity on a local day: `occurredOn`, `activityKind` (a goal's kinds plus `steps`), `completed`, optional `durationSeconds`, `steps`, `distanceMeters`, `source` (`manual`, `workout`, `integration`), optional `workoutId` (cascade with the workout), optional `provider` and `externalId`, `note`; cascade from the user; two raw-SQL partial unique indexes (below) |
| Health sync | `HealthSyncDevice` | `health_sync_devices` | One paired phone per `(userId, installationId)`: name, model, Android version, app version and `appVersionCode`, package name and signing SHA-256, phone time zone, `patId` (the linked personal access token, set null when it is deleted), `status` (`active`, `revoked`), last seen and last sync fields; cascade from the user |
| Health sync | `HealthSyncRun` | `health_sync_runs` | One sync attempt of a device: trigger, status (`ok`, `partial`, `failed`, `skipped`), start and finish, window, counts, error, `details` JSON (the phone's per-type counts and the server's `details.server`); newest 200 kept per device |
| Health sync | `HealthSyncDiagnosticReport` | `health_sync_diagnostic_reports` | An uploaded phone self-test report (JSON, at most 256 KB); newest 20 kept per device |
| Android | `AndroidAppRelease` | `android_app_releases` | One hosted APK: `packageName`, `versionName`, `versionCode` (unique with `packageName`), `signingSha256`, `fileSha256`, `sizeBytes`, `storageKey` (the object under `android-releases/`), `notes`, `isCurrent`, `uploadedById` (set null when the user is deleted); at most one current release deployment-wide, enforced by the raw-SQL partial unique index `android_app_releases_one_current_uniq_idx`; a deployment artifact kept by both resets |
| Health | `SleepSession` | `sleep_sessions` | One night: `startAt`, `endAt`, `localDate` (day of waking), asleep minutes and optional stage minutes, `origin` (`manual`, `device`), `provider`, `externalId`, optional `healthSyncDeviceId` (set null when the device is deleted); CHECKs keep the times ordered and the minutes in range; device rows are unique through the raw-SQL partial unique index `sleep_sessions_provider_external_uniq_idx` |
| Coach | `CoachMessage` | `coach_messages` | One timeline message, every kind in one table: `role` (`coach`, `user`), `kind` (`nudge`, `chat`, `weekly_review`, `celebration`, `photo_prompt`, `comeback`, `kickoff`, `system`), `moment`, bandit `angle`, persona and intensity, title and body, lock-screen `pushTitle`/`pushBody`, `audioStatus` (`none`, `pending`, `ready`, `failed`) with the audio `StorageObject` (set null so retention can purge the file and keep the text), plain `audioRunId`, `aiRunId` and `notificationId` columns, `data` JSON, `deliveredAt`, `openedAt`, `convertedAt`, `feedback` (`up`, `down`); cascade from the user |
| Coach | `CoachState` | `coach_states` | One row per user (unique `userId`): `lastNudgeAt`, `nudgesToday` with its local day, `consecutiveIgnored`, `pausedUntil`, `silencedAt`, `lastSweepAt`, `usualWorkoutMinuteLocal`, `weeklyStreak`, `streakPassesLeft`, `lastWeeklyReviewWeek` (ISO week key), `chatClearedAt` (the last chat **Start over**, #323) |
| Memory | `UserMemory` | `user_memories` | One remembered fact about a user (#325, [ai-memory.md](specs/ai-memory.md)): `content` (one sentence, at most 300 characters, validated against instructions, links, code, secrets, financial, phone and third-party data), `category`, `source` (`explicit`, `extracted`, `user_edited`), `sensitivity` (`normal`, `health`), `status` (`active`, `superseded`, `deleted`) with `supersededById` (self, set null) and `deletedAt`, `sourceMessageId` (a coach message, set null), `confidence`, `pinned`, `lastUsedAt`; GIN `gin_trgm_ops` index `user_memories_content_trgm_idx` for near-duplicates (the `pg_trgm` extension is created in the migration); cascade from the user |
| Memory | `UserMemoryState` | `user_memory_states` | One row per user (unique `userId`): the server-managed extraction watermark `lastExtractedAt`, `extractionsToday` and its UTC day |
| Coach | `ProgressPhoto` | `progress_photos` | One progress photo: `localDate`, `pose` (`front`, `side`, `back`, `other`), a note of at most 200 characters no model reads, and the image `StorageObject` (cascade) |

Conventions: UUID primary keys, `timestamptz` timestamps, JSONB for extensible shapes, cascade deletes from `users` where the data belongs to the user. Users are deactivated, not deleted.

Twelve indexes exist only in hand-written migration SQL because Prisma cannot express a partial unique index: `jobs_active_dedup_uniq_idx` (job deduplication while `pending`/`running`), `database_backup_runs_active_uniq_idx` (at most one active backup run), `gyms_user_default_uniq_idx` (one default gym per user), `workouts_user_in_progress_uniq_idx` (one in-progress workout per user), `training_plan_runs_active_per_user_uniq_idx` (one active training run per user, not counting kind `adapt`), `programs_one_active_per_user_uniq_idx` (one active program per user), `workout_adaptations_active_per_user_uniq_idx` (one queued or running adaptation per user), `activity_entries_provider_external_uniq_idx` (one entry per user, provider and external id where a provider is set, so a re-sent reading replaces its earlier row) `activity_entries_workout_kind_uniq_idx` (one workout-derived entry per workout and kind), `measurements_provider_external_uniq_idx` (one device reading per user, external provider and external id), `sleep_sessions_provider_external_uniq_idx` (one device sleep session per user, provider and external id) and `android_app_releases_one_current_uniq_idx` (at most one current Android release). This is intentional schema drift. Do not add a `@@unique` to the models to "fix" it.

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

`user_settings.value` namespaces (`userSettingsSchema`): `theme`, `profile` (display name, image source, uploaded image), and the optional `dataTables`, `navigation`, `notifications` (per-event channel preferences), `ai` (`training` limits only; models are chosen by administrators in the `ai.assignments` system setting) and `onboarding` (`welcomeSeenAt`, `checklistDismissedAt`, `goal`: UI state only, step completion is derived; see [specs/onboarding.md](specs/onboarding.md)). An absent optional namespace means "use the defaults".

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
| `system_settings:read` | ✓ | | | Read system settings, email, notification policy, maintenance, About; run the Doctor (`GET /api/admin/doctor`, `/admin/settings/doctor`); reach `/admin/settings`; view the telemetry services status |
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
| `ai_config:read` | ✓ | | | View AI configuration, model catalog, model assignments, usage report, the coach policy (`GET /api/admin/coach/settings`) |
| `ai_config:write` | ✓ | | | Change AI configuration, admin keys, models, model assignments, the coach policy (`PUT /api/admin/coach/settings`); refresh the catalog |
| `ai:use` | ✓ | ✓ | | Call AI and manage own AI keys (`/api/ai/*` except `GET /api/ai/config`); use the AI Coach (`/api/coach/*`) and manage own memories (`/api/memories`) |
| `telemetry:read` | ✓ | | | View the telemetry policy and store status; reach `/admin/settings/telemetry` |
| `telemetry:write` | ✓ | | | Change telemetry policy (retention, query bounds, the AI assistant); save, test or reset the GreptimeDB connection |
| `telemetry:query` | ✓ | | | Run explorer queries, export results, use the telemetry AI assistant (with `ai:use`), view the telemetry dashboard |
| `system:factory_reset` | ✓ | | | Reset the deployment's application data to a fresh install (irreversible; Admin only) |
| `health_data:read` | ✓ | ✓ | ✓ | Read own health data (`GET /api/health-profile`, `GET /api/measurements*`, `GET /api/check-ins*`, `GET /api/health/documents*`); export it (`POST /api/health/exports`, `GET /api/health/exports*`); reach `/settings/health-profile` and `/settings/health-documents`; with `intakes:read`, `GET /api/measurements/lab-reports/:intakeId/duplicates` and `.../issues`; with `ai:use`, `GET /api/ai/training/health-summary` |
| `health_data:write` | ✓ | ✓ | ✓ | Change own health data (`PUT /api/health-profile`, `POST/PATCH/DELETE /api/measurements`, `PUT/DELETE /api/check-ins/:date`, `PATCH/DELETE /api/health/documents/:id`); with `ai:use`, `PUT /api/ai/training/health-summary/consent` and `POST /api/ai/training/health-summary/refresh` |
| `intakes:read` | ✓ | ✓ | ✓ | Read own photo intakes and their draft items (`GET /api/intakes*`); a kind's own `requiredPermissions.read` is also needed (`body_metric_reading` and `lab_report`: `health_data:read`, `gym_equipment`: `gyms:read`, `workout_prefill`: `workouts:read`) |
| `intakes:write` | ✓ | ✓ | ✓ | Create, edit, apply and discard own photo intakes (`POST/PATCH/DELETE /api/intakes*`); `POST /api/intakes/:id/analyze` also needs `ai:use`, and a kind's own `requiredPermissions.write` is also needed (`body_metric_reading` and `lab_report`: `health_data:write`, `gym_equipment`: `gyms:write`, `workout_prefill`: `workouts:write` and `exercises:write`) |
| `gyms:read` | ✓ | ✓ | ✓ | Read own gyms, their equipment and the equipment catalog (`GET /api/gyms*`, `GET /api/equipment-types`, `GET /api/capabilities`) |
| `gyms:write` | ✓ | ✓ | ✓ | Create, edit and delete own gyms, equipment and custom equipment types (`POST/PATCH/DELETE /api/gyms*`, `/api/equipment-types*`); gym photo attach and remove also need `storage:write` |
| `exercises:read` | ✓ | ✓ | ✓ | Read the exercise library and own custom exercises (`GET /api/exercises*`) |
| `exercises:write` | ✓ | ✓ | ✓ | Create, edit, approve and delete own custom exercises (`POST/PATCH/DELETE /api/exercises*`, `POST /api/exercises/:id/approve`) |
| `workouts:read` | ✓ | ✓ | ✓ | Read own workouts, exercises and sets (`GET /api/workouts*`) |
| `workouts:write` | ✓ | ✓ | ✓ | Start, edit, finish and delete own workouts, their exercises and sets (`POST/PATCH/DELETE /api/workouts*`) |
| `programs:read` | ✓ | ✓ | ✓ | Read own training programs, versions and change log (`GET /api/programs*`) |
| `programs:write` | ✓ | ✓ | ✓ | Create, edit, activate, pause, archive, duplicate, revert and delete own programs (`POST/PATCH/PUT/DELETE /api/programs*`) |
| `goals:read` | ✓ | ✓ | ✓ | Read own activity goals, progress, history and entries (`GET /api/goals*`, `GET /api/activity-entries`); reach `/train/goals` and see the Today Goals card |
| `goals:write` | ✓ | ✓ | ✓ | Create, edit, pause, resume and archive own goals, log, edit and delete own check-in entries (`POST/PATCH/DELETE /api/goals*`, `/api/activity-entries*`) |

**Note on `storage:*`.** `GET /api/storage/status` (a `configured` boolean) and every `/api/storage/objects` route require `storage:read` (list, get, download) or `storage:write` (uploads, metadata updates, delete). Ownership is enforced on top: a caller may act only on their own objects unless they also hold `storage:delete_any`, which lifts the ownership check for delete on every object except another user's profile image (removed only via `DELETE /api/user-settings/profile-image` by its owner).

Separate permission families (`push:*`, `nodes:*`, `storage_config:*`, `ai_config:*`, `db_backup:restore`, `telemetry:*`, `health_data:*`, `intakes:*`, `gyms:*`, `exercises:*`, `workouts:*`, `programs:*`, `goals:*`) exist because each gates something with a distinct blast radius. Folding them into `system_settings:*` would hand that authority to anyone granted routine settings access. See [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md) for the design.

---

## 8. Background work

### 8.1 Job-type inventory

All 47 registered job types. Handler paths are relative to `apps/api/src/`. A type is node-eligible when its handler carries both `nodeResultSchema` and `persistNodeResult`.

| Type | Handler | What it does | Node-eligible |
|---|---|---|:-:|
| `ai.catalog.refresh` | `ai/catalog/ai-catalog-refresh.handler.ts` | Syncs one provider's model catalog with the admin key; daily and on admin request | No |
| `ai.response.run` | `ai/runtime/ai-response-run.handler.ts` | Executes one background AI response | No |
| `ai.image.generate` | `ai/runtime/ai-image-generate.handler.ts` | One image generation or edit; outputs become the user's storage objects | No |
| `ai.audio.transcribe` | `ai/runtime/ai-audio-transcribe.handler.ts` | Streams a user's recording to the provider; stores the transcript on the run | No |
| `ai.audio.speech` | `ai/runtime/ai-audio-speech.handler.ts` | Text-to-speech; the audio becomes the user's storage object | No |
| `ai.usage.purge` | `ai/usage/ai-usage-purge.handler.ts` | Deletes `ai_usage_events` past `ai.usageRetentionDays`, in batches; daily | No |
| `ai.health.body_metric_reading` | `measurements/photo/body-metric-reading.handler.ts` | Reads a scale or blood-pressure-cuff photo into pending draft readings for a `body_metric_reading` intake | No |
| `ai.health.lab_report` | `measurements/lab-report/lab-report.handler.ts` | Transcribes a lab report (PDF or page photos) of a `lab_report` intake into pending draft lab results, matched to the lab catalog and converted to canonical units by the server, with a collection date per result, plus the report date and lab name in the intake's context | No |
| `ai.health.summary` | `health-summary/health-summary.handler.ts` | Writes the opt-in AI health summary from the server-built health digest through the `health_summary` feature's model, post-checks it (one regeneration, then failed) and appends a version to `health_summaries`; debounced after a health write or on refresh, one per user at a time (dedup); profile 4 minutes, 1 attempt | No |
| `ai.keys.recheck` | `ai/keys/ai-keys-recheck.handler.ts` | Re-verifies stale user keys for one provider, refreshes reachable models | No |
| `ai.equipment.scan` | `gyms/scan/equipment-scan.handler.ts` | "Scan gym": sends a `gym_equipment` photo intake's photos to the user's vision model in batches of 16 and stores the equipment drafts for review | No |
| `ai.workout.prefill` | `workouts/prefill/workout-prefill.handler.ts` | "Prefill from photo": sends a `workout_prefill` photo intake's photos (machine placard, notebook, whiteboard) to the user's vision model in chunks of 16 and stores one exercise draft per line, with the written sets converted to kg | No |
| `ai.training.plan.run` | `training-agents/runtime/training-plan-run.handler.ts` | Executes one training agent graph run with checkpoints; profile 25 minutes, 1 attempt; a resume is a new job for the same run | No |
| `ai.training.adapt.run` | `training-adaptation/handlers/adaptation-run.handler.ts` | Executes one quick workout adaptation (planner, light critic, at most one revise) on a `training_plan_runs` row of kind `adapt`; profile 5 minutes, 1 attempt; server-only | No |
| `coach.sweep` | `coach/planning/handlers/coach-sweep.handler.ts` | Plans every coach-enabled user's next moment through the pure decision engine, in pages with a cursor continuation; enqueued hourly (minute 17) by a cron that only enqueues, only while AI and the coach are on; profile 5 minutes, 2 attempts; server-only | No |
| `coach.workout_finished` | `coach/planning/handlers/coach-workout-finished.handler.ts` | Plans the event moments (`comeback`, `pr`, `weekly_target_hit`, `goal_hit`) for one user after a finished workout, through the same gates; profile 1 minute, 2 attempts; server-only | No |
| `coach.activity_recorded` | `coach/planning/handlers/coach-activity-recorded.handler.ts` | Plans `goal_hit` for one user after a manual goal check-in (`activity.entry.recorded`), through the same gates; profile 1 minute, 2 attempts; server-only | No |
| `ai.coach.nudge` | `coach/nudges/handlers/coach-nudge.handler.ts` | Asks the `coach.decision` model whether to speak and what to say, runs the content guard (one regeneration, then a static persona line), persists the `coach_messages` row and queues delivery; profile 2 minutes, 2 attempts | No |
| `ai.coach.weekly_review` | `coach/review/handlers/coach-weekly-review.handler.ts` | Writes the weekly review (server-built stats, model prose, static fallback), updates the weekly streak and queues delivery; one per user per ISO week; profile 3 minutes, 2 attempts | No |
| `ai.memory.extract` | `memory/extraction/memory-extract.handler.ts` | Learns durable facts from one user's own chat messages since the watermark (coach replies as context only): extract candidates, then decide ADD / UPDATE / DELETE / NOOP per candidate against the same-category memories with the `memory.extract` model; never changes an explicit or user-edited memory; enqueued 5 minutes after each chat turn, deduplicated per user; daily cap per user; profile 2 minutes, 2 attempts | No |
| `memory.purge` | `memory/purge/memory-purge.handler.ts` | Hard-deletes deleted and superseded memories older than `memory.purgeAfterDays`, in batches; enqueued by a daily 04:00 cron that only enqueues; server-only (writes as it goes), profile 5 minutes, 3 attempts | No |
| `coach.message.deliver` | `coach/nudges/handlers/coach-message-deliver.handler.ts` | Raises the `coach.*` notification for one persisted message after its write committed; skips a message already delivered; profile 1 minute, 3 attempts; server-only | No |
| `coach.audio.settle` | `coach/audio/handlers/coach-audio-settle.handler.ts` | Maps a settled `ai.audio.speech` run (or the 2-minute wait cap) to its message as `ready` or `failed`; never notifies for an on-demand (Listen) request; profile 30 seconds, 3 attempts; server-only | No |
| `coach.audio.purge` | `coach/audio/handlers/coach-audio-purge.handler.ts` | Deletes coach audio older than `coach.audioRetentionDays`, keeping the message text; enqueued daily at 03:23 UTC by a cron that only enqueues; profile 10 minutes, 2 attempts; server-only | No |
| `gyms.temporary.purge` | `gyms/handlers/temporary-gym-purge.handler.ts` | Deletes temporary gyms unchanged for 30 days that no workout, live adaptation, holding program or scanning intake references, and their storage objects; enqueued by a daily 03:30 cron that only enqueues; server-only, default profile | No |
| `health.document.purge` | `health-documents/handlers/health-document-purge.handler.ts` | Erases one `delete_after_processing` health document's file through `ObjectsService.delete`, stamps `file_deleted_at`, audits `health:document:delete`; enqueued inside the transaction that applies or discards a health intake, or with `reason: user_delete` (any retention) by `DELETE /api/health/documents/:id`; server-only (it deletes storage objects), profile 5 minutes, 8 attempts | No |
| `health.export` | `health-export/handlers/health-export.handler.ts` | Writes one user's health data export (JSON, CSV zip, XLSX or PDF) for a date range to `exports/<userId>/<exportId>.<ext>` as a storage object the user owns, records the result on its own `payload.result`, audits `health:export:create` and notifies the user; enqueued by `POST /api/health/exports` (the export id is the job id); server-only (reads several tables mid-computation, and the input is a health record), profile 15 minutes, 2 attempts | No |
| `health.export.purge` | `health-export/handlers/health-export-purge.handler.ts` | Deletes export files (bytes, then row) under `exports/` older than 7 days; enqueued by a daily 03:00 cron that only enqueues; server-only (it deletes storage objects), profile 30 minutes, 3 attempts | No |
| `training.adaptations.purge` | `training-adaptation/handlers/adaptations-purge.handler.ts` | Deletes `workout_adaptations` rows past `expires_at`, in batches of 5000; enqueued by a daily 03:20 cron that only enqueues; profile 15 minutes, 3 attempts | No |
| `training.runs.purge` | `training-agents/runtime/handlers/training-runs-purge.handler.ts` | Deletes finished runs' events and checkpoints past retention, then old run rows; enqueued by a daily 05:30 cron that only enqueues; profile 30 minutes, 3 attempts | No |
| `training.evaluation.sweep` | `training-agents/evaluation/handlers/training-evaluation-sweep.handler.ts` | Expires unanswered proposals and starts the due evaluation runs (weekly, deferred, missed sessions) through the scheduler's gates; enqueued hourly (minute 7) by a cron that only enqueues, and only while `ai.enabled`; profile 10 minutes, 3 attempts | No |
| `user.data_reset` | `user-data/handlers/user-data-reset.handler.ts` | A user's factory reset: collects storage object ids, deletes the user's rows in one transaction, then deletes the media from the storage provider; profile 15 minutes, 3 attempts; server-only | No |
| `admin.factory_reset` | `admin-factory-reset/handlers/admin-factory-reset.handler.ts` | The deployment factory reset: seven idempotent steps (job history, every user's data via the shared per-user deletion, custom catalog rows, node reassignment to the actor, other users, deployment-wide leftovers, storage objects except backup archives), each in its own transaction; one active reset deployment-wide; profile 30 minutes, 3 attempts; server-only | No |
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
| Signed in | `/` (Today), `/health` (latest body and vital values with quick entry; see [specs/health-data.md](specs/health-data.md#214-quick-entry-and-the-health-page)), `/train`, `/train/exercises` and `/train/workouts/:workoutId` (workout logging and the exercise library; see [§5.23](#523-exercise-library) and [§5.24](#524-workout-logging)), `/train/plans`, `/train/plans/:programId` and `/train/plans/:programId/history` (`programs:read`; see [§5.25](#525-training-programs)), `/train/goals` (`goals:read`, else a redirect to `/train`; see [§5.31](#531-activity-goals)), `/train/plans/new` and `/train/plans/runs/:runId` (`ai:use`, AI enabled, else a redirect to `/train/plans`; see [§5.10](#510-ai-platform)), `/train/adapt/:adaptationId` (a quick workout adaptation, `ai:use` and AI enabled, else a redirect to `/train`; see [§5.10](#510-ai-platform)), `/gyms` (see [§5.22](#522-gyms-and-equipment)), `/health/progress-photos` (the progress-photo gallery, compare and ghost overlay; `health_data:read`, else a redirect to `/health`; see [§5.30](#530-ai-coach)), `/coach` (the AI Coach timeline; `ai:use` and AI enabled, else a redirect to `/`; see [§5.30](#530-ai-coach)), `/activate` (device approval), `/settings` hub and its pages |
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
| `/admin/settings/setup` | Setup guide | General | `system_settings:read` | none (it is where AI gets switched on) |
| `/admin/settings/android` | Android app (trusted apps, reported apps, the Digital Asset Links preview) | General | `system_settings:read` | |
| `/admin/settings/users` | Users & Allowlist | Access | `users:read` | |
| `/admin/settings/jobs` | Jobs | Operations | `jobs:read` | |
| `/admin/settings/jobs/insights` | Job Insights | Operations | `jobs:read` | |
| `/admin/settings/workers` | Worker Nodes | Operations | `nodes:read` | |
| `/admin/settings/db-backup` | Database Backup | Operations | `db_backup:read` | |
| `/admin/settings/broadcasts` | Broadcasts | Operations | `broadcasts:read` | |
| `/admin/settings/about` | About | Operations | `system_settings:read` | |
| `/admin/settings/ai` | AI | AI | `ai_config:read` | none (the page that turns AI on) |
| `/admin/settings/ai/models` | AI Models | AI | `ai_config:read` | `ai` |
| `/admin/settings/ai/assignments` | AI Model Assignments | AI | `ai_config:read` | `ai` |
| `/admin/settings/ai/usage` | AI Usage | AI | `ai_config:read` | `ai` |
| `/admin/settings/coach` | Coach (system policy, engagement stats; the coach models are on AI Model Assignments) | AI | `ai_config:read` | `ai` |
| `/admin/settings/telemetry` | Telemetry | Observability | `telemetry:read` | none (the page that turns telemetry on) |
| `/admin/settings/telemetry/explorer` | Telemetry Explorer | Observability | `telemetry:query` | `telemetry` |
| `/admin/settings/telemetry/dashboard` | Telemetry Dashboard | Observability | `telemetry:query` | `telemetry` |
| `/admin/settings/doctor` | Doctor | Observability | `system_settings:read` | none (reports on AI and telemetry while they are off) |
| `/admin/settings/factory-reset` | Factory reset | Danger Zone | `system:factory_reset` | none |
| `/settings/profile` | Profile | Account | | |
| `/settings/appearance` | Appearance | Account | | |
| `/settings/notifications` | Notifications | Account | | |
| `/settings/tokens` | Access Tokens | Security | | |
| `/settings/ai` | AI Keys | Security | `ai:use` | `ai` |
| `/settings/ai/agents` | Training agents (read-only model view) | AI | `ai:use` | `ai` |
| `/settings/coach` | Coach (persona, intensity, adult-language opt-in, audio, quiet hours, daily cap, photo cadence) | AI | `ai:use` | `ai` |
| `/settings/health-profile` | Health Profile | Health | `health_data:read` | |
| `/settings/health-documents` | Health Documents (view, download, rename, delete uploaded files) | Health | `health_data:read` | |
| `/settings/connected-devices` | Connected devices (paired Android phones: sync history, diagnostics, unpair) | Health | `goals:read` | |
| `/settings/danger-zone` | Delete all my data | Danger Zone | | none (stays reachable while AI is off) |

`/health/progress-photos` is not a settings card: it is a Health sub-page reached from the Health page and from the coach's photo prompts.

Cards gate reachability; pages gate their own write controls (for example, a `jobs:read` holder without `jobs:write` sees disabled retry buttons). The Users & Allowlist page keeps two tabs because they are parallel views of one question; `allowlist:read` gates the Allowlist tab's content.

### 9.3 Layout and breakpoint

The layout switches between a phone treatment (bottom navigation, compact AppBar, drill-down settings list) and a wider treatment (navigation rail, card grid) at MUI's `sm` breakpoint, 600px. Five gates move together: `showRail` in `apps/web/src/components/common/Layout.tsx`, the self-gate in `components/navigation/BottomNav.tsx`, `<main>`'s bottom padding in `Layout.tsx`, and `isCompactWindow` in both `components/settings/SettingsHub.tsx` and `components/navigation/AppBar.tsx`. Change one only after checking all five. See [specs/settings-ui.md](specs/settings-ui.md).

Destinations are declared once, in `apps/web/src/config/destinations.ts`; the rail, the bottom bar and the user menu all read that list. Four are `primary` for any one user: Today, Train, Health and a fourth that is Coach while it is visible to the user (`ai:use` and AI on) and Gyms otherwise (`gyms` carries `primaryWhenHidden: 'coach'`, so the pair are mutually exclusive and the bar never has three tabs). Gyms stays reachable from the rail and the user menu. They make up the phone bottom bar, and `PRIMARY_DESTINATION_LIMIT` (4) caps how many may be, because more labelled tabs do not fit at 360px; a test enforces the ceiling. The other destinations (Settings, Console, AI, and whichever of Coach or Gyms is not primary) are not in the bottom bar. On phones they are entries in the user menu; at `sm` and up they sit in the rail, with Console pinned at its foot.

### 9.4 Contexts and API client

| Context | File | Provides |
|---|---|---|
| `ThemeContextProvider` | `apps/web/src/contexts/ThemeContext.tsx` | Light, dark or system mode preference (stored as `theme_mode`) on top of the one application theme ([§9.5](#95-theme)) |
| `AuthProvider` | `apps/web/src/contexts/AuthContext.tsx` | Current user, enabled sign-in providers, sign-in and sign-out |
| `NotificationProvider` | `apps/web/src/contexts/NotificationContext.tsx` | In-app inbox and the SSE notification stream |
| `AiConfigProvider` | `apps/web/src/contexts/AiConfigContext.tsx` | The one `GET /api/ai/config` answer: whether AI is on, key policy, enabled providers |

All HTTP calls go through `ApiService` in `apps/web/src/services/api.ts`. It resolves the base URL (`VITE_API_BASE_URL`, default `/api`), attaches the in-memory access token, refreshes it once on `401`, unwraps the `{ data }` envelope, and recognizes the maintenance `503` centrally. Feature-specific clients (`services/jobs.ts`, `services/ai.ts`, `services/storage.ts` and others) are thin wrappers over it. `services/sse.ts` opens event streams against the same base URL.

### 9.5 Theme

The web app has one MUI 9 theme (`apps/web/src/theme/index.ts`) with CSS variables (`cssVariables: { colorSchemeSelector: 'class' }`) and two colour schemes, `light` and `dark`, built from the "Tidal Teal" tokens in `theme/tokens.ts`. MUI emits each palette value as a `--mui-palette-*` custom property, and a mode change flips a `.light` or `.dark` class on `<html>` instead of swapping a theme object.
`ThemeContextProvider` is the only place that mounts the theme. It drives the mode through `useColorScheme` (stored as `theme_mode`), uses `forceThemeRerender` so direct `theme.palette` reads follow the scheme, and keeps `<meta name="theme-color">` on the active scheme's `background.paper`.
`theme/augment.ts` adds `tertiary` (AI content), `container` and `onContainer` tones, `surface.container1` and `container2`, `outline` and `chart.series`; charts take series from `useChartSeries()`, never from status colours. `THEME_COLOR` from `packages/shared` is the light `primary.main`.
Palette, rules for new UI and brand-mark files: [design/color-scheme-options.md](design/color-scheme-options.md).

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
| `fake-ai.compose.yml` | Fake AI providers for e2e and development: an OpenAI-compatible server (`fake-ai`, port 4010; gym scan, workout prefill and quick adaptation scenarios) and a Responses server (`fake-ai-responses`, port 4011; training plan scenarios). No key; see [TESTING.md](TESTING.md#end-to-end-tests-playwright) | Local development and Playwright AI specs |
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
| `/.well-known/assetlinks.json` | api | Exact match, proxied to `/api/well-known/assetlinks.json` (Digital Asset Links for the Android app) |
| `= /api/admin/android-app/releases` | api | Exact match: `client_max_body_size 160m` and request buffering off for the streamed APK upload, ten-minute timeouts |
| `/api/android-app/download/` | api | Buffering off for the streamed APK download, ten-minute timeouts |
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
- The Doctor (`/admin/settings/doctor`, `system_settings:read`) checks that telemetry capture works (export switches, GreptimeDB connection, tables and retention, data freshness) beside every other capability — see [specs/doctor.md](specs/doctor.md#27-check-inventory).
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
| A Doctor check | [specs/doctor.md §4](specs/doctor.md#4-extending-it-in-a-fork) |
| A Health Connect data type for the Android sync | [specs/health-connect-sync.md §4](specs/health-connect-sync.md#4-extending-it-in-a-fork) |
| A goal template, activity kind or workout credit rule | [specs/activity-goals.md §4](specs/activity-goals.md#4-extending-it-in-a-fork) |
| A user key type (bring your own key) | [specs/user-credentials.md](specs/user-credentials.md) |
| A model with a user relation (keep/delete decision for the data reset and the factory reset, in `user-data/user-data-purge.ts`) | [specs/user-data-reset.md §4](specs/user-data-reset.md#4-extending-it-in-a-fork), [specs/factory-reset.md §4](specs/factory-reset.md#4-extending-it-in-a-fork) |
| A post-upload storage processor | [processors/README.md](../apps/api/src/storage/processing/processors/README.md) |
| A worker node executor | [executors/README.md](../apps/cli/src/node/executors/README.md) |

---

## 13. Related documents

Every document in this repository, with its audience and a suggested reading order, is listed in [README.md](README.md).
