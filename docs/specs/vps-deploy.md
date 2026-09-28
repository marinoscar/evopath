# VPS Deployment (`appctl deploy`)

> **Status:** shipped · **Code:** `apps/cli/src/deploy/`, `apps/cli/src/commands/deploy.ts`, `apps/cli/src/tui/screens/deploy.tsx`, `infra/compose/vps.compose.yml`, `apps/api/src/about/`, `apps/web/src/pages/Admin/AboutPage.tsx` · **API:** `GET /api/admin/about` (see `/api/docs`) · **Admin UI:** `/admin/settings/about` · **Runbooks:** [deploy-to-vps.md](../runbooks/deploy-to-vps.md), [deployment-info.md](../runbooks/deployment-info.md) · **Command reference:** [apps/cli/README.md](../../apps/cli/README.md#deploying-to-a-server)

`appctl deploy` installs, updates, inspects and removes this application on a
Linux server with Docker. The operator runs it on the server itself. It clones
the fork, writes `.env` through a wizard generated from `.env.example`, builds
images, migrates and seeds an external PostgreSQL database, starts the stack
on a loopback port, and publishes it through a shared host reverse proxy that
terminates TLS. It leaves a state file and a deployment document behind, which
the admin About page reads.

## 1. Purpose

- **What it is.** The only deployment tool in this repository. There is no
  separate deploy script or Ansible playbook, and there should not be one.
  A fork deploys itself: nothing about the repository URL or product name is
  hard-coded.
- **What it is not.**
  - Not a remote orchestrator: the CLI contains no SSH client.
  - Not a registry-based deploy: images are built on the server; nothing pulls
    from GHCR.
  - Not a database host: PostgreSQL is always external.
  - No automatic rollback of a failed `update`.
- **Problem it solves.** A team that forks the template gets a repeatable,
  resumable, idempotent path from "a VPS with Docker" to "served over HTTPS at
  a real domain", with several applications able to share one server.

## 2. How it works

### Design decisions in force

| Decision | Meaning | Rules out |
|---|---|---|
| Runs on the VPS | The operator SSHes in with their own credentials and runs `appctl` there | An SSH library in the CLI, laptop-driven orchestration, managing SSH keys |
| Git + build | `git clone`/`fetch` and `docker compose build` on the server, every time | Pulling pre-built images |
| TLS by a shared host proxy | One nginx + certbot stack at `/opt/infra/proxy`, outside this repository, serves every app on the box. The app binds `127.0.0.1` only | Per-app port 443, per-app certbot timers |
| External PostgreSQL | `POSTGRES_*` point at a server the operator provides. There is no `db` service in any production compose file | The CLI managing database volumes, backups or upgrades |
| A state document written by the CLI | The CLI records what it deployed (`.appctl-deploy.json`) and publishes `deploy-info/info.json`, which the API reads through a read-only bind mount | A second deployment registry, the API guessing its own provenance |

### Commands

| Subcommand | Does |
|---|---|
| `doctor` | Runs the prerequisite checks; exits `6` (`PRECONDITION`) on any required failure |
| `install` | Full pipeline on a new deployment directory |
| `update` | Brings an existing deployment to the latest revision of its ref |
| `status` | Containers, local and external health, migrations, certificate |
| `list` | Every deployment under the apps root |
| `about` | Prints `deploy-info/info.json` from disk (never asks the API) |
| `certs` | Inspects or renews the certificate (`--renew`, `--force`, `--staging`) |
| `uninstall` | Removes a deployment, after a read-only inventory (`--dry-run` shows it) |

Flags per subcommand are in [apps/cli/README.md](../../apps/cli/README.md#deploying-to-a-server).
Every subcommand keeps the CLI's two rules: human output on stderr, `--json`
on stdout only, and failure is a non-zero exit.

### Layout on the server

```
/opt/infra/proxy/                 # shared proxy (not in this repo)
  docker-compose.yml, conf.d/<domain>.conf, webroot/, letsencrypt/
/opt/infra/apps/<app-name>/       # one deployment (DEFAULT_APPS_ROOT)
  repo/                           # the CLI's own clone of the fork
    infra/compose/.env            # written here today (legacy location)
  .env                            # preferred by readers when present
  .appctl-deploy.json             # deploy state (0600, atomic write)
  deploy-info/info.json           # the document the API reads
  logs/<run>.log, <run>.jsonl     # run journal
```

`.env` is written at `repo/infra/compose/.env`. `resolveEnvPath` already
prefers `<root>/.env` when it exists, in anticipation of moving it out of the
checkout.

### Locating a deployment

`layout.ts`'s `locateApp` resolves which deployment a command acts on, in five
ranks:

1. an explicit `--root`;
2. an explicit `--name` (under `--apps-root`, default `/opt/infra/apps`);
3. the deployment the current directory is inside (bounded by the apps root);
4. the sole installed deployment;
5. otherwise **refuse, naming every candidate**. It never picks one.

`DEPLOY_ROOT` is written into `.env` by the CLI and is deliberately absent from
`.env.example`. It marks a deployment this CLI wrote, so enumeration can skip a
foreign application sharing the apps root. Two forks of this template on one
host are still ambiguous; rank 3 is what resolves that in practice.

### Deployment evidence and adoption

A deployment **is** a git checkout at `<root>/repo` **and** a readable `.env`
(`deployment-evidence.ts`, `isDeployment`). The state file is not required.
`layout.ts` and `update.ts` share that predicate. When the state file is
missing, `update` **adopts** the deployment (`adopt.ts`): it rebuilds a record
from the checkout's origin and ref and the `.env`'s `APP_BIND_PORT`, sets
`adoptedAt`, and invents nothing else.

### Install pipeline

Each step is idempotent. A failed run records `completedSteps` and
`lastFailedStep`; `--resume` continues from the failed step. `install` refuses
a directory that already holds a deployment unless `--reinstall` or `--resume`
is passed.

| Step | Does |
|---|---|
| `preflight` | Required doctor checks (skippable with `--skip-doctor`) |
| `checkout` | Clone or fetch the repo at `--ref`. For a private GitHub HTTPS URL with `gh` logged in, runs `gh auth setup-git` first |
| `environment` | The env wizard, or answers from `--answer`/`--answers-file` |
| `validate-environment` | Formats, database reachability and credentials, OAuth probe |
| `ensure-database` | Create the database if it is the only thing missing (see below) |
| `version` | Choose, write and commit the release version (see below) |
| `build` | `docker compose -f base -f prod -f vps build` (`--no-cache` available) |
| `migrate` | `docker compose run --rm --no-deps api npm run prisma:migrate` |
| `seed` | `… npm run prisma:seed` (idempotent upserts; `--skip-seed` to skip) |
| `start` | `up -d` |
| `health` | Poll `http://127.0.0.1:<port>/api/health/ready` |
| `deploy-info` | Write `deploy-info/info.json` (first write, at the health gate) |
| `proxy-bootstrap` | Create the shared proxy if absent (asks, or `--bootstrap-proxy`) |
| `publish` | Render the vhost, issue the certificate, validate, reload (`--skip-proxy` to skip) |
| `renewal` | Schedule renewal unless something already owns it (`--skip-renewal`) |
| `verify` | Containers, local ready and frontend, pending migrations (`prisma migrate status`), external HTTPS, OAuth smoke |
| `publish-version` | Push the version commit (last; a failed push is a warning) |

`/api/health/ready` passes against an empty, unmigrated database. Only the
`migrate` step's exit code and `verify`'s migration status prove migrations
ran.

### Update pipeline

`preflight`, `fetch`, `environment-drift`, `ensure-database`, `version`,
`build`, `migrate`, `seed`, `restart`, `health`, `deploy-info`, `publish`,
`renewal`, `verify`, `publish-version`.

- `fetch` compares the ref's SHA with the recorded `commitSha`. Unchanged and
  no `--force`: report "up to date" and do nothing.
- `environment-drift` finds `.env.example` keys missing from `.env`. It prompts
  for just those keys, or fails under `--non-interactive`.
- The seed re-runs by default, so new permissions and roles reach existing
  installs.
- There is no automatic rollback. The previous SHA is recorded
  (`previousSha`) for a manual `git checkout` and re-run.

### Environment wizard

- **`env-spec.ts`** parses `infra/compose/.env.example` at run time: banners
  become sections, comments above a key become its help, an active `KEY=value`
  is a required-shape entry, a commented `# KEY=value` is optional, and
  trailing inline comments are stripped from values.
- **`env-metadata.ts`** is the only hard-coded list: `secret` (masked input,
  redacted in logs), `generate` (`randomBytes(32)` in-process for
  `JWT_SECRET`, `COOKIE_SECRET`, `SECRETS_ENCRYPTION_KEY`), validators (32-char
  minimum; `SECRETS_ENCRYPTION_KEY` must decode to 32 bytes), `derivedFrom`
  (`APP_URL` and `GOOGLE_CALLBACK_URL` from the one domain question),
  `essential` (prompted by default), and optional `group`s such as
  `observability` and `email`, opted into with `--group`.
- `--all` reviews every key. A key a fork adds to `.env.example` with no
  metadata entry is still prompted as plain text.
- `.env` is written with mode `0600` via a temp file and rename.

### Doctor checks

Registered in `apps/cli/src/deploy/checks/`, one module per area, shared by
`doctor` and the pipelines' `preflight`:

| Area | Check ids |
|---|---|
| Host | `docker-installed`, `docker-daemon`, `docker-compose-v2`, `git-installed`, `node-version`, `disk-space`, `memory`, `bind-port-free` |
| Source | `gh-installed`, `gh-authenticated` |
| Database | `database-reachable`, `database-credentials`, `database-exists`, `database-privileges`, `database-ssl`, `database-create-privilege` |
| DNS | `dns-resolves`, `dns-points-here` |
| Proxy and TLS | `proxy-root`, `proxy-conf-writable`, `acme-webroot`, `certbot-installed`, `proxy-container`, `proxy-config-valid`, `certificate-present`, `certificate-validity`, `certificate-renewal`, `certificate-renewal-paths`, `certificate-served` |

`certbot-installed` is required only when the proxy runs on the host. DNS and
TLS checks run when `--domain` is given.

### Shared proxy and TLS

- **`ProxyRuntime`** (`proxy.ts`) makes the proxy's shape explicit:
  `mode: 'container' | 'host'`, the container name (default `proxy-nginx`),
  and the certificate and webroot paths **as nginx sees them**
  (`/etc/letsencrypt`, `/var/www/certbot` in container mode). Resolution order:
  `--proxy-mode`/`--proxy-container`; the deployment's recorded values;
  `docker inspect` finding the container; a host `nginx -v`; otherwise
  container mode.
- **Publishing** renders `conf.d/<domain>.conf` (HTTP-01 challenge location,
  redirect to HTTPS, `proxy_pass http://127.0.0.1:<APP_BIND_PORT>`, and
  `X-Forwarded-Proto` set at this outermost hop), issues the certificate with
  certbot's **webroot** method (the dockerised `certbot/certbot:latest` in
  container mode), runs `nginx -t` (inside the container in container mode),
  and reloads only if validation passed. Any failure restores the previous
  vhost, so one app cannot take down its neighbours. Vhosts carry a
  `# Managed by appctl deploy` sentinel; uninstall never removes one without it.
- **Renewal ownership** (`renewal.ts`, `detectRenewalOwner`): a central script,
  then a systemd `certbot.timer`, then another direct cron line, then this
  CLI's own `/etc/cron.d/<cli>-certbot-renew`, then none. Only `none` makes the
  CLI install its twice-daily entry (`17 3,15 * * *`), which renews **and
  reloads** the proxy. In container mode, a host mechanism that does not touch
  the proxy's `letsencrypt/` mount is reported but not counted as the owner.
- `certs --renew` renews within 30 days of expiry (`RENEW_WITHIN_DAYS`).

### Database creation

`ensureDatabase` (`database.ts`) creates the database only when the server is
reachable, the credentials work, and the only problem is that the database does
not exist (`3D000`). It asks first, or needs `--create-database` under
`--non-interactive`, because a typo in `POSTGRES_DB` looks exactly like a
missing database. It only ever issues `CREATE DATABASE "<name>"` on the
`postgres` maintenance database, with the name checked against
`^[A-Za-z_][A-Za-z0-9_$]*$` and the password passed via `PGPASSWORD`.

### OAuth probe

`oauth-check.ts`, run in `validate-environment` and again in `verify`:

1. **Shape:** `GOOGLE_CLIENT_ID` matches
   `^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$`.
2. **Callback:** `GOOGLE_CALLBACK_URL` is exactly
   `https://<domain>/api/auth/google/callback`.
3. **Live probe:** a POST to `https://oauth2.googleapis.com/token` with a
   deliberately invalid code. `invalid_grant` is a **pass** (Google accepted the
   client before rejecting the code). `invalid_client`, `unauthorized_client`
   and `redirect_uri_mismatch` fail. Anything else (timeout, egress blocked) is
   a warning.

`--skip-oauth-check` skips the live probe and downgrades a malformed id to a
warning, for test deployments with dummy credentials.

### Deploy-time version bump

The `version` step asks for (or takes `--app-version`) the release version,
writes it into the manifests listed in `app-version.ts` (`VERSIONED_MANIFESTS`)
and the lockfile's workspace entries **textually**, and commits in the same
step. `publish-version` pushes it last, as
`git push origin HEAD:refs/heads/<ref>`, never with `--force` and never
retried. A failed push is a warning and the local commit is rolled back, so the
clone always ends at `origin/<ref>`. `--no-version-bump` deploys the current
version with no write, commit or push.

### Compose project name

Recorded at install (`composeProject`, the deployment directory's basename)
and passed as `-p` on every call; never re-derived. A deployment that predates
the field keeps the name `compose`, which is what Compose derived for it
originally. Renaming an existing project would start a second stack on the same
port.

### Run journal

Every run writes `<root>/logs/<run>.log` and `.jsonl` (argv, cwd, exit code,
duration, output) in a `0700` directory, keeping the newest 10 runs. Every
value marked `secret`, typed or generated, is replaced by a placeholder before
anything is written. Redaction is a literal match against known values, so a
fork's new secret needs a `secret: true` metadata entry.

### Deploy state

`<root>/.appctl-deploy.json`, never `~/.appctl/config.json` (which `appctl
login` rewrites whole). Version `2` (`DEPLOY_STATE_VERSION`). A v1 file is
upgraded in place (`history: []`, `host`/`proxy` absent); an unknown version is
refused with the remedy.

| Field group | Fields |
|---|---|
| Source | `repoUrl`, `ref`, `commitSha`, `previousSha` |
| Placement | `deployRoot`, `domain`, `bindPort`, `composeProject`, `groups` |
| Proxy | `proxyRoot`, `proxyMode`, `proxyContainer`, `proxy` (domain, port, mode, container, certificate expiry) |
| Timeline | `installedAt` (never overwritten), `lastDeployedAt`, `adoptedAt`, `lastCommand`, `appctlVersion` |
| Resume | `completedSteps`, `lastOutcome`, `lastFailedStep`, `lastAttemptAt` |
| Host | `host`: hostname, OS, kernel, arch, CPUs, memory, Docker and Compose versions (each `null` if a probe fails) |
| History | `history`: successful runs only, newest first, capped at 20 |

### Deployment info and the About page

The CLI publishes what it deployed; the running application reports it.

- **The document.** `<root>/deploy-info/info.json`, written by
  `deploy-info.ts` atomically (temp file, rename). It is written **at the
  health gate** (so a run that fails later still describes a running
  deployment) and rewritten at the end of a successful run with that run's
  history entry and certificate. `schema` is `1` and stays `1`: the reader
  validates `schema` strictly and every other field leniently, so new fields
  never need a bump. `null` means "known to be absent".
- **Fields:** `app` (name, version, commitSha, ref), `installedAt`,
  `updatedAt`, `deployedBy` (cli, version), `domain`, `remote`
  (commitsBehind, checkedAt; currently `null`), `run` (completed steps,
  failedStep, outcome), `lastCommand`, `bindPort`, `proxy` (mode, container,
  certificateExpiresAt), `host` (as in state), `history` (at, command,
  commitSha, previousCommitSha, ref, durationMs, cliVersion, outcome).
- **The mount.** `vps.compose.yml` mounts `${DEPLOY_ROOT}/deploy-info` at
  `/app/deploy-info` **read-only**, and sets `DEPLOY_INFO_PATH`. The directory
  is mounted, not the file, so an atomic rename is visible without a restart.
  Install creates the directory before `up`, or Docker would create it
  root-owned.
- **The API.** `apps/api/src/about/` serves `GET /api/admin/about`
  (`system_settings:read`, no permission of its own). It always answers `200`:
  `deployInfoStatus` is `ok`, `absent` or `invalid` (with `deployInfoPath` and
  `deployInfoError`), alongside the API's own `api.version`, a live `runtime`
  block (`processStartedAt`, `nodeVersion`, `environment`) and a database
  liveness check. `runtime` describes the process now; the document describes
  the server as last deployed. The two are never merged.
- **The UI.** The About card at `/admin/settings/about` (Operations group).
  `/admin/settings/deployment` redirects there; it is one destination, not two.
- **The CLI.** `appctl deploy about` reads the same file from disk, so it works
  while the app is down and needs no login.

What the page shows, and how to re-point the mount, is in
[deployment-info.md](../runbooks/deployment-info.md).

### Removing a deployment

`uninstall` builds a read-only inventory first (`planUninstall`), then removes
the stack (`down -v`), its vhost, and `repo/`, `logs/`, `deploy-info/`,
`.env` and the state file. It never touches shared
infrastructure: the Docker network, the proxy container, the TLS certificate,
or the renewal cron entry.

Destructive extras each need their own flag **and** the resource's real name
typed back:

- `--purge-storage --confirm-bucket <name>` runs
  `npm run storage:purge` inside the built `api` image before teardown, because
  only the running application can decrypt the runtime-configured storage
  credential. A purge that does not happen stops the uninstall.
- `--drop-database --confirm-database <name>`: after `down -v`, drops the
  database via `psql` in a throwaway `postgres:16-alpine` container
  (`--network host`, password by name, `PGSSLMODE=require` when
  `POSTGRES_SSL=true`, `PGCONNECT_TIMEOUT=5`), terminating only that
  database's own backends if it is busy. A failed drop stops the uninstall
  and keeps the checkout, `.env`, vhost and state so the same command can be
  re-run; the role must own the database, or be superuser. A database inside
  the compose stack itself (the `devdb` overlay, `POSTGRES_HOST=db`) cannot
  be dropped this way, since `down -v` removes its volume first.

### CLI and TUI seam

`install.ts`/`update.ts` never write to the terminal. They report through
`DeployHooks` (step start and result, log lines, progress).
`commands/deploy.ts` renders them to stderr; `tui/screens/deploy.tsx` renders
the same callbacks as React state, inside a bounded `ScrollBox`. Subprocesses
run through `executor.ts`: argv only, `shell: false`, a timeout, streamed and
ANSI-stripped output, and an `AbortSignal`.

### Exit codes

`0` OK, `1` failure, `2` usage, `3` API, `4` network, `5` auth, `6`
`PRECONDITION` (a required check failed before anything destructive ran).
Defined in `apps/cli/src/errors.ts`.

## 3. Configuration and permissions

### Environment variables

- `APP_BIND_PORT` — loopback port nginx publishes on (default `3535`); the
  proxy forwards to it. In `.env.example`.
- `DEPLOY_ROOT` — written by the CLI only; locates `deploy-info/` for the bind
  mount and marks a CLI-written `.env`. Never in `.env.example`.
- `DEPLOY_INFO_PATH` — where the API reads the document (default
  `/app/deploy-info/info.json`, set by `vps.compose.yml`).

Everything else comes from `infra/compose/.env.example`; see the wizard above.

### Compose overlay

`infra/compose/vps.compose.yml`, layered after `base` and `prod`:

- `nginx.ports: !override ["127.0.0.1:${APP_BIND_PORT:-3535}:80"]`. The
  `!override` tag replaces the inherited list; a plain `ports:` would merge and
  keep `0.0.0.0:3535`.
- The read-only `deploy-info` bind mount and `DEPLOY_INFO_PATH` on `api`.
- `json-file` log rotation (10 MB × 3) on `nginx`, `api` and `web`.

When the `observability` group is recorded for the deployment,
`composeFilesFor` (`apps/cli/src/deploy/compose-files.ts`) also layers
`telemetry.compose.yml` (before the VPS files, so it inherits their
hardening) and `vps.telemetry.compose.yml` last (so its `ports: !override`
is the final word): the OTel Collector publishes no host port at all, and
GreptimeDB's PostgreSQL wire port is published on
`127.0.0.1:${GREPTIME_BIND_PG_PORT:-14003}` only. See
[specs/telemetry.md](telemetry.md) and the
[telemetry runbook](../runbooks/telemetry.md).

### Permissions and API

| Method + route | Purpose | Permission |
|---|---|---|
| `GET /api/admin/about` | API version, deployment document, runtime, database liveness | `system_settings:read` |

## 4. Extending it in a fork

- **New environment variables.** Add them to `infra/compose/.env.example`; the
  wizard picks them up. Add an `env-metadata.ts` entry for anything secret
  (`secret: true`), generated, derived, essential or grouped. Never add a
  commented `# KEY=value` example line that is not a real optional key: the
  parser treats it as a declaration.
- **A new doctor check.** Add it to the matching module in `checks/` and to
  its registry export; `doctor` and `preflight` both read it.
- **A new pipeline step.** Add it to `install.ts` and/or `update.ts`. Make it
  idempotent, since `--resume` re-enters after the last completed step.
- **A new About field.** Add it to the document builder in
  `apps/cli/src/deploy/deploy-info.ts` and to the reader
  (`apps/api/src/about/deploy-info.ts`) and DTO. Do not bump `schema`.
- **Different hosting.** Not a CLI flag. A registry-based deploy
  (`deploy.yml` already builds images) would be a new mode that skips `build`.

## 5. Guardrails

| Guardrail | Enforces |
|---|---|
| `.github/workflows/deploy-e2e.yml` | Real Docker, a real PostgreSQL service, a fake VPS layout: unattended `install`, the version bump rolled back (not left ahead of origin), the document reaching the running container, `update` twice with nothing moved and no image rebuilt, journal redaction, `status` healthy. Runs on changes to `apps/cli/**`, `infra/compose/**` or the Dockerfiles, and nightly |
| `.github/workflows/deploy.yml` | Not this CLI: tag-triggered build and push of the `api`, `web` and `worker` images to GHCR. Its staging/production deploy jobs are `echo` stubs. Kept separate from `deploy-e2e.yml` on purpose |
| `apps/cli/src/deploy/testing/fake-vps.test.ts` | Pipelines against a simulated server |
| `apps/cli/src/deploy/install.test.ts`, `install-hardening.test.ts`, `update.test.ts`, `update-publish.test.ts`, `version-step.test.ts` | Step order, resume, adoption, version push rules |
| `apps/cli/src/deploy/layout.test.ts`, `deployment-evidence.test.ts`, `adopt.test.ts`, `compose-project.test.ts` | Five ranks, the evidence predicate, adoption, recorded project names |
| `apps/cli/src/deploy/proxy.test.ts`, `proxy-certs.test.ts`, `proxy-bootstrap.test.ts`, `renewal.test.ts`, `checks/tls.test.ts` | Container vs host paths, validate-then-reload, rollback, renewal ownership |
| `apps/cli/src/deploy/env-spec.test.ts`, `env-wizard.test.ts`, `journal.test.ts`, `journal-hook.test.ts` | `.env.example` parsing, wizard behaviour, redaction |
| `apps/cli/src/deploy/database.test.ts`, `oauth-check.test.ts`, `uninstall.test.ts`, `state.test.ts`, `deploy-info.test.ts` | Database creation rules, OAuth classification, uninstall confirmations, state upgrade, document shape |
| `apps/api/src/about/deploy-info.spec.ts`, `apps/api/test/about/deploy-info-contract.spec.ts`, `apps/api/test/about/about.integration.spec.ts` | Lenient reader, CLI/API contract, the endpoint and its permission |
| `apps/web/src/__tests__/pages/Admin/AboutPage.test.tsx`, `apps/web/src/__tests__/hooks/useAbout.test.ts` | The About page's states |

## 6. Design decisions

- **Run on the server, no SSH client.** Reuses the operator's authenticated
  session; no key handling, and laptop network flakiness cannot break a deploy.
- **Build on the server, not pull from GHCR.** No registry credentials on the
  server and no compose file using `image:`. A `--from-registry` mode is the
  natural later addition.
- **Shared host proxy, not per-app TLS.** A second app on the box is normal;
  only one process can own port 443 and one renewal schedule.
- **External PostgreSQL.** Keeps the CLI's blast radius to the stateless tier.
- **Wizard generated from `.env.example`.** A hard-coded list goes stale the
  day a fork edits the file. An essential subset plus `--all` keeps the common
  path short.
- **State in its own file.** `~/.appctl/config.json` is rewritten whole by
  `appctl login`.
- **Evidence, not bookkeeping.** A lost state file must not make a live
  deployment "uninstalled". Adoption invents nothing (no `installedAt` from
  `mtime`).
- **Ambiguity refuses.** No tiebreak at rank 5; the marker cannot tell "ours,
  older" from "not ours".
- **Recorded compose project name.** Re-deriving would start a parallel stack.
- **Typed resource names for destructive extras**, never a shared word like
  `DELETE`: dropping a database is not consent to empty a bucket.
- **Storage purge inside the api image.** The CLI cannot import `apps/api`
  (`rootDir: ./src`) and cannot decrypt the credential.
- **Prompt before `CREATE DATABASE`.** A typo would otherwise migrate into a
  new empty database.
- **`invalid_grant` is a pass.** Google validates the client before the code.
- **Act on the existing renewal owner.** A second renewer races and spends a
  shared Let's Encrypt budget.
- **Extend the About page, not a new Deployment page.** One destination
  gaining content (Settings UI rule 2); no new permission.
- **`schema` stays `1`.** A bump would make every running API report `invalid`
  the moment a newer CLI writes the file.
- **Version at deploy time.** Accepted costs: the running commit is not the one
  CI built (bounded to version fields), and the server can push. Push last,
  never force, never retry.
- **No automatic rollback.** Reverting a migration needs a human.

## 7. Verification

On a disposable VPS with Docker, DNS pointing at it, and an external
PostgreSQL:

1. Build the CLI in a checkout of your fork (`npm run build --workspace=cli`,
   see [apps/cli/README.md](../../apps/cli/README.md)), then:
   ```bash
   appctl deploy doctor --domain app.example.com
   ```
   Expect every required check to pass, or exit `6` with a remedy.
2. Install with Let's Encrypt staging first:
   ```bash
   appctl deploy install --domain app.example.com --staging
   ```
   Watch each step report; `verify` should show containers up, ready, frontend
   up, no pending migrations, external HTTPS.
3. Check the binding: `docker compose -f base.compose.yml -f prod.compose.yml
   -f vps.compose.yml config` (in `repo/infra/compose`) shows one `nginx` port
   with `host_ip: 127.0.0.1`.
4. `appctl deploy status` and `appctl deploy about` agree with the About page
   at `/admin/settings/about` (`deployInfoStatus: "ok"`).
5. `appctl deploy update`: with no new commits it reports "up to date" and
   rebuilds nothing.
6. `grep` a known secret value in `<root>/logs/*.log`: no match.
7. `appctl deploy uninstall --dry-run` lists what would go and what is kept.
8. Tests: `npm test --workspace=cli -- --run`; the `Deploy E2E` workflow for
   the full pipeline against real Docker.

The operator procedure, prerequisites and troubleshooting are in
[deploy-to-vps.md](../runbooks/deploy-to-vps.md).

## History

- Epic #168: the `appctl deploy` command family, `vps.compose.yml`, the TUI
  screen, and the infra fixes it needed (`env_file` on `api`, loopback bind,
  password URL-encoding in the database URL builder).
- Epic #397 (#398–#405): multi-app layout and five-rank resolution, evidence
  and adoption, `uninstall`, recorded compose project names, deploy-info and
  the About page (#401), deploy-time versioning (#405); #407 added the Deploy
  E2E workflow.
- Epic #388 (#389–#393): `ProxyRuntime` container/host split (#389); renewal
  ownership, the database-creation prompt, the OAuth probe and new doctor
  checks (#390–#392); deploy state v2 carried by the About page (#392).
- #522: `--drop-database` drops the database after the stack stops.
