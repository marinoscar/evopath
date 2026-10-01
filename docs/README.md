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
| [../apps/cli/README.md](../apps/cli/README.md) | `evopathcli`: install, `login`, `api`, `config`, `deploy`, `node`, CI usage |
| [../apps/api/src/email/templates/README.md](../apps/api/src/email/templates/README.md) | Building an email template: the layout contract, components, timestamp rule, preview script and the add-a-template checklist |

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
| [specs/doctor.md](specs/doctor.md) | The admin Doctor: read-only configuration and health checks | you add a check for a capability or read the Doctor's report |
| [specs/onboarding.md](specs/onboarding.md) | First-run onboarding: the welcome dialog, the admin Setup guide, the user Get started checklist, and the `onboarding` user-settings namespace | you add a checklist step, change what a new user or administrator sees first, or read `GET /api/onboarding` |
| [specs/telemetry.md](specs/telemetry.md) | GreptimeDB-backed telemetry, the Telemetry Explorer and the Telemetry Dashboard | you change telemetry ingest, storage, querying or the dashboard |
| [specs/health-data.md](specs/health-data.md) | Per-user health data: the health profile, measurements with the metric registry, daily check-ins, photo readings, and the `health_data` permissions | you add a health feature, read values off a photo, add a metric, read the profile (units, time zone, height), or read today's readiness |
| [specs/health-records.md](specs/health-records.md) | Health records: the health document store, the keep-or-delete retention choice at every upload, the `health.document.purge` job, the storage reference checker, blood work, the health data export (JSON, CSV, XLSX, PDF) and the planned AI health summary | you add a health upload, read a value's source file, or change how health files are kept or erased |
| [specs/gyms-and-equipment.md](specs/gyms-and-equipment.md) | Gyms, the equipment catalog and custom equipment, gym photos, AI Scan Gym (`ai.equipment.scan`), optional GPS location, and the `gyms` permissions | you add equipment or a capability to the catalog, read a user's gym equipment, change the scan prompt, or build another photo-to-rows flow |
| [specs/workouts.md](specs/workouts.md) | The exercise library and custom exercises, workout logging (set model, kilograms canonical, one in progress), personal records, the training summary, AI Prefill from photo (`ai.workout.prefill`), and the `exercises` and `workouts` permissions | you add an exercise to the library, change the record rules, read a user's workouts, change the prefill prompt, or build another photo-to-rows flow |
| [specs/training-signals.md](specs/training-signals.md) | Plan signals: adherence, frequency, hard sets per muscle, lift trends, effort, pain, readiness and body weight, computed deterministically for the user and for agents | you add or change a signal, read a user's adherence, or build an agent prompt from training facts |
| [specs/activity-goals.md](specs/activity-goals.md) | Activity goals: weekly and daily targets, check-ins, workout auto-credit, source precedence, progress and streaks, the `goals` permissions, and the sync-ready entry model | you change how goals count, add a goal template or activity kind, or build a device importer |
| [specs/health-connect-sync.md](specs/health-connect-sync.md) | Android Health Connect sync: the TWA plus native app, device-flow pairing, the data mapping, idempotent upserts, reconciliation, Digital Asset Links and trust, phone diagnostics | you add a Health Connect data type, change a sync rule, or debug a phone that does not sync |
| [specs/ai-training-plans.md](specs/ai-training-plans.md) | AI training plans: the researcher, planner, critic and evaluator agents, the LangGraph graphs, run state machine, guardrails and adaptation envelope, quick workout adaptation and travel workouts (rules, minimised context, apply), events, limits, and the fake-provider scenarios | you change or extend the training agents, their guardrails, the adjust-workout flow or their tests |
| [specs/ai-coach.md](specs/ai-coach.md) | AI Coach: accountability nudges chosen by a deterministic decision engine, seven personas with an age-gated profane mode, optional spoken nudges, chat, the weekly review and email, weekly streak, and progress photos | you build or change the coach, a persona, a moment or the coach settings |
| [specs/user-credentials.md](specs/user-credentials.md) | Encrypted per-user credentials | you add a bring-your-own-key credential type |
| [specs/factory-reset.md](specs/factory-reset.md) | The admin Danger Zone factory reset (`admin.factory_reset`): step design, what is deleted and kept, confirmation, extending it | you change the reset or add a model with a user relation |
| [specs/user-data-reset.md](specs/user-data-reset.md) | The per-user Danger Zone factory reset (`user.data_reset`): what is deleted and kept, confirmation, retry safety | you add a model with a user relation or change the reset |
| [specs/vps-deploy.md](specs/vps-deploy.md) | `evopathcli deploy` to a single VPS | you change the deploy commands or the deployed layout |
| [design/color-scheme-options.md](design/color-scheme-options.md) | Adopted colour scheme (Tidal Teal) for light and dark mode: the four candidates, where the theme lives, the rules for new UI and the implementation plan (interactive mock-up in `design/color-studio/`) | you change the web theme, add palette roles or chart colours |

## Runbooks

| Runbook | When you need it |
|---|---|
| [runbooks/deploy-to-vps.md](runbooks/deploy-to-vps.md) | Taking an Ubuntu VPS to a running HTTPS deployment with `evopathcli deploy`, and keeping it current |
| [runbooks/run-worker-nodes.md](runbooks/run-worker-nodes.md) | Enrolling, running and operating worker nodes with `evopathcli node` |
| [runbooks/storage-configuration.md](runbooks/storage-configuration.md) | Setting up object storage, creating the bucket, rotating its key |
| [runbooks/ai-configuration.md](runbooks/ai-configuration.md) | Turning AI on, choosing the key policy, curating models, switching it off |
| [runbooks/ai-training-plans.md](runbooks/ai-training-plans.md) | Enabling web search and models for the training agents, the fake provider overlay, cost control, run monitoring and troubleshooting |
| [runbooks/ai-coach.md](runbooks/ai-coach.md) | Enabling the AI Coach and its three models, adult-language and audio policy, caps and quiet-hour tuning, the weekly review email, engagement stats, cost estimates, troubleshooting and what the fake provider covers |
| [runbooks/vapid-keys.md](runbooks/vapid-keys.md) | Generating, enabling, rotating or removing Web Push keys |
| [runbooks/maintenance-mode.md](runbooks/maintenance-mode.md) | Opening or closing a maintenance window, or recovering from a lockout |
| [runbooks/database-restore.md](runbooks/database-restore.md) | Restoring the database from a backup, with the app possibly down |
| [runbooks/postgres-client-version.md](runbooks/postgres-client-version.md) | Backups fail because `pg_dump` is older than the server |
| [runbooks/node-job-secrets.md](runbooks/node-job-secrets.md) | Letting worker nodes take backups with short-lived database roles |
| [runbooks/rotate-secrets-encryption-key.md](runbooks/rotate-secrets-encryption-key.md) | Rotating or recovering from the loss of `SECRETS_ENCRYPTION_KEY` |
| [runbooks/deployment-info.md](runbooks/deployment-info.md) | Reading the About page's deployment sections |
| [runbooks/telemetry.md](runbooks/telemetry.md) | Enabling the GreptimeDB telemetry overlay, setting retention, configuring the AI assistant, connecting a BI tool |
| [runbooks/doctor.md](runbooks/doctor.md) | Triaging a misconfigured or unhealthy deployment with the admin Doctor |
| [runbooks/android-app.md](runbooks/android-app.md) | Installing the APK, trusting it, pairing a phone, making source apps share to Health Connect, and diagnosing a phone by self-test check |
| [runbooks/android-release.md](runbooks/android-release.md) | Shipping a new Android APK: keystore, versioning, release from the CLI, the terminal menu, a deploy, the admin page or CI, verifying, rolling back and troubleshooting |
| [runbooks/factory-reset.md](runbooks/factory-reset.md) | Wiping a deployment to a fresh install: backup first, run the reset, verify, recover, troubleshoot |

## Developer recipes in the code

READMEs that live next to the code they describe.

| README | Use it for |
|---|---|
| [../apps/api/src/jobs/handlers/README.md](../apps/api/src/jobs/handlers/README.md) | Adding a job type |
| [../apps/api/src/jobs/contracts/README.md](../apps/api/src/jobs/contracts/README.md) | Result schemas a worker node posts back for a node-eligible type |
| [../apps/cli/src/node/executors/README.md](../apps/cli/src/node/executors/README.md) | The CLI side of a node-eligible job type |
| [../apps/api/src/ai/README.md](../apps/api/src/ai/README.md) | Using AI from a feature; the AI module's map; recipes for a training agent or node and for an agent graph feature like quick adaptation |
| [../apps/api/src/intake/README.md](../apps/api/src/intake/README.md) | Adding a photo-intake kind; the intake module's map |
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
