# Documentation index

Every document in this repository, grouped by what you need it for. Links are
relative to `docs/`.

- A **spec** (`specs/`) describes the design of one feature and serves as its reference: the model, the rules, and the rejected alternatives. It is written for developers extending the template.
- A **runbook** (`runbooks/`) is a step-by-step procedure for an operator running a deployment.

## Read first

In this order:

1. [../README.md](../README.md): what the template is, what you get, how to start a new app.
2. [ARCHITECTURE.md](ARCHITECTURE.md): the subsystem map, permission matrix, tables and job types.
3. [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md): authentication, credential kinds, RBAC, transport and data protection.
4. [DEVELOPMENT.md](DEVELOPMENT.md): the dev loop and Fastify, Prisma and Passport gotchas.
5. [TESTING.md](TESTING.md): test layers, helpers and how to run each suite.
6. [RENAMING.md](RENAMING.md): turning the template into your own product.

## Guides

| Guide | What it covers |
|---|---|
| [API.md](API.md) | API conventions: auth schemes, response envelope, pagination, errors, `If-Match`, SSE, rate limits, how the OpenAPI document is produced |
| [DEVICE-AUTH.md](DEVICE-AUTH.md) | Integrating a CLI or device with the RFC 8628 device flow |
| [personal-access-tokens.md](personal-access-tokens.md) | Creating and using `pat_` tokens for scripts and CI |
| [../apps/cli/README.md](../apps/cli/README.md) | `appctl`: install, `login`, `api`, `config`, `deploy`, `node`, CI usage |

## Feature specs

| Spec | Feature | Read it when… |
|---|---|---|
| [specs/settings-ui.md](specs/settings-ui.md) | Registry-driven settings hubs | you add a settings page, admin or per-user |
| [specs/storage-providers.md](specs/storage-providers.md) | Runtime-configured object storage (S3, R2, S3-compatible) | you touch storage configuration or a storage consumer |
| [specs/job-queue.md](specs/job-queue.md) | Postgres-backed background job queue | you add a job type or anything long-running |
| [specs/worker-nodes.md](specs/worker-nodes.md) | Remote worker nodes and their data plane | you make a job type node-eligible or change the node API |
| [specs/ai-platform.md](specs/ai-platform.md) | Admin-governed, bring-your-own-key AI | you use AI from a feature or add a provider |
| [specs/browser-notifications.md](specs/browser-notifications.md) | Notification channels, service worker, Web Push | you add a notification event or channel |
| [specs/notification-broadcasts.md](specs/notification-broadcasts.md) | Admin broadcasts to every user | you change how broadcasts are composed or fanned out |
| [specs/database-backup.md](specs/database-backup.md) | Scheduled and on-demand `pg_dump` backups | you change backups or their node offload |
| [specs/database-restore.md](specs/database-restore.md) | Restore and rollback from a backup | you change restore gates or outcomes |
| [specs/maintenance-mode.md](specs/maintenance-mode.md) | The 503 maintenance window | you change maintenance behaviour or its layers |
| [specs/telemetry.md](specs/telemetry.md) | GreptimeDB-backed telemetry, the Telemetry Explorer and the Telemetry Dashboard | you change telemetry ingest, storage, querying or the dashboard |
| [specs/user-credentials.md](specs/user-credentials.md) | Encrypted per-user credentials | you add a bring-your-own-key credential type |
| [specs/vps-deploy.md](specs/vps-deploy.md) | `appctl deploy` to a single VPS | you change the deploy commands or the deployed layout |

## Runbooks

| Runbook | When you need it |
|---|---|
| [runbooks/deploy-to-vps.md](runbooks/deploy-to-vps.md) | Taking an Ubuntu VPS to a running HTTPS deployment with `appctl deploy`, and keeping it current |
| [runbooks/run-worker-nodes.md](runbooks/run-worker-nodes.md) | Enrolling, running and operating worker nodes with `appctl node` |
| [runbooks/storage-configuration.md](runbooks/storage-configuration.md) | Setting up object storage, creating the bucket, rotating its key |
| [runbooks/ai-configuration.md](runbooks/ai-configuration.md) | Turning AI on, choosing the key policy, curating models, switching it off |
| [runbooks/vapid-keys.md](runbooks/vapid-keys.md) | Generating, enabling, rotating or removing Web Push keys |
| [runbooks/maintenance-mode.md](runbooks/maintenance-mode.md) | Opening or closing a maintenance window, or recovering from a lockout |
| [runbooks/database-restore.md](runbooks/database-restore.md) | Restoring the database from a backup, with the app possibly down |
| [runbooks/postgres-client-version.md](runbooks/postgres-client-version.md) | Backups fail because `pg_dump` is older than the server |
| [runbooks/node-job-secrets.md](runbooks/node-job-secrets.md) | Letting worker nodes take backups with short-lived database roles |
| [runbooks/rotate-secrets-encryption-key.md](runbooks/rotate-secrets-encryption-key.md) | Rotating or recovering from the loss of `SECRETS_ENCRYPTION_KEY` |
| [runbooks/deployment-info.md](runbooks/deployment-info.md) | Reading the About page's deployment sections |
| [runbooks/telemetry.md](runbooks/telemetry.md) | Enabling the GreptimeDB telemetry overlay, setting retention, configuring the AI assistant, connecting a BI tool |

## Developer recipes in the code

READMEs that live next to the code they describe.

| README | Use it for |
|---|---|
| [../apps/api/src/jobs/handlers/README.md](../apps/api/src/jobs/handlers/README.md) | Adding a job type |
| [../apps/api/src/jobs/contracts/README.md](../apps/api/src/jobs/contracts/README.md) | Result schemas a worker node posts back for a node-eligible type |
| [../apps/cli/src/node/executors/README.md](../apps/cli/src/node/executors/README.md) | The CLI side of a node-eligible job type |
| [../apps/api/src/ai/README.md](../apps/api/src/ai/README.md) | Using AI from a feature; the AI module's map |
| [../apps/api/src/notifications/README.md](../apps/api/src/notifications/README.md) | Adding a notification; the notifications module's map |
| [../apps/api/src/storage/processing/processors/README.md](../apps/api/src/storage/processing/processors/README.md) | Post-upload storage object processors |
| [../apps/api/src/device-auth/README.md](../apps/api/src/device-auth/README.md) | Device flow reference: schemas, fields, security rationale |
| [../apps/api/scripts/README.md](../apps/api/scripts/README.md) | The `prisma-env.js` wrapper that builds `DATABASE_URL` |
| [../packages/shared/README.md](../packages/shared/README.md) | Product identity: name and brand colours shared by every app |

## Agent rules

For AI coding agents working in this repository.

- [../CLAUDE.md](../CLAUDE.md): binding rules and pointers.
- [../.claude/agents/](../.claude/agents/): the specialised subagents (backend, frontend, database, testing, docs, ops).
- [../.claude/skills/new-project/SKILL.md](../.claude/skills/new-project/SKILL.md): bootstrap a new product from the template.
- [../.claude/skills/rename-app/SKILL.md](../.claude/skills/rename-app/SKILL.md): rename and rebrand a fork.
