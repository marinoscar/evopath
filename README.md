# EvoPath

EvoPath is an AI-powered personal health operating system. It keeps biomarkers, body composition, workouts and training plans in one longitudinal, user-controlled health record, and uses AI only as an optional, reviewable assistant on top of data the user can always enter by hand.

This repository is both the product and its foundation. The product features (health data, gyms, workouts, AI training plans) are built on a production-grade full-stack foundation that is also maintained as a template you can fork: sign-in, RBAC, settings framework, job queue, AI platform, backups, telemetry and a CLI ([docs/ARCHITECTURE.md §1](docs/ARCHITECTURE.md#1-purpose-and-audience), [docs/RENAMING.md](docs/RENAMING.md)).

[VISION.md](VISION.md) describes where the product is going. This README describes what exists. Nutrition and medication tracking are in the vision and are not built yet.

## What you get

### Product features

| Feature | What it does | Read |
|---|---|---|
| Health data | Health profile, longitudinal measurements (body, vital, wellness, lab analytes), daily readiness check-ins, values read from a scale or cuff photo | [health-data](docs/specs/health-data.md) |
| Health records | Health document store with a keep-or-delete choice on every upload, PDFs for body metrics, lab catalog and lab report extraction API. In progress: lab report review UI, documents API, export, AI health summary | [health-records](docs/specs/health-records.md) |
| Gyms and equipment | Gyms, equipment catalog and custom equipment, photos, optional GPS location, AI Scan Gym | [gyms-and-equipment](docs/specs/gyms-and-equipment.md) |
| Workouts | Exercise library, custom exercises, workout logging, personal records, training summary, AI Prefill from photo | [workouts](docs/specs/workouts.md) |
| Training plans | Manual plan builder with immutable versions, today's workout, change log and revert. Works with AI off | [ai-training-plans](docs/specs/ai-training-plans.md) |
| Training signals | Adherence, frequency, hard sets per muscle, lift trends, effort, pain and readiness, computed deterministically | [training-signals](docs/specs/training-signals.md) |
| AI training plans | Researcher, planner, critic and evaluator agents on LangGraph, server-enforced guardrails, continuous evaluation, quick workout adaptation | [ai-training-plans](docs/specs/ai-training-plans.md), [runbook](docs/runbooks/ai-training-plans.md) |
| AI Coach | An accountability coach with seven personas: a deterministic scheduler decides when it may speak and a model writes the nudge, with an age-gated adult-language mode, optional spoken messages, chat grounded in your training data, a weekly review and email, and progress photos | [ai-coach](docs/specs/ai-coach.md), [runbook](docs/runbooks/ai-coach.md) |
| Onboarding | Welcome dialog, admin Setup guide, user Get started checklist, derived from real state | [onboarding](docs/specs/onboarding.md) |

### Platform

| Capability | What it does | Read |
|---|---|---|
| Authentication | Google OAuth, 15-minute JWT, rotating refresh cookie, email allowlist, personal access tokens (`pat_`), RFC 8628 device flow | [SECURITY-ARCHITECTURE](docs/SECURITY-ARCHITECTURE.md), [DEVICE-AUTH](docs/DEVICE-AUTH.md), [PATs](docs/personal-access-tokens.md) |
| Authorization | Admin, Contributor and Viewer roles; `resource:action` permissions enforced by guards | [ARCHITECTURE §7](docs/ARCHITECTURE.md#7-authorization) |
| Settings framework | Registry-driven admin and per-user hubs; one card per page | [settings-ui](docs/specs/settings-ui.md) |
| Object storage | AWS S3, Cloudflare R2 or any S3-compatible endpoint, configured at runtime | [storage-providers](docs/specs/storage-providers.md), [runbook](docs/runbooks/storage-configuration.md) |
| Encrypted credentials | Runtime secrets encrypted at rest; per-user credential store | [user-credentials](docs/specs/user-credentials.md), [rotate key](docs/runbooks/rotate-secrets-encryption-key.md) |
| Notifications | Email, in-app (SSE) and Web Push with admin policy and user preferences; admin broadcasts | [browser-notifications](docs/specs/browser-notifications.md), [broadcasts](docs/specs/notification-broadcasts.md), [VAPID](docs/runbooks/vapid-keys.md) |
| AI platform | Admin-governed, bring-your-own-key AI over OpenAI, Anthropic, Gemini, Azure OpenAI and OpenAI-compatible providers | [ai-platform](docs/specs/ai-platform.md), [runbook](docs/runbooks/ai-configuration.md) |
| Job queue | Postgres-backed queue (no Redis); every long-running activity is a job | [job-queue](docs/specs/job-queue.md) |
| Worker nodes | Remote machines that run node-eligible jobs over a confined API | [worker-nodes](docs/specs/worker-nodes.md), [runbook](docs/runbooks/run-worker-nodes.md) |
| Backup and restore | Streamed `pg_dump` into object storage, restore and rollback | [backup](docs/specs/database-backup.md), [restore](docs/specs/database-restore.md), [runbook](docs/runbooks/database-restore.md) |
| Maintenance mode | An admin-controlled 503 window with an env break-glass | [maintenance-mode](docs/specs/maintenance-mode.md), [runbook](docs/runbooks/maintenance-mode.md) |
| Doctor | Read-only configuration and health checks for administrators | [doctor](docs/specs/doctor.md), [runbook](docs/runbooks/doctor.md) |
| Data reset | Per-user "delete all my data" and admin factory reset | [user-data-reset](docs/specs/user-data-reset.md), [factory-reset](docs/specs/factory-reset.md), [runbook](docs/runbooks/factory-reset.md) |
| Telemetry | OpenTelemetry to GreptimeDB, explorer, dashboard and AI assistant | [telemetry](docs/specs/telemetry.md), [runbook](docs/runbooks/telemetry.md) |

### Tooling

| Tool | What it does | Read |
|---|---|---|
| `evopathcli` | Environment setup, generic API calls, VPS deploy, worker nodes | [apps/cli/README.md](apps/cli/README.md) |
| VPS deploy | One command takes an empty Ubuntu VPS to HTTPS | [vps-deploy](docs/specs/vps-deploy.md), [runbook](docs/runbooks/deploy-to-vps.md) |
| Rename and bootstrap | `scripts/rename.mjs`, `scripts/new-project.mjs`, `/rename-app` and `/new-project` skills | [RENAMING](docs/RENAMING.md) |
| API reference | OpenAPI generated from code, Scalar UI at `/api/docs`, Spectral lint | [API.md](docs/API.md) |

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 24 (`.nvmrc`), npm workspaces `apps/*` and `packages/*` |
| API | NestJS 11 on Fastify, TypeScript, Zod via `nestjs-zod` |
| Database | PostgreSQL 16, Prisma 7 with `@prisma/adapter-pg` |
| Web | React 19, Material UI, react-router 7, Vite |
| CLI | Commander, ink |
| Agents | LangGraph.js, imported only under `apps/api/src/training-agents/` |
| Observability | OpenTelemetry, Pino, GreptimeDB |
| Testing | Jest and Supertest (API), Vitest and React Testing Library (web, CLI), Playwright (e2e, visual) |
| Infrastructure | Docker Compose, nginx same-origin routing |

## Architecture at a glance

```
 Browser (React SPA)     evopathcli CLI        Worker nodes
        │ session JWT         │ pat_ token         │ nod_ token, presigned URLs
        ▼                     ▼                    ▼
 ┌────────────────────────────────────────────────────────┐
 │ nginx :3535   /  → web    /api → api    /api/docs → api │
 └──────────────┬─────────────────────────┬───────────────┘
                ▼                         ▼
        web (React + MUI)        api (NestJS + Fastify)
                                  │   │   │        │
                                  ▼   │   ▼        ▼
                         PostgreSQL 16│  AI providers   SMTP, Web Push
                      (data, job queue)│ (server-side only)
                                      ▼
                               Object storage (S3, R2, S3-compatible)

 api ── OTLP ──► otel-collector ──► GreptimeDB   (telemetry.compose.yml)
```

- The UI renders. The API owns every business rule and authorization decision.
- Browser, CLI and nodes share one origin, so there is no CORS to maintain.
- Only the API talks to AI providers, email and Web Push.

Request lifecycle, subsystem map, data model and permission matrix: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository layout

```
evopath/
  apps/
    api/                # NestJS API: src/, test/, prisma/ (schema, migrations, seed)
    web/                # React app
    cli/                # evopathcli
    stack-agent/        # VPS-only sidecar that holds the Docker socket
  packages/shared/      # product identity (identity.json) shared by api, web, cli
  docs/                 # architecture, guides, specs/, runbooks/
  infra/
    compose/            # Compose overlays and .env.example
    nginx/              # nginx.conf, CSP
    otel/               # collector and GreptimeDB config
  scripts/              # rename.mjs, new-project.mjs (plus dev.ps1, worktree.ps1)
  tests/
    e2e/                # Playwright end-to-end
    visual/             # visual regression baselines
  .claude/              # agents/, skills/ (new-project, rename-app)
```

The Compose overlays and when to use each are listed in [docs/ARCHITECTURE.md §10.1](docs/ARCHITECTURE.md#101-compose-files).

## Start a new app from this template

Use this section for a first run, whether you are developing EvoPath itself or a fork. In Claude Code, the `/new-project` skill walks the same steps.

### Prerequisites

- Node.js 24 (`.nvmrc`) and Docker with Compose.
- A Google OAuth client. Google is the only sign-in provider and the API does not start without `GOOGLE_CLIENT_ID`. Set the redirect URI to `http://localhost:3535/api/auth/google/callback`.
- A PostgreSQL 16 server. The base stack has no database; the `devdb` overlay below adds one.

### Steps

```bash
npm install
npm run setup                    # builds the CLI, runs `evopathcli init`, writes infra/compose/.env
docker network create devnet     # once per host
```

1. `npm run setup` generates `JWT_SECRET`, `COOKIE_SECRET` and `SECRETS_ENCRYPTION_KEY`. Provide `INITIAL_ADMIN_EMAIL` and the Google credentials; nothing can generate those.
2. With the `devdb` overlay, `.env` must say `POSTGRES_HOST=db`.
3. Start the stack, migrate and seed. Run all of it from `infra/compose`.

```bash
cd infra/compose
docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml up -d
docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml exec api npm run prisma:migrate
docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml exec api npm run prisma:seed
```

4. Open http://localhost:3535 and sign in with the `INITIAL_ADMIN_EMAIL` Google account. That account becomes Admin on first sign-in. Skipping the seed shows up as "Default role not found" at login.

To add telemetry, include `-f telemetry.compose.yml` (GreptimeDB dashboard at http://localhost:14000/dashboard). To sign in without Google in development, use `/testing/login`.

- The API does not migrate on startup. Run migrate and seed after the first start and after each upgrade.
- Use the `npm run prisma:*` scripts, never bare `npx prisma`: they build `DATABASE_URL` from `POSTGRES_*`.
- Application: http://localhost:3535. API reference (Scalar): http://localhost:3535/api/docs.

More on the dev loop and framework gotchas: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

### Make it your own

A fork is renamed before anything else. `new-project.mjs --reset-release` and `--license` refuse to run while `origin` still points at the template's own repository.

```bash
node scripts/rename.mjs --name "Acme Hub" --repo owner/acme-hub --theme '#7c3aed'
node scripts/new-project.mjs --reset-release --license mit --holder "Your Name"
node scripts/new-project.mjs --audit
```

- `rename.mjs` rewrites `packages/shared/identity.json` and the values no runtime read can reach. `new-project.mjs` resets `CHANGELOG.md` and workspace versions to `0.1.0`, writes a `LICENSE` and audits what needs a human decision.
- Run `npm install` afterwards, regenerate the visual baselines, rename the GitHub repository and update the OAuth redirect URIs.
- In Claude Code, `/rename-app` and `/new-project` drive both scripts.
- The root `README.md` and `VISION.md` are hand-written product prose; replace them with your own.

Full guide: [docs/RENAMING.md](docs/RENAMING.md).

## Common commands

There is no root `npm test`; run each workspace.

```bash
npm test --workspace=api               # unit + mocked integration
npm run test:db --workspace=api        # real PostgreSQL (see docs/TESTING.md)
npm run test:run --workspace=web
npm run test:run --workspace=cli

npm run typecheck --workspace=api      # also web, cli
npm run openapi:dump && npm run openapi:lint

cd apps/api && npm run prisma:generate                               # after schema changes
cd apps/api && npm run prisma:migrate:dev -- --name <migration_name> # new migration
```

Tiers, helpers, end-to-end and visual tests: [docs/TESTING.md](docs/TESTING.md).

## The `evopathcli` CLI

```bash
curl -fsSL https://raw.githubusercontent.com/marinoscar/evopath/main/install.sh | bash
```

The installer needs `node` 20 or newer, `npm`, `git` and `curl`, builds the CLI from this repository and puts `evopathcli` in `~/.local/bin`. Re-running it updates the install.

| Command | Purpose |
|---|---|
| `init` | Create `infra/compose/.env` for a checkout (`npm run setup` runs it) |
| `login`, `config` | Device-flow sign-in that stores a personal access token; show the stored configuration |
| `api <method> <path>` | Call any endpoint, including ones added after the CLI was built |
| `deploy doctor\|install\|update\|status\|list\|about\|certs\|uninstall` | Install and manage this app on a VPS |
| `node config\|enroll\|register\|start\|stop\|status\|logs\|set-concurrency\|doctor\|install-deps\|service\|heap-snapshot` | Run and manage a worker node |

With no arguments in a real terminal it opens an interactive menu. Reference: [apps/cli/README.md](apps/cli/README.md).

## Deploying

- **VPS.** Run `evopathcli deploy install --domain app.example.com` on the server itself, never with `sudo`. It builds, migrates, seeds and serves the app over HTTPS behind a shared host proxy. Runbook: [deploy-to-vps.md](docs/runbooks/deploy-to-vps.md). Design: [vps-deploy.md](docs/specs/vps-deploy.md).
- **Worker nodes.** Enroll a machine with `evopathcli node enroll`, `register` and `start` to run node-eligible jobs away from the API server. Runbook: [run-worker-nodes.md](docs/runbooks/run-worker-nodes.md). Compose files: `infra/compose/worker.compose.yml`.
- **Operations.** After deploying, read [doctor.md](docs/runbooks/doctor.md) for triage and [database-restore.md](docs/runbooks/database-restore.md) for recovery.

## Configuration

[`infra/compose/.env.example`](infra/compose/.env.example) is the reference for every environment variable.

- **Runtime-configured features have no environment variables.** Object storage, AI providers and keys, Web Push (VAPID) and SMTP are set by an administrator in the admin UI, live, with no restart. A second source of truth is the failure this prevents.
- **`SECRETS_ENCRYPTION_KEY`** encrypts those runtime secrets before they are stored. Without it, file uploads and credential saves are refused.
- **`DATABASE_URL` is not configured.** It is built at runtime from `POSTGRES_*`.
- **Telemetry connection** is also set at runtime at `/admin/settings/telemetry`; `GREPTIME_*` variables are only the deployment default.

## Security

- Google OAuth sign-in with an email allowlist; `INITIAL_ADMIN_EMAIL` always bypasses it. No passwords are stored.
- The access JWT lives 15 minutes by default and is sent only as `Authorization: Bearer`. The one cookie is the HttpOnly, rotating `refresh_token`.
- Every endpoint declares `@Auth()` with the exact permission it needs unless deliberately public. The UI never decides access on its own.
- Runtime secrets are encrypted with AES-256-GCM. No API returns secret material.
- AI calls happen only on the server, under a key resolved per call. A user's key is never sent to a worker node.
- Input is validated with Zod on every endpoint. nginx sets HSTS, CSP and framing headers.

Design and credential kinds: [docs/SECURITY-ARCHITECTURE.md](docs/SECURITY-ARCHITECTURE.md).

## Documentation

[docs/README.md](docs/README.md) indexes every document, grouped by purpose. Read in this order:

1. This README.
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): subsystem map, permission matrix, tables, job types.
3. [docs/SECURITY-ARCHITECTURE.md](docs/SECURITY-ARCHITECTURE.md): authentication, credential kinds, RBAC.
4. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): the dev loop and framework gotchas.
5. [docs/TESTING.md](docs/TESTING.md): test tiers and how to run them.
6. [docs/RENAMING.md](docs/RENAMING.md): turning the template into your own product.

Feature design lives in `docs/specs/`, operator procedures in `docs/runbooks/`, per-endpoint reference at `/api/docs`.

## Contributing

[CLAUDE.md](CLAUDE.md) holds the binding rules; this is the short version.

- Every feature and bug fix has a GitHub issue first ([issue templates](.github/ISSUE_TEMPLATE)).
- Develop in a Git worktree under `worktrees/`, on a `<type>/<short-name>` branch. The main checkout stays on `main`.
- Commit small and often, in Conventional Commits form: `<type>(<scope>): <summary>`.
- A behaviour change carries its tests. Fill in the [pull request template](.github/pull_request_template.md).
- Coding agents delegate to the subagents in [.claude/agents/](.claude/agents/), as CLAUDE.md describes.
