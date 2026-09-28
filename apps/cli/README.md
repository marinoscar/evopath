# CLI (`appctl`)

First-party command-line client for the API. It authenticates with the same
device authorization flow as any other headless client, stores a personal
access token, and then lets you call any API endpoint from a shell — which
matters because this repository is a **baseline**: new endpoints get added
and old ones get renamed constantly, and a CLI that hard-codes a subcommand
per resource goes stale the day it ships. `appctl` has exactly one command
that talks to the API (`api <method> <path>`), so it stays correct against
endpoints that don't exist yet.

Run with no arguments in an interactive terminal and it opens a full-screen
menu (login, call an endpoint, status, worker node, deploy this server,
logout) built with [ink](https://github.com/vadimdemedes/ink). Everything that menu can do
is also a plain subcommand, and the subcommands are what this document
covers — they're what you'd script or run in CI.

## What appctl does

Four jobs, one binary. Each is also reachable from the full-screen menu.

**Create a local environment.** From a clone of the repository, `init` writes
`infra/compose/.env` from the checkout's own `.env.example` and generates
every secret. `npm run setup` at the repository root builds the CLI and runs
it for you.

```bash
appctl init --admin-email you@example.com
```

**Call any endpoint, with no stale wrappers.** Log in once through the device
flow; `api` then reaches every route the server has, including ones added
after this CLI was built.

```bash
appctl login --server https://app.example.com
appctl api GET /api/auth/me
```

**Deploy to a VPS in one command.** On the server itself, `deploy install`
checks prerequisites, writes `.env`, builds, migrates, seeds, starts, and
publishes the app over HTTPS behind a shared TLS reverse proxy that every
application on the box uses.

```bash
appctl deploy install --domain app.example.com
```

**Run a worker node.** `node` enrolls this machine with its own credential,
then claims and runs jobs from the application's queue.

```bash
appctl node enroll && appctl node register
appctl node start
```

In a real terminal, `appctl` with no arguments opens the menu. **Worker node
→ Dashboard** attaches read-only to the running worker and shows its status,
concurrency, job types, success/failure totals, heartbeat age, active jobs
with elapsed time, and a live event stream.

## Install

There's no published package; the installer builds `appctl` from this repo
and deploys a standalone copy — you don't need a local clone to end up with
a working `appctl` on your PATH.

```bash
curl -fsSL https://raw.githubusercontent.com/marinoscar/EnterpriseAppBase/main/install.sh | bash
```

It's safe to re-run: the installer detects an existing install at
`~/.appctl/app`, shows the old → new version transition, and updates it in
place — the same command is also how you update.

### Install from a local clone

If you already have the repo checked out (or want to test the installer
itself without a network round-trip), point it at that directory with
`APPCTL_SRC` instead of letting it `git clone`:

```bash
APPCTL_SRC=/path/to/repo bash /path/to/repo/install.sh
```

### Update

Re-run the same command you installed with — the curl one-liner above, or
the `APPCTL_SRC` form for a local clone. Either way the installer detects
the existing install and updates it in place.

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/marinoscar/EnterpriseAppBase/main/install.sh | bash -s -- --uninstall
```

or, from a local clone:

```bash
bash install.sh --uninstall
```

This removes the installed app directory (`~/.appctl/app`) and the `appctl`
shim (`~/.local/bin/appctl` by default). It leaves
`~/.appctl/config.json` — your stored server URL and credentials — untouched;
uninstalling doesn't log you out.

### Requirements

The installer checks for these before doing anything else:

| Tool | Version | Notes |
| --- | --- | --- |
| `node` | >= 20 | apps/cli's own `engines.node` floor |
| `npm` | any | ships with Node.js |
| `git` | any | only needed unless you use `APPCTL_SRC` |
| `curl` | any | only needed for the piped one-liner |

apps/cli has no native modules, so there's no C-compiler / build-toolchain
requirement — just these four.

### Adding appctl to your PATH

If `~/.local/bin` (or your custom `APPCTL_BIN_DIR`) isn't on `$PATH`, add
this to `~/.bashrc` or `~/.zshrc` and reload your shell:

```bash
export PATH="$PATH:$HOME/.local/bin"
```

(On WSL specifically, the installer prints a dedicated box with the exact
two commands to run, since `~/.local/bin` is rarely on `$PATH` there by
default.)

### Installer environment variables

Set these before running the installer to override its defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPCTL_REPO` | `https://github.com/marinoscar/EnterpriseAppBase.git` | Git clone URL |
| `APPCTL_REF` | `main` | Branch/tag/commit to install |
| `APPCTL_HOME` | `$HOME/.appctl` | App install root (same directory the CLI stores `config.json` in) |
| `APPCTL_BIN_DIR` | `$HOME/.local/bin` | Directory for the `appctl` shim |
| `GITHUB_TOKEN` | (unset) | Optional GitHub PAT, for cloning a private repo |
| `APPCTL_SRC` | (unset) | Local directory to install from instead of cloning |

`NO_COLOR` and the installer's own `--no-color` flag both disable ANSI
colour in its output.

## Creating a local environment

```bash
appctl init
appctl init --non-interactive --admin-email you@example.com
appctl init --force                 # update an existing .env, keeping its values
```

Run it from a clone of the repository, or pass `--repo-root <path>`. It
writes `infra/compose/.env` at mode `0600`, and nothing else. The questions
and defaults come from `infra/compose/.env.example`, which is never modified.
`JWT_SECRET`, `COOKIE_SECRET` and `SECRETS_ENCRYPTION_KEY` are generated and
never asked for. Google OAuth credentials may be left blank here, but the API
does not start without `GOOGLE_CLIENT_ID`. `npm run setup` at the repository
root builds the CLI and runs `init`.

```
Options:
  --force                Update an existing .env in place, keeping the values
                         already in it
  --non-interactive      Never prompt: generate the secrets, take every default,
                         leave OAuth blank
  --admin-email <email>  Set INITIAL_ADMIN_EMAIL without being asked for it
  --all                  Review every variable, not only the ones that must be
                         answered
  --repo-root <path>     Repository root (default: this directory or a parent)
```

Exit codes: `0` the file was written; `2` a `.env` already exists (re-run
with `--force`), or a value is missing that an unattended run cannot supply;
`6` this is not a checkout of the repository, or the template is gone.

## Logging in

```bash
appctl login
```

This runs the device authorization flow (RFC 8628) — the same "open this URL
and enter this code" flow you'd use for the CLI on a smart TV. It:

1. Requests a device code and user code from the server.
2. Prints a short instruction panel with the verification URL and the code,
   and tries to open your default browser to it (skip that with
   `--no-browser`, which just prints the URL instead).
3. Polls the server until you approve the request in the browser (or it
   expires — RFC 8628's `authorization_pending` / `slow_down` / `expired_token`
   / `access_denied` outcomes all apply).
4. On approval, validates the issued credential against `GET /api/auth/me`
   and saves it — validating before saving means a bad or already-invalid
   credential never overwrites a working one already on disk.

The credential minted here is a **personal access token** (a `pat_...`
string), not a short-lived session JWT — that's what makes it practical to
stay logged in for days between commands. It's stored, along with the server
URL, in `~/.appctl/config.json`. That file is created with `0600`
permissions (owner read/write only) even across restarts and partial
rewrites — see the extensive comment on `writeConfigFile` in
`apps/cli/src/config.ts` if you want the mechanics of how that's guaranteed
under a hostile umask. The token itself is never printed by any command; if
you need to see what's stored, `appctl config` prints the server URL and a
masked hint (`pat_abcd••••••••` — the first eight characters, then a
fixed-width mask) instead.

`login --server <url>` skips the interactive prompt for the server. If you
already have a personal access token (minted from the web UI's Access Tokens
page, or from a previous device-flow login), `login --server <url> --token
pat_...` validates and stores it directly, skipping the device flow entirely
— useful for a one-off headless setup, though prefer the environment
variables below for anything that runs unattended and repeatedly. Passing a
token on the command line puts it in your shell history and in `ps` output
for other users on the machine, which is why the CLI warns about it after a
successful `--token` login.

There is deliberately no `appctl logout` subcommand — logout only exists as
a screen in the interactive menu (`appctl` with no arguments, then choose
Logout). It calls `DELETE /api/pat/{id}` to revoke the token on the server
*before* deleting the local file, on purpose: the PAT this CLI holds is
long-lived, so simply deleting the local copy would leave a fully valid,
unrevoked token that nobody can see is still active. If you're scripting and
need to invalidate a token, revoke it from the web UI's Access Tokens page
(`DELETE /api/pat/{id}` — the same call the TUI makes) — there is no headless
equivalent of the interactive logout.

## Calling the API

```bash
appctl api GET /api/auth/me
```

`api` is the one command that talks to arbitrary endpoints. The response
body goes to stdout and nothing else does — status line, spinner and errors
all go to stderr — so a pipeline sees exactly the server's JSON:

```bash
appctl api GET /api/users --raw | jq '.data[].email'
```

`--raw` prints compact, uncoloured JSON with a trailing newline and nothing
else on stdout; without it, the same body is pretty-printed with colour when
stdout is a terminal. Either way it's the server's response body verbatim —
not the unwrapped `data` field — because a paginated list's `data` +
`pagination` shape and a single resource wrapped by the API's
`TransformInterceptor` as `{ data, meta }` look identical from the outside,
and unwrapping one of them silently drops the pagination info.

Other flags, from `appctl api --help`:

```
Arguments:
  method               HTTP method (GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS)
  path                 Request path, e.g. /api/auth/me

Options:
  --query <key=value>  Query parameter; repeat for more than one
  --data <json>        Request body: inline JSON, @file.json, or - for stdin
  --raw                Print unformatted JSON on stdout and nothing else
  -q, --quiet          Suppress the status line and spinner on stderr
  --no-color           Disable colour even on a terminal
  --timeout <ms>       Per-request timeout in milliseconds
```

The exit code is `0` only for a 2xx response; anything else exits non-zero
with the server's own error message, so `appctl api ... || echo failed` (or
just relying on `set -e`) works the way you'd expect in a script. The `/api`
prefix is optional — `appctl api GET /api/auth/me` and `appctl api GET
/auth/me` request the same thing, since the client's base URL already ends
in `/api`.

Since this is a generic `api` command, it reaches the AI platform the same
way as any other endpoint — no dedicated `appctl ai` command
exists or is needed:

```bash
appctl api post /ai/responses --data '{"input":"hello"}'
```

This requires the caller's account to hold `ai:use`, AI to be enabled for
the deployment (`ai.enabled`, see
[`docs/runbooks/ai-configuration.md`](../../docs/runbooks/ai-configuration.md)),
and either a stored BYOK key for the target provider
(`appctl api put /ai/keys/openai --data '{"apiKey":"sk-..."}'`) or an
admin/org fallback key under `byok_with_org_fallback` — otherwise it answers
`403` with `details.reason: "AI_KEY_REQUIRED"` or `"AI_DISABLED"`. The
streaming route (`POST /api/ai/responses/stream`) is not reachable through
`appctl api`, which is built for a single request/response cycle, not
Server-Sent Events — use the web Playground for a streamed response.

## Deploying to a server

```bash
appctl deploy doctor
```

Eight subcommands (`doctor`, `install`, `update`, `status`, `list`, `about`,
`certs`, `uninstall`) take this repository — or, far more likely, your fork of it —
from an empty VPS to running, migrated, seeded, and served over HTTPS at a
real domain, back to the latest revision on every subsequent deploy, and,
eventually, gone again. They run **on the VPS itself**: SSH in with your own
credentials, build `appctl` from a checkout there (see
[Building from source](#building-from-source-development) below), and run
these from inside it. There's no SSH client in `appctl` and no laptop-driven
orchestration — it never dials out to a server on your behalf, and it must
never be run with `sudo` (see the runbook's prerequisites for why).

A box can host more than one deployment, each at
`<apps-root>/<app-name>/` under the apps root (`--apps-root`, default
`/opt/infra/apps`). Every subcommand finds its deployment from `--root`,
then `--name`, then the deployment directory you are standing in, then the
only deployment present, and otherwise refuses and names the candidates. On a
box with more than one application, pass `--name` or `--root`, or `cd` into
the deployment. See the runbook's section on running more than one
application for the detail.

`doctor`, `install`, `update` and `status` also have screens in the
interactive menu (**Deploy (this server)**), running the same pipelines with
the same flags; the runbook describes them.

For the full walkthrough — prerequisites, the manual step after install,
troubleshooting — see [`docs/runbooks/deploy-to-vps.md`](../../docs/runbooks/deploy-to-vps.md).
For why it's built this way, see
[`docs/specs/vps-deploy.md`](../../docs/specs/vps-deploy.md).

### Checking prerequisites

```bash
appctl deploy doctor
appctl deploy doctor --domain app.example.com
```

Nothing is installed, written or started — it's read-only, so it's safe to
run against a production server at any time, not just before a first
install. It runs around 30 checks: Docker and its daemon, the Compose v2
plugin, git, node, disk and memory headroom, the loopback port, `gh` installed
and authenticated (required only when the resolved repository is a private
HTTPS GitHub URL git cannot already read), the shared reverse proxy's
directory and its `conf.d`/webroot being writable, the proxy container itself
running (container mode), certbot (required only in host mode), ports 80 and
443, the proxy's current config, renewal ownership (who, if anyone, already
renews here, and whether it actually covers a containerised proxy's
certificates), whether the renewal configs on disk use paths a dockerised
`certbot renew` can follow, whether the certificate the proxy serves matches
the one on disk, the external PostgreSQL database (reachable, credentials
valid, database exists, `CREATEDB` privilege, can create tables, TLS), and —
once `--domain` turns them on — DNS and the certificate.

```bash
appctl deploy doctor --json | jq '.checks[] | select(.status=="fail")'
```

Exits `6` (`EXIT.PRECONDITION`) when a required check fails, `0` when only
recommended checks fail — warnings never fail the run. `--json` prints a
machine-readable report on stdout and nothing on stderr.

Other flags, from `appctl deploy doctor --help`:

```
Options:
  --root <path>            Deployment directory (rank 1: an explicit path)
  --apps-root <path>       Directory holding the deployments (rank 3 walks up
                           inside it) (default: "/opt/infra/apps")
  --name <app>             Which deployment to act on, by name
  --proxy-root <path>      Shared reverse proxy directory (default:
                           "/opt/infra/proxy")
  --port <port>            Loopback port the proxy forwards to (default:
                           "3535")
  --domain <domain>        Public domain; enables the DNS and TLS checks
  --proxy-container <name> The proxy container's name (default: "proxy-nginx")
  --proxy-mode <mode>      "container" or "host"; skips runtime detection
  --repo <url>             Repository whose access to check (default: the
                           recorded one, then this checkout's origin)
  --json                   Print a machine-readable report on stdout
  --no-color               Disable colour even on a terminal
```

`install` and `update` both run the same required checks as their own
preflight step, so nothing they do is skipped by running `doctor` first —
but running it on its own first means you find out about a bad DNS record or
an unreachable database before you're mid-pipeline, not partway through one.

### Installing

```bash
appctl deploy install --domain app.example.com
```

Runs preflight → checkout → environment → validate-environment →
ensure-database → build → migrate → seed → start → health → proxy-bootstrap →
publish → renewal → verify, in that order, printing each step's result as it
completes. `--domain` is the one required flag. `validate-environment`
also checks the Google OAuth credentials (shape, callback URL, and a live,
harmless probe against Google's token endpoint), and `verify` includes an
OAuth sign-in smoke check alongside the external HTTPS one.

The repository and ref come from **this checkout's own git remote**, not a
value hardcoded in the CLI — a fork deploys itself with no configuration
change; see "Deploying a fork" below.

```bash
appctl deploy install --domain app.example.com --staging
appctl deploy install --non-interactive --domain app.example.com
```

Use `--staging` while you're still working out the setup — it requests a
Let's Encrypt **staging** certificate instead of a production one. Worth
doing before a first real attempt, because a failed production issuance
spends real rate-limit budget: five failures per hostname per hour, and 50
certificates per registered domain per week, shared with every subdomain on
that server. `--non-interactive` skips every prompt and fails, listing
what's unresolved, rather than asking; pair it with `--all` to review every
environment variable instead of only the essential dozen.

`install` is idempotent — if it fails partway through, fix whatever it
reported and run the same command again, or add `--resume` to continue from
the step that failed rather than re-running everything before it.
`--reinstall` installs over an existing deployment on purpose; `--force`
discards uncommitted changes in the checkout it manages; `--skip-doctor`,
`--skip-proxy` and `--skip-seed` each skip exactly the one stage they name.
Three more steps prompt before acting and each takes a `--non-interactive`
opt-in flag: `--bootstrap-proxy` (bring up a fresh container-mode proxy when
this box has none — an existing proxy is never touched either way),
`--create-database` (run `CREATE DATABASE` when the configured database does
not exist and nothing else about the connection is wrong, then re-run every
database check against it — a role that cannot create tables stops there; a
`--non-interactive` run without the flag stops at preflight, before cloning,
whenever the `.env` or `--answer`s already name every `POSTGRES_*` setting), and
`--skip-renewal` (opt **out** of the renewal-scheduling step, which otherwise
schedules a twice-daily renewal only when nothing already owns it).
`--skip-oauth-check` skips the live Google credentials probe (a malformed
client id then only warns instead of failing).

Other flags, from `appctl deploy install --help`:

```
Options:
  --root <path>            Deployment directory (rank 1: an explicit path)
  --apps-root <path>       Directory holding the deployments (default:
                           "/opt/infra/apps")
  --name <app>             Which deployment to act on, by name
  --domain <domain>        Public domain to publish under
  --proxy-root <path>      Shared reverse proxy directory (default:
                           "/opt/infra/proxy")
  --proxy-container <name> The proxy container's name (default: "proxy-nginx")
  --proxy-mode <mode>      "container" or "host"; skips runtime detection
  --port <port>            Loopback port the proxy forwards to (default:
                           "3535")
  --repo <url>             Repository to deploy (default: this checkout's
                           origin)
  --ref <ref>              Branch, tag or commit (default: the remote default
                           branch)
  --email <email>          Certificate registration address
  --group <name>           Optional feature group; repeat for more (default:
                           []). "observability" is always included and this
                           flag is a no-op for it; use it for "email" or
                           "microsoft-oauth"
  --all                    Review every environment variable, not only the
                           essential ones
  --non-interactive        Never prompt; fail listing anything unresolved
  --answers-file <path>    Read answers from a KEY=value file (like .env)
  --reinstall              Install over an existing deployment
  --resume                 Continue from the step that failed
  --skip-doctor            Skip the prerequisite checks
  --skip-proxy             Do not touch the reverse proxy or request a
                           certificate
  --skip-seed              Do not run the database seed
  --bootstrap-proxy        Create the shared proxy if this server has none
                           (no prompt)
  --create-database        Create the database if it does not exist (no
                           prompt)
  --skip-renewal           Do not schedule certificate renewal
  --skip-oauth-check       Do not verify the Google OAuth credentials with
                           Google
  --no-cache               Rebuild images without the layer cache
  --force                  Discard uncommitted changes in the checkout
  --staging                Use Let's Encrypt staging while working out the
                           setup
  --no-version-bump        Deploy the current version: no write, no commit,
                           no push
  --json                   Print a machine-readable result on stdout
```

**`install` does not create an admin user.** The seed writes the allowlist
row for `INITIAL_ADMIN_EMAIL`, not a user account — nobody has access until
that address logs in through Google OAuth at `https://<domain>`. See "After
install: the first login" in the runbook linked above.

### Deploying a fork

No flag or CLI change is needed. `install` and `update` read the repository
URL and ref from the checkout you run them in (override with `--repo` and
`--ref`), and the environment wizard reads that checkout's own
`infra/compose/.env.example`. Clone your fork on the server, build `appctl`
from it, and run `appctl deploy install` there. See
[`docs/runbooks/deploy-to-vps.md`, "Deploying a fork"](../../docs/runbooks/deploy-to-vps.md#6-deploying-a-fork).

### Updating

```bash
appctl deploy update
```

Brings an already-installed server up to the latest revision (or, with
`--ref`, to a specific one): preflight, fetch, environment-drift,
ensure-database, version, build, migrate, seed, restart, health, publish,
renewal, verify. It refuses to run at all if nothing is installed at
`--root` yet. `ensure-database` and `renewal` are the same steps `install`
runs (see above): a database that has since been dropped or renamed gets the
same create-with-consent prompt, and renewal ownership is (re-)checked and
acted on the same way. `verify` includes the same OAuth sign-in smoke check
as `install`'s.

```bash
appctl deploy update --ref v1.4.0
```

If the resolved ref's commit hasn't moved since the last successful run,
`update` exits `0` **without doing anything** — no rebuild, no restart —
which is what makes it safe to run unattended, e.g. from cron. `--force`
rebuilds anyway even when the revision is unchanged.

The database seed **re-runs by default** on every `update`. The seed is
entirely upserts, and re-running it is the only way a permission or role a
newer release adds actually reaches an already-installed server — skip it
and the feature ships, the permission doesn't exist, and it shows up later
as a confusing 403 with nothing in the logs to explain it. Pass `--skip-seed` if you've hand-edited seeded rows and don't
want them upserted back.

There's no automatic rollback. A partly-applied database migration can't be
undone by checking out the old code, so on failure `update` prints the
previous revision and the exact command to redeploy it —
`appctl deploy update --ref <sha> --force` — and leaves that decision to you.

Other flags, from `appctl deploy update --help`:

```
Options:
  --root <path>            Deployment directory (rank 1: an explicit path)
  --apps-root <path>       Directory holding the deployments (default:
                           "/opt/infra/apps")
  --name <app>             Which deployment to act on, by name
  --ref <ref>              Branch, tag or commit to move to
  --force                  Rebuild even when the revision has not changed
  --no-cache               Rebuild images without the layer cache
  --non-interactive        Never prompt; fail listing anything unresolved
  --answers-file <path>    Read answers from a KEY=value file (like .env)
  --skip-seed              Do not re-run the database seed
  --skip-proxy             Do not touch the reverse proxy
  --create-database        Create the database if it does not exist (no
                           prompt)
  --skip-renewal           Do not schedule certificate renewal
  --skip-oauth-check       Do not run the post-deploy OAuth sign-in smoke
  --proxy-container <name> The proxy container's name (default: "proxy-nginx")
  --proxy-mode <mode>      "container" or "host"; skips runtime detection
  --no-version-bump        Deploy the current version: no write, no commit,
                           no push
  --json                   Print a machine-readable result on stdout
```

### Checking status

```bash
appctl deploy status
```

Reports whether the deployment at `--root` is healthy: container state, an
immediate `/api/health/ready` poll, migration state, and — with `--domain` —
an external HTTPS check.

```bash
appctl deploy status --domain app.example.com
appctl deploy status --json || alert 'deployment unhealthy'
```

`/api/health/ready` returning 200 only proves the app can run `SELECT 1`
against the database — it passes against a completely empty, unmigrated one
just as readily as a fully migrated one. That's why `status` reports
migration state as its own fact rather than inferring it from the health
probe.

Exits `0` when serving and the schema is current, `1` when installed but
unhealthy, `2` when nothing is installed at `--root`.

Other flags, from `appctl deploy status --help`:

```
Options:
  --root <path>       Deployment directory (rank 1: an explicit path)
  --apps-root <path>  Directory holding the deployments (rank 3 walks up inside
                      it) (default: "/opt/infra/apps")
  --name <app>        Which deployment to act on, by name
  --port <port>       Loopback port the proxy forwards to (default: "3535")
  --domain <domain>   Public domain; adds an external HTTPS check
  --json              Print a machine-readable report on stdout
  --no-color          Disable colour even on a terminal
```

### Listing every deployment

```bash
appctl deploy list
```

Reads the filesystem only — no git, no Docker, no network — and reports every
deployment under `--apps-root`. Each row's source is `record` (a proper
deployment record was read), `inferred` (reconstructed from that
deployment's own `.env` because no record exists — the next `update` against
it adopts one, inventing nothing it cannot know), or `unreadable` (a record
is present but this build cannot parse it). A `null`/`-` commit means nothing
recorded one; this command never shells out to `git` to go find it, so a
seven-app host costs no subprocesses and cannot fail differently per app.

```
Options:
  --apps-root <path>  Directory holding the deployments (default: "/opt/infra/apps")
  --json              Print a machine-readable inventory on stdout
```

### What this server says it is running

```bash
appctl deploy about
appctl deploy about --name myapp --json
```

Prints the deployment record `install`/`update` leave at
`<deploy-root>/deploy-info/info.json`.

**It reads that file; it does not ask the application.** Three reasons, and
each of them bites: the app would have to be UP, and the moment you most want
to know what was deployed here is the moment it is not answering; `/api/about`
is gated on `system_settings:read`, so a command that reads a local file would
acquire a login flow; and the endpoint reports what the *container* believes,
which is a different fact from what this CLI deployed. When those two
disagree, that disagreement is the answer — it is a stale image serving old
code — not an error to route around. The API reads the very same file from
the other side of a read-only bind mount, which is the point of the file
existing.

Four outcomes, **all exiting 0**, because none of them means the command
failed:

| Outcome | What it means |
|---|---|
| the record | A deployment with a record. |
| no record | Written once the API answers, so a deployment installed before this CLI wrote one — or whose run stopped earlier — has none. Not the same as nothing being deployed. |
| unreadable | The file is there and this build cannot interpret it. A different condition from absent, and worth telling apart: one corrupt file is not a missing deployment. |
| a warning | Every fact, plus "the run that deployed this did not finish, at `<step>`". The record is written at the health gate, so a run that died afterwards still leaves a document describing a deployment that is up and serving. |

```
Options:
  --root <path>       Deployment directory (rank 1: an explicit path)
  --apps-root <path>  Directory holding the deployments (default: "/opt/infra/apps")
  --name <app>        Which deployment to act on, by name
  --json              Print the record itself on stdout
```

### Unattended runs

`install` and `update` take answers without a terminal:

```bash
appctl deploy install --non-interactive \
  --answers-file ./answers.env \
  --answer INITIAL_ADMIN_EMAIL=admin@example.com
```

`--answers-file` is read with the **same parser as `.env`**, so quoting,
`export ` prefixes, comments and CRLF all behave exactly as they will when the
deployment reads the file this run writes. `--answer` splits on the **first**
`=` only — a signing secret is base64 and base64 ends in `=` padding.

⚠ **An unattended run must answer every essential variable, including the
secrets.** That is the wizard's rule, not an oversight: a non-interactive run
takes the template default only for a *non-essential* key, because a default
for an essential one is a placeholder nobody chose (`POSTGRES_PASSWORD=postgres`),
and generate-mode secrets are never generated without a terminal to confirm on.
`SECRETS_ENCRYPTION_KEY` is the one that surprises — not marked essential, not
commented out, blank default, generate-mode — so an unattended install fails on
it every time unless you supply it.

A world-readable answers file **warns** rather than refusing, because on a CI
runner that is the ordinary case; an **empty** one refuses, because it means
you believe you supplied answers and did not.


### Managing the TLS certificate directly

```bash
appctl deploy certs                              # report expiry, change nothing
appctl deploy certs --renew                      # renew only inside the 30-day window
appctl deploy certs --renew --domain app.example.com
```

`--force` renews even when the certificate is not due, and spends rate-limit
budget. Why the window matters, and how automatic renewal is scheduled, is in
[`docs/runbooks/deploy-to-vps.md`, "Inspecting and renewing the certificate directly"](../../docs/runbooks/deploy-to-vps.md#10-inspecting-and-renewing-the-certificate-directly).

Exit codes: `0` reported, or renewed and the proxy reloaded; `1` the
certificate is due or expired and `--renew` was not passed, or a renewal ran
but the proxy's `nginx -t`/reload failed; `2` nothing is installed at
`--root`.

```
Options:
  --root <path>             Deployment directory (rank 1: an explicit path)
  --apps-root <path>        Directory holding the deployments (rank 3 walks up
                            inside it) (default: "/opt/infra/apps")
  --name <app>              Which deployment to act on, by name
  --proxy-root <path>       Shared reverse proxy directory (default:
                            "/opt/infra/proxy")
  --domain <domain>         Domain to act on (default: the recorded one)
  --proxy-container <name>  Name of the shared proxy container (default: as
                            recorded, else proxy-nginx)
  --proxy-mode <mode>       How the shared proxy runs: container or host
                            (default: as recorded, else detected)
  --renew                   Renew when the certificate is inside the renewal
                            window
  --force                   Renew even when it is not due. Spends rate-limit
                            budget.
  --email <email>           Registration address (default: INITIAL_ADMIN_EMAIL)
  --staging                 Use Let's Encrypt staging, which is not trusted by
                            browsers
  --json                    Print a machine-readable report on stdout
```

### Removing a deployment

```bash
appctl deploy uninstall --dry-run     # always first: what goes, what stays
appctl deploy uninstall
appctl deploy uninstall --purge-storage --confirm-bucket <bucket-name>
```

`uninstall` stops the stack and removes the clone, the run logs, the
`deploy-info` directory, the `.env` and the deployment record. It always
keeps the shared Docker network, the shared proxy, the TLS certificate and
the renewal cron entry. Each destructive extra needs its own flag plus that
resource's real name typed back. `--drop-database --confirm-database <name>`
drops the database after the stack stops: confirmation, then the optional
storage purge, then `compose down -v`, then `DROP DATABASE`, then the vhost
and file removal. A failed drop stops the uninstall with an error and keeps
the checkout, `.env`, vhost and state so the same command can be re-run. What
each step does, and why, is in
[`docs/runbooks/deploy-to-vps.md`, "Removing a deployment"](../../docs/runbooks/deploy-to-vps.md#11-removing-a-deployment).

Exit codes: `0` removed, or a `--dry-run` report; `2` nothing to uninstall at
`--root`, a confirmation that does not match, or a storage purge that failed
(nothing removed).

```
Options:
  --root <path>              Deployment directory (rank 1: an explicit path)
  --apps-root <path>         Directory holding the deployments (rank 3 walks up
                             inside it) (default: "/opt/infra/apps")
  --name <app>               Which deployment to act on, by name
  --proxy-root <path>        Shared reverse proxy directory (default:
                             "/opt/infra/proxy")
  --proxy-container <name>   Name of the shared proxy container (default: as
                             recorded, else proxy-nginx)
  --proxy-mode <mode>        How the shared proxy runs: container or host
                             (default: as recorded, else detected)
  --dry-run                  Report what would be removed and change nothing
  --drop-database            Also DROP the PostgreSQL database named by
                             POSTGRES_DB, after the stack stops (needs
                             --confirm-database)
  --confirm-database <name>  The database's own name, typed back
  --purge-storage            Also delete every object in storage (needs
                             --confirm-bucket)
  --confirm-bucket <name>    The bucket's own name, typed back
  --json                     Print a machine-readable plan on stdout
```

### Logs

Every `doctor`, `install`, `update` and `uninstall` run writes a human-readable `.log`
and a matching machine-readable `.jsonl` under `<deployRoot>/logs/`, mode
`0600`, newest ten runs kept. Every value the CLI knows to be a secret —
whether you typed it or the wizard generated it — is redacted from both
files before a single byte reaches disk, so they're safe to attach to an
issue or hand to someone else for help.

## Running a worker node

`appctl node` turns this machine into a worker for the application's job
queue. A node claims jobs from the server, runs them locally,
and submits results — the same handler code the API server would have run,
on hardware you control. Nodes coordinate through nothing but the database,
so you can run as many as you like without configuring any of them to know
about the others.

### Enrolling a machine

```bash
appctl node enroll
```

One command from nothing to a machine that holds its own credential. It
runs the same device-authorization login `appctl login` does, then uses that
session to mint a **node credential** (`nod_…`) and stores it for you. You
never see or paste the secret.

A node credential is deliberately weaker than a personal access token: the
API refuses it on every route outside `/api/nodes/*` — including the route
that mints credentials — so a worker running unattended for months cannot
escalate, and cannot mint a second identity. That is why enrolling is worth
a separate command rather than just reusing your login token.

| Flag | Meaning |
|---|---|
| `-s, --server <url>` | Server URL, when this machine has no stored one |
| `-n, --name <name>` | Name for the credential in the web UI (default: `appctl node: user@host`) |
| `--expires-in-days <n>` | Expire the credential after N days (default: never — see below) |
| `--no-browser` | Print the verification URL instead of opening one |
| `--show-token` | Also print the credential on stdout, for provisioning another machine |

**Node credentials do not expire by default, on purpose.** A worker runs
unattended for months; a token expiry nobody scheduled taking a fleet down
at 3am is worse than a long-lived credential whose blast radius is already
confined to `/api/nodes/*`. Revocation is the control, and it is immediate —
revoke from the web UI and the next request fails.

If the server predates node credentials you get a named error, not a stack
trace, pointing at the fallback: create a PAT in the web UI, `appctl login
--token <pat>`, then register. That works, but the PAT carries your full
account authority.

### Registering the node

```bash
appctl node register --concurrency 4 --types example.checksum
```

Creates (or re-attaches to) this machine's row in the fleet. Registration is
idempotent: the server keys on your account plus the node name, so re-running
it reattaches rather than creating a second row — and the command tells you
which of the two happened, because an unexpected reattach means a name
collision you want to know about.

| Flag | Meaning |
|---|---|
| `-n, --name <name>` | Node name; reattachment keys on it (default: the hostname) |
| `-c, --concurrency <n>` | How many jobs to run at once, 1–64 |
| `-t, --types <csv>` | Job types to claim (default: every node-eligible type) |
| `--json` | Emit the registered node as JSON on stdout |

`--types` is checked against what the server actually advertises at
`GET /api/nodes/job-types`, so a typo is refused with the valid list rather
than producing a node that registers happily and then claims nothing.

**`db.backup.run` — taking the deployment's database backups here.** This node
type is offered only when an administrator has enabled *both*
`nodes.jobSecretBrokerEnabled` and `databaseBackup.nodeOffloadEnabled`, and the
server can actually mint a per-job database role; until then it is absent from
`GET /api/nodes/job-types` and the API takes its own backups. On this machine
it needs `pg_dump` on `PATH` (a startup self-test refuses to declare the type
without it) and a network route to the database — there is no tunnelling, by
design. `psql` is optional: without it the backup still runs, and two audit
fields are recorded as `null`.

⚠ The database credential is fetched **per job**, held in memory for the length
of that job, and revoked when it settles. It is never written to
`~/.<cli>/config.json`, never written to the state directory, and never logged.
Nothing about running this type requires you to put a database password on this
machine.

### Inspecting the resolved settings

```bash
appctl node config          # human-readable, on stderr
appctl node config --json   # machine-readable, on stdout — never includes the token
```

### Running the worker

```bash
appctl node start                 # foreground, attachable
appctl node start --daemon        # detached, logging to ~/.appctl/node/logs/node.log
appctl node start --headless      # container/service mode
```

**Every run hosts the control socket**, foreground or detached — a worker you
can only inspect if you started it a particular way is a worker nobody
inspects. The socket lives in the state directory at mode `0600`, so the
control channel is bounded by the same filesystem permission that protects
your token.

`--headless` changes exactly one thing, and it matters: on `SIGTERM` the
worker **drains without deregistering**, so a restarting container re-attaches
to its existing node row instead of leaking a new one on every restart.
Interactive Ctrl-C does deregister — a human stopping a worker on their laptop
means it is going away.

### Inspecting and controlling a running worker

```bash
appctl node status                # live snapshot from the running worker
appctl node status --json
appctl node logs -n 200           # recent lines
appctl node logs --follow         # attach and stream
appctl node set-concurrency 8     # applies live; persists either way
appctl node stop
```

`status` is never simply unavailable: with no worker running it falls back to
this machine's stored settings, so the command always answers something useful.

`set-concurrency` works whether or not a worker is running — live over the
control socket when one is, persisted for the next start when not. The cap is
re-read on every claim pass, so a live change takes effect on the next
iteration rather than at restart.

`stop` is a three-rung ladder, each rung bounded: ask the worker over the
socket (clean drain and deregister) → `SIGTERM` the pid in the pidfile (its
handler drains) → deregister server-side so no further work is dispatched to a
process that is already gone. That last rung matters more than it looks:
without it a `SIGKILL`ed worker keeps its `online` row until the liveness cron
notices, and every lease handed to it in the meantime has to expire before the
work is retried elsewhere.

### Logs

JSONL under `<state dir>/logs/node.log`, one rollover generation at 5 MiB.
Writes are synchronous, so the lines written immediately before a crash — the
only ones anybody wants after a crash — are on disk.

**Secrets are redacted before anything reaches the file**, recursively, through
nested objects and arrays: tokens, API keys, passwords, and **presigned storage
URLs**. That last one is not hygiene theatre — a presigned URL is a bearer
capability over an object, and a log file is a thing people attach to issues.

### Health checks, dependencies and running as a service

```bash
appctl node doctor                 # three independent groups of checks
appctl node install-deps --dry-run # the dependency step framework
appctl node service install        # systemd user unit
appctl node service status
appctl node service uninstall
```

`doctor` checks **this machine**, **the server** and **the worker**
independently — a failure in one never masks the others — and distinguishes
"cannot reach the server" from "reached it and was refused", which look
identical in a stack trace and have entirely different fixes.

For database-backup offload (`db.backup.run`) it also reports the `pg_dump`
client version and, with `--db-host`, a TCP probe of the database:

```bash
appctl node doctor --db-host db.internal:5432
```

Both are **warnings, never failures**. Most nodes in a fleet will never take
the backups, and failing `doctor` on a machine that simply is not the one doing
it would be wrong. A node that cannot reach the database must not declare the
type — which is a `--types` decision, not a health problem. The host is a flag
rather than a stored setting on purpose: **a worker node holds no database
configuration at all**; the connection arrives per job, from the server, and is
dropped when the job settles.

`install-deps` ships as a **framework**, not a set of real installs: this
template has no native dependencies, so it provides the ordered-step structure,
per-step outcomes, distro detection and `--dry-run`, and a fork fills in its own
steps. See [`docs/runbooks/run-worker-nodes.md`](../../docs/runbooks/run-worker-nodes.md).

`service install` writes a systemd **user** unit (no root needed) whose name
and description derive from the CLI and app names. It sets
`Restart=on-failure`, which is required rather than decorative — the memory
watchdog exits deliberately after draining, and without a supervisor that
successful drain leaves the worker down. Run `loginctl enable-linger $USER`
afterwards, or the unit stops when you log out.

### Memory: heap tuning, the watchdog and snapshots

A worker is a long-lived process doing repetitive work — the shape that turns a
small per-job leak into an OOM kill hours later. Three things address that, and
all three are on by default.

**Heap tuning.** Node's default old-space limit is low for a machine whose
whole job is being a worker: a 32 GB box can OOM at a fraction of it. On start
the worker re-execs itself once with an explicit, RAM-aware
`--max-old-space-size`, and the original process becomes a signal-forwarding
shim — so a container `SIGTERM` still reaches the worker and still drains, and
a signal-killed child makes the shim die of the *same* signal rather than
reporting a clean exit to its supervisor. Set `APPCTL_HEAP_LIMIT_MB=0` to turn
re-tuning off entirely (the right answer when a cgroup or a PaaS already
manages memory).

**The memory watchdog** samples `rss`, `heapUsed`, `heapTotal`, `external` and
`arrayBuffers`, and once the samples span a real window reports a least-squares
growth trend in MB/hour. A single reading cannot tell a leak from GC sawtooth;
the trend is what turns "it died" into "it was climbing 40 MB/hour".

**The pre-OOM valve** fires once, when `heapUsed / heapLimit` crosses
`APPCTL_MEMORY_THRESHOLD` (default 0.9), in this order:

1. write a heap snapshot — **first**, before the drain collects the evidence away
2. log the decision with the sample
3. drain in-flight work, **keeping** the node row
4. exit `71`, for a supervised restart

> ⚠️ **The valve requires a supervisor.** It exits deliberately after a clean
> drain, so without `Restart=on-failure` (`appctl node service install` sets
> this) or `restart: unless-stopped` in compose, a *successful* drain leaves
> the worker down.

Why not V8's own `--heapsnapshot-near-heap-limit`? It fires only at genuine
near-OOM, which is *above* this threshold — so on a worker hardened with this
valve it would never fire at all, the process would recycle cleanly forever,
and the retainer could never be named.

```bash
appctl node heap-snapshot   # ask the LIVE daemon to write one
```

Asking the live daemon is the point: restarting to attach a diagnostic flag
discards exactly the accumulated state that names the retainer. Snapshots go to
`<state dir>/heap-snapshots`, newest five kept, and are skipped with a clear
reason when free disk is under 1.5× the live heap. `APPCTL_HEAP_SNAPSHOTS=false`
disables all three snapshot paths at once.

### Running a fleet in containers

```bash
cd infra/compose
cp .env.worker.example .env.worker      # fill in the server URL and the token
docker compose --env-file .env.worker -f worker.compose.yml up -d --scale worker=4
docker compose -f worker.compose.yml -f worker.build.compose.yml up --build   # build from source
```

Only `APPCTL_SERVER_URL` and `APPCTL_TOKEN` are required. Leave
`APPCTL_NODE_NAME` and `APPCTL_NODE_ID` unset when scaling. Why, and what the
compose file's `restart`, `stop_grace_period` and exec-form `ENTRYPOINT` are
for, is in
[`docs/runbooks/run-worker-nodes.md`, "Run a fleet in containers"](../../docs/runbooks/run-worker-nodes.md#4-run-a-fleet-in-containers).

### The interactive dashboard

Run `appctl` with no arguments in a real terminal and choose **Worker node**.
It offers a live dashboard, `doctor`, the log, and both `register` and
`enroll` — all calling the same functions the subcommands call, so there is no
second implementation of anything.

**Attaching is read-only.** The dashboard renders the event stream the daemon
already pushes and sends nothing back, so you can inspect a systemd unit or a
container running production work without perturbing it, and Esc leaves it
running untouched. `set-concurrency` and `stop` stay one-line commands
deliberately — a TUI that can stop a fleet member from a highlighted row is a
liability.

With no worker running, press `s` to start a **detached** one and attach to it.
That is not laziness: an interactive process cannot re-exec itself to raise its
heap ceiling without destroying raw-mode input, so an in-process engine would
silently run at the low default old-space limit — the least suitable
configuration for exactly the long jobs a node exists to take.

### Worker environment variables

Every setting can come from the environment instead of the config file, which
is how a container runs with no interactive setup at all. Environment values
win over the file, **per field** — override one without restating the rest.

⚠️ **Generated — do not edit the table below by hand.** It is built from
`WORKER_ENV` (`src/node/worker-env.ts`) and the JSDoc comment already written
above each of its entries, so it cannot drift the way a hand-typed copy would.
Run `npm run docs:worker-env --workspace=cli` to regenerate it after changing
`WORKER_ENV`; `worker-env-table.test.ts` fails the build if this block and
`WORKER_ENV` disagree.

<!-- GENERATED:WORKER_ENV_TABLE:START -->
| Variable | Description |
| --- | --- |
| `APPCTL_SERVER_URL` | `APPCTL_SERVER_URL` — reused from `config.ts`, never minted again. |
| `APPCTL_TOKEN` | `APPCTL_TOKEN` — reused from `config.ts`. A `nod_` credential, normally. |
| `APPCTL_NODE_ID` | The node row this process re-attaches to, so a restart is not a new node. |
| `APPCTL_NODE_NAME` | Display name; defaults to the hostname. Reattachment keys on it server-side. |
| `APPCTL_CONCURRENCY` | How many jobs this process runs at once. 1–64, per the server's own cap. |
| `APPCTL_ELIGIBLE_TYPES` | Comma-separated job types this node will claim. Empty means "all it can". |
| `APPCTL_POLL_INTERVAL_MS` | Idle poll interval in milliseconds. |
| `APPCTL_HEADLESS` | `true` to run without a TTY and drain on SIGTERM WITHOUT deregistering. |
| `APPCTL_STATE_DIR` | Overrides the state directory. The one variable a container almost always sets. |
| `APPCTL_HEAP_LIMIT_MB` | Old-space limit in MB for the re-exec. `0` disables re-tuning entirely. |
| `APPCTL_HEAP_TUNED` | The re-exec LATCH. Set by the parent shim on the child it spawns. Not an operator knob — it exists so the re-exec cannot loop. It is still declared here rather than read as a literal, because the rule this map enforces has no exceptions: a variable the code reads is a variable a rename must reach. |
| `APPCTL_MEMORY_WATCHDOG` | `false` to disable the memory watchdog and its pre-OOM valve. |
| `APPCTL_MEMORY_THRESHOLD` | heapUsed/heapLimit fraction at which the valve fires. Default ~0.9. |
| `APPCTL_HEAP_SNAPSHOTS` | `false` to disable ALL THREE heap-snapshot paths. |
<!-- GENERATED:WORKER_ENV_TABLE:END -->

With `APPCTL_SERVER_URL` and `APPCTL_TOKEN` set and no config file at all, the
worker synthesises its settings from the environment and starts. If it cannot
write the file back (a read-only container home is common), it warns and keeps
going — set `APPCTL_NODE_ID` so a restart re-attaches instead of registering
again.

## CI usage

In CI there's no browser to complete the device flow in and no persistent
home directory to have logged in from earlier, so skip `login` entirely and
set:

```bash
export APPCTL_SERVER_URL=https://app.example.com
export APPCTL_TOKEN=pat_...
```

The environment always wins over `~/.appctl/config.json` when both are
present, specifically so a pipeline's service token can't be shadowed by
whatever a developer happens to have logged in as on a shared runner.

Create and revoke the token itself from the web UI's **Access Tokens** page
(under user settings) — there's no CLI command to mint a PAT out of thin air
for CI use; the device flow is how the CLI gets one for a human logging in
interactively.

`appctl` also refuses to launch its interactive menu unless stdout and stdin
are both real terminals, `TERM` is set to something other than `dumb`, and
neither `CI` nor `CONTINUOUS_INTEGRATION` is set — so `appctl api ...` in a
pipeline behaves identically whether or not those variables happen to be
set. If you need to force that refusal in an environment that looks like a
terminal but isn't one you want to interact with, set `APPCTL_NO_TUI` to
any truthy value (anything except empty, `0`, `false`, or `no`); every
explicit subcommand ignores this gate entirely and is unaffected by it.

## Renaming this for a fork

There are two identities here, and they are deliberately independent.

**The product name** — the half of the CLI banner in `--help` and the
interactive UI that names the product rather than the executable — is not set
in this package at all. It comes from `packages/shared/identity.json`, the one
manifest every app reads its identity from, so renaming the product renames
the CLI banner, the browser wordmark and the email templates together:

```json
// packages/shared/identity.json
{
  "productName": "Your Product Name"
}
```

See [`docs/RENAMING.md`](../../docs/RENAMING.md) for the full rebrand
walkthrough — this section only covers what's specific to the CLI.

**The executable's own identity** — the command name shown in `--help` and
errors, the config directory (`~/.appctl/`), and the `APPCTL_`
environment-variable prefix — is derived from a separate constant:

```ts
// apps/cli/src/branding.ts
export const CLI_NAME = 'appctl';
```

The split is intentional: a product called "Acme" may perfectly well still
ship a command called `appctl`, and renaming the binary moves a filesystem
path and an environment-variable prefix, which renaming the product must not.

Change that one line (see the comment above it in `branding.ts` for the
naming constraints — lowercase ASCII letters, digits and hyphens only, since
it becomes both a filesystem path and part of an environment variable name)
and the config directory, the env var prefix, and every place the CLI refers
to itself by name follow automatically. The one place it can't reach is the
`bin` key in `apps/cli/package.json` — npm reads that before any of this
code runs, so it has to be updated by hand to match, and a test in
`apps/cli/src/branding.test.ts` asserts the two stay in sync.

Note that the env var prefix is `APPCTL_`, not `APP_` — a bare `APP_` prefix
is generic enough to collide with unrelated variables in a shared CI shell,
so the prefix is derived from the (longer, more specific) binary name
instead. If you've seen `APP_SERVER_URL` / `APP_TOKEN` mentioned elsewhere,
that's what it would have been under a shorter, collision-prone prefix;
`APPCTL_SERVER_URL` / `APPCTL_TOKEN` is what the code actually reads.

`install.sh`'s default `APPCTL_REPO` (the git URL it clones when
`APPCTL_SRC` isn't set) is a second place a fork has to edit by hand,
alongside the `bin` key above. It's a standalone shell script that runs
*before* any of this repo's own code executes — `git clone`s the source
first — so it has no way to read `CLI_NAME` out of `branding.ts` and derive
the clone URL itself; the URL is hard-coded near the top of `install.sh`
under its own "Defaults" comment block and has to be changed there directly.

## How the installer works

`install.sh` runs these steps, in order:

1. Checks dependencies (`node`, `npm`, `git`, `curl`; warns, but doesn't
   fail, on low disk space).
2. Gets the source — either `git clone --depth 1` of `APPCTL_REPO` at
   `APPCTL_REF`, or a copy of `APPCTL_SRC` if set — into a temp directory
   that's cleaned up on exit.
3. Builds the CLI workspace: `npm install --workspace=cli` then
   `npm run build --workspace=cli`, from that temp checkout.
4. Deploys the standalone app: copies `apps/cli/dist`, `package.json` and
   `README.md` into `~/.appctl/app` (replacing any previous install), then
   runs `npm install --omit=dev` there to pull in just the runtime
   dependencies (commander, ink, ink-select-input, ink-spinner,
   ink-text-input, react).
5. Writes the `appctl` shim to `~/.local/bin/appctl` — a small script that
   `exec`s `node ~/.appctl/app/dist/cli.js "$@"` — and makes it executable.
6. Checks whether the shim's directory is on `$PATH` and, if not, prints the
   `export` line to add to your shell config (see below).
7. Verifies the install by running the new shim's `--version` and printing
   an install summary (version, install size, paths).

## Building from source (development)

The install path above is for end users. If you're developing the CLI
itself inside this monorepo, build and run it from the workspace instead:

```bash
# from the repo root, after the workspace's node_modules are installed
npm run build --workspace=cli
```

This runs `tsc` against `apps/cli/tsconfig.build.json`, emitting
`apps/cli/dist/`, and marks `dist/cli.js` executable. From there you can run
it straight from the workspace without installing or publishing anything:

```bash
node apps/cli/dist/cli.js --help
```

or, from inside `apps/cli`:

```bash
node dist/cli.js --help
```

If you want the bare `appctl` command on your PATH without publishing, `npm
link` from `apps/cli` (`package.json`'s `bin` field maps `appctl` to
`./dist/cli.js`) does that using the standard npm mechanism.

For iterating on the CLI's own source without rebuilding on every change,
`npm run dev --workspace=cli` runs `tsx src/cli.ts` directly — same behavior,
no build step.

## Running tests

```bash
npm run test:run --workspace=cli
```
