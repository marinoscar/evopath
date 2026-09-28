# Runbook: Deploy to a VPS

Use this to take one Ubuntu VPS from nothing to a running, migrated, seeded,
HTTPS deployment with `appctl deploy`, then keep it current, inspect it and
remove it. Audience: the operator who SSHes into the server; every command
runs **on the VPS**. Design and rationale:
[`docs/specs/vps-deploy.md`](../specs/vps-deploy.md). Flags and exit codes:
[`apps/cli/README.md`, "Deploying to a server"](../../apps/cli/README.md#deploying-to-a-server).

Source of truth: `apps/cli/src/deploy/` (`install.ts`, `update.ts`,
`checks/`, `proxy.ts`, `layout.ts`, `journal.ts`, `uninstall.ts`),
`infra/compose/vps.compose.yml`, and `apps/api/prisma/seed.ts`.

## 1. Before you start

**Never run `appctl deploy`, or anything else in this CLI, with `sudo`.**
`sudo` resets `HOME` to `/root`, so `gh` (which stores its credentials under
`$HOME/.config/gh`) is unauthenticated under it, and a private clone fails for
a reason unrelated to the repository. Everything the CLI writes (the clone,
`.env`, the state file, the run journal, the deployment record) must stay
owned by the ordinary account that will run `update` next month. Run from that
account, with it in the `docker` group. The one file that needs root is
`/etc/cron.d/appctl-certbot-renew` (section 10): when an ordinary account
cannot write it, the step prints a loud warning with the exact file content,
and you install it once by hand, as root. The deploy does not fail.

### 1.1 Prerequisites

`appctl deploy doctor` checks all of the following, and running it is the
intended first step — before you've written a line of configuration, before
you've touched the shared proxy, before anything. Don't hand-verify this list
yourself; let doctor do it, and fix whatever it reports.

- An Ubuntu VPS you have root SSH access to.
- Docker Engine, with the **Compose v2 plugin** (`docker compose`, not the
  standalone `docker-compose` v1 binary — see the troubleshooting table).
- git and Node.js on the server, to clone the repository and build `appctl`.
- **The GitHub CLI (`gh`), installed and authenticated, if the repository you
  are deploying is private and you clone it over HTTPS.** `doctor`'s
  `gh-installed`/`gh-authenticated` checks are only `recommended` in general —
  a public repository or an SSH deploy key needs neither — but they **promote
  to `required`** when the resolved repository URL is an HTTPS GitHub URL and
  git is not already credentialed for it, because in that case the clone
  genuinely cannot proceed without it. When it applies, `install` runs `gh
  auth setup-git` once, before the first clone, so `git clone`/`git fetch` pick
  up `gh`'s credentials automatically; it is a plain `git clone` throughout,
  never `gh repo clone`, so an SSH-keyed checkout is unaffected.
- **The shared reverse proxy, either already running or nothing at all.**
  This design's default and recommended shape is a **containerised** proxy —
  one long-lived `nginx:alpine` container, plus the dockerised
  `certbot/certbot` for issuance and renewal — and `install` bootstraps
  that for you the first time it finds neither a running proxy container nor
  an existing compose file at `/opt/infra/proxy` (override with
  `--proxy-root`): it writes a minimal compose project and a default
  ACME-challenge server, creates the shared Docker network if it is missing,
  and brings the proxy up, prompting first (`--bootstrap-proxy` skips the
  prompt for a non-interactive install). **An existing proxy is never
  touched** — a running container, or merely a compose file already sitting in
  that directory, is treated as somebody else's and left exactly alone; if a
  different app on this box got there first, `install` reuses its directories
  without changing anything about how it runs. A **host-mode** proxy (nginx
  and certbot installed and runnable directly on the host) is also supported:
  pass `--proxy-mode host`, or let detection find a working host `nginx`. See
  [`docs/specs/vps-deploy.md`](../specs/vps-deploy.md) for why container mode
  is the default. `doctor`'s
  `certbot-installed` check is `required` only in host mode — in container
  mode, a missing host `certbot` binary is not a problem at all, and `doctor`
  does not fail a correctly configured server over it.
- A DNS **A record** for your domain, already pointing at this server's
  public IP, before you run `install` — the certificate can't be issued
  otherwise, and issuance failures spend real rate-limit budget (section 8).
- An **external PostgreSQL** database, reachable from this server. It does
  **not** have to already exist: `install` will offer to create it (see
  section 2, step 4) when the server is reachable, the credentials
  authenticate, and the only problem is that the named database is absent.
  Any other connection problem is reported as a failure, and nothing is ever
  created silently. This application ships no `db` service
  (`base.compose.yml` deliberately has none), so the PostgreSQL server itself
  (managed or self-hosted) is yours to stand up before you install.
- Google OAuth credentials whose **redirect URI matches
  `https://<domain>/api/auth/google/callback`** — the exact domain you're
  about to deploy under, not a placeholder. Alongside the wizard's shape
  check, `install` makes a live, harmless probe
  of the credentials against Google's own token endpoint before it finishes
  (see section 2, step 4), so a mismatched client secret is caught before the
  build, the migration, the certificate and the vhost, not at the first
  user's sign-in attempt.

```bash
appctl deploy doctor
appctl deploy doctor --domain app.example.com
appctl deploy doctor --repo https://github.com/you/your-fork
```

`--repo` checks `gh`'s access to a specific repository URL — useful to run
ahead of time against your fork if you have not yet cloned it on this server.

Nothing is installed, written, or started by `doctor` — it's read-only, so
it's safe to run against a production server at any time, not just before a
first install. Run it plain first; add `--domain` once you know what domain
you're deploying to, which turns on the DNS and certificate checks.

## 2. Installing for the first time

`appctl deploy` has no SSH client and never dials out to a server on your
behalf — you SSH in yourself, with your own credentials, and everything below
runs **on the VPS**.

**Everything in this section also has a screen in `appctl`'s interactive
menu** (run `appctl` with no arguments, in a real terminal, then choose
**Deploy (this server)**), driving the exact same `install`/`update`/`doctor`
pipelines described below rather than a second implementation of them. An
**Advanced** step lets you set the root, proxy root, port, proxy container
and proxy mode — pre-filled with the recorded or default values, one Enter to
keep them. Doctor results are grouped into failed/warnings/passed, each
failure or warning with its remedy shown beneath it. Because the TUI holds
the terminal and cannot prompt you mid-run the way the command line does, the
install/update forms ask the create-database, bootstrap-proxy,
skip-renewal and skip-OAuth-check questions up front, as yes/no fields. While
a deploy runs, the screen shows the run journal's path live; if it fails, it
shows the step that failed, that step's last output lines, and the exact
command to re-run from there (`--resume`, for `install`) — with no secret in
it.

1. **SSH into the VPS.**

2. **Clone the repository you want to deploy** (your fork, if you have one —
   see section 6) and build `appctl` from source:

   ```bash
   git clone <your-repo-url>
   cd <your-checkout>
   npm install --workspace=cli
   npm run build --workspace=cli
   node apps/cli/dist/cli.js deploy doctor
   ```

   You need a real git checkout here, not the standalone `appctl` the
   `curl | bash` installer in the main [CLI README](../../apps/cli/README.md)
   produces — `deploy install` reads its default repository URL and ref from
   *this checkout's own git remote* (section 6), and a standalone install has
   no remote to read. If `~/.local/bin` is already on your `PATH` from an
   earlier `appctl` install, the plain `appctl` command works the same as
   `node apps/cli/dist/cli.js` from here on; this runbook uses `appctl` for
   brevity.

3. **Run `doctor`** (as above) and fix everything it reports before going
   further. A required failure here is cheaper to fix now than mid-install.

4. **Run `install`:**

   ```bash
   appctl deploy install --domain app.example.com
   ```

   This is interactive by default: it walks you through the essential
   environment variables (database credentials, JWT/cookie secrets — offering
   to generate the ones that can be generated, Google OAuth credentials,
   `INITIAL_ADMIN_EMAIL`) with sensible defaults, then runs preflight,
   checkout, environment validation (including the OAuth shape and callback
   checks, and the live credentials probe described above), build,
   migrate, seed, start, health wait, proxy bootstrap (if this box has none),
   database creation (if the database does not yet exist), certificate
   issuance and vhost publish, renewal scheduling, and a final external HTTPS
   verification plus an OAuth sign-in smoke check, printing each step's result
   as it completes. `--domain` is the one required flag; everything else —
   `--root` (default `/opt/infra/apps`), `--proxy-root` (default
   `/opt/infra/proxy`), `--port` (default `3535`), `--proxy-container`,
   `--proxy-mode` — has a workable default.

   Two steps prompt before acting, and both take a non-interactive opt-in
   flag:
   - **If the configured database does not exist yet**, and everything else
     about the connection checks out, `install` asks whether to create it —
     see the prerequisites section above for exactly which failure this
     covers and which it does not. `--create-database` answers yes without
     asking, for a non-interactive run. Once created, every database check
     runs again against it (so `database-privileges` gives a real answer),
     and declining names `POSTGRES_DB` and the `.env` to correct it in —
     a typo and a not-yet-created database look identical from outside.
     `appctl deploy doctor` never creates anything: it still fails on a
     missing database, with the `createdb` remedy.
   - **If this box has no shared proxy yet**, `install` asks whether to
     bootstrap one — see the prerequisites section above. `--bootstrap-proxy`
     answers yes without asking.

   `--skip-oauth-check` skips the live Google credentials probe (a malformed
   client id then only warns, rather than failing) — useful for a test
   deployment using dummy OAuth credentials. `--skip-renewal` opts out of the
   renewal-scheduling step described in section 10.

   For a scripted or first-time-nervous install, add `--staging` (section 8)
   and/or `--non-interactive` (which fails, listing what's unresolved,
   instead of prompting — useful once you already know every value you want
   to pass, or want a `.env` prepared ahead of time).

   **Object storage is deliberately not part of this wizard, or of `.env` at
   all.** A freshly installed deployment boots with no object storage
   configured and answers every upload, avatar, job-artifact and
   database-backup request with a `503` until an administrator signs in and
   configures a provider at `/admin/settings/storage` — which needs no
   restart and no redeploy. See
   [`docs/runbooks/storage-configuration.md`](../runbooks/storage-configuration.md)
   for that first-time setup, done once `install` has finished and you have
   logged in per section 3 below.

5. **Telemetry (OTel Collector + GreptimeDB) ships with every install** — no
   flag needed. The `GREPTIME_*` passwords and `STACK_AGENT_TOKEN` are
   generated as random hex with no prompt, and `GREPTIME_BIND_PG_PORT`
   (default `14003`) is where GreptimeDB's PostgreSQL wire protocol is
   published, on `127.0.0.1` only. `--group observability` is still accepted
   on `install`/`update`, as a no-op, for a script that already passes it.
   Nothing is *collected* until an administrator turns `telemetry.enabled` on
   from `/admin/settings/telemetry` — see the
   [telemetry runbook](telemetry.md) for that, for setting retention, for
   (re)deploying the GreptimeDB/collector containers from the admin UI if
   they are ever stopped, and for connecting a BI tool afterward.

6. **If it fails partway through**, fix whatever it reported and run the
   *same command again* — `install` is idempotent, and each step is safe to
   re-run. Add `--resume` to skip straight to the step that failed rather
   than re-checking everything before it.

7. **Once it succeeds**, do not treat a clean `install` as "the site is
   live and correct" until you've done section 3 — the seed does not create
   anyone who can log in.

Full flag reference and exit codes: [`apps/cli/README.md`, "Deploying to a
server"](../../apps/cli/README.md#deploying-to-a-server).

## 3. After install: the first login (do this before anything else)

**A successful `install` does not create an admin user, or any user at
all.** The seed (`apps/api/prisma/seed.ts`) writes an **allowlist row** for
`INITIAL_ADMIN_EMAIL` — the same mechanism the "Access Control: Email
Allowlist" section of the root `CLAUDE.md` describes for local development —
and nothing more. Nobody is an admin, and nobody has an account, until that
exact email address completes Google OAuth login at `https://<domain>`.

If you skip this step and go looking for why the admin panel is empty or why
nobody can do anything privileged, you will not find a bug — you'll find a
correctly-installed application with no users. So:

1. Open `https://<domain>` in a browser.
2. Log in with Google, using the exact address configured as
   `INITIAL_ADMIN_EMAIL` during the environment wizard.
3. This creates the account and grants it the **admin** role, the same
   first-login bootstrap local development relies on.
4. From there, use the admin panel (`/admin/settings/users`, Allowlist tab)
   to add every other address that should be able to log in — the allowlist
   restricts access to pre-authorized emails only, and `INITIAL_ADMIN_EMAIL`
   is the only address the seed adds automatically.

## 4. Checking status and health

```bash
appctl deploy status
appctl deploy status --domain app.example.com
```

`status` reports container state, an immediate `/api/health/ready` poll, a
**separate frontend probe**, and — this is the part worth understanding, not
just running — migration state reported on its own, not inferred from the
health probe.

**`/api/health/ready` returning 200 only proves the app can run `SELECT 1`
against the configured database.** It passes against a completely empty,
unmigrated database exactly as readily as a fully migrated one, because
that's all the underlying check does. Nothing about a green readiness probe
tells you the schema is current. This is precisely why `status` reports
"Migrations: up to date" / "N pending" / "could not be determined" as its own
line, and why the install/update pipelines treat their own migrate step's
exit code — not the later health wait — as the only real evidence a
migration ran.

The frontend gets its own probe for the same kind of reason: the API can
answer every request correctly while the site itself 502s, if the web
container's own nginx and the shared proxy's upstream ever disagree about
which port to talk on (see the troubleshooting table's last row). A single
"healthy: true/false" that only checked the API would hide that class of
failure completely.

```bash
appctl deploy status --json || alert 'deployment unhealthy'
```

Exit codes: `0` serving and schema current, `1` installed but unhealthy, `2`
nothing installed at `--root`. The distinct exit `2` matters for monitoring —
"nothing is installed here" and "something is installed and broken" need
different alerts.

## 5. Updating

```bash
appctl deploy update
```

Fetches, and if the resolved ref's commit has moved, rebuilds, migrates,
re-seeds, restarts, and re-verifies. `update` refuses outright if nothing is
installed at `--root` — run `install` first.

**If the revision hasn't moved, `update` exits `0` and does nothing else** —
no rebuild, no restart, no seed. That's what makes it safe to run
unattended, for example from cron:

```cron
# Check for a new release every night at 03:00, do nothing if there isn't one
0 3 * * * cd /opt/infra/apps/repo && appctl deploy update --non-interactive >> /var/log/appctl-update.log 2>&1
```

Two behaviors are worth knowing before your first `update`; both are
deliberate:

**The seed re-runs by default, on every update.** `apps/api/prisma/seed.ts`
is entirely upserts, and re-running it is the *only* way a permission or role
row a newer release adds actually reaches a server that was installed
earlier. Skip it, and a release that ships a new permission does nothing on
your server — the feature ships, the permission doesn't exist in your
database, and the first symptom is a confusing 403 with nothing in the logs
pointing at "you needed to re-seed." Pass `--skip-seed`
only if you've hand-edited seeded rows (a role's permission set, say) and
don't want them upserted back to their defaults.

**There is no automatic rollback.** A partly-applied database migration
can't be safely undone by checking out the old application code — that's a
decision that needs a human looking at what actually happened, not a
heuristic guessing at it. On failure, `update` prints the previous revision
and the exact command to redeploy it:

```bash
appctl deploy update --ref <previous-sha> --force
```

`--force` is what makes that command work even though the "ref" you're
moving to is technically older than what's currently checked out — without
it, `update` would see the ref hasn't "moved forward" in the way it expects
and do nothing.

Full flag reference: [`apps/cli/README.md`, "Deploying to a
server"](../../apps/cli/README.md#deploying-to-a-server).

## 6. Deploying a fork

You do not need to change anything in this CLI to deploy a fork, and that
property is worth understanding rather than just trusting.

`appctl deploy install`/`update` read the repository URL and ref from **the
checkout you ran them from** (`repo.ts` walks upward from the current
directory looking for `.git`, then reads `git remote get-url origin` and the
current branch) — not from a value hardcoded anywhere in `apps/cli`.
`--repo`/`--ref` override the detected values when you need to, but the
default is always "whatever this checkout points at." The environment
wizard's questions are parsed structurally from **your checkout's own**
`infra/compose/.env.example`, not from a fixed list of field names baked into
the CLI — rename the application, add a new secret, remove an optional
block, switch your default branch to `develop`, and the wizard follows
all of it with no CLI change. The only two places a fork edits by hand are
outside `appctl deploy` entirely: the `bin` field in `apps/cli/package.json`
and `install.sh`'s default clone URL, both documented in the CLI README's
"Renaming this for a fork" section — neither is part of the deploy path.

In practice: clone your fork on the VPS (step 2 of section 2), build `appctl`
from *that* checkout, and run `deploy install` from inside it. It deploys
your fork, at your fork's default branch, asking about your fork's own
environment variables, automatically.

## 7. Logs

Every `doctor`, `install`, `update`, and `uninstall` run writes two files under
`<deployRoot>/logs/`: a timestamped human-readable `.log` and a matching
machine-readable `.jsonl` (one JSON object per executed subprocess:
`argv`, `cwd`, `exitCode`, `durationMs`, captured `stdout`/`stderr`,
`startedAt`). Both are written mode `0600`, and only the newest ten runs are
kept — older ones are pruned at the start of each new run.

**Every value the CLI knows to be a secret is redacted from both files
before a single byte reaches disk** — whether you typed it during the wizard
or the wizard generated it. This is what makes it safe to attach a `.log` to
a support request or a GitHub issue without a second pass to scrub it by
hand. The honest boundary: redaction is a substring match against *known*
secret values (the ones `env-metadata.ts` marks `secret: true`), not a
pattern-based scan of the output — a value your fork's own `.env.example`
introduces with no corresponding metadata entry won't be recognized as a
secret and won't be redacted. If you add a new secret-shaped variable to a
fork, add a `secret: true` entry for it in `env-metadata.ts` so both masking
and log redaction pick it up.

## 8. Using Let's Encrypt staging while you work out the setup

```bash
appctl deploy install --domain app.example.com --staging
```

`--staging` requests a certificate from Let's Encrypt's **staging**
environment instead of production. The certificate it issues won't be
trusted by a real browser, but the whole rest of the pipeline — DNS,
webroot, vhost rendering, `nginx -t` validation, reload — runs identically,
so it's the right way to work out a first install's kinks.

The reason this matters more than it might look: a **failed** production
issuance spends real, shared rate-limit budget — five failures per hostname
per hour, and 50 certificates per registered domain per week, shared with
*every* subdomain on that server, not just this one app. Burn through that
debugging a typo'd DNS record on your first attempt, and you (and anyone else
deploying to the same box) are locked out of real certificates for the rest
of the week. Use `--staging` until `doctor --domain <yours>` and a full
`install --staging` both come back clean, then run `install` again without
the flag for the real certificate — `install` skips issuance entirely when a
usable certificate already exists, so re-running costs nothing if staging
already got you a (test) one.

Treat the first real install on a new box as the first end-to-end test of
the proxy and certificate half. The CI workflow
`.github/workflows/deploy-e2e.yml` exercises install and update on real
Docker, but runs with `--skip-proxy` and `--skip-oauth-check`, so nginx,
certbot and Let's Encrypt are covered by unit tests only.

## 9. Running more than one application on this box

`apps/cli/src/deploy/layout.ts` lays out every deployment at
`<apps-root>/<app-name>/`, with the apps root defaulting to
`/opt/infra/apps`, because the shared-proxy design expects a box to host more
than one application. `--root` has no default: passing neither `--root` nor
`--name` means "figure it out", per the five ranks below.

```bash
appctl deploy list
appctl deploy list --json
```

`deploy list` reads the filesystem only — no git, no Docker, no network — and
reports every
deployment it finds under the apps root, each row's `SOURCE` telling you
whether it came from a proper deployment record (`record`), was reconstructed
from that deployment's own `.env` because no record exists (`inferred` — the
next `update` against it adopts a record, inventing nothing it cannot know),
or exists but could not be parsed by this build (`unreadable`). A commit shown
as `-` is not a bug; it means nothing recorded one, and `deploy list` will
never shell out to `git` to go find it (a seven-app host would cost fourteen
subprocesses for one inventory, and fail differently for each one).

**What counts as a deployment matters for `update`.** A directory only counts as a deployment when it has a git
checkout at `<root>/repo` **and** a readable `.env` — deliberately **not**
"has a state file." A deployment whose state file was lost — the record
deleted, the disk half-recovered from a snapshot, whatever the cause — is
still a deployment: `update` works on it and adopts a fresh record rather than
telling you, from inside a directory that is visibly serving traffic, to go
run `install` instead.

**Every subcommand — not only `list` — resolves which deployment it acts on
through the same five-rank order** (`layout.ts`'s `locateApp`, called from
`install`, `update`, `status`, `doctor`, `certs` and `uninstall` alike):

1. `--root <dir>` — an explicit path. Not required to already exist:
   `install` legitimately names one that doesn't yet.
2. `--name <app>` — an explicit name, resolved under `--apps-root`
   (`/opt/infra/apps` by default). Still outranks the next two, so `--name
   other` run from inside `myapp/` means `other`.
3. **The deployment your current directory is standing inside** — walking
   upward, bounded strictly inside the apps root. This is the rank that
   matters day to day: `cd` into a deployment and every command (barring
   `install`, which has nothing to stand inside yet) figures out which one
   you mean with no flag at all.
4. The sole deployment under the apps root, if there is exactly one.
5. Refusal — **naming every candidate** it found, never guessing between
   them. `doctor` and `install` are the two exceptions here: since their
   whole job includes the case where nothing is installed yet, an
   unresolvable rank 5 for either of them quietly falls back to the apps
   root itself, rather than refusing outright.

On a host with only one application, rank 4 (or rank 3, once you `cd` into
the deployment) resolves it with no flag. On a host with more than one, pass
`--name <app>` or `--root <path>` explicitly, or simply run the command from
inside the deployment's own directory.

## 10. Inspecting and renewing the certificate directly

```bash
appctl deploy certs
appctl deploy certs --renew
```

With no flags, `certs` reports the certificate's expiry and remaining days and
changes nothing — safe to run at any time, including from a monitoring
script. `--renew` renews **only when the certificate is inside its renewal
window** (30 days of expiry); Let's Encrypt allows just 5 *duplicate*
certificates per week, and a command that reissued on every invocation would
burn through that budget during one debugging session, at exactly the moment
a real renewal is needed. `--force` overrides the window and is deliberately
not implied by `--renew` alone. An expiry that cannot be read is reported as
exactly that, `expiry unreadable`, never silently treated as "not due" —
assuming a certificate is healthy is how one quietly expires.

Exit codes mirror `status`: `0` for a report or a successful renewal, `1` when
the certificate is due or expired and `--renew` was not passed, **or when a
renewal ran but the proxy's reload afterward failed** (so a cron wrapper
notices either failure), `2` when nothing is installed at `--root`.
`--domain` defaults to the domain recorded for the deployment; `--email`
defaults to `INITIAL_ADMIN_EMAIL` read from that deployment's own `.env`.

### 10.1 Renewal is scheduled automatically, but only when nothing else owns it

`install`/`update` do not simply add a renewal schedule on every run — the
proxy is shared with every other application on the box, so a second
schedule renewing the same certificates is not redundancy, it is a race that
also spends a rate-limit budget shared by every subdomain on the server.
Each run asks a single question first — **who, if anyone, already renews
here?** — and acts on the answer, in this order of precedence:

1. **A central renewal script** already covers this box (a cron line, in
   root's crontab, `/etc/crontab` or `/etc/cron.d/*`, running an existing
   file that itself invokes `certbot ... renew`) → **nothing is scheduled**,
   and the run says so.
2. **An enabled `certbot.timer`** (systemd) → likewise, nothing is
   scheduled.
3. **Any other cron entry** invoking `certbot ... renew` directly → likewise.
4. **Nothing renews yet** → `install`/`update` write
   `/etc/cron.d/appctl-certbot-renew`, a twice-daily entry that runs
   `certbot renew` and then validates and reloads the proxy — the reload is
   the point of writing this file at all, not an afterthought: nginx only
   reads certificates when it loads its configuration, so a renewal that
   writes a new certificate to disk without a reload leaves the **old** one
   served until it expires, on a server whose files all look correct.

**A host `certbot.timer` does not count as an owner when the proxy is
containerised.** A host-mode timer renews the host's own `/etc/letsencrypt`,
which is not the tree a containerised proxy reads its certificates from at
all (that proxy's `/etc/letsencrypt` is `<proxyRoot>/letsencrypt`, bind-mounted
in) — so a host timer renewing host state has renewed nothing this proxy will
ever serve. `doctor`'s `certificate-renewal` check reports such a mechanism
so it is never silently lost from the diagnosis, but does not treat it as
covering this deployment. `--skip-renewal` opts out of this step entirely,
if you would rather manage renewal yourself.

### 10.2 The served certificate can lag the one on disk

A certificate renewed on disk is not the same thing as a certificate being
**served** — until the proxy reloads, it keeps answering with the old one,
right up to its expiry, on a server whose files all look correct. `doctor`'s
`certificate-served` check compares the certificate the proxy actually
presents on the wire against the one on disk and warns when disk is newer.
The remedy is one line, and is exactly what the automatic renewal above
already runs after every scheduled renewal:

```bash
docker exec <proxy-container> nginx -t && docker exec <proxy-container> nginx -s reload
```

(drop the `docker exec <container>` prefix in host mode). If you see this
warning on a deployment where renewal is scheduled by something *other* than
`appctl`, it usually means that other mechanism renews but does not reload —
worth fixing at the source, not just running the command above once.

## 11. Removing a deployment

```bash
appctl deploy uninstall --dry-run
appctl deploy uninstall
```

**Always run `--dry-run` first.** It prints exactly what would be removed and
what would be kept, without touching anything — nobody can consent to a
number they were not shown, and that inventory is what every confirmation
below is *about*.

`uninstall` stops the stack, then removes the clone, the run logs, the
`deploy-info` directory, the `.env`, and the deployment record. It **always**
refuses to touch four things, because every one of them is shared with every
other application on this host, not owned by this one:

- the shared Docker network,
- the shared proxy container,
- the TLS certificate — Let's Encrypt allows only 5 duplicate certificates per
  week, and keeping the existing one is what makes a later reinstall possible
  at all,
- the per-host certificate renewal cron entry/timer — it renews every
  application's certificate, not just this one.

Two further, opt-in extras each need their **own** flag *and* a typed
confirmation of that resource's **own real name** — never a generic word like
`DELETE` — specifically so that confirming one can never authorize the other:

- `--purge-storage --confirm-bucket <bucket-name>` deletes every object this
  application ever wrote to object storage. Because the bucket and its
  credential live in the runtime-configurable `storage` system-settings
  namespace and an encrypted database row, not in `.env`, this
  purge runs **inside the built api image** —
  `docker compose run --rm --no-deps api npm run storage:purge -- --confirm
  --bucket <name>` — the same reason the CLI cannot itself decrypt that
  credential to check the typed name against it: only the running application
  can. See
  [`docs/specs/storage-providers.md`](../specs/storage-providers.md). This
  step runs **before** the stack and the clone are torn down, because it
  needs the application's own image and configuration to do its job; if it
  fails, `uninstall` stops and removes nothing rather than leaving you
  uncertain whether your bucket was emptied.
- `--drop-database --confirm-database <database-name>` drops the
  application's PostgreSQL database once the stack has stopped: confirmation
  first, then the optional storage purge, then `compose down -v`, then the
  drop, then vhost and file removal. The drop itself runs `psql` in a
  throwaway `postgres:16-alpine` container on `--network host`, with the
  password passed by name through the environment (never argv),
  `PGSSLMODE=require` added when `POSTGRES_SSL=true`, and `PGCONNECT_TIMEOUT=5` so an
  unreachable host fails fast rather than hanging the uninstall. It tries a
  plain `DROP DATABASE` first; only if that reports `object_in_use` does it
  terminate *that database's own* backends and try again (never every backend
  on the server) — see `database-drop.ts`'s header for why `DROP DATABASE
  WITH (FORCE)` was rejected. On success it prints `Dropped database <name>
  (terminated N session(s)).`, always naming the count so a killed session is
  never silent. The role connecting must own the database, or be superuser.
  If the drop fails, `uninstall` stops with an error saying the database was
  **not** dropped: the stack stays stopped, but the checkout, `.env`, vhost
  and state file are all kept (they hold the credentials a retry needs), so
  re-running the same command picks up where it left off. A database that
  lives *inside* the compose stack itself (the `devdb` overlay,
  `POSTGRES_HOST=db`) cannot be dropped this way — `down -v` removes its
  volume before the drop ever runs, so the drop fails loudly; re-run without
  `--drop-database` in that case.

## 12. The compose project name

Every `docker compose` invocation this CLI makes runs under an explicit
`-p <project>`. Without it, Compose derives the project name from the compose
file's directory — `compose`, for every deployment on the box, because they
all resolve `infra/compose` — so a second application's `up -d` fights the
first one's containers over the same project. `install` gives a **fresh**
deployment its own project name (the deployment's directory name). The name
is **recorded** in the deployment record and never re-derived, so a
deployment recorded under the literal name `compose` keeps it. Do not try to "fix" an older deployment by hand-editing anything
to give it a new project name: Compose would then see no existing containers
under that new name and build a **parallel** stack that collides with the
still-running old one on the same bind port. If you ever see two stacks
fighting over one port on a box with only one application installed, this is
the first thing to check — `deploy status`'s container list will show it.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| Certificate issuance fails during `install` | The domain's DNS doesn't actually point at this server. | `doctor --domain <domain>` runs `dns-resolves` and `dns-points-here` specifically for this — the failure names both addresses (what the domain resolves to, and what this server's own address is) so a CDN or a stale record is obvious at a glance. |
| Login redirects loop, or Google rejects the callback | `GOOGLE_CALLBACK_URL` disagrees with the domain you're actually serving. | `GOOGLE_CALLBACK_URL` is **derived automatically** from the domain you gave during install (`https://<domain>/api/auth/google/callback`) unless you deliberately overrode it in the wizard's `--all` review. If you're seeing this, something overrode the derived value — check the deployed `.env` and either fix it there or re-run the wizard for that key. |
| Migration step succeeds, but the app can't connect to the database afterward | `POSTGRES_PASSWORD` contains a URL-reserved character (`@`, `:`, `/`, `#`). | The API and the `prisma:*` scripts percent-encode the password when they build the database URL, so this points at a hand-built connection string or an out-of-date checkout. Update the checkout (`appctl deploy update`), or choose a password without those characters. |
| `install`/`doctor` reports the loopback port is already in use, by something that isn't this deployment | Another app on the same VPS is already bound to that port. | Pick a different port for this app with `APP_BIND_PORT` in its `.env` (or `--port` during install), or stop whatever's holding the port. `doctor`'s `bind-port-free` check is written to *not* flag this app's own already-running nginx as a conflict — a false positive here means it's genuinely something else. |
| Repeated `install` attempts start failing with a rate-limit error from Let's Encrypt | You burned the hourly/weekly certificate budget on earlier failed attempts (section 8). | Wait — retrying immediately makes it worse. Use `--staging` for everything except the attempt you actually intend to keep. |
| `docker compose` commands fail as if the command doesn't exist, or behave unexpectedly | The standalone `docker-compose` **v1** binary is installed instead of the Compose **v2 plugin** (`docker compose`, no hyphen). | `doctor`'s `docker-compose-v2` check catches this directly. Install the v2 plugin per Docker's current documentation; v1 is not a supported substitute anywhere in this pipeline. |
| `status`/health checks show the API healthy, but the site itself returns 502 | The web container's own nginx and the shared proxy's upstream port have drifted out of agreement. | This is why `status` probes the frontend **separately** from `/api/health/ready` — an API-only health check would show green while the site is down. A stock deployment is guarded by a test asserting these two ports agree; if you've modified `apps/web/nginx.conf` or `infra/nginx/nginx.conf` in a fork, check that they still match. |
| The site serves an expired (or about-to-expire) certificate even though `certs` reports it was renewed | The certificate on disk was renewed, but the proxy was never reloaded, so it is still serving the old one. | `doctor`'s `certificate-served` check catches exactly this by comparing the certificate on the wire against the one on disk. The remedy is one line: `docker exec <proxy-container> nginx -t && docker exec <proxy-container> nginx -s reload` (drop the `docker exec` prefix in host mode) — see section 10. |
| `git clone`/`git fetch` fails with an authentication prompt or error partway through `install`, against a private repository | The repository URL is an HTTPS GitHub URL, and neither `gh` nor another git credential helper is set up for it. | Install and log in with the GitHub CLI (`gh auth login`) before running `install` — `doctor`'s `gh-installed`/`gh-authenticated` checks catch this ahead of time and are `required` in exactly this situation. An SSH deploy key is unaffected either way; `gh` is only ever a credential source for HTTPS. |

## Summary checklist

- [ ] Never running `appctl` with `sudo` — the ordinary operator account owns every file it writes
- [ ] `appctl deploy doctor` run clean (or only recommended warnings) before starting
- [ ] `gh` installed and authenticated (`gh auth login`), if deploying a private repository over HTTPS
- [ ] The shared proxy either already running (container or host), or nothing at all — `install` bootstraps a fresh container-mode proxy for you and never touches an existing one
- [ ] DNS A record for the domain points at this server, confirmed by `doctor --domain <domain>`
- [ ] On a host with more than one application, an explicit `--root` passed to every command except `deploy list`
- [ ] Google OAuth redirect URI matches `https://<domain>/api/auth/google/callback` exactly, and the live credentials probe (or `--skip-oauth-check`) passes
- [ ] External PostgreSQL reachable, with credentials `doctor`/`install`'s environment validation accepts — the database itself may not exist yet, `install` will offer to create it
- [ ] First install run with `--staging` if this is a new domain or a first attempt on this server
- [ ] `appctl deploy install --domain <domain>` completed, including the external HTTPS verification step
- [ ] Logged in at `https://<domain>` as `INITIAL_ADMIN_EMAIL` — this, not the seed, is what creates the admin account
- [ ] Additional users added to the allowlist from the admin panel
- [ ] `appctl deploy status` reports healthy, with migrations "up to date," not just the readiness probe green
- [ ] `appctl deploy update` scheduled (cron or otherwise) if this server should track new releases automatically
- [ ] Certificate renewal confirmed owned by *something* — `install`'s own report (section 10) names which mechanism, and `doctor`'s `certificate-renewal`/`certificate-served` checks catch a gap or an un-reloaded renewal later
- [ ] `<deployRoot>/logs/` reviewed for anything unexpected if any step above didn't go as described
