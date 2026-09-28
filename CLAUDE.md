# CLAUDE.md

Rules for AI assistants working on this codebase, plus one-line pointers to where everything else is documented.

## Project overview

This repository is a template: teams fork it to get a production-grade foundation for an enterprise web app.
Stack: React 19 + MUI (web), NestJS 11 on Fastify + Prisma 7 + Zod (API), PostgreSQL 16, Commander + ink (`appctl` CLI), Nginx same-origin, OpenTelemetry + Pino, Docker Compose, Node 24.
Start at [README.md](README.md) (what you get, how to start a new app) and [docs/README.md](docs/README.md) (index of every doc, read-first order).

## Repository structure

```
/
  apps/
    api/                      # NestJS API: src/, test/, prisma/ (schema.prisma, migrations/, seed), Dockerfile
    web/                      # React app: src/, src/__tests__/, Dockerfile
    cli/                      # `appctl` first-party CLI
      src/commands/           # init, login, api, config, deploy, node
      src/tui/                # interactive ink menu (real terminals only)
    stack-agent/              # VPS-only sidecar: holds the Docker socket, starts the telemetry stack
  packages/shared/            # product identity (identity.json) shared by api, web, cli
  docs/
    specs/                    # feature design and rationale
    runbooks/                 # operator procedures (incl. VPS deploy, worker nodes)
  infra/
    compose/
      base.compose.yml        # nginx, api, web; no database
      dev.compose.yml         # hot reload, volumes, exposed ports
      devdb.compose.yml       # opt-in development PostgreSQL
      telemetry.compose.yml   # OTel collector, GreptimeDB
      prod.compose.yml        # resource limits, restart policies
      vps.compose.yml         # behind a shared host proxy
      vps.telemetry.compose.yml # VPS hardening for the telemetry stack
      test.compose.yml        # disposable real-database test Postgres
      worker.compose.yml      # worker node containers, scalable
      worker.build.compose.yml # build worker image from source
      .env.example            # environment variable reference
    nginx/                    # nginx.conf, CSP headers
    otel/                     # collector and GreptimeDB config
  scripts/                    # rename.mjs, new-project.mjs (plus dev.ps1, worktree.ps1)
  tests/
    e2e/                      # Playwright end-to-end tests
    visual/                   # visual regression baselines
  .claude/
    agents/                   # specialized subagents (see below)
    skills/                   # new-project, rename-app
```

## Where things are documented

| Topic | Read |
|---|---|
| Architecture, subsystem map; permission matrix, Prisma models, job-type inventory, settings-page inventory, compose files | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (permissions: [§7](docs/ARCHITECTURE.md#7-authorization)) |
| Security design, credential kinds, sessions, email allowlist | [docs/SECURITY-ARCHITECTURE.md](docs/SECURITY-ARCHITECTURE.md) |
| API conventions (auth, errors, pagination, If-Match, SSE); per-endpoint reference is the generated OpenAPI at `/api/docs` | [docs/API.md](docs/API.md) |
| Testing (tiers, helpers, tripwire suites, e2e, visual) | [docs/TESTING.md](docs/TESTING.md) |
| Dev loop, Fastify/Prisma/Passport gotchas, debugging | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| Renaming a fork | [docs/RENAMING.md](docs/RENAMING.md) |
| Device authorization and personal access tokens | [docs/DEVICE-AUTH.md](docs/DEVICE-AUTH.md), [docs/personal-access-tokens.md](docs/personal-access-tokens.md) |
| Spec: AI platform | [docs/specs/ai-platform.md](docs/specs/ai-platform.md) |
| Spec: browser notifications and Web Push | [docs/specs/browser-notifications.md](docs/specs/browser-notifications.md) |
| Spec: database backup | [docs/specs/database-backup.md](docs/specs/database-backup.md) |
| Spec: database restore | [docs/specs/database-restore.md](docs/specs/database-restore.md) |
| Spec: background job queue | [docs/specs/job-queue.md](docs/specs/job-queue.md) |
| Spec: maintenance mode | [docs/specs/maintenance-mode.md](docs/specs/maintenance-mode.md) |
| Spec: admin broadcasts | [docs/specs/notification-broadcasts.md](docs/specs/notification-broadcasts.md) |
| Spec: settings UI | [docs/specs/settings-ui.md](docs/specs/settings-ui.md) |
| Spec: object storage providers | [docs/specs/storage-providers.md](docs/specs/storage-providers.md) |
| Spec: per-user credentials (add a user key type: §4) | [docs/specs/user-credentials.md](docs/specs/user-credentials.md#4-extending-it-in-a-fork) |
| Spec: telemetry (GreptimeDB, explorer) | [docs/specs/telemetry.md](docs/specs/telemetry.md) |
| Spec: VPS deploy | [docs/specs/vps-deploy.md](docs/specs/vps-deploy.md) |
| Spec: worker nodes | [docs/specs/worker-nodes.md](docs/specs/worker-nodes.md) |
| Runbooks (operator procedures) | [docs/README.md#runbooks](docs/README.md#runbooks) |
| Runbooks: deploy to a VPS, run worker nodes | [docs/runbooks/deploy-to-vps.md](docs/runbooks/deploy-to-vps.md), [docs/runbooks/run-worker-nodes.md](docs/runbooks/run-worker-nodes.md) |
| Runbook: telemetry (enable, retention, BI access) | [docs/runbooks/telemetry.md](docs/runbooks/telemetry.md) |
| `appctl` CLI command reference | [apps/cli/README.md](apps/cli/README.md) |
| Recipe: add a job type | [apps/api/src/jobs/handlers/README.md](apps/api/src/jobs/handlers/README.md) |
| Recipe: use AI in a feature | [apps/api/src/ai/README.md](apps/api/src/ai/README.md) |
| Recipe: add a notification | [apps/api/src/notifications/README.md](apps/api/src/notifications/README.md) |
| Recipe: add an AI provider | [docs/specs/ai-platform.md §4](docs/specs/ai-platform.md#4-extending-it-in-a-fork) |

## MANDATORY: Issue-Driven Development

Every feature and bug fix is tracked by a GitHub issue, filed **before** implementation planning is finalized (features) or the fix starts (bugs), and before any worktree or branch is created. `gh issue create` run inside the repo infers the repository from the git remote.

- **New feature**: create (or confirm) an issue with `gh issue create --template feature_request.yml`. Fill in the real problem, proposed solution, affected component and priority, not placeholder text.
- **Larger initiative** spanning several features or sessions: file an epic with `gh issue create --template epic.yml`. Child feature issues reference the epic in their body or task list.
- **Bug fix**: create (or confirm) an issue with `gh issue create --template bug_report.yml`: description, reproduction steps, expected vs. actual, component, environment/logs if known. Reuse an existing issue rather than filing a duplicate.
- **Link the work**: reference the issue in commit messages and/or the PR description (`Fixes #<n>` / `Relates to #<n>`), per `.github/pull_request_template.md`.
- **Keep it current**: update or close the issue as the PR resolves it.
- **Scope**: feature and bug work only. Routine `chore`/`docs`/`refactor` commits need no issue of their own.

## MANDATORY: Worktree-Based Feature Development

The main checkout stays on `main`. Every feature or fix is developed in a Git worktree.

- Worktrees live under `worktrees/` in the repo root (git-ignored), with flat short names: `worktrees/<short-name>`.
- Branches follow `<type>/<short-name>` (`feat/add-export`, `fix/auth-bug`).
- The **main agent** creates the worktree and its branch, after the tracking issue exists:
  ```bash
  git worktree add worktrees/<short-name> -b <type>/<short-name>
  ```
- All development and commits happen inside `worktrees/<short-name>/`.
- To finish: commit everything inside the worktree, then `git worktree remove worktrees/<short-name>`. The branch remains for the PR.
- Never check out a feature branch in the main working directory, and never work on a feature in the main checkout.
- One worktree per branch. If the worktree for the requested feature already exists, work inside it.
- **Exception**: when the environment has already put you on a designated branch (for example a cloud session), work there instead of creating a worktree.
- Do not open PRs unless asked.

## MANDATORY: Commit rules

Create clean, frequent commits while implementing the requested work.

- **Commit early, commit often.** No large uncommitted change sets.
- Each commit is **small, coherent and reviewable**, with **one intent** (no "misc fixes" bundles).
- **No unrelated refactors**, repo-wide formatting or dependency upgrades unless explicitly requested or required.
- **A behaviour change carries its tests** in the same commit or the next one.
- Include code plus tests for the same area, the minimal config needed to build/test, and small refactors that reduce complexity for this change. Exclude cleanup in neighbouring modules.
- **Mixed changes**: revert unrelated edits before committing, or split them into a separate commit (keep that commit only if requested).

**Format** (Conventional Commits): `<type>(<scope>): <short imperative summary>`

- Types: `feat`, `fix`, `refactor` (no behaviour change), `test`, `docs`, `chore` (tooling, deps, formatting, build, CI).
- Scopes: `api`, `web`, `cli`, `db`, `infra`, `auth`, `ai`, `jobs`, `nodes`, `storage`, `notifications`, `ui`, `core`, `docs`, `tests`.
- Examples: `feat(jobs): add export.csv job type` · `fix(ai): refuse previousResponseId on stateless providers` · `test(storage): cover SWITCH confirmation` · `docs(docs): add maintenance-mode runbook`.

**Cadence**: commit at each checkpoint:

1. Scaffold / wiring (new files, routes, plumbing, even if incomplete).
2. Core functionality (smallest working slice end to end).
3. Edge cases and validation.
4. Tests.
5. Cleanup strictly related to the change.
6. Docs, if the task needs them.

**Sequence**: `git status` → `git diff` → stage intentionally (`git add -p` preferred, or `git add <files>`) → `git commit -m "<type>(<scope>): <summary>"` → `git status`.

**Tests not run**: if you cannot run tests for a valid reason, still commit and say so in the commit body (`Notes: tests not run (DB env not available).`).

**Golden rule**: if the diff feels big, you waited too long. Split the work and commit sooner.

## MANDATORY: Settings UI Pattern

Every settings surface, admin or per-user, is a **registry-driven hub**. Rationale, rejected alternatives and accessibility requirements: [docs/specs/settings-ui.md](docs/specs/settings-ui.md).

1. **Every new settings page is declared in a section registry.** Admin cards go in `apps/web/src/config/adminSections.tsx` (`ADMIN_SECTIONS`); per-user cards in `apps/web/src/config/userSettingsSections.tsx` (`USER_SETTINGS_SECTIONS`). A route without a registry entry is unacceptable: the hub, the Console rail and the AppBar title resolver cannot know it exists. Append new cards; do not insert them between existing ones.
2. **A settings page is never added as a new tab on an existing settings page.** Tabs are legitimate only inside one destination, for genuinely **parallel** content (two views of one question). The example is `apps/web/src/pages/Admin/UsersPage.tsx` (Users, Allowlist: "who may use this application"). A **destination** gate (which card, which route) is about **reachability**; a **tab** gate (inside one page) is about **content**. Hierarchical content wearing a tab strip is the mistake this rule prevents.
3. **The card's `permission` is the exact string the API controller enforces**, never invented or approximated:
   - `system_settings:read` / `system_settings:write` → `system-settings.controller.ts`
   - `users:read` → `users.controller.ts`
   - `allowlist:read` → `allowlist.controller.ts` (gates content **inside** the Users page, not the route)
   Writes are gated inside the page (disabled controls), not by a second card permission.
4. **Reuse `apps/web/src/components/settings/SettingsHub.tsx`.** Do not fork or copy it. `/settings` (`apps/web/src/pages/UserSettingsHubPage.tsx`) is a binding (`sections`, `hubKey`, `title`, `subtitle`, `features`) over the same component `/admin/settings` uses, nothing more.
5. **The five coupled breakpoint gates move together or not at all** ([breakpoint gates](docs/specs/settings-ui.md#breakpoint-gates)):
   1. `Layout.tsx` `showRail` (`up('sm')`): mounts/unmounts `NavigationRail`
   2. `BottomNav`'s own `down('sm')` self-gate
   3. `<main>`'s `pb: { xs: 10, sm: 3 }` in `Layout.tsx`
   4. `SettingsHub.tsx` `isCompactWindow` (`down('sm')`)
   5. `AppBar.tsx` `isCompactWindow` (`down('sm')`)

   The boundary is `sm` (600px), never `md` (900px). There is deliberately no shared constant binding them (see the spec's design decisions).

## MANDATORY: Every Long-Running Activity Is a Queue Job

Full design: [docs/specs/job-queue.md](docs/specs/job-queue.md#all-long-running-work-is-a-job).

1. **No long-running work outside the queue.** Anything that outlives the HTTP request or cron tick that started it is a registered `JobHandler` with a declared `type`, enqueued through `JobsService`. A detached `void this.doSomething()`, an `@OnEvent` body that downloads or spawns, and a `@Cron` body that works inline are violations. A `@Cron` only decides *whether* work is due and enqueues it: `apps/api/src/jobs/tasks/job-history-purge.task.ts` is the reference, `apps/api/src/jobs/housekeeping.enqueue.ts` the shared helper.
   - Exactly three permanent exemptions:
     - `jobs/tasks/job-stuck-reset.task.ts`: the lease reaper; recovery cannot depend on what it recovers.
     - `jobs/tasks/temp-file-janitor.task.ts`: sweeps this process's local disk, which another executor cannot reach.
     - `nodes/tasks/node-secret-sweep.task.ts`: revokes credentials brokered to nodes; a wedged queue must not leak live credentials.
   - `apps/api/test/jobs/cron-enqueue-only.spec.ts` is the executable form. A fourth exemption requires editing both the spec and the test.
   - Not covered: fire-and-forget notification dispatch (`this.notifications.notify(...)`). "Long-running" means work worth accounting for (a table sweep, a dump, a network round trip per row).
2. **Node eligibility is the default posture.** A new job type SHOULD carry `nodeResultSchema` + `persistNodeResult` unless it genuinely cannot (writes as it goes, reads several tables mid-computation, or needs a privilege a remote machine must never hold; the database restore is server-only permanently). Eligibility is **derived** from those two members; there is no `nodeEligible` flag and never will be (`apps/api/src/jobs/job-handler.interface.ts`). A deployment declines offload with a system setting read at claim time (`NodeOffloadService.offeredTypes()`, a handler's `nodeOffloadEnabled()`), never by editing the handler.
3. **A node never persists a job-scoped credential.** Every per-job secret is issued through `POST /api/nodes/:id/jobs/:jobId/secret`, gated by `assertJobHeldByNode`, bounded by the job's lease, held in node memory only, and revoked when the job settles or by the sweep above. `job_node_secrets` stores the credential's **handle**, never its material (it has no column able to hold one). A handler declares the need by carrying a `nodeSecretBroker` (`apps/api/src/jobs/job-secret-broker.ts`); presence is the declaration. The node's own `nod_` identity token is the single exception: an identity, not a job-scoped grant.
4. **A job type declares its execution profile or takes the global default.** `JobHandler.profile` is optional and carries exactly `{ maxRuntimeMs, maxAttempts }` (`apps/api/src/jobs/job-execution-profile.ts`). The lease, renewal interval and reaper patience are derived from `maxRuntimeMs`. Never add `leaseMs` or `heartbeatMs`.

## MANDATORY: AI Platform Rules

Design: [docs/specs/ai-platform.md](docs/specs/ai-platform.md). Recipe: [apps/api/src/ai/README.md](apps/api/src/ai/README.md). Operators: [docs/runbooks/ai-configuration.md](docs/runbooks/ai-configuration.md).

1. **Never import a provider SDK outside `apps/api/src/ai/providers/<provider>/`.** A feature injects `AiService` (exported by `AiModule`) and calls `AiService.forUser(userId)`, never an SDK client of its own. A new provider's SDK gets its own boundary spec.
2. **Never call AI from the browser; keys never leave the server.** Every provider call is server-side, under a key `AiKeyResolver` resolved for that call (admin/org key or the user's BYOK key), held only between resolution and the adapter call. No route, log line, span, `AiError`, `ai_usage_events` row or `ai_runs.request` row carries key material. The single exception is a realtime session's **ephemeral** provider secret, minted server-side and returned only by `POST /api/ai/realtime/sessions`, never the key itself.
3. **AI jobs are server-only, permanently.** Every `ai.*` job type implements neither `nodeResultSchema` nor `persistNodeResult`: a user's BYOK key and the org key are never brokered to a worker node. This is on top of the queue rules above.
4. **Route guards.** Every consumer route under `/api/ai/*` sits behind `AiEnabledGuard` plus `ai:use`, except `GET /api/ai/config`, which stays open. Every admin route under `/api/admin/ai/*` requires `ai_config:read`/`ai_config:write` and is deliberately **not** behind `AiEnabledGuard`, so an administrator can always turn AI back on.
5. **New AI settings cards follow the Settings UI Pattern and declare `feature: 'ai'`**, so they are hidden while AI is off. The one exception is the admin `AI` card (`/admin/settings/ai`): it is where AI is switched on, so it carries no `feature`.

Guardrails: the suites under `apps/api/test/ai/` (kill switch, RBAC matrix, secret egress, key policy, jobs server-only, no SDK leak), the per-provider SDK boundary specs and `apps/web/src/__tests__/config/aiSettingsRegistry.test.ts` discover routes, job types and cards automatically; see [ai-platform.md §5](docs/specs/ai-platform.md#5-guardrails).

## MANDATORY: Invariants that are easy to break

Each is enforced by tests and explained in the linked doc. Read it before touching the area.

- **Raw-SQL partial unique indexes are intentional schema drift.** `jobs_active_dedup_uniq_idx` and `database_backup_runs_active_uniq_idx` exist only in migration SQL because Prisma cannot express them. Never "fix" the drift with `@@unique`, and never replace them with a `findFirst` pre-check. See [job-queue.md](docs/specs/job-queue.md) and [database-backup.md](docs/specs/database-backup.md).
- **A backup archive is never buffered.** `pg_dump` streams straight into object storage, and both the upload and the dump's exit code are awaited. See [database-backup.md](docs/specs/database-backup.md).
- **No restore pre-flight may create, drop or rename anything**, and the cluster admin connection lives outside the Prisma pool, on the `postgres` maintenance database. See [database-restore.md](docs/specs/database-restore.md).
- **`notify()` runs after the triggering write commits, outside any `$transaction`.** See [the notifications README](apps/api/src/notifications/README.md).
- **A job `type` string is permanent** once jobs of that type exist. See [the job handlers README](apps/api/src/jobs/handlers/README.md).

## Architecture principles

1. **Separation of concerns**: the UI handles presentation only; the API handles all business logic and authorization.
2. **Same-origin hosting**: UI at `/`, API at `/api`, API reference (Scalar) at `/api/docs`.
3. **Security by default**: every endpoint declares `@Auth()` unless deliberately public. There is no global JWT guard (the only `APP_GUARD` is `MaintenanceGuard`), so a route without `@Auth()` is public.
4. **API-first**: all business logic lives in the API layer.

## Security guidelines

- Deployment secrets come from environment variables (`infra/compose/.env.example`), never from code.
- Storage, AI, Web Push (VAPID) and SMTP are configured at runtime in the admin UI and must **never** get environment variables: no `STORAGE_PROVIDER`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `OPENAI_API_KEY` or equivalent. Two sources of truth is the failure this prevents.
- The telemetry store's connection (GreptimeDB host, port, database, reader/admin logins) is also runtime-configured at `/admin/settings/telemetry`, with `GREPTIME_*` kept only as the deployment default and for the collector/container (see [docs/specs/telemetry.md §8](docs/specs/telemetry.md#8-runtime-connection)).
- Runtime-configured credentials are encrypted with `SECRETS_ENCRYPTION_KEY` before they are stored.
- The access JWT is short-lived (15 minutes by default) and is read only from `Authorization: Bearer`. The only cookie is the HttpOnly `refresh_token`, rotated on use.
- Validate input on every endpoint (Zod schemas).
- Profile-image uploads: images only, with size and type limits.
- The email allowlist restricts access to pre-authorized users; `INITIAL_ADMIN_EMAIL` always bypasses it.

## Environment variables

- [`infra/compose/.env.example`](infra/compose/.env.example) is the reference for every variable; do not duplicate it here.
- `DATABASE_URL` is not configured: it is constructed at runtime from `POSTGRES_*`. Use the `npm run prisma:*` scripts, never bare `npx prisma`.
- Never add an environment variable for runtime-configured features (see Security guidelines).
- ⚠ **Never add a commented `# KEY=value` line to `.env.example`.** `apps/cli`'s `parseEnvExample` reads any such line as declaring a variable, so an illustrative assignment fails the CLI env-spec test. Document a value for `MAINTENANCE_MODE` as prose ("set to `true`"), never as an inline commented example. `.env.example` already carries exactly one commented default for it; do not add a second.

## Key commands

```bash
# First-time setup: build the CLI and create infra/compose/.env (appctl init)
npm run setup
docker network create devnet                # once per host

# Start development (from infra/compose); devdb.compose.yml adds a local Postgres (.env: POSTGRES_HOST=db)
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml up
# Add telemetry (OTel Collector + GreptimeDB)
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f telemetry.compose.yml up

# Migrate and seed, from infra/compose, with the same -f files you started with
# (the API does not migrate on startup)
docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml exec api npm run prisma:migrate
docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml exec api npm run prisma:seed
cd apps/api && npm run prisma:generate                              # after schema changes
cd apps/api && npm run prisma:migrate:dev -- --name <migration_name> # new migration

# Tests (there is no root npm test)
npm test --workspace=api                    # unit + mocked integration
npm run test:db --workspace=api             # real-Postgres tier
npm run test:run --workspace=web
npm run test:run --workspace=cli

# Typecheck, per workspace
npm run typecheck --workspace=api
npm run typecheck --workspace=web
npm run typecheck --workspace=cli

# OpenAPI
npm run openapi:dump && npm run openapi:lint
```

Service URLs (development):

- Application: http://localhost:3535 (via Nginx)
- API reference (Scalar): http://localhost:3535/api/docs
- GreptimeDB dashboard: http://localhost:14000/dashboard (with `telemetry.compose.yml`)
- GreptimeDB PostgreSQL wire protocol: postgres://localhost:14003 (with `telemetry.compose.yml`)

## Testing requirements

- Unit tests for isolated logic (services, guards, validators).
- Integration tests for API + RBAC flows; real-database tests (`*.db.spec.ts`) where a mocked Prisma cannot prove the behaviour.
- Mock OAuth in CI (no real Google dependency).
- Frontend component and hook tests.

Details: [docs/TESTING.md](docs/TESTING.md).

## Specialized Subagents (MANDATORY)

Delegate development work to the matching subagent in `.claude/agents/`. Each agent carries its domain's rules and points to the docs that own the details, so delegation keeps patterns consistent.

| Agent | Domain | MUST use for |
|---|---|---|
| `backend-dev` | NestJS API, Fastify, auth, RBAC | **Any** backend code: endpoints, services, guards, middleware, JWT, OAuth |
| `frontend-dev` | React, MUI, TypeScript | **Any** frontend code: components, pages, hooks, theming, responsive design |
| `database-dev` | PostgreSQL, Prisma | **Any** database work: schema, migrations, seeds, queries |
| `testing-dev` | Jest/Supertest (API), Vitest/RTL (web) | **Any** testing: unit, integration, typecheck, fixtures |
| `docs-dev` | Technical documentation | **Any** documentation: ARCHITECTURE.md, SECURITY-ARCHITECTURE.md, API.md, README, specs, runbooks |
| `ops-dev` | Routine operations (Haiku) | Rebuilding/restarting containers, running Prisma migrations, running typecheck |

Delegation rules:

1. Backend code changes → `backend-dev`.
2. Frontend code changes → `frontend-dev`.
3. Database/Prisma changes → `database-dev`.
4. Writing or updating tests → `testing-dev`.
5. Documentation updates → `docs-dev`.
6. Routine ops (container rebuilds, migrations, typecheck) → `ops-dev`. `ops-dev` must **never** perform state-changing git operations (pull, merge, push, commit, worktree or branch management); the main agent does those, and `ops-dev` refuses them.

Multi-domain tasks invoke several agents in sequence, for example a new user setting: `database-dev` (migration) → `backend-dev` (endpoint) → `frontend-dev` (UI) → `testing-dev` (tests) → `docs-dev` (docs).

```
"Use backend-dev to implement the user settings endpoint"
"Use testing-dev to write integration tests for auth"
"Use ops-dev to rebuild the api container and run migrations"
```

Do not write controllers, services, guards, components, Prisma schema, migrations, tests or documentation directly. The only exceptions:

- Reading files to understand context.
- Answering questions about the codebase.
- Planning and coordinating between agents.
- Running simple commands (`git status`, `npm install`, etc.).
