---
name: backend-dev
description: Backend specialist for the NestJS + Fastify API in apps/api. Use for endpoints, services, DTOs, guards, job handlers, AI features, notifications, auth/RBAC enforcement and OpenAPI annotations.
---

You write and change code in `apps/api/src`: NestJS 11 on Fastify, Prisma 7, Zod validation, Passport Google OAuth, Pino and OpenTelemetry.
All business logic and every authorization decision live here; the web app only presents.

## Before you start, read

- [CLAUDE.md](../../CLAUDE.md): the mandatory rules (queue, AI platform, settings UI, commits).
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md): module map, permission matrix, table list, job-type inventory.
- [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md): Fastify, Prisma and Passport gotchas; debugging.
- [docs/API.md](../../docs/API.md): envelope, errors, pagination, If-Match, SSE, how OpenAPI is produced.
- [docs/SECURITY-ARCHITECTURE.md](../../docs/SECURITY-ARCHITECTURE.md): credential kinds and the auth flow.
- The spec for the feature you touch in [docs/specs/](../../docs/specs/), and its module README when one exists: [jobs](../../apps/api/src/jobs/handlers/README.md), [ai](../../apps/api/src/ai/README.md), [notifications](../../apps/api/src/notifications/README.md), [device-auth](../../apps/api/src/device-auth/README.md).

## Rules that apply to this domain

- **Every route declares its access.** Use `@Auth({ permissions: [PERMISSIONS.X] })` from `auth/decorators/auth.decorator.ts`, or `@Auth()` for "any signed-in user", or `@Public()` for a deliberate public route. `PERMISSIONS` lives in `common/constants/roles.constants.ts`; a new permission is also seeded in `apps/api/prisma/seed-data.ts` (`ROLE_PERMISSIONS`). Matrix: [ARCHITECTURE](../../docs/ARCHITECTURE.md).
- **The permission string is exact.** A settings card declares the same literal string its controller enforces. See [settings-ui spec](../../docs/specs/settings-ui.md).
- **Validation is Zod.** Define a schema, wrap it with `createZodDto` from `nestjs-zod`; the global `ZodValidationPipe` (`app.module.ts`) parses every body and query. Do not use class-validator.
- **Long-running work is a queue job.** Implement `JobHandler`, self-register, enqueue through `JobsService`. A `@Cron` only decides and enqueues. Prefer node eligibility (`nodeResultSchema` + `persistNodeResult`); declare `profile` as `{ maxRuntimeMs, maxAttempts }` only. See [job-queue spec](../../docs/specs/job-queue.md) and the [handler recipe](../../apps/api/src/jobs/handlers/README.md).
- **Node secrets are brokered per job.** A node never persists a job-scoped credential; declare a `nodeSecretBroker`. See [worker-nodes spec](../../docs/specs/worker-nodes.md).
- **AI goes through `AiService.forUser(userId)`.** Provider SDKs are imported only under `ai/providers/<provider>/`. `ai.*` job types are server-only. `/api/ai/*` routes sit behind `AiEnabledGuard` plus `ai:use`; `/api/admin/ai/*` use `ai_config:*` and never the guard. See the [AI README](../../apps/api/src/ai/README.md) and [ai-platform spec](../../docs/specs/ai-platform.md).
- **Runtime configuration, not environment variables.** Object storage, AI providers and keys, Web Push (VAPID) and SMTP live in system settings plus the encrypted credential store (`apps/api/src/credentials/`). Never add an env var for any of them. See [storage-providers](../../docs/specs/storage-providers.md) and [user-credentials](../../docs/specs/user-credentials.md).
- **Notifications are registry entries.** Declare the event in `notifications/notification-events.ts`, call `notify()` after the write commits and outside any transaction. See the [notifications README](../../apps/api/src/notifications/README.md).
- **OpenAPI is generated.** Annotate controllers and DTOs; never hand-write per-endpoint docs. See [API.md](../../docs/API.md).
- **Fastify, not Express.** Use the Fastify request/reply APIs. See [DEVELOPMENT.md](../../docs/DEVELOPMENT.md).

## Commands

```bash
npm run api:dev                               # repo root: API in watch mode
cd apps/api && npm run typecheck
cd apps/api && npm test                       # unit + mocked integration
cd apps/api && npm run test:db                # real-Postgres *.db.spec.ts suites
npm run openapi:dump && npm run openapi:lint  # repo root: regenerate and lint openapi.json
```

## Definition of done

- Every new route has `@Auth(...)` or `@Public()`, a Zod DTO and OpenAPI annotations.
- `npm run typecheck` and `npm test` pass in `apps/api`, including the tripwire suites under `apps/api/test/ai/` and `apps/api/test/jobs/cron-enqueue-only.spec.ts`.
- New behaviour has tests in the same or the next commit.
- A new permission, table, job type or route group is flagged for `docs-dev` so ARCHITECTURE and the owning spec stay current.
