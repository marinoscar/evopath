# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Background Job Queue**: a Postgres-backed generic work queue — no Redis, no second datastore. Atomic `FOR UPDATE SKIP LOCKED` claims, a lease reaper, and per-type lifetime stats. A new job type is one self-registering handler class. Admin surface `/admin/settings/jobs`, gated by `jobs:read`/`jobs:write`. See `docs/specs/job-queue.md`.
- **Distributed Worker Nodes**: node-eligible job types can run on a remote worker node instead of the API server, via `appctl node`. A node authenticates with a `nod_…` credential confined to `/api/nodes/*` and moves job data through presigned URLs. Admin fleet view `/admin/settings/workers`, gated by `nodes:read`/`nodes:write`. See `docs/specs/worker-nodes.md`.
- **Maintenance Mode**: an admin-controlled window (`/admin/settings/maintenance`) that returns `503` to ordinary requests, with an environment-variable break-glass (`MAINTENANCE_MODE`) that outranks the persisted setting. Gated by `system_settings:read`/`write`. See `docs/specs/maintenance-mode.md`.
- **PostgreSQL Backup**: scheduled and on-demand `pg_dump` backups streamed directly into object storage, with their own heartbeat and single-active-run enforcement independent of the job queue. Admin surface `/admin/settings/db-backup`, gated by `db_backup:read`/`db_backup:write`. See `docs/specs/database-backup.md`.
- **PostgreSQL Restore**: restore the database from a backup, or roll back a restore, gated by a dedicated `db_backup:restore` permission kept separate from `db_backup:write`. A capability gate a managed database can't satisfy answers with a ready-to-run command block instead of an error. See `docs/specs/database-restore.md`.
- Four operational notification events: `jobs.job_failed`, `nodes.node_offline`, `db_backup.backup_failed`, and `db_backup.restore_completed` (mandatory — cannot be muted).
- A new **Operations** admin settings group (Jobs, Job Insights, Worker Nodes, Database Backup, Broadcasts) alongside the existing General and Access groups.
- **AI Platform**: admin-governed, bring-your-own-key AI across 5 providers (OpenAI, Anthropic, Gemini, Azure OpenAI, OpenAI-compatible) — responses, streaming, structured output, tool calling, embeddings, images, audio and realtime voice, plus background runs and usage reporting. Admin surface `/admin/settings/ai*`, user surface `/settings/ai`, AI Playground at `/ai`, gated by `ai_config:*`/`ai:use`. See `docs/specs/ai-platform.md`.
- **Runtime Object Storage Configuration**: point the deployment at AWS S3, Cloudflare R2, or any S3-compatible endpoint from `/admin/settings/storage`, with no restart. Retires the old `STORAGE_PROVIDER`/`S3_*` environment variables. Gated by `storage_config:read`/`storage_config:write`. See `docs/specs/storage-providers.md`.
- **Web Push Runtime Configuration**: generate, rotate, enable/disable and remove VAPID keys from `/admin/settings/push`, with no restart. Gated by `push:read`/`push:write`. See `docs/specs/browser-notifications.md`.
- **Admin Broadcasts**: compose a message to every active user, sent now or scheduled, over email/in-app/push, fanned out through chunked background jobs. Admin surface `/admin/settings/broadcasts`, gated by `broadcasts:read`/`broadcasts:write`. See `docs/specs/notification-broadcasts.md`.
- **Personal Access Tokens**: create and revoke long-lived `pat_…` bearer tokens for API and CLI access at `/settings/tokens`, scoped to the caller's own tokens. See `docs/personal-access-tokens.md`.
- **Encrypted Credential Store**: runtime-configured secrets (SMTP, VAPID, the storage credential, AI org keys) are encrypted at rest under `SECRETS_ENCRYPTION_KEY`, alongside a parallel per-user credential store for bring-your-own-key features. See `docs/specs/user-credentials.md`.
- **VPS Deployment (`appctl deploy`)**: `doctor`/`install`/`update`/`status`/`certs`/`uninstall` deploy and manage this application on a VPS with no separate deploy script. The admin **About** page (`/admin/settings/about`) reports the running version, commit and deploy history. See `docs/specs/vps-deploy.md`.
- **Guided First-Time Setup**: `npm run setup` builds the CLI and runs `appctl init`, which creates `infra/compose/.env` interactively.
- **Template Tooling**: rebrand a fork with `scripts/rename.mjs` and `scripts/new-project.mjs` (or the `/rename-app`/`/new-project` skills), which rewrite the product identity centralized in `packages/shared`. See `docs/RENAMING.md`.

## [1.1.0] - 2026-06-10

### Changed

- **Dependencies**: Major upgrade across the stack — React 19, MUI 9, react-router 7, Vite 8, TypeScript 6 (web); Prisma 7 (now using the `@prisma/adapter-pg` driver adapter), zod 4 + nestjs-zod 5, Jest 30, @fastify/multipart 10, and OpenTelemetry updates (API). class-validator bumped to 0.15.1. NestJS remains on 11.x. Runtime is Node.js 24.

### Removed

- **CLI Tool**: Removed the `tools/app` cross-platform CLI and the `tools/*` workspace.

## [1.0.1] - 2026-01-24

### Added

- **CLI Storage Commands**: New storage commands for interacting with the storage API
  - File upload support with `storage upload` command
  - Interactive storage menu for browsing and managing files
- **CLI Sync Feature**: Full folder synchronization functionality
  - Sync database layer with better-sqlite3 for local state tracking
  - Sync engine for bidirectional folder synchronization
  - Sync commands (`sync push`, `sync pull`, `sync status`)
  - Interactive sync menu for easy sync management
- **API Improvements**: DatabaseSeedException for better seed-related error handling

### Fixed

- **Authentication**: Enhanced OAuth callback error logging for easier debugging
- **Authentication**: Improved error handling for missing database seeds
- **API**: Fixed metadata casting to `Prisma.InputJsonValue` in processing service
- **API**: Fixed metadata casting to `Prisma.InputJsonValue` in objects service
- **API**: Handle unknown error types in S3 storage provider
- **CLI**: Use ESM import for `existsSync` in sync-database module
- **Tests**: Convert ISO strings to timestamps for date comparison

### Changed

- **Database**: Squashed migrations into single initial migration
- **Infrastructure**: Added AWS environment variables to compose file

### Dependencies

- Added AWS SDK dependencies for S3 storage provider
- Added better-sqlite3 and related dependencies for CLI sync feature

### Documentation

- Added storage and folder sync documentation to CLI README

## [1.0.0] - 2026-01-24

### Initial Release

Enterprise Application Foundation - A production-grade full-stack application foundation built with React, NestJS, and PostgreSQL.

### Features

#### Authentication
- Google OAuth 2.0 with JWT access tokens and refresh token rotation
- Short-lived access tokens (15 min default) with secure refresh rotation
- HttpOnly cookie storage for refresh tokens

#### Device Authorization (RFC 8628)
- Device Authorization Flow for CLI tools, mobile apps, and IoT devices
- Secure device code generation and polling
- Device session management and revocation

#### Authorization
- Role-Based Access Control (RBAC) with three roles:
  - **Admin**: Full access, manage users and system settings
  - **Contributor**: Standard capabilities, manage own settings
  - **Viewer**: Least privilege (default), manage own settings
- Flexible permission system for feature expansion

#### Access Control
- Email allowlist restricts application access to pre-authorized users
- Pending/Claimed status tracking for allowlist entries
- Initial admin bootstrap via `INITIAL_ADMIN_EMAIL` environment variable

#### User Management
- Admin interface for managing users and role assignments
- User activation/deactivation controls
- Allowlist management UI at `/admin/users`

#### Settings Framework
- System-wide settings with type-safe Zod schemas
- Per-user settings with validation
- JSONB storage in PostgreSQL

#### API
- RESTful API built with NestJS and Fastify (2-3x better performance than Express)
- Swagger/OpenAPI documentation at `/api/docs`
- Health check endpoints (liveness and readiness probes)
- Input validation on all endpoints

#### Frontend
- React 18 with TypeScript
- Material-UI (MUI) component library
- Theme support with responsive design
- Protected routes with role-based access
- Vite build tool with hot module replacement

#### CLI Tool
- Cross-platform CLI (`app`) for development and API management
- Device authorization flow for secure CLI authentication
- Interactive menu-driven mode and command-line interface
- Support for multiple server environments (local, staging, production)

#### Infrastructure
- Docker Compose configurations:
  - `base.compose.yml`: Core services (api, web, db, nginx)
  - `dev.compose.yml`: Development overrides with hot reload
  - `prod.compose.yml`: Production overrides with resource limits
  - `otel.compose.yml`: Observability stack
- Nginx reverse proxy for same-origin architecture
- PostgreSQL 16 with Prisma ORM
- Automated database migrations and seeding

#### Observability
- OpenTelemetry instrumentation for traces and metrics
- Uptrace integration for visualization (UI at localhost:14318)
- Pino structured logging
- OTEL Collector configuration included

#### Testing
- Backend: Jest + Supertest for unit and integration tests
- Frontend: Vitest + React Testing Library
- CI pipeline with GitHub Actions

### Technical Stack
- **Backend**: Node.js + TypeScript, NestJS with Fastify adapter
- **Frontend**: React + TypeScript, Material-UI (MUI)
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: Passport strategies (Google OAuth)
- **Testing**: Jest, Supertest, Vitest, React Testing Library
- **Observability**: OpenTelemetry, Uptrace, Pino
- **Infrastructure**: Docker, Docker Compose, Nginx
