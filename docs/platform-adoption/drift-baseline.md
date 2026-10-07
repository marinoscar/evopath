# Drift baseline: the app against EnterpriseAppBase

> **Base:** `marinoscar/EnterpriseAppBase` `origin/main` at `d58ca18e48e354347ad96f42021202f848bfafd7` · **App:** the app repository `origin/main` at `144b42057f91246ccf3af223f628c43ad9ec3768` · **Tool:** `scripts/platform-drift.mjs` of the base · **Ledger:** [README.md](README.md) · **Machine-readable:** [drift-baseline.json](drift-baseline.json)

This is the measured starting point of the retrofit: which app files are platform copies, which differ only cosmetically and which really diverge.
Part 1 is the generated report. Part 2 classifies every differing file. Part 3 maps every platform module to the story that adopts it. Parts 4 to 7 record the cross-check against the earlier manual measurement, the non-API areas and the backport list.

## How to read this baseline

- **Direction matters.** The base has moved since the app last copied it. A difference is not always the app ahead: the `base ahead (app behind)` class marks files where the base holds newer platform code (permission and generic registries, event bus, deployment mode, retention purges, package sources). Adopting the package delivers those.
- **Cosmetic means the script found the file identical after normalisation** (comments, whitespace, issue numbers and the product, repository and CLI identity removed on both sides). Those files are safe to delete when their slice is adopted.
- **Classes.** `cosmetic`, `identity`, `appearance`, `generic improvement (backport candidate)`, `domain extension (needs a seam)`, `domain`, and the added `base ahead (app behind)`.
- **Per-file data.** Every differing file, including each app-only file, is classified in the `annotations.files` object of [drift-baseline.json](drift-baseline.json). Part 2 lists every modified and base-only file one by one and groups app-only files by module.
- **Story ids** are the program ids (`PP-10.n`), each linked to its issue in `marinoscar/EnterpriseAppBase`. `-` means the file stays in the app.

Regenerate it from a checkout of the base at the commit above, with `npm ci` run there (the script resolves `typescript` from the base):

```bash
node scripts/platform-drift.mjs --app ../<app-repository> --out ./drift-report
```

The report in Part 1 had its two root-path cells replaced by the repository names, and Parts 2 to 7 were added by hand. The app's product name, repository slug and short name appear as `<app product name>`, `<app repository>` and `<app slug>` throughout, because the repository's identity guard (the CLI `template-identity` test) forbids those literals in any file outside its allowlist. See the runbook `docs/runbooks/platform-drift-report.md` in EnterpriseAppBase for the flags and the normalisation rules.

## Part 1: Generated report

Generated 2026-10-06T21:08:22.538Z by `scripts/platform-drift.mjs` (schema 1).

| | Root | Commit |
|---|---|---|
| Base | `EnterpriseAppBase` | `d58ca18e48e354347ad96f42021202f848bfafd7` |
| App | `app repository` | `144b42057f91246ccf3af223f628c43ad9ec3768` |

### Identity replacements

Every value in this table, base or app, is replaced by its token on both sides before comparing, so these differences are ignored. A row marked "no" is unknown on one side and was not applied (pass the `--base-*`/`--app-*` flags).

| Placeholder | Base | App | Applied as |
|---|---|---|---|
| `__PRODUCT__` | `My App` | `<app product name>` | `__PRODUCT__` |
| `__SLUG__` | `my-app` | `<app slug>` | `__SLUG__` |
| `__SLUG_SNAKE__` | `my_app` | `<app slug>` | `__SLUG__` |
| `__SERVICE__` | `my-app-api` | `<app slug>-api` | `__SERVICE__` |
| `__REPO_SLUG__` | `marinoscar/EnterpriseAppBase` | `<app repository>` | `__REPO_SLUG__` |
| `__REPO_NAME__` | `EnterpriseAppBase` | `<app slug>` | `__SLUG__` |
| `__CLI__` | `appctl` | `evopathcli` | `__CLI__` |
| `__CLI_UPPER__` | `APPCTL` | `EVOPATHCLI` | `__CLI_UPPER__` |
| `__CLI_TITLE__` | `Appctl` | `Evopathcli` | `__CLI_TITLE__` |

### Areas

"Identical" counts identical plus normalised-identical files over every base file in the area (present on both sides, or base-only).

| Area | Root | Base files | Identical | Normalised-identical | Modified | Base-only | App-only | Lines +/- | Identical to base |
|---|---|---|---|---|---|---|---|---|---|
| api | `apps/api/src` | 984 | 704 | 92 | 121 | 67 | 830 | +4227 / -1892 | 80.9% |
| api-test | `apps/api/test` | 141 | 103 | 10 | 18 | 10 | 252 | +753 / -200 | 80.1% |
| web | `apps/web/src` | 514 | 347 | 58 | 97 | 12 | 621 | +3562 / -938 | 78.8% |
| cli | `apps/cli/src` | 233 | 89 | 96 | 36 | 12 | 53 | +742 / -301 | 79.4% |
| prisma | `apps/api/prisma` | 29 | 22 | 1 | 3 | 3 | 31 | +1948 / -52 | 79.3% |
| infra | `infra` | 16 | 6 | 7 | 3 | 0 | 1 | +78 / -14 | 81.3% |
| stack-agent | `apps/stack-agent/src` | 7 | 5 | 2 | 0 | 0 | 0 | +0 / -0 | 100% |
| android | `apps/android` (not in base) | 0 | 0 | 0 | 0 | 0 | 109 | +0 / -0 | n/a |
| packages | `packages` | 73 | 0 | 0 | 5 | 68 | 0 | +61 / -11 | 0% |
| scripts | `scripts` | 8 | 1 | 1 | 2 | 4 | 0 | +31 / -69 | 25% |
| github | `.github` | 12 | 8 | 0 | 1 | 3 | 1 | +0 / -7 | 66.7% |

### Modules by changed lines

| Area | Module | Files | Modified | Base-only | App-only | Lines +/- | Identical to base |
|---|---|---|---|---|---|---|---|
| web | `__tests__` | 465 | 37 | 7 | 260 | +2064 / -458 | 78.5% |
| api | `email` | 49 | 23 | 0 | 5 | +1290 / -544 | 47.7% |
| api | `common` | 111 | 13 | 46 | 5 | +1002 / -76 | 44.3% |
| prisma | `schema.prisma` | 1 | 1 | 0 | 0 | +1016 / -32 | 0% |
| prisma | `seed` | 2 | 2 | 0 | 0 | +932 / -20 | 0% |
| api | `notifications` | 85 | 24 | 6 | 7 | +557 / -348 | 61.5% |
| api | `settings` | 24 | 9 | 1 | 0 | +435 / -222 | 58.3% |
| api | `ai` | 261 | 17 | 3 | 19 | +549 / -44 | 91.7% |
| cli | `deploy` | 90 | 15 | 0 | 6 | +334 / -186 | 82.1% |
| api-test | `ai` | 33 | 4 | 0 | 9 | +477 / -36 | 83.3% |
| web | `(root)` | 4 | 3 | 0 | 0 | +342 / -13 | 25% |
| api | `jobs` | 72 | 6 | 2 | 0 | +30 / -262 | 88.9% |
| web | `config` | 6 | 3 | 0 | 3 | +214 / -72 | 0% |
| web | `theme` | 8 | 5 | 1 | 2 | +202 / -72 | 0% |
| api | `db-backup` | 52 | 9 | 1 | 0 | +8 / -233 | 80.8% |
| cli | `tui` | 52 | 13 | 0 | 10 | +215 / -21 | 69% |
| api | `openapi` | 16 | 1 | 0 | 0 | +215 / -0 | 93.8% |
| cli | `(root)` | 30 | 6 | 2 | 0 | +98 / -88 | 73.3% |
| web | `components/ai` | 35 | 3 | 0 | 0 | +116 / -15 | 91.4% |
| web | `types` | 1 | 1 | 0 | 0 | +123 / -7 | 0% |
| api-test | `fixtures` | 85 | 1 | 0 | 79 | +118 / -0 | 83.3% |
| web | `components/auth` | 4 | 3 | 0 | 1 | +57 / -59 | 0% |
| web | `services` | 45 | 6 | 0 | 26 | +99 / -14 | 68.4% |
| web | `contexts` | 6 | 2 | 0 | 1 | +76 / -37 | 60% |
| web | `components/navigation` | 5 | 4 | 0 | 0 | +87 / -15 | 20% |
| scripts | `(root)` | 8 | 2 | 4 | 0 | +31 / -69 | 25% |
| cli | `commands` | 13 | 1 | 0 | 3 | +93 / -4 | 90% |
| api-test | `(root)` | 12 | 1 | 1 | 0 | +21 / -69 | 83.3% |
| web | `components/telemetry` | 36 | 8 | 0 | 0 | +35 / -48 | 77.8% |
| infra | `nginx` | 3 | 1 | 0 | 0 | +78 / -4 | 66.7% |
| web | `pages` | 38 | 3 | 1 | 24 | +20 / -60 | 71.4% |
| api-test | `settings` | 9 | 1 | 0 | 2 | +0 / -74 | 85.7% |
| packages | `shared` | 5 | 5 | 0 | 0 | +61 / -11 | 0% |
| web | `components/datatable` | 45 | 7 | 0 | 1 | +35 / -25 | 84.1% |
| api | `(root)` | 3 | 2 | 0 | 0 | +51 / -9 | 33.3% |
| api | `doctor` | 9 | 2 | 0 | 0 | +12 / -47 | 77.8% |
| api | `auth` | 39 | 3 | 0 | 1 | +27 / -19 | 92.1% |
| web | `components/admin` | 24 | 1 | 0 | 2 | +36 / -9 | 95.5% |
| api | `config` | 2 | 2 | 0 | 0 | +0 / -44 | 0% |
| api-test | `openapi` | 3 | 1 | 0 | 0 | +44 / -0 | 66.7% |
| web | `components/settings` | 32 | 3 | 1 | 16 | +29 / -11 | 75% |
| web | `pages/Admin` | 31 | 5 | 0 | 5 | +15 / -21 | 80.8% |
| api-test | `prisma` | 2 | 1 | 1 | 0 | +34 / -0 | 0% |
| api | `about` | 8 | 3 | 0 | 0 | +5 / -27 | 62.5% |
| api-test | `notifications` | 6 | 2 | 1 | 1 | +28 / -1 | 40% |
| api | `storage` | 66 | 3 | 2 | 3 | +21 / -2 | 92.1% |
| api | `telemetry` | 93 | 2 | 1 | 0 | +7 / -14 | 96.8% |
| api | `pat` | 8 | 2 | 0 | 0 | +18 / -1 | 75% |
| api-test | `broadcasts` | 3 | 1 | 0 | 0 | +17 / -1 | 66.7% |
| api-test | `doctor` | 1 | 1 | 0 | 0 | +0 / -14 | 0% |
| infra | `compose` | 13 | 2 | 0 | 1 | +0 / -10 | 83.3% |
| web | `components/pwa` | 3 | 2 | 0 | 1 | +6 / -2 | 0% |
| api-test | `nodes` | 13 | 1 | 0 | 0 | +6 / -2 | 92.3% |
| api-test | `jobs` | 15 | 1 | 0 | 0 | +7 / -0 | 93.3% |
| github | `workflows` | 6 | 1 | 1 | 1 | +0 / -7 | 60% |
| web | `components/common` | 18 | 1 | 0 | 8 | +6 / -0 | 90% |
| cli | `node` | 55 | 1 | 0 | 0 | +2 / -2 | 98.2% |
| api-test | `integration` | 6 | 1 | 0 | 0 | +0 / -2 | 83.3% |
| api-test | `about` | 2 | 1 | 0 | 0 | +0 / -1 | 50% |
| api-test | `maintenance` | 2 | 1 | 0 | 0 | +1 / -0 | 50% |
| android | `(root)` | 8 | 0 | 0 | 8 | +0 / -0 | n/a |
| android | `app` | 97 | 0 | 0 | 97 | +0 / -0 | n/a |
| android | `gradle` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| android | `scripts` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| api | `activity` | 18 | 0 | 0 | 18 | +0 / -0 | n/a |
| api | `admin-factory-reset` | 8 | 0 | 0 | 8 | +0 / -0 | n/a |
| api | `allowlist` | 10 | 0 | 1 | 0 | +0 / -0 | 90% |
| api | `android-app` | 23 | 0 | 0 | 23 | +0 / -0 | n/a |
| api | `app-registrations` | 2 | 0 | 2 | 0 | +0 / -0 | 0% |
| api | `check-ins` | 8 | 0 | 0 | 8 | +0 / -0 | n/a |
| api | `coach` | 180 | 0 | 0 | 180 | +0 / -0 | n/a |
| api | `exercises` | 8 | 0 | 0 | 8 | +0 / -0 | n/a |
| api | `gyms` | 41 | 0 | 0 | 41 | +0 / -0 | n/a |
| api | `health-documents` | 13 | 0 | 0 | 13 | +0 / -0 | n/a |
| api | `health-export` | 22 | 0 | 0 | 22 | +0 / -0 | n/a |
| api | `health-profile` | 9 | 0 | 0 | 9 | +0 / -0 | n/a |
| api | `health-summary` | 16 | 0 | 0 | 16 | +0 / -0 | n/a |
| api | `health-sync` | 8 | 0 | 0 | 8 | +0 / -0 | n/a |
| api | `intake` | 18 | 0 | 0 | 18 | +0 / -0 | n/a |
| api | `measurements` | 50 | 0 | 0 | 50 | +0 / -0 | n/a |
| api | `memory` | 20 | 0 | 0 | 20 | +0 / -0 | n/a |
| api | `nodes` | 50 | 0 | 1 | 0 | +0 / -0 | 98% |
| api | `onboarding` | 9 | 0 | 0 | 9 | +0 / -0 | n/a |
| api | `programs` | 42 | 0 | 0 | 42 | +0 / -0 | n/a |
| api | `progress-photos` | 11 | 0 | 0 | 11 | +0 / -0 | n/a |
| api | `sleep` | 4 | 0 | 0 | 4 | +0 / -0 | n/a |
| api | `training-adaptation` | 45 | 0 | 0 | 45 | +0 / -0 | n/a |
| api | `training-agents` | 193 | 0 | 0 | 193 | +0 / -0 | n/a |
| api | `training-usage` | 6 | 0 | 0 | 6 | +0 / -0 | n/a |
| api | `user-data` | 9 | 0 | 0 | 9 | +0 / -0 | n/a |
| api | `users` | 12 | 0 | 1 | 0 | +0 / -0 | 91.7% |
| api | `workouts` | 29 | 0 | 0 | 29 | +0 / -0 | n/a |
| api-test | `activity` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| api-test | `admin-factory-reset` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| api-test | `android-app` | 4 | 0 | 0 | 4 | +0 / -0 | n/a |
| api-test | `auth` | 5 | 0 | 1 | 0 | +0 / -0 | 80% |
| api-test | `coach` | 33 | 0 | 0 | 33 | +0 / -0 | n/a |
| api-test | `db-backup` | 4 | 0 | 1 | 0 | +0 / -0 | 75% |
| api-test | `evals` | 27 | 0 | 0 | 27 | +0 / -0 | n/a |
| api-test | `event-bus` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| api-test | `exercises` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| api-test | `fake-responses` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| api-test | `gyms` | 9 | 0 | 0 | 9 | +0 / -0 | n/a |
| api-test | `health-data` | 20 | 0 | 0 | 20 | +0 / -0 | n/a |
| api-test | `health-sync` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| api-test | `helpers` | 9 | 0 | 2 | 0 | +0 / -0 | 77.8% |
| api-test | `intake` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| api-test | `memory` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| api-test | `onboarding` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| api-test | `programs` | 8 | 0 | 0 | 8 | +0 / -0 | n/a |
| api-test | `retention` | 2 | 0 | 2 | 0 | +0 / -0 | 0% |
| api-test | `storage` | 3 | 0 | 0 | 1 | +0 / -0 | 100% |
| api-test | `training-adaptation` | 6 | 0 | 0 | 6 | +0 / -0 | n/a |
| api-test | `training-agents` | 18 | 0 | 0 | 18 | +0 / -0 | n/a |
| api-test | `training-usage` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| api-test | `user-data` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| api-test | `workouts` | 14 | 0 | 0 | 14 | +0 / -0 | n/a |
| cli | `__fixtures__` | 10 | 0 | 10 | 0 | +0 / -0 | 0% |
| cli | `android` | 34 | 0 | 0 | 34 | +0 / -0 | n/a |
| github | `(root)` | 3 | 0 | 1 | 0 | +0 / -0 | 66.7% |
| github | `ISSUE_TEMPLATE` | 4 | 0 | 1 | 0 | +0 / -0 | 75% |
| packages | `(root)` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| packages | `platform-api` | 13 | 0 | 13 | 0 | +0 / -0 | 0% |
| packages | `platform-cli` | 9 | 0 | 9 | 0 | +0 / -0 | 0% |
| packages | `platform-contract` | 13 | 0 | 13 | 0 | +0 / -0 | 0% |
| packages | `platform-db` | 11 | 0 | 11 | 0 | +0 / -0 | 0% |
| packages | `platform-infra` | 12 | 0 | 12 | 0 | +0 / -0 | 0% |
| packages | `platform-web` | 9 | 0 | 9 | 0 | +0 / -0 | 0% |
| prisma | `catalog` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| prisma | `migrations` | 54 | 0 | 2 | 31 | +0 / -0 | 91.3% |
| web | `components/coach` | 15 | 0 | 0 | 15 | +0 / -0 | n/a |
| web | `components/goals` | 5 | 0 | 0 | 5 | +0 / -0 | n/a |
| web | `components/gyms` | 24 | 0 | 0 | 24 | +0 / -0 | n/a |
| web | `components/health` | 28 | 0 | 0 | 28 | +0 / -0 | n/a |
| web | `components/home` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| web | `components/intake` | 10 | 0 | 0 | 10 | +0 / -0 | n/a |
| web | `components/onboarding` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| web | `components/progress` | 7 | 0 | 0 | 7 | +0 / -0 | n/a |
| web | `components/today` | 10 | 0 | 0 | 10 | +0 / -0 | n/a |
| web | `components/train` | 19 | 0 | 0 | 19 | +0 / -0 | n/a |
| web | `components/training` | 64 | 0 | 0 | 64 | +0 / -0 | n/a |
| web | `components/user` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| web | `hooks` | 109 | 0 | 0 | 63 | +0 / -0 | 100% |
| web | `pages/Train` | 6 | 0 | 0 | 6 | +0 / -0 | n/a |
| web | `utils` | 20 | 0 | 0 | 17 | +0 / -0 | 100% |

### Most changed files (top 80)

| File | Lines +/- |
|---|---|
| `apps/api/prisma/schema.prisma` | +1016 / -32 |
| `apps/api/prisma/seed-data.ts` | +790 / -20 |
| `apps/api/src/email/templates/layout.ts` | +376 / -59 |
| `apps/web/src/__tests__/App.test.tsx` | +303 / -102 |
| `apps/api/test/ai/ai-kill-switch.integration.spec.ts` | +370 / -27 |
| `apps/api/src/common/otel/app-metrics.service.ts` | +350 / -0 |
| `apps/web/src/__tests__/mocks/handlers.ts` | +315 / -0 |
| `apps/web/src/App.tsx` | +294 / -7 |
| `apps/api/src/ai/README.md` | +249 / -6 |
| `apps/web/src/__tests__/config/userSettingsSections.test.ts` | +235 / -1 |
| `apps/api/src/common/schemas/user-settings-namespaces.schema.ts` | +221 / -0 |
| `apps/api/src/settings/system-settings/system-settings.service.spec.ts` | +114 / -105 |
| `apps/api/src/openapi/tags.ts` | +215 / -0 |
| `apps/web/src/__tests__/config/destinations.test.ts` | +172 / -12 |
| `apps/api/src/email/templates/layout.spec.ts` | +170 / -5 |
| `apps/api/src/notifications/notification-stream.service.spec.ts` | +0 / -172 |
| `apps/api/src/common/schemas/settings.schema.ts` | +118 / -33 |
| `apps/web/src/__tests__/config/settingsRegistry.test.ts` | +131 / -14 |
| `apps/api/prisma/seed.ts` | +142 / -0 |
| `apps/api/src/jobs/job.worker.spec.ts` | +2 / -140 |
| `apps/api/src/email/templates/backup-failed.email.ts` | +67 / -64 |
| `apps/web/src/types/index.ts` | +123 / -7 |
| `apps/api/src/notifications/notification-stream.service.ts` | +2 / -126 |
| `apps/api/src/email/templates/node-offline.email.ts` | +61 / -64 |
| `apps/api/src/notifications/channels/browser-notification.channel.ts` | +118 / -1 |
| `apps/api/test/fixtures/test-data.factory.ts` | +118 / -0 |
| `apps/web/src/config/adminSections.tsx` | +54 / -64 |
| `apps/api/src/email/templates/restore-completed.email.ts` | +50 / -66 |
| `apps/api/src/email/templates/job-failed.email.ts` | +57 / -57 |
| `apps/cli/src/deploy/update.test.ts` | +109 / -0 |
| `apps/api/src/email/templates/test-email.email.ts` | +49 / -58 |
| `apps/web/src/__tests__/components/navigation/BottomNav.test.tsx` | +69 / -36 |
| `apps/web/src/__tests__/components/auth/OAuthButton.test.tsx` | +104 / -0 |
| `apps/web/src/contexts/ThemeContext.tsx` | +64 / -37 |
| `apps/api/src/email/templates/role-changed.email.ts` | +48 / -52 |
| `apps/api/src/settings/system-settings/system-settings.service.ts` | +58 / -41 |
| `apps/cli/src/commands/deploy.ts` | +93 / -4 |
| `apps/api/src/email/templates/allowlist-invitation.email.ts` | +48 / -42 |
| `apps/api/test/docs-links.spec.ts` | +21 / -69 |
| `apps/web/src/theme/components.ts` | +77 / -13 |
| `apps/api/src/email/templates/user-welcome.email.ts` | +47 / -41 |
| `apps/api/src/settings/user-settings/user-settings.service.spec.ts` | +88 / -0 |
| `apps/web/src/__tests__/services/pushSubscription.test.ts` | +83 / -5 |
| `apps/web/src/__tests__/pwa/service-worker.test.ts` | +86 / -1 |
| `apps/api/src/ai/core/ai-error.spec.ts` | +85 / -1 |
| `apps/api/src/common/otel/app-metrics.service.spec.ts` | +86 / -0 |
| `apps/api/src/notifications/notification-events.ts` | +83 / -3 |
| `apps/web/src/config/userSettingsSections.tsx` | +86 / -0 |
| `apps/api/src/common/constants/roles.constants.ts` | +53 / -32 |
| `apps/api/src/db-backup/database-restore.service.spec.ts` | +1 / -82 |
| `apps/api/src/settings/user-settings/user-settings.service.ts` | +81 / -1 |
| `apps/web/src/config/destinations.ts` | +74 / -8 |
| `infra/nginx/nginx.conf` | +78 / -4 |
| `apps/web/src/__tests__/contexts/ThemeContext.test.tsx` | +81 / -0 |
| `apps/cli/src/deploy/proxy.ts` | +79 / -1 |
| `apps/api/src/settings/dto/update-system-settings.dto.ts` | +61 / -18 |
| `apps/api/src/notifications/push-subscription.service.spec.ts` | +74 / -2 |
| `apps/api/test/settings/system-settings.integration.spec.ts` | +0 / -74 |
| `apps/web/src/components/ai/AiSpeechPlayer.tsx` | +68 / -6 |
| `apps/api/src/ai/providers/openai/openai-hosted-tools.spec.ts` | +73 / -0 |
| `apps/web/src/__tests__/pages/UserAiKeysPage.wire.test.tsx` | +11 / -61 |
| `apps/api/src/email/templates/index.spec.ts` | +66 / -3 |
| `apps/web/src/__tests__/components/navigation/NavigationRail.test.tsx` | +55 / -13 |
| `apps/cli/src/deploy/proxy.test.ts` | +67 / -0 |
| `scripts/new-project.mjs` | +10 / -57 |
| `apps/web/src/__tests__/pages/LoginPage.test.tsx` | +66 / -0 |
| `apps/api/src/common/schemas/settings-parity.spec.ts` | +64 / -0 |
| `apps/cli/src/rename-script.test.ts` | +38 / -24 |
| `apps/web/src/components/auth/SignInErrorView.tsx` | +26 / -33 |
| `apps/api/src/app.module.ts` | +51 / -7 |
| `apps/web/src/__tests__/components/ai/AiSpeechPlayer.test.tsx` | +57 / -1 |
| `apps/cli/src/deploy/proxy-bootstrap.test.ts` | +0 / -57 |
| `apps/cli/src/new-project-script.test.ts` | +1 / -56 |
| `apps/api/test/ai/ai-rbac-matrix.integration.spec.ts` | +49 / -6 |
| `apps/web/src/theme/augment.ts` | +46 / -8 |
| `apps/web/src/__tests__/pages/Admin/DbBackupPage.test.tsx` | +0 / -53 |
| `apps/api/src/settings/dto/update-system-settings.dto.spec.ts` | +0 / -52 |
| `apps/web/src/sw.ts` | +46 / -6 |
| `apps/api/src/db-backup/db-backup-admin.service.spec.ts` | +1 / -50 |
| `apps/cli/src/deploy/update.ts` | +47 / -4 |

### Migrations

Matched by normalised SQL first, then by the name after the 14-digit timestamp.

| Base | App | Shared | Renamed | Same name, different SQL | Base-only | App-only |
|---|---|---|---|---|---|---|
| 22 | 51 | 20 | 1 | 0 | 1 | 30 |

Renamed (same SQL, different id):

- `20260928100000_add_worker_node_vitals` is `20260930100000_add_worker_node_vitals` in the app

Base-only:

- `20261006120000_add_retention_created_at_indexes`

App-only:

- `20260929125915_add_health_profile`
- `20260929131912_add_measurements`
- `20260929161524_add_photo_intake`
- `20260929164626_add_gyms_equipment`
- `20260929212013_add_exercise_library`
- `20260929220000_fix_exercise_primary_muscles_check`
- `20260929230000_add_workout_logging`
- `20260929230548_add_workout_photos`
- `20260930001950_add_training_run_checkpoints`
- `20260930110000_add_training_plan_runs`
- `20260930130000_add_training_programs`
- `20260930140000_add_program_sessions`
- `20260930150000_add_program_evaluation_state`
- `20260930160000_add_workout_adaptations`
- `20260930170000_allow_adapt_training_run_kind`
- `20260930180000_remove_user_ai_model_choices`
- `20260930190000_add_health_documents`
- `20260930200000_add_measurement_reference_range`
- `20261001090000_add_health_document_version`
- `20261001100000_add_health_summaries`
- `20261001110000_add_health_profile_lab_units`
- `20261001120000_ai_coach_foundations`
- `20261002100000_program_exercise_cardio_targets`
- `20261002110000_add_activity_goals_and_entries`
- `20261003100000_add_health_sync`
- `20261003110000_add_sleep_and_measurement_external_ids`
- `20261003120000_add_android_app_releases`
- `20261004100000_add_push_subscription_platform`
- `20261005100000_coach_chat_cleared_at`
- `20261005110000_user_memories`

### Prisma models

Base models present in the app: 31 of 31. Total models in the app: 77.

- Missing from the app: none
- App-only: `ActivityEntry`, `ActivityGoal`, `AndroidAppRelease`, `Capability`, `CoachMessage`, `CoachState`, `DraftItem`, `EquipmentType`, `EquipmentTypeCapability`, `Exercise`, `ExerciseRequirement`, `Gym`, `GymEquipment`, `GymEquipmentPhoto`, `GymPhoto`, `HealthDocument`, `HealthProfile`, `HealthSummary`, `HealthSummarySetting`, `HealthSyncDevice`, `HealthSyncDiagnosticReport`, `HealthSyncRun`, `Measurement`, `PhotoIntake`, `PhotoIntakePhoto`, `Program`, `ProgramBlock`, `ProgramChangeLog`, `ProgramExercise`, `ProgramSession`, `ProgramVersion`, `ProgramWeek`, `ProgramWorkout`, `ProgressPhoto`, `SetLog`, `SleepSession`, `TrainingPlanRun`, `TrainingRunCheckpoint`, `TrainingRunCheckpointWrite`, `TrainingRunEvent`, `UserMemory`, `UserMemoryState`, `Workout`, `WorkoutAdaptation`, `WorkoutExercise`, `WorkoutPhoto`

Shared models whose fields differ:

| Model | Fields added in the app | Fields removed in the app |
|---|---|---|
| `PersonalAccessToken` | `healthSyncDevices` | none |
| `PushSubscription` | `platform` | none |
| `StorageObject` | `coachAudio`, `gymPhotos`, `healthDocuments`, `intakePhotos`, `progressPhotos`, `workoutPhotos` | none |
| `User` | `activityEntries`, `activityGoals`, `androidAppReleasesUploaded`, `coachMessages`, `coachState`, `equipmentTypes`, `exercises`, `gyms`, `healthDocuments`, `healthProfile`, `healthSummaries`, `healthSummarySetting`, `healthSyncDevices`, `healthSyncDiagnosticReports`, `healthSyncRuns`, `measurements`, `memories`, `memoryState`, `photoIntakes`, `programChanges`, `programSessions`, `programs`, `progressPhotos`, `sleepSessions`, `trainingPlanRuns`, `workoutAdaptations`, `workouts` | none |

### Zero-drift modules

Modules where every file exists on both sides and is identical or normalised-identical: the candidates for early adoption.

- api: `credentials` (7 files)
- api: `device-auth` (18 files)
- api: `health` (9 files)
- api: `prisma` (3 files)
- api: `test-auth` (7 files)
- api: `user-credentials` (8 files)
- api-test: `device-auth` (1 files)
- api-test: `errors` (1 files)
- api-test: `health` (1 files)
- api-test: `mocks` (5 files)
- api-test: `rbac` (2 files)
- api-test: `telemetry` (4 files)
- api-test: `test-auth` (1 files)
- api-test: `user-credentials` (1 files)
- api-test: `users` (1 files)
- web: `components/device-activation` (5 files)
- web: `components/doctor` (1 files)
- web: `components/notifications` (1 files)
- cli: `init` (2 files)
- prisma: `(root)` (2 files)
- infra: `otel` (1 files)
- stack-agent: `(root)` (7 files)

## Part 2: Classification of every differing file

### Summary

| Classification | Modified | Base-only | app-only | Cosmetic (normalised-identical) | Total |
|---|---|---|---|---|---|
| cosmetic | 1 | 1 | 0 | 267 | 269 |
| identity | 9 | 0 | 0 | 0 | 9 |
| appearance | 47 | 6 | 17 | 0 | 70 |
| generic improvement (backport candidate) | 39 | 0 | 18 | 0 | 57 |
| domain extension (needs a seam) | 119 | 1 | 297 | 0 | 417 |
| domain | 12 | 0 | 1566 | 0 | 1578 |
| base ahead (app behind) | 59 | 171 | 0 | 0 | 230 |
| **All** | 286 | 179 | 1898 | 267 | 2630 |

Byte-identical files are not classified: they are platform copies with nothing to decide.

### API (`apps/api/src`)

Modified and base-only files, one row each.

| File | Status | Lines +/- | Classification | Story | Why |
|---|---|---|---|---|---|
| `apps/api/src/about/about.service.spec.ts` | modified | +3 / -19 | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/about/about.service.ts` | modified | +2 / -6 | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/about/dto/about-response.dto.ts` | modified | +0 / -2 | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/ai/README.md` | modified | +249 / -6 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | documents the administrator model assignments and training agents |
| `apps/api/src/ai/ai.module.ts` | modified | +2 / -0 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | wired to the feature-assignment resolver |
| `apps/api/src/ai/ai.permissions.ts` | base-only |  | base ahead (app behind) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | permission declaration the base moved next to its module |
| `apps/api/src/ai/config/ai-config-admin.service.spec.ts` | modified | +10 / -0 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | wired to the feature-assignment resolver |
| `apps/api/src/ai/config/ai-config-admin.service.ts` | modified | +1 / -0 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | wired to the feature-assignment resolver |
| `apps/api/src/ai/core/ai-error.spec.ts` | modified | +85 / -1 | generic improvement (backport candidate) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | log-safe provider error detail, with redaction |
| `apps/api/src/ai/core/ai-error.ts` | modified | +38 / -0 | generic improvement (backport candidate) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | log-safe provider error detail, with redaction |
| `apps/api/src/ai/http/ai-responses.controller.ts` | modified | +2 / -2 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | documents the administrator model assignments and training agents |
| `apps/api/src/ai/http/ai-sse.ts` | modified | +6 / -3 | generic improvement (backport candidate) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | SseFrame: any frame type through the shared SSE pipe |
| `apps/api/src/ai/providers/openai/openai-hosted-tools.spec.ts` | modified | +73 / -0 | generic improvement (backport candidate) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | adds web_search_call.action.sources to the request include list |
| `apps/api/src/ai/providers/openai/openai-responses.mapper.ts` | modified | +29 / -3 | generic improvement (backport candidate) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | adds web_search_call.action.sources to the request include list |
| `apps/api/src/ai/runtime/ai-embed.spec.ts` | modified | +1 / -1 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | wired to the feature-assignment resolver |
| `apps/api/src/ai/runtime/ai-file-inputs.spec.ts` | modified | +14 / -0 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | wired to the feature-assignment resolver |
| `apps/api/src/ai/runtime/ai-runs-purge.handler.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | retention purge handler present only in the base |
| `apps/api/src/ai/runtime/ai-runs-purge.handler.ts` | base-only |  | base ahead (app behind) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | retention purge handler present only in the base |
| `apps/api/src/ai/runtime/ai-runtime.module.ts` | modified | +1 / -4 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | wired to the feature-assignment resolver |
| `apps/api/src/ai/runtime/ai.service.spec.ts` | modified | +8 / -3 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | wired to the feature-assignment resolver |
| `apps/api/src/ai/runtime/ai.service.ts` | modified | +16 / -16 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | wired to the feature-assignment resolver |
| `apps/api/src/ai/storage/ai-output-writer.ts` | modified | +2 / -0 | generic improvement (backport candidate) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | text/csv and application/pdf output extensions (plus identity string) |
| `apps/api/src/ai/testing/ai-runtime-harness.ts` | modified | +12 / -5 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | wired to the feature-assignment resolver |
| `apps/api/src/allowlist/allowlist.permissions.ts` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | permission declaration the base moved next to its module |
| `apps/api/src/app-registrations/README.md` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | base slot where an app registers its permissions and roles |
| `apps/api/src/app-registrations/permissions.ts` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | base slot where an app registers its permissions and roles |
| `apps/api/src/app.module.ts` | modified | +51 / -7 | domain | - | imports and registers every app domain module |
| `apps/api/src/auth/decorators/index.ts` | modified | +1 / -0 | generic improvement (backport candidate) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | @AuthCredential() and PatService.resolveToken: tells a route which PAT authenticated it |
| `apps/api/src/auth/guards/jwt-auth.guard.spec.ts` | modified | +17 / -15 | generic improvement (backport candidate) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | @AuthCredential() and PatService.resolveToken: tells a route which PAT authenticated it |
| `apps/api/src/auth/guards/jwt-auth.guard.ts` | modified | +9 / -4 | generic improvement (backport candidate) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | @AuthCredential() and PatService.resolveToken: tells a route which PAT authenticated it |
| `apps/api/src/common/common.module.ts` | modified | +1 / -3 | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/common/constants/roles.constants.ts` | modified | +53 / -32 | domain extension (needs a seam) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | hand list of roles and permissions incl. app ones; the base derives them from the permission registry |
| `apps/api/src/common/crypto/secret-cipher.spec.ts` | modified | +21 / -0 | generic improvement (backport candidate) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | deriveSigningKey / shared CSV helper: generic, no app concept in them |
| `apps/api/src/common/crypto/secret-cipher.ts` | modified | +14 / -0 | generic improvement (backport candidate) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | deriveSigningKey / shared CSV helper: generic, no app concept in them |
| `apps/api/src/common/deployment/deployment-mode.service.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/deployment/deployment-mode.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/deployment/deployment-mode.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/deployment/deployment.module.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/deployment/doctor/deployment-mode.doctor-check.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/deployment/doctor/deployment-mode.doctor-check.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/deployment/index.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/dto/error.dto.ts` | modified | +1 / -0 | generic improvement (backport candidate) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | zod issue details under details.issues and the 412 PRECONDITION_FAILED code |
| `apps/api/src/common/event-bus/doctor/event-bus.doctor-check.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/event-bus/doctor/event-bus.doctor-check.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/event-bus/event-bus-core.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/event-bus/event-bus.config.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/event-bus/event-bus.config.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/event-bus/event-bus.interface.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/event-bus/event-bus.module.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/event-bus/event-bus.module.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/event-bus/in-process-event-bus.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/event-bus/in-process-event-bus.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/event-bus/index.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/event-bus/postgres-event-bus.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/event-bus/postgres-event-bus.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/filters/http-exception.filter.spec.ts` | modified | +30 / -1 | generic improvement (backport candidate) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | zod issue details under details.issues and the 412 PRECONDITION_FAILED code |
| `apps/api/src/common/filters/http-exception.filter.ts` | modified | +17 / -0 | generic improvement (backport candidate) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | zod issue details under details.issues and the 412 PRECONDITION_FAILED code |
| `apps/api/src/common/otel/app-metrics.service.spec.ts` | modified | +86 / -0 | domain extension (needs a seam) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | closed metric name map holds 26 app.coach.* and app.health.* names (PP-10.3) |
| `apps/api/src/common/otel/app-metrics.service.ts` | modified | +350 / -0 | domain extension (needs a seam) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | closed metric name map holds 26 app.coach.* and app.health.* names (PP-10.3) |
| `apps/api/src/common/permissions/README.md` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/permissions/index.ts` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/permissions/permission-catalog.ts` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/permissions/permission-ids.ts` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/permissions/permission.manifest.ts` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/permissions/permission.registry.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/permissions/permission.registry.ts` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/permissions/permission.types.ts` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/permissions/platform-roles.ts` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/principal/index.ts` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/principal/principal.types.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/principal/principal.types.ts` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/registry/README.md` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/registry/index.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/registry/registry-freeze.service.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/registry/registry-freeze.service.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/registry/registry.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/registry/registry.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/registry/testing.ts` | base-only |  | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/retention/audit-events-purge.handler.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/retention/audit-events-purge.handler.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/retention/batched-purge.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/retention/batched-purge.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/retention/retention-purge.task.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/retention/retention-purge.task.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/retention/retention.module.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | platform seam the base has and the app lacks (deployment mode, event bus, permission and generic registries, retention purges) |
| `apps/api/src/common/schemas/settings-parity.spec.ts` | modified | +64 / -0 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | coach, memory, onboarding and AI assignment settings namespaces: needs a settings-namespace registry (PP-10.8) |
| `apps/api/src/common/schemas/settings.schema.ts` | modified | +118 / -33 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | coach, memory, onboarding and AI assignment settings namespaces: needs a settings-namespace registry (PP-10.8) |
| `apps/api/src/common/schemas/user-settings-namespaces.schema.ts` | modified | +221 / -0 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | coach, memory, onboarding and AI assignment settings namespaces: needs a settings-namespace registry (PP-10.8) |
| `apps/api/src/common/types/settings.types.ts` | modified | +26 / -7 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | coach, memory, onboarding and AI assignment settings namespaces: needs a settings-namespace registry (PP-10.8) |
| `apps/api/src/config/configuration.spec.ts` | modified | +0 / -38 | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/config/configuration.ts` | modified | +0 / -6 | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/db-backup/database-restore.service.spec.ts` | modified | +1 / -82 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/db-backup/database-restore.service.ts` | modified | +0 / -5 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/db-backup/db-backup-admin.service.spec.ts` | modified | +1 / -50 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/db-backup/db-backup-admin.service.ts` | modified | +1 / -23 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/db-backup/db-backup.controller.ts` | modified | +2 / -28 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/db-backup/db-backup.errors.ts` | modified | +0 / -12 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/db-backup/db-backup.permissions.ts` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | permission declaration the base moved next to its module |
| `apps/api/src/db-backup/dto/db-backup-config.dto.ts` | modified | +0 / -5 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/db-backup/handlers/db-restore-run.handler.spec.ts` | modified | +2 / -18 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/db-backup/handlers/db-restore-run.handler.ts` | modified | +1 / -10 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/doctor/doctor-check.registry.spec.ts` | modified | +0 / -32 | base ahead (app behind) | [PP-10.2](https://github.com/marinoscar/EnterpriseAppBase/issues/717) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/doctor/doctor-check.registry.ts` | modified | +12 / -15 | base ahead (app behind) | [PP-10.2](https://github.com/marinoscar/EnterpriseAppBase/issues/717) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/email/email-test-send.service.spec.ts` | modified | +16 / -0 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | EmailAttachment on EmailMessage and both providers (inline brand mark) |
| `apps/api/src/email/email-test-send.service.ts` | modified | +3 / -7 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | EmailAttachment on EmailMessage and both providers (inline brand mark) |
| `apps/api/src/email/email.types.ts` | modified | +8 / -0 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | EmailAttachment on EmailMessage and both providers (inline brand mark) |
| `apps/api/src/email/index.ts` | modified | +6 / -1 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | EmailAttachment on EmailMessage and both providers (inline brand mark) |
| `apps/api/src/email/providers/ses-email.provider.spec.ts` | modified | +45 / -0 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | EmailAttachment on EmailMessage and both providers (inline brand mark) |
| `apps/api/src/email/providers/ses-email.provider.ts` | modified | +15 / -0 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | EmailAttachment on EmailMessage and both providers (inline brand mark) |
| `apps/api/src/email/providers/smtp-email.provider.spec.ts` | modified | +34 / -0 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | EmailAttachment on EmailMessage and both providers (inline brand mark) |
| `apps/api/src/email/providers/smtp-email.provider.ts` | modified | +11 / -0 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | EmailAttachment on EmailMessage and both providers (inline brand mark) |
| `apps/api/src/email/templates/allowlist-invitation.email.ts` | modified | +48 / -42 | appearance | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | app email layout (brand mark, eyebrow, footer reason); template copy follows it |
| `apps/api/src/email/templates/backup-failed.email.ts` | modified | +67 / -64 | appearance | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | app email layout (brand mark, eyebrow, footer reason); template copy follows it |
| `apps/api/src/email/templates/broadcast.email.ts` | modified | +22 / -17 | appearance | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | app email layout (brand mark, eyebrow, footer reason); template copy follows it |
| `apps/api/src/email/templates/email-template.types.ts` | modified | +19 / -2 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | composeEmailMessage and RenderedEmail.attachments: inline MIME parts |
| `apps/api/src/email/templates/index.spec.ts` | modified | +66 / -3 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | composeEmailMessage and RenderedEmail.attachments: inline MIME parts |
| `apps/api/src/email/templates/index.ts` | modified | +33 / -1 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | composeEmailMessage and RenderedEmail.attachments: inline MIME parts |
| `apps/api/src/email/templates/job-failed.email.ts` | modified | +57 / -57 | appearance | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | app email layout (brand mark, eyebrow, footer reason); template copy follows it |
| `apps/api/src/email/templates/layout.spec.ts` | modified | +170 / -5 | appearance | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | app email layout (brand mark, eyebrow, footer reason); template copy follows it |
| `apps/api/src/email/templates/layout.ts` | modified | +376 / -59 | appearance | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | app email layout (brand mark, eyebrow, footer reason); template copy follows it |
| `apps/api/src/email/templates/node-offline.email.ts` | modified | +61 / -64 | appearance | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | app email layout (brand mark, eyebrow, footer reason); template copy follows it |
| `apps/api/src/email/templates/operational.email.spec.ts` | modified | +39 / -5 | appearance | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | app email layout (brand mark, eyebrow, footer reason); template copy follows it |
| `apps/api/src/email/templates/restore-completed.email.ts` | modified | +50 / -66 | appearance | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | app email layout (brand mark, eyebrow, footer reason); template copy follows it |
| `apps/api/src/email/templates/role-changed.email.ts` | modified | +48 / -52 | appearance | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | app email layout (brand mark, eyebrow, footer reason); template copy follows it |
| `apps/api/src/email/templates/test-email.email.ts` | modified | +49 / -58 | appearance | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | app email layout (brand mark, eyebrow, footer reason); template copy follows it |
| `apps/api/src/email/templates/user-welcome.email.ts` | modified | +47 / -41 | appearance | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | app email layout (brand mark, eyebrow, footer reason); template copy follows it |
| `apps/api/src/jobs/handlers/README.md` | modified | +0 / -10 | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/jobs/job-type-labels.ts` | modified | +25 / -4 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | 30-odd app job type labels: needs a label registry |
| `apps/api/src/jobs/job-wake.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | event-bus job wake-up channel |
| `apps/api/src/jobs/job.worker.spec.ts` | modified | +2 / -140 | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/jobs/job.worker.ts` | modified | +2 / -48 | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/jobs/jobs.permissions.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | permission declaration the base moved next to its module |
| `apps/api/src/jobs/jobs.service.spec.ts` | modified | +0 / -49 | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/jobs/jobs.service.ts` | modified | +1 / -11 | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | event-bus wake-up, deployment mode, generic registry; the app lacks them |
| `apps/api/src/main.ts` | modified | +0 / -2 | base ahead (app behind) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | DEPLOYMENT_MODE start-up check (plus an issue number) |
| `apps/api/src/nodes/nodes.permissions.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | permission declaration the base moved next to its module |
| `apps/api/src/notifications/README.md` | modified | +12 / -4 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/broadcasts/broadcasts.permissions.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | permission declaration the base moved next to its module |
| `apps/api/src/notifications/broadcasts/broadcasts.service.spec.ts` | modified | +14 / -1 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/broadcasts/broadcasts.service.ts` | modified | +11 / -6 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/broadcasts/dto/broadcast-response.dto.ts` | modified | +1 / -0 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/channels/browser-notification.channel.spec.ts` | modified | +5 / -0 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/channels/browser-notification.channel.ts` | modified | +118 / -1 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/channels/email-notification.channel.spec.ts` | modified | +34 / -0 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/channels/email-notification.channel.ts` | modified | +4 / -6 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/channels/push-notification.channel.spec.ts` | modified | +34 / -0 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/channels/push-notification.channel.ts` | modified | +36 / -5 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/dto/push-subscription.dto.ts` | modified | +8 / -1 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/notification-events.spec.ts` | modified | +27 / -0 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/notification-events.ts` | modified | +83 / -3 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/notification-stream.service.spec.ts` | modified | +0 / -172 | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | cross-replica fan-out through the event bus |
| `apps/api/src/notifications/notification-stream.service.ts` | modified | +2 / -126 | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | cross-replica fan-out through the event bus |
| `apps/api/src/notifications/notification.types.ts` | modified | +1 / -0 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/notifications.controller.ts` | modified | +4 / -0 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/notifications.module.ts` | modified | +8 / -8 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/notifications.service.spec.ts` | modified | +23 / -1 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/notifications.service.ts` | modified | +9 / -4 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/operational-events-no-migration.spec.ts` | modified | +31 / -2 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/push-subscription.service.spec.ts` | modified | +74 / -2 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/push-subscription.service.ts` | modified | +15 / -3 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/push-test.service.ts` | modified | +3 / -3 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | android_app channel, coach and training events, push actions: needs channel, event and template registries (PP-10.9) |
| `apps/api/src/notifications/push.permissions.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | permission declaration the base moved next to its module |
| `apps/api/src/notifications/retention/notification-deliveries-purge.handler.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | retention purge handler present only in the base |
| `apps/api/src/notifications/retention/notification-deliveries-purge.handler.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | retention purge handler present only in the base |
| `apps/api/src/notifications/retention/notification-inbox-purge.handler.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | retention purge handler present only in the base |
| `apps/api/src/notifications/retention/notification-inbox-purge.handler.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | retention purge handler present only in the base |
| `apps/api/src/openapi/tags.ts` | modified | +215 / -0 | domain extension (needs a seam) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | OpenAPI tag descriptions for app modules |
| `apps/api/src/pat/pat.service.spec.ts` | modified | +14 / -0 | generic improvement (backport candidate) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | @AuthCredential() and PatService.resolveToken: tells a route which PAT authenticated it |
| `apps/api/src/pat/pat.service.ts` | modified | +4 / -1 | generic improvement (backport candidate) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | @AuthCredential() and PatService.resolveToken: tells a route which PAT authenticated it |
| `apps/api/src/settings/dto/system-settings-response.dto.ts` | modified | +15 / -5 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | settings DTOs and services know the app namespaces |
| `apps/api/src/settings/dto/update-system-settings.dto.spec.ts` | modified | +0 / -52 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | settings DTOs and services know the app namespaces |
| `apps/api/src/settings/dto/update-system-settings.dto.ts` | modified | +61 / -18 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | settings DTOs and services know the app namespaces |
| `apps/api/src/settings/dto/update-user-settings.dto.ts` | modified | +12 / -0 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | settings DTOs and services know the app namespaces |
| `apps/api/src/settings/dto/user-settings-response.dto.ts` | modified | +6 / -0 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | settings DTOs and services know the app namespaces |
| `apps/api/src/settings/settings.permissions.ts` | base-only |  | base ahead (app behind) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | permission declaration the base moved next to its module |
| `apps/api/src/settings/system-settings/system-settings.service.spec.ts` | modified | +114 / -105 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | settings DTOs and services know the app namespaces |
| `apps/api/src/settings/system-settings/system-settings.service.ts` | modified | +58 / -41 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | settings DTOs and services know the app namespaces |
| `apps/api/src/settings/user-settings/user-settings.service.spec.ts` | modified | +88 / -0 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | settings DTOs and services know the app namespaces |
| `apps/api/src/settings/user-settings/user-settings.service.ts` | modified | +81 / -1 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | settings DTOs and services know the app namespaces |
| `apps/api/src/storage/config/storage-config.permissions.ts` | base-only |  | base ahead (app behind) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | permission declaration the base moved next to its module |
| `apps/api/src/storage/storage-key-prefixes.spec.ts` | modified | +15 / -1 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | exports/ and android-releases/ key prefixes: needs a prefix registry |
| `apps/api/src/storage/storage-key-prefixes.ts` | modified | +4 / -0 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | exports/ and android-releases/ key prefixes: needs a prefix registry |
| `apps/api/src/storage/storage.module.ts` | modified | +2 / -1 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | exports/ and android-releases/ key prefixes: needs a prefix registry |
| `apps/api/src/storage/storage.permissions.ts` | base-only |  | base ahead (app behind) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | permission declaration the base moved next to its module |
| `apps/api/src/telemetry/dashboard/__snapshots__/telemetry-dashboard.sql.spec.ts.snap` | modified | +6 / -6 | cosmetic | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | only issue numbers in test names |
| `apps/api/src/telemetry/export/telemetry-export.service.ts` | modified | +1 / -8 | generic improvement (backport candidate) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | imports the shared CSV helper (formula neutralising, BOM) instead of inline copies |
| `apps/api/src/telemetry/telemetry.permissions.ts` | base-only |  | base ahead (app behind) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | permission declaration the base moved next to its module |
| `apps/api/src/users/users.permissions.ts` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | permission declaration the base moved next to its module |

app-only files, grouped by module and classification. Each file is classified in the JSON.

| Module | Files | Classification | Story | Examples |
|---|---|---|---|---|
| `activity` | 18 | domain | - | `activity-entries.controller.ts`, `activity-entries.events.spec.ts`, `activity-entries.service.ts`, ... |
| `admin-factory-reset` | 8 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `admin-factory-reset.constants.ts`, `admin-factory-reset.controller.ts`, `admin-factory-reset.module.ts`, ... |
| `ai` | 17 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | `ai-assignments-admin.controller.ts`, `ai-assignments-admin.service.spec.ts`, `ai-assignments-admin.service.ts`, ... |
| `ai` | 2 | generic improvement (backport candidate) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | `ai-provider-filename.spec.ts`, `ai-provider-filename.ts` |
| `android-app` | 23 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `android-app.controller.ts`, `android-app.module.ts`, `android-app.schema.spec.ts`, ... |
| `auth` | 1 | generic improvement (backport candidate) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | `auth-credential.decorator.ts` |
| `check-ins` | 8 | domain | - | `check-in-date.pipe.ts`, `check-ins.controller.ts`, `check-ins.module.ts`, ... |
| `coach` | 180 | domain | - | `coach-admin-settings.controller.ts`, `coach-admin-stats.controller.ts`, `coach-admin-stats.service.spec.ts`, ... |
| `common` | 1 | domain | - | `training.constants.ts` |
| `common` | 3 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | `coach-settings.schema.spec.ts`, `memory-settings.schema.spec.ts`, `user-ai-settings.schema.spec.ts` |
| `common` | 1 | generic improvement (backport candidate) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | `csv.ts` |
| `email` | 4 | appearance | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | `README.md`, `brand-mark.generated.ts`, `coach-weekly-review.email.spec.ts`, ... |
| `email` | 1 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | `email-template.types.spec.ts` |
| `exercises` | 8 | domain | - | `exercise.dto.ts`, `exercise-availability.service.ts`, `exercise-usage.repository.ts`, ... |
| `gyms` | 41 | domain | - | `capabilities.controller.ts`, `equipment-type.dto.ts`, `fields.ts`, ... |
| `health-documents` | 13 | domain | - | `health-document.dto.spec.ts`, `health-document.dto.ts`, `health-document-purge.handler.spec.ts`, ... |
| `health-export` | 22 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `health-export.dto.spec.ts`, `health-export.dto.ts`, `health-export-purge.handler.spec.ts`, ... |
| `health-profile` | 9 | domain | - | `health-profile.dto.spec.ts`, `health-profile.dto.ts`, `health-profile.controller.spec.ts`, ... |
| `health-summary` | 16 | domain | - | `health-summary.dto.ts`, `health-digest.spec.ts`, `health-digest.ts`, ... |
| `health-sync` | 8 | domain | - | `health-sync.dto.ts`, `health-sync-plan.spec.ts`, `health-sync-plan.ts`, ... |
| `intake` | 18 | domain | - | `README.md`, `intake.dto.ts`, `intake-analyzer.spec.ts`, ... |
| `measurements` | 50 | domain | - | `biomarkers.controller.ts`, `biomarkers.service.spec.ts`, `biomarkers.service.ts`, ... |
| `memory` | 20 | domain | - | `memory.dto.ts`, `memory-extract.handler.spec.ts`, `memory-extract.handler.ts`, ... |
| `notifications` | 7 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | `android-app-push.service.spec.ts`, `android-app-push.service.ts`, `android-app-notification.channel.spec.ts`, ... |
| `onboarding` | 9 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `onboarding-metrics.dto.ts`, `onboarding.dto.ts`, `onboarding-admin.controller.ts`, ... |
| `programs` | 42 | domain | - | `plan-change.contract.ts`, `plan-contracts.spec.ts`, `plan-snapshot.contract.ts`, ... |
| `progress-photos` | 11 | domain | - | `progress-photo.dto.ts`, `progress-photo-events.ts`, `progress-photo-references.spec.ts`, ... |
| `sleep` | 4 | domain | - | `sleep.dto.ts`, `sleep.controller.ts`, `sleep.module.ts`, ... |
| `storage` | 3 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | `storage-status.dto.ts`, `storage-status.controller.spec.ts`, `storage-status.controller.ts` |
| `training-adaptation` | 45 | domain | - | `adaptation.constants.ts`, `adaptation.controller.ts`, `adaptation.service.spec.ts`, ... |
| `training-agents` | 193 | domain | - | `critic-adaptation.prompt.ts`, `critic-tools.ts`, `critic-verdict.contract.ts`, ... |
| `training-usage` | 6 | domain | - | `training-usage.dto.ts`, `training-usage.attribution.spec.ts`, `training-usage.attribution.ts`, ... |
| `user-data` | 9 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `user-data.dto.ts`, `user-data-reset.handler.spec.ts`, `user-data-reset.handler.ts`, ... |
| `workouts` | 29 | domain | - | `body-or-empty.decorator.ts`, `exercise-history.dto.ts`, `quick-cardio.dto.ts`, ... |

### API tests (`apps/api/test`)

Modified and base-only files, one row each.

| File | Status | Lines +/- | Classification | Story | Why |
|---|---|---|---|---|---|
| `apps/api/test/about/about.integration.spec.ts` | modified | +0 / -1 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | follows the base doctor and about |
| `apps/api/test/ai/ai-http.helper.ts` | modified | +32 / -1 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | AI guardrail suites extended with app routes and the orchestration boundary |
| `apps/api/test/ai/ai-kill-switch.integration.spec.ts` | modified | +370 / -27 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | AI guardrail suites extended with app routes and the orchestration boundary |
| `apps/api/test/ai/ai-no-sdk-leak.spec.ts` | modified | +26 / -2 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | AI guardrail suites extended with app routes and the orchestration boundary |
| `apps/api/test/ai/ai-rbac-matrix.integration.spec.ts` | modified | +49 / -6 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | AI guardrail suites extended with app routes and the orchestration boundary |
| `apps/api/test/auth/app-permission-ids.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | test of a base-only capability |
| `apps/api/test/broadcasts/broadcasts.integration.spec.ts` | modified | +17 / -1 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | tests of the app extensions above |
| `apps/api/test/db-backup/db-backup-restore-saas-mode.integration.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | test of a base-only capability |
| `apps/api/test/docs-links.spec.ts` | modified | +21 / -69 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | the base also scans package READMEs |
| `apps/api/test/doctor/doctor.integration.spec.ts` | modified | +0 / -14 | base ahead (app behind) | [PP-10.2](https://github.com/marinoscar/EnterpriseAppBase/issues/717) | follows the base doctor and about |
| `apps/api/test/event-bus/postgres-event-bus.db.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | test of a base-only capability |
| `apps/api/test/fixtures/test-data.factory.ts` | modified | +118 / -0 | domain | - | app test data factories |
| `apps/api/test/helpers/deployment-mode.helper.ts` | base-only |  | base ahead (app behind) | - | test of a base-only capability |
| `apps/api/test/helpers/fake-network-event-bus.helper.ts` | base-only |  | base ahead (app behind) | - | test of a base-only capability |
| `apps/api/test/integration/database-restore-round-trip.db.spec.ts` | modified | +0 / -2 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | follows the base db-backup |
| `apps/api/test/jobs/cron-enqueue-only.spec.ts` | modified | +7 / -0 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | names app crons and routes |
| `apps/api/test/maintenance/maintenance-reachable-set.integration.spec.ts` | modified | +1 / -0 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | names app crons and routes |
| `apps/api/test/nginx-connection-limits.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | test of a base-only capability |
| `apps/api/test/nodes/node-telemetry.integration.spec.ts` | modified | +6 / -2 | generic improvement (backport candidate) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | filters the stuck-job reaper out of the shared mock: removes a flake |
| `apps/api/test/notifications/notification-stream-fanout.integration.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | test of a base-only capability |
| `apps/api/test/notifications/push-channel-registration.integration.spec.ts` | modified | +1 / -1 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | tests of the app extensions above |
| `apps/api/test/notifications/push-subscriptions.integration.spec.ts` | modified | +27 / -0 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | tests of the app extensions above |
| `apps/api/test/openapi/openapi-document.spec.ts` | modified | +44 / -0 | domain extension (needs a seam) | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | asserts the app tags |
| `apps/api/test/prisma/permission-catalog.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.6](https://github.com/marinoscar/EnterpriseAppBase/issues/747) | test of a base-only capability |
| `apps/api/test/prisma/seed-data.spec.ts` | modified | +34 / -0 | domain extension (needs a seam) | [PP-10.6](https://github.com/marinoscar/EnterpriseAppBase/issues/747) | tests of the app extensions above |
| `apps/api/test/retention/retention-handlers.integration.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | test of a base-only capability |
| `apps/api/test/retention/retention-purge.db.spec.ts` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | test of a base-only capability |
| `apps/api/test/settings/system-settings.integration.spec.ts` | modified | +0 / -74 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | tests of the app extensions above |

app-only files, grouped by module and classification. Each file is classified in the JSON.

| Module | Files | Classification | Story | Examples |
|---|---|---|---|---|
| `activity` | 2 | domain | - | `activity.db.spec.ts`, `goals.integration.spec.ts` |
| `admin-factory-reset` | 2 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | `admin-factory-reset.db.spec.ts`, `admin-factory-reset.integration.spec.ts` |
| `ai` | 8 | domain | - | `adaptation-fake-server-contract.spec.ts`, `ai-assignments.integration.spec.ts`, `ai-training-models.integration.spec.ts`, ... |
| `ai` | 1 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | `ai-orchestration-boundary.spec.ts` |
| `android-app` | 4 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | `android-app.integration.spec.ts`, `android-release-nginx.spec.ts`, `android-releases.db.spec.ts`, ... |
| `coach` | 33 | domain | - | `coach-admin-settings.integration.spec.ts`, `coach-admin-stats.db.spec.ts`, `coach-admin-stats.integration.spec.ts`, ... |
| `evals` | 27 | domain | - | `draft-synth.ts`, `judge.ts`, `live-client.ts`, ... |
| `exercises` | 3 | domain | - | `exercise-catalog.spec.ts`, `exercises.db.spec.ts`, `exercises.integration.spec.ts` |
| `fake-responses` | 1 | domain | - | `fake-responses-server.spec.ts` |
| `fixtures` | 79 | domain | - | `bp-cuff.model-output.json`, `load.ts`, `out-of-range.model-output.json`, ... |
| `gyms` | 9 | domain | - | `fake-vision-server.spec.ts`, `gym-catalog.spec.ts`, `gym-equipment-scan.db.spec.ts`, ... |
| `health-data` | 20 | domain | - | `biomarkers-summary.db.spec.ts`, `check-ins.db.spec.ts`, `check-ins.integration.spec.ts`, ... |
| `health-sync` | 3 | domain | - | `health-sync-schema.db.spec.ts`, `health-sync.db.spec.ts`, `health-sync.integration.spec.ts` |
| `intake` | 2 | domain | - | `intakes.db.spec.ts`, `intakes.integration.spec.ts` |
| `memory` | 2 | domain | - | `memory.db.spec.ts`, `memory.integration.spec.ts` |
| `notifications` | 1 | domain extension (needs a seam) | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | `push-subscription-platform.db.spec.ts` |
| `onboarding` | 3 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | `onboarding-metrics.db.spec.ts`, `onboarding-metrics.integration.spec.ts`, `onboarding.integration.spec.ts` |
| `programs` | 8 | domain | - | `program-cardio.db.spec.ts`, `program-sessions.db.spec.ts`, `programs-schema.db.spec.ts`, ... |
| `settings` | 2 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | `coach-settings.integration.spec.ts`, `onboarding-settings.integration.spec.ts` |
| `storage` | 1 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) | `storage-status.integration.spec.ts` |
| `training-adaptation` | 6 | domain | - | `adaptation-apply-edge.db.spec.ts`, `adaptation-apply.db.spec.ts`, `adaptation-canary.db.spec.ts`, ... |
| `training-agents` | 18 | domain | - | `agent-graph-support.ts`, `checkpoint-saver.smoke.db.spec.ts`, `prisma-checkpoint-saver.db.spec.ts`, ... |
| `training-usage` | 1 | domain | - | `training-usage.db.spec.ts` |
| `user-data` | 2 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | `user-data-reset.db.spec.ts`, `user-data.integration.spec.ts` |
| `workouts` | 14 | domain | - | `quick-cardio.db.spec.ts`, `quick-cardio.integration.spec.ts`, `workout-history.db.spec.ts`, ... |

### Web (`apps/web/src`)

Modified and base-only files, one row each.

| File | Status | Lines +/- | Classification | Story | Why |
|---|---|---|---|---|---|
| `apps/web/src/App.tsx` | modified | +294 / -7 | domain | - | app routes, types and mock handlers |
| `apps/web/src/__tests__/App.test.tsx` | modified | +303 / -102 | domain | - | app routes, types and mock handlers |
| `apps/web/src/__tests__/components/admin/BroadcastComposer.test.tsx` | modified | +40 / -2 | domain extension (needs a seam) | app shell (stays) | broadcast audience shows android_app reach; Android admin page |
| `apps/web/src/__tests__/components/ai/AiErrorAlert.test.tsx` | modified | +27 / -0 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | training run budget errors, coach audio autoplay, multi-capability model select |
| `apps/web/src/__tests__/components/ai/AiSpeechPlayer.test.tsx` | modified | +57 / -1 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | training run budget errors, coach audio autoplay, multi-capability model select |
| `apps/web/src/__tests__/components/auth/OAuthButton.test.tsx` | modified | +104 / -0 | appearance | app shell (stays) | branded split sign-in layout and copy |
| `apps/web/src/__tests__/components/auth/signInErrorContent.test.ts` | modified | +31 / -0 | appearance | app shell (stays) | branded split sign-in layout and copy |
| `apps/web/src/__tests__/components/common/Layout.test.tsx` | modified | +10 / -2 | domain extension (needs a seam) | app shell (stays) | shell mounts the Android update banner and the welcome dialog |
| `apps/web/src/__tests__/components/home/QuickActions.test.tsx` | base-only |  | appearance | app shell (stays) | base home page and profile card; the app replaced the home shell with its Today experience |
| `apps/web/src/__tests__/components/navigation/BottomNav.test.tsx` | modified | +69 / -36 | appearance | app shell (stays) | app app shell: rail, bottom nav, prompts, brand mark |
| `apps/web/src/__tests__/components/navigation/NavigationRail.test.tsx` | modified | +55 / -13 | appearance | app shell (stays) | app app shell: rail, bottom nav, prompts, brand mark |
| `apps/web/src/__tests__/components/navigation/UserMenu.test.tsx` | modified | +28 / -5 | appearance | app shell (stays) | app app shell: rail, bottom nav, prompts, brand mark |
| `apps/web/src/__tests__/components/settings/NotificationSettings.test.tsx` | modified | +26 / -3 | domain extension (needs a seam) | app shell (stays) | notification preferences and settings hub for app events |
| `apps/web/src/__tests__/components/settings/SettingsHub.test.tsx` | modified | +21 / -0 | domain extension (needs a seam) | app shell (stays) | notification preferences and settings hub for app events |
| `apps/web/src/__tests__/components/telemetry/TelemetryServicesSection.test.tsx` | modified | +1 / -0 | base ahead (app behind) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | base routes colours through telemetryTokens; the app uses palette roles (and identity strings) |
| `apps/web/src/__tests__/components/telemetry/dashboard/KpiTiles.test.tsx` | modified | +1 / -42 | base ahead (app behind) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | base routes colours through telemetryTokens; the app uses palette roles (and identity strings) |
| `apps/web/src/__tests__/components/telemetry/dashboard/telemetryTokenTheming.test.tsx` | base-only |  | base ahead (app behind) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | test of a base-only web seam |
| `apps/web/src/__tests__/components/user/UserProfileCard.test.tsx` | base-only |  | appearance | app shell (stays) | base home page and profile card; the app replaced the home shell with its Today experience |
| `apps/web/src/__tests__/config/aiSettingsRegistry.test.ts` | modified | +41 / -4 | domain extension (needs a seam) | app shell (stays) | AI settings registry with assignments card |
| `apps/web/src/__tests__/config/destinations.test.ts` | modified | +172 / -12 | domain | - | app navigation destinations and Today cards |
| `apps/web/src/__tests__/config/settingsRegistry.test.ts` | modified | +131 / -14 | domain extension (needs a seam) | app shell (stays) | app cards in the settings registries (registry is the seam) |
| `apps/web/src/__tests__/config/userSettingsSections.test.ts` | modified | +235 / -1 | domain extension (needs a seam) | app shell (stays) | app cards in the settings registries (registry is the seam) |
| `apps/web/src/__tests__/contexts/ThemeContext.test.tsx` | modified | +81 / -0 | appearance | app shell (stays) | app theme: palette, CSS variables, brand tokens |
| `apps/web/src/__tests__/hooks/useDbBackup.test.ts` | modified | +0 / -1 | base ahead (app behind) | app shell (stays) | follows the base DEPLOYMENT_MODE restore availability |
| `apps/web/src/__tests__/mocks/data.ts` | modified | +7 / -0 | domain | - | app routes, types and mock handlers |
| `apps/web/src/__tests__/mocks/handlers.ts` | modified | +315 / -0 | domain | - | app routes, types and mock handlers |
| `apps/web/src/__tests__/pages/Admin/AboutPage.test.tsx` | modified | +4 / -10 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | follows the base DEPLOYMENT_MODE restore availability |
| `apps/web/src/__tests__/pages/Admin/BroadcastsPage.test.tsx` | modified | +7 / -0 | domain extension (needs a seam) | app shell (stays) | broadcast audience shows android_app reach; Android admin page |
| `apps/web/src/__tests__/pages/Admin/DbBackupPage.test.tsx` | modified | +0 / -53 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | follows the base DEPLOYMENT_MODE restore availability |
| `apps/web/src/__tests__/pages/AiPlaygroundPage.test.tsx` | modified | +0 / -25 | domain extension (needs a seam) | app shell (stays) | no per-user default model: models are administrator assignments |
| `apps/web/src/__tests__/pages/AuthCallbackPage.test.tsx` | modified | +12 / -11 | appearance | app shell (stays) | branded split sign-in layout and copy |
| `apps/web/src/__tests__/pages/HomePage.test.tsx` | base-only |  | appearance | app shell (stays) | base home page and profile card; the app replaced the home shell with its Today experience |
| `apps/web/src/__tests__/pages/LoginPage.test.tsx` | modified | +66 / -0 | appearance | app shell (stays) | branded split sign-in layout and copy |
| `apps/web/src/__tests__/pages/UserAiKeysPage.test.tsx` | modified | +0 / -46 | domain extension (needs a seam) | app shell (stays) | no per-user default model: models are administrator assignments |
| `apps/web/src/__tests__/pages/UserAiKeysPage.wire.test.tsx` | modified | +11 / -61 | domain extension (needs a seam) | app shell (stays) | no per-user default model: models are administrator assignments |
| `apps/web/src/__tests__/pages/UserNotificationsPage.test.tsx` | modified | +1 / -1 | domain extension (needs a seam) | app shell (stays) | notification preferences and settings hub for app events |
| `apps/web/src/__tests__/pwa/manifest.test.ts` | modified | +5 / -0 | appearance | app shell (stays) | app app shell: rail, bottom nav, prompts, brand mark |
| `apps/web/src/__tests__/pwa/service-worker.test.ts` | modified | +86 / -1 | appearance | app shell (stays) | app app shell: rail, bottom nav, prompts, brand mark |
| `apps/web/src/__tests__/services/pushSubscription.test.ts` | modified | +83 / -5 | domain extension (needs a seam) | app shell (stays) | Android TWA launch capture and push notification actions |
| `apps/web/src/__tests__/theme/telemetryTokenUsage.test.ts` | base-only |  | base ahead (app behind) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | test of a base-only web seam |
| `apps/web/src/__tests__/theme/telemetryTokens.test.tsx` | base-only |  | base ahead (app behind) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | test of a base-only web seam |
| `apps/web/src/__tests__/utils/apiPermissions.ts` | base-only |  | base ahead (app behind) | app shell (stays) | test of a base-only web seam |
| `apps/web/src/__tests__/utils/hook-utils.tsx` | modified | +2 / -2 | appearance | app shell (stays) | test wrappers follow the app theme export |
| `apps/web/src/__tests__/utils/mock-providers.tsx` | modified | +9 / -4 | appearance | app shell (stays) | test wrappers follow the app theme export |
| `apps/web/src/__tests__/utils/test-utils.tsx` | modified | +23 / -1 | appearance | app shell (stays) | test wrappers follow the app theme export |
| `apps/web/src/components/admin/BroadcastComposer.tsx` | modified | +36 / -9 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) / [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | broadcast audience shows android_app reach; Android admin page |
| `apps/web/src/components/ai/AiErrorAlert.tsx` | modified | +18 / -1 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | training run budget errors, coach audio autoplay, multi-capability model select |
| `apps/web/src/components/ai/AiModelSelect.tsx` | modified | +30 / -8 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | training run budget errors, coach audio autoplay, multi-capability model select |
| `apps/web/src/components/ai/AiSpeechPlayer.tsx` | modified | +68 / -6 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | training run budget errors, coach audio autoplay, multi-capability model select |
| `apps/web/src/components/auth/OAuthButton.tsx` | modified | +14 / -11 | appearance | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | branded split sign-in layout and copy |
| `apps/web/src/components/auth/SignInErrorView.tsx` | modified | +26 / -33 | appearance | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | branded split sign-in layout and copy |
| `apps/web/src/components/auth/signInErrorContent.ts` | modified | +17 / -15 | appearance | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | branded split sign-in layout and copy |
| `apps/web/src/components/common/Layout.tsx` | modified | +6 / -0 | domain extension (needs a seam) | app shell (stays) | shell mounts the Android update banner and the welcome dialog |
| `apps/web/src/components/datatable/BulkActionBar.tsx` | modified | +3 / -2 | appearance | platform-web (PP-10.8 to PP-10.11) | selection tint derived from the palette; CSS-variable spacing in tests |
| `apps/web/src/components/datatable/__tests__/DataTableContrast.test.tsx` | modified | +14 / -11 | appearance | platform-web (PP-10.8 to PP-10.11) | selection tint derived from the palette; CSS-variable spacing in tests |
| `apps/web/src/components/datatable/__tests__/DataTableLayoutPrefs.test.tsx` | modified | +2 / -3 | appearance | platform-web (PP-10.8 to PP-10.11) | selection tint derived from the palette; CSS-variable spacing in tests |
| `apps/web/src/components/datatable/__tests__/conformance/runDataTableConformanceSuite.tsx` | modified | +2 / -2 | appearance | platform-web (PP-10.8 to PP-10.11) | selection tint derived from the palette; CSS-variable spacing in tests |
| `apps/web/src/components/datatable/desktop/RowActionsCell.tsx` | modified | +10 / -5 | generic improvement (backport candidate) | platform-web (PP-10.8 to PP-10.11) | DataTableRowAction.disabledReason |
| `apps/web/src/components/datatable/mobile/DataCard.tsx` | modified | +3 / -2 | appearance | platform-web (PP-10.8 to PP-10.11) | selection tint derived from the palette; CSS-variable spacing in tests |
| `apps/web/src/components/datatable/types.ts` | modified | +1 / -0 | generic improvement (backport candidate) | platform-web (PP-10.8 to PP-10.11) | DataTableRowAction.disabledReason |
| `apps/web/src/components/home/QuickActions.tsx` | base-only |  | appearance | app shell (stays) | base home page and profile card; the app replaced the home shell with its Today experience |
| `apps/web/src/components/navigation/AppBar.tsx` | modified | +13 / -2 | appearance | app shell (stays) | app app shell: rail, bottom nav, prompts, brand mark |
| `apps/web/src/components/navigation/BottomNav.tsx` | modified | +24 / -6 | appearance | app shell (stays) | app app shell: rail, bottom nav, prompts, brand mark |
| `apps/web/src/components/navigation/NavigationRail.tsx` | modified | +28 / -4 | appearance | app shell (stays) | app app shell: rail, bottom nav, prompts, brand mark |
| `apps/web/src/components/navigation/UserMenu.tsx` | modified | +22 / -3 | appearance | app shell (stays) | app app shell: rail, bottom nav, prompts, brand mark |
| `apps/web/src/components/pwa/InstallPrompt.tsx` | modified | +2 / -1 | appearance | app shell (stays) | app app shell: rail, bottom nav, prompts, brand mark |
| `apps/web/src/components/pwa/UpdatePrompt.tsx` | modified | +4 / -1 | appearance | app shell (stays) | app app shell: rail, bottom nav, prompts, brand mark |
| `apps/web/src/components/settings/NotificationSettings.tsx` | modified | +8 / -8 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) / [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | notification preferences and settings hub for app events |
| `apps/web/src/components/settings/ProfileSettings.tsx` | modified | +7 / -1 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) / [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | storage-not-configured notice paired with GET /api/storage/status |
| `apps/web/src/components/settings/ai/DefaultAiModelPicker.tsx` | base-only |  | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | per-user default model picker; the app removed it when models became administrator assignments |
| `apps/web/src/components/settings/ai/aiErrorText.ts` | modified | +14 / -2 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | training run budget errors, coach audio autoplay, multi-capability model select |
| `apps/web/src/components/telemetry/dashboard/ApiTimelineChart.tsx` | modified | +6 / -6 | base ahead (app behind) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | base routes colours through telemetryTokens; the app uses palette roles (and identity strings) |
| `apps/web/src/components/telemetry/dashboard/KpiTiles.tsx` | modified | +10 / -13 | base ahead (app behind) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | base routes colours through telemetryTokens; the app uses palette roles (and identity strings) |
| `apps/web/src/components/telemetry/dashboard/LogSeverityChart.tsx` | modified | +6 / -7 | base ahead (app behind) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | base routes colours through telemetryTokens; the app uses palette roles (and identity strings) |
| `apps/web/src/components/telemetry/dashboard/TopProblems.tsx` | modified | +4 / -7 | base ahead (app behind) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | base routes colours through telemetryTokens; the app uses palette roles (and identity strings) |
| `apps/web/src/components/telemetry/dashboard/UnknownRoutesPanel.tsx` | modified | +1 / -3 | base ahead (app behind) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | base routes colours through telemetryTokens; the app uses palette roles (and identity strings) |
| `apps/web/src/components/telemetry/dashboard/metrics/MetricSections.tsx` | modified | +5 / -6 | base ahead (app behind) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | base routes colours through telemetryTokens; the app uses palette roles (and identity strings) |
| `apps/web/src/components/telemetry/dashboard/metrics/MetricSeriesChart.tsx` | modified | +2 / -3 | base ahead (app behind) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | base routes colours through telemetryTokens; the app uses palette roles (and identity strings) |
| `apps/web/src/components/telemetry/dashboard/metrics/MetricTable.tsx` | modified | +1 / -3 | base ahead (app behind) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | base routes colours through telemetryTokens; the app uses palette roles (and identity strings) |
| `apps/web/src/components/user/UserProfileCard.tsx` | base-only |  | appearance | app shell (stays) | base home page and profile card; the app replaced the home shell with its Today experience |
| `apps/web/src/config/adminSections.tsx` | modified | +54 / -64 | domain extension (needs a seam) | app shell (stays) | app cards in the settings registries (registry is the seam) |
| `apps/web/src/config/destinations.ts` | modified | +74 / -8 | domain | - | app navigation destinations and Today cards |
| `apps/web/src/config/userSettingsSections.tsx` | modified | +86 / -0 | domain extension (needs a seam) | app shell (stays) | app cards in the settings registries (registry is the seam) |
| `apps/web/src/contexts/AuthContext.tsx` | modified | +12 / -0 | generic improvement (backport candidate) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | sessionExpired state and the cross-tab refresh Web Lock (issue 295) |
| `apps/web/src/contexts/ThemeContext.tsx` | modified | +64 / -37 | appearance | app shell (stays) | app theme: palette, CSS variables, brand tokens |
| `apps/web/src/main.tsx` | modified | +2 / -0 | domain extension (needs a seam) | app shell (stays) | Android TWA launch capture and push notification actions |
| `apps/web/src/pages/Admin/AboutPage.tsx` | modified | +0 / -4 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | follows the base DEPLOYMENT_MODE restore availability |
| `apps/web/src/pages/Admin/BroadcastsPage.tsx` | modified | +12 / -2 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) / [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | broadcast audience shows android_app reach; Android admin page |
| `apps/web/src/pages/Admin/DbBackupPage.tsx` | modified | +1 / -13 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | follows the base DEPLOYMENT_MODE restore availability |
| `apps/web/src/pages/Admin/TelemetrySettingsPage.tsx` | modified | +1 / -2 | base ahead (app behind) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | base routes colours through telemetryTokens; the app uses palette roles (and identity strings) |
| `apps/web/src/pages/Admin/broadcastsTable.tsx` | modified | +1 / -0 | domain extension (needs a seam) | platform-web (PP-10.8 to PP-10.11) | broadcast audience shows android_app reach; Android admin page |
| `apps/web/src/pages/AiPlaygroundPage.tsx` | modified | +7 / -11 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | no per-user default model: models are administrator assignments |
| `apps/web/src/pages/HomePage.tsx` | base-only |  | appearance | platform-web (PP-10.8 to PP-10.11) | base home page and profile card; the app replaced the home shell with its Today experience |
| `apps/web/src/pages/LoginPage.tsx` | modified | +11 / -33 | appearance | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | branded split sign-in layout and copy |
| `apps/web/src/pages/UserAiKeysPage.tsx` | modified | +2 / -16 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | no per-user default model: models are administrator assignments |
| `apps/web/src/services/aiErrors.ts` | modified | +14 / -2 | domain extension (needs a seam) | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) | training run budget errors, coach audio autoplay, multi-capability model select |
| `apps/web/src/services/api.ts` | modified | +37 / -2 | generic improvement (backport candidate) | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | sessionExpired state and the cross-tab refresh Web Lock (issue 295) |
| `apps/web/src/services/broadcasts.ts` | modified | +3 / -1 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) / [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | broadcast audience shows android_app reach; Android admin page |
| `apps/web/src/services/dbBackup.ts` | modified | +1 / -7 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | follows the base DEPLOYMENT_MODE restore availability |
| `apps/web/src/services/pushSubscription.ts` | modified | +37 / -2 | domain extension (needs a seam) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) / [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | Android TWA launch capture and push notification actions |
| `apps/web/src/services/storage.ts` | modified | +7 / -0 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) / [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | storage status client |
| `apps/web/src/sw.ts` | modified | +46 / -6 | domain extension (needs a seam) | app shell (stays) | Android TWA launch capture and push notification actions |
| `apps/web/src/theme/augment.ts` | modified | +46 / -8 | appearance | app shell (stays) | app theme: palette, CSS variables, brand tokens |
| `apps/web/src/theme/components.ts` | modified | +77 / -13 | appearance | app shell (stays) | app theme: palette, CSS variables, brand tokens |
| `apps/web/src/theme/dark.ts` | modified | +32 / -14 | appearance | app shell (stays) | app theme: palette, CSS variables, brand tokens |
| `apps/web/src/theme/index.ts` | modified | +16 / -24 | appearance | app shell (stays) | app theme: palette, CSS variables, brand tokens |
| `apps/web/src/theme/light.ts` | modified | +31 / -13 | appearance | app shell (stays) | app theme: palette, CSS variables, brand tokens |
| `apps/web/src/theme/telemetryTokens.ts` | base-only |  | base ahead (app behind) | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) | telemetry token set the base provides; the app uses MUI palette roles |
| `apps/web/src/types/index.ts` | modified | +123 / -7 | domain | - | app routes, types and mock handlers |

app-only files, grouped by module and classification. Each file is classified in the JSON.

| Module | Files | Classification | Story | Examples |
|---|---|---|---|---|
| `__tests__` | 4 | appearance | app shell (stays) | `AuthBrandLayout.test.tsx`, `SignInErrorView.test.tsx`, `UserMenuGettingStarted.test.tsx`, ... |
| `__tests__` | 244 | domain | - | `AdaptRoutes.test.tsx`, `PlanRoutes.test.tsx`, `ProgressPhotoRoutes.test.tsx`, ... |
| `__tests__` | 10 | domain extension (needs a seam) | app shell (stays) | `AndroidUpdateBanner.test.tsx`, `BrandMark.test.tsx`, `ComingInChip.test.tsx`, ... |
| `__tests__` | 2 | generic improvement (backport candidate) | app shell (stays) | `AuthContext.sessionExpired.test.tsx`, `useStorageStatus.test.tsx` |
| `components/admin` | 2 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `AndroidNotificationsSection.tsx`, `AndroidReleasesSection.tsx` |
| `components/auth` | 1 | appearance | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) | `AuthBrandLayout.tsx` |
| `components/coach` | 15 | domain | - | `CoachComposer.tsx`, `CoachEngagementPanel.tsx`, `CoachHeader.tsx`, ... |
| `components/common` | 5 | appearance | app shell (stays) | `BrandMark.tsx`, `ComingInChip.tsx`, `EmptyState.tsx`, ... |
| `components/common` | 1 | domain | - | `MarkdownText.tsx` |
| `components/common` | 1 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `AndroidUpdateBanner.tsx` |
| `components/common` | 1 | generic improvement (backport candidate) | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) / [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) | `FeatureUnavailableNotice.tsx` |
| `components/datatable` | 1 | generic improvement (backport candidate) | platform-web (PP-10.8 to PP-10.11) | `RowActionsCell.test.tsx` |
| `components/goals` | 5 | domain | - | `CheckInSheet.tsx`, `GoalFormDialog.tsx`, `GoalHistory.tsx`, ... |
| `components/gyms` | 24 | domain | - | `ConfirmDialog.tsx`, `CustomEquipmentForm.tsx`, `EquipmentDraftEditor.tsx`, ... |
| `components/health` | 28 | domain | - | `CheckInDialog.tsx`, `CheckInSection.tsx`, `CheckInSummary.tsx`, ... |
| `components/intake` | 10 | domain | - | `AiDraftReview.tsx`, `AiVisionDisclosure.tsx`, `ConfidenceBadge.tsx`, ... |
| `components/onboarding` | 3 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `ActivationMetrics.tsx`, `OnboardingChecklist.tsx`, `WelcomeDialog.tsx` |
| `components/progress` | 7 | domain | - | `AddProgressPhotoDialog.tsx`, `CompareProgressPhotosDialog.tsx`, `DeleteProgressPhotoDialog.tsx`, ... |
| `components/pwa` | 1 | appearance | app shell (stays) | `PromptMessage.tsx` |
| `components/settings` | 16 | domain | - | `HealthProfileSettings.tsx`, `MonthlyAgentUsageSection.tsx`, `DownloadApkButton.tsx`, ... |
| `components/today` | 10 | domain | - | `CoachHero.tsx`, `QuickCardioSheet.tsx`, `TodayBodySnapshot.tsx`, ... |
| `components/train` | 19 | domain | - | `CustomExerciseDialog.tsx`, `EditWorkoutDialog.tsx`, `ExerciseDraftEditor.tsx`, ... |
| `components/training` | 64 | domain | - | `ActivatePlanDialog.tsx`, `AdherenceChart.tsx`, `AgentModelCard.tsx`, ... |
| `config` | 2 | domain | - | `roadmap.ts`, `todayCards.tsx` |
| `config` | 1 | domain extension (needs a seam) | app shell (stays) | `settingsRegistry.ts` |
| `contexts` | 1 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `OnboardingContext.tsx` |
| `hooks` | 59 | domain | - | `useAdaptation.ts`, `useAgentModels.ts`, `useAgentUsage.ts`, ... |
| `hooks` | 3 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `useFactoryReset.ts`, `useOnboarding.ts`, `useOnboardingMetrics.ts` |
| `hooks` | 1 | generic improvement (backport candidate) | platform-web (PP-10.8 to PP-10.11) | `useStorageStatus.ts` |
| `pages` | 24 | domain | - | `AdaptationReviewPage.tsx`, `AndroidAppDownloadPage.tsx`, `BiomarkerDetailPage.tsx`, ... |
| `pages/Admin` | 2 | domain | - | `AiAssignmentsPage.tsx`, `CoachAdminPage.tsx` |
| `pages/Admin` | 3 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `AndroidAppPage.tsx`, `FactoryResetPage.tsx`, `SetupGuidePage.tsx` |
| `pages/Train` | 6 | domain | - | `GoalsPage.tsx`, `PlanHistoryPage.tsx`, `PlanRunPage.tsx`, ... |
| `services` | 26 | domain | - | `aiAssignments.ts`, `biomarkers.ts`, `coach.ts`, ... |
| `theme` | 2 | appearance | app shell (stays) | `chartPalette.ts`, `tokens.ts` |
| `utils` | 16 | domain | - | `androidIdentity.ts`, `biomarkers.ts`, `downscaleImage.ts`, ... |
| `utils` | 1 | domain extension (needs a seam) | platform-web (PP-10.8 to PP-10.11) | `twa.ts` |

### CLI (`apps/cli/src`)

Modified and base-only files, one row each.

| File | Status | Lines +/- | Classification | Story | Why |
|---|---|---|---|---|---|
| `apps/cli/src/__fixtures__/package-docs/passing/apps/api/src/demo-registry.example.txt` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | fixture of the base package-docs checker |
| `apps/cli/src/__fixtures__/package-docs/passing/apps/web/src/widget-slot.example.txt` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | fixture of the base package-docs checker |
| `apps/cli/src/__fixtures__/package-docs/passing/packages/platform-demo/README.md` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | fixture of the base package-docs checker |
| `apps/cli/src/__fixtures__/package-docs/passing/packages/platform-demo/docs-api/api.json` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | fixture of the base package-docs checker |
| `apps/cli/src/__fixtures__/package-docs/passing/packages/platform-demo/package.json` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | fixture of the base package-docs checker |
| `apps/cli/src/__fixtures__/package-docs/passing/packages/platform-demo/src/index.ts` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | fixture of the base package-docs checker |
| `apps/cli/src/__fixtures__/package-docs/passing/packages/platform-demo/src/widgets/README.md` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | fixture of the base package-docs checker |
| `apps/cli/src/__fixtures__/package-docs/passing/packages/platform-demo/src/widgets/index.ts` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | fixture of the base package-docs checker |
| `apps/cli/src/__fixtures__/package-docs/passing/packages/platform-demo/tsconfig.json` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | fixture of the base package-docs checker |
| `apps/cli/src/__fixtures__/package-docs/passing/packages/platform-demo/typedoc.json` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | fixture of the base package-docs checker |
| `apps/cli/src/api-client.ts` | modified | +7 / -0 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android command, deploy android step, multipart upload |
| `apps/cli/src/commands/deploy.ts` | modified | +93 / -4 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android command, deploy android step, multipart upload |
| `apps/cli/src/deploy/app-version.test.ts` | modified | +11 / -8 | generic improvement (backport candidate) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | reconciles edge config on update; keeps apps/cli out of version lockstep |
| `apps/cli/src/deploy/app-version.ts` | modified | +0 / -1 | generic improvement (backport candidate) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | reconciles edge config on update; keeps apps/cli out of version lockstep |
| `apps/cli/src/deploy/checks/tls.test.ts` | modified | +3 / -3 | identity | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | evopathcli / app identity strings and CLI_NAME |
| `apps/cli/src/deploy/deploy-info.ts` | modified | +2 / -1 | identity | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | evopathcli / app identity strings and CLI_NAME |
| `apps/cli/src/deploy/env-metadata.ts` | modified | +0 / -6 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | base env-spec and proxy-bootstrap helpers |
| `apps/cli/src/deploy/env-spec.test.ts` | modified | +0 / -40 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | base env-spec and proxy-bootstrap helpers |
| `apps/cli/src/deploy/install.test.ts` | modified | +10 / -13 | identity | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | evopathcli / app identity strings and CLI_NAME |
| `apps/cli/src/deploy/journal.ts` | modified | +3 / -2 | identity | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | evopathcli / app identity strings and CLI_NAME |
| `apps/cli/src/deploy/proxy-bootstrap.test.ts` | modified | +0 / -57 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | base env-spec and proxy-bootstrap helpers |
| `apps/cli/src/deploy/proxy-bootstrap.ts` | modified | +0 / -48 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | base env-spec and proxy-bootstrap helpers |
| `apps/cli/src/deploy/proxy.test.ts` | modified | +67 / -0 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | APK upload body limit at the edge (plus an issue number) |
| `apps/cli/src/deploy/proxy.ts` | modified | +79 / -1 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | APK upload body limit at the edge (plus an issue number) |
| `apps/cli/src/deploy/update.test.ts` | modified | +109 / -0 | generic improvement (backport candidate) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | reconciles edge config on update; keeps apps/cli out of version lockstep |
| `apps/cli/src/deploy/update.ts` | modified | +47 / -4 | generic improvement (backport candidate) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | reconciles edge config on update; keeps apps/cli out of version lockstep |
| `apps/cli/src/deploy/version-step.ts` | modified | +3 / -2 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android step threaded through deploy |
| `apps/cli/src/new-project-script.test.ts` | modified | +1 / -56 | identity | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | evopathcli / app identity strings and CLI_NAME |
| `apps/cli/src/node/worker-env.test.ts` | modified | +2 / -2 | identity | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | evopathcli / app identity strings and CLI_NAME |
| `apps/cli/src/package-docs-script.test.ts` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | maintainer tooling test; not part of an app |
| `apps/cli/src/platform-drift-script.test.ts` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | maintainer tooling test; not part of an app |
| `apps/cli/src/program.ts` | modified | +2 / -0 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android command, deploy android step, multipart upload |
| `apps/cli/src/rename-script.test.ts` | modified | +38 / -24 | identity | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | evopathcli / app identity strings and CLI_NAME |
| `apps/cli/src/shared-identity.test.ts` | modified | +33 / -1 | identity | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | evopathcli / app identity strings and CLI_NAME |
| `apps/cli/src/template-identity.test.ts` | modified | +17 / -7 | identity | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | evopathcli / app identity strings and CLI_NAME |
| `apps/cli/src/tui/app.tsx` | modified | +13 / -1 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android command, deploy android step, multipart upload |
| `apps/cli/src/tui/layout.tsx` | modified | +3 / -1 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android command, deploy android step, multipart upload |
| `apps/cli/src/tui/routes.ts` | modified | +1 / -1 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android command, deploy android step, multipart upload |
| `apps/cli/src/tui/screens/deploy/fields.tsx` | modified | +9 / -3 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android command, deploy android step, multipart upload |
| `apps/cli/src/tui/screens/deploy/flags-model.test.ts` | modified | +24 / -1 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android command, deploy android step, multipart upload |
| `apps/cli/src/tui/screens/deploy/flags-model.ts` | modified | +23 / -0 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android command, deploy android step, multipart upload |
| `apps/cli/src/tui/screens/deploy/install.tsx` | modified | +40 / -7 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android command, deploy android step, multipart upload |
| `apps/cli/src/tui/screens/deploy/model.ts` | modified | +5 / -0 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android command, deploy android step, multipart upload |
| `apps/cli/src/tui/screens/deploy/run-model.test.ts` | modified | +9 / -0 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android command, deploy android step, multipart upload |
| `apps/cli/src/tui/screens/deploy/run-model.ts` | modified | +4 / -1 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android command, deploy android step, multipart upload |
| `apps/cli/src/tui/screens/deploy/update.test.ts` | modified | +40 / -0 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android command, deploy android step, multipart upload |
| `apps/cli/src/tui/screens/deploy/update.tsx` | modified | +39 / -6 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android command, deploy android step, multipart upload |
| `apps/cli/src/tui/screens/menu.tsx` | modified | +5 / -0 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | android command, deploy android step, multipart upload |

app-only files, grouped by module and classification. Each file is classified in the JSON.

| Module | Files | Classification | Story | Examples |
|---|---|---|---|---|
| `android` | 34 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `build.test.ts`, `build.ts`, `doctor.test.ts`, ... |
| `commands` | 3 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `android.test.ts`, `android.ts`, `deploy-android.test.ts` |
| `deploy` | 2 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `android-step.test.ts`, `android-step.ts` |
| `deploy` | 4 | generic improvement (backport candidate) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | `edge-config.test.ts`, `edge-config.ts`, `preferences.test.ts`, ... |
| `tui` | 10 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `android.test.tsx`, `android.tsx`, `model.test.ts`, ... |

### Prisma (`apps/api/prisma`)

Modified and base-only files, one row each.

| File | Status | Lines +/- | Classification | Story | Why |
|---|---|---|---|---|---|
| `apps/api/prisma/catalog/permissions.json` | base-only |  | base ahead (app behind) | [PP-10.6](https://github.com/marinoscar/EnterpriseAppBase/issues/747) | generated permission catalog |
| `apps/api/prisma/migrations/20260928100000_add_worker_node_vitals/migration.sql` | base-only |  | cosmetic | [PP-10.6](https://github.com/marinoscar/EnterpriseAppBase/issues/747) | same SQL as 20260930100000_add_worker_node_vitals in the app under a different id |
| `apps/api/prisma/migrations/20261006120000_add_retention_created_at_indexes/migration.sql` | base-only |  | base ahead (app behind) | [PP-10.6](https://github.com/marinoscar/EnterpriseAppBase/issues/747) | retention index migration the base added after the app forked this slice |
| `apps/api/prisma/schema.prisma` | modified | +1016 / -32 | domain | [PP-10.6](https://github.com/marinoscar/EnterpriseAppBase/issues/747) | 46 app models and their seed data; the base models are intact |
| `apps/api/prisma/seed-data.ts` | modified | +790 / -20 | domain | [PP-10.6](https://github.com/marinoscar/EnterpriseAppBase/issues/747) | 46 app models and their seed data; the base models are intact |
| `apps/api/prisma/seed.ts` | modified | +142 / -0 | domain | [PP-10.6](https://github.com/marinoscar/EnterpriseAppBase/issues/747) | 46 app models and their seed data; the base models are intact |

app-only files, grouped by module and classification. Each file is classified in the JSON.

| Module | Files | Classification | Story | Examples |
|---|---|---|---|---|
| `migrations` | 31 | domain | [PP-10.6](https://github.com/marinoscar/EnterpriseAppBase/issues/747) | `migration.sql`, `migration.sql`, `migration.sql`, ... |

### Infra (`infra`)

Modified and base-only files, one row each.

| File | Status | Lines +/- | Classification | Story | Why |
|---|---|---|---|---|---|
| `infra/compose/.env.example` | modified | +0 / -2 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | nginx nofile ulimit and the DEPLOYMENT_MODE section |
| `infra/compose/base.compose.yml` | modified | +0 / -8 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | nginx nofile ulimit and the DEPLOYMENT_MODE section |
| `infra/nginx/nginx.conf` | modified | +78 / -4 | domain extension (needs a seam) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | adds SSE locations, APK upload, download and assetlinks, geolocation=(self); the base raises worker_connections and nofile (base ahead) |

app-only files, grouped by module and classification. Each file is classified in the JSON.

| Module | Files | Classification | Story | Examples |
|---|---|---|---|---|
| `compose` | 1 | domain | - | `fake-ai.compose.yml` |

### Android (`apps/android`)

app-only files, grouped by module and classification. Each file is classified in the JSON.

| Module | Files | Classification | Story | Examples |
|---|---|---|---|---|
| `(root)` | 8 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `.gitignore`, `README.md`, `build.gradle.kts`, ... |
| `app` | 97 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `build.gradle.kts`, `proguard-rules.pro`, `AndroidManifest.xml`, ... |
| `gradle` | 3 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `libs.versions.toml`, `gradle-wrapper.jar`, `gradle-wrapper.properties` |
| `scripts` | 1 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `build-meta.sh` |

### Packages (`packages`)

Modified and base-only files, one row each.

| File | Status | Lines +/- | Classification | Story | Why |
|---|---|---|---|---|---|
| `packages/platform-api/.gitignore` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-api/README.md` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-api/package.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-api/src/index.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-api/test/boundaries.spec.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-api/test/index.spec.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-api/test/jest.config.js` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-api/test/slice-graph.spec.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-api/test/support/run-eslint.mjs` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-api/test/tsdoc-lint.spec.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-api/tsconfig.build.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-api/tsconfig.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-api/typedoc.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-cli/.gitignore` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-cli/README.md` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-cli/package.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-cli/src/index.test.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-cli/src/index.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-cli/tsconfig.build.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-cli/tsconfig.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-cli/typedoc.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-cli/vitest.config.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-contract/.gitignore` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-contract/README.md` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-contract/package.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-contract/scripts/dev.mjs` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-contract/scripts/write-dist-stubs.mjs` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-contract/src/index.test.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-contract/src/index.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-contract/tsconfig.build.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-contract/tsconfig.cjs.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-contract/tsconfig.esm.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-contract/tsconfig.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-contract/typedoc.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-contract/vitest.config.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-db/.gitignore` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-db/README.md` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-db/migrations/.gitkeep` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-db/package.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-db/schema/.gitkeep` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-db/src/index.test.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-db/src/index.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-db/tsconfig.build.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-db/tsconfig.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-db/typedoc.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-db/vitest.config.mts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-infra/.gitignore` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-infra/README.md` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-infra/compose/.gitkeep` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-infra/nginx/.gitkeep` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-infra/otel/.gitkeep` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-infra/package.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-infra/src/index.test.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-infra/src/index.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-infra/tsconfig.build.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-infra/tsconfig.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-infra/typedoc.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-infra/vitest.config.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-slices.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-web/.gitignore` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-web/README.md` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-web/package.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-web/src/index.test.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-web/src/index.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-web/tsconfig.build.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-web/tsconfig.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-web/typedoc.json` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/platform-web/vitest.config.ts` | base-only |  | base ahead (app behind) | platform packages | platform package source: the target of adoption, not an app file |
| `packages/shared/README.md` | modified | +41 / -8 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | platform package source: the target of adoption, not an app file |
| `packages/shared/identity.json` | modified | +3 / -2 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | platform package source: the target of adoption, not an app file |
| `packages/shared/index.d.ts` | modified | +5 / -0 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | platform package source: the target of adoption, not an app file |
| `packages/shared/index.js` | modified | +11 / -0 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | platform package source: the target of adoption, not an app file |
| `packages/shared/package.json` | modified | +1 / -1 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | platform package source: the target of adoption, not an app file |

### Scripts (`scripts`)

Modified and base-only files, one row each.

| File | Status | Lines +/- | Classification | Story | Why |
|---|---|---|---|---|---|
| `scripts/check-package-docs.mjs` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | base maintainer tooling; an app does not carry it |
| `scripts/check-package-pack.mjs` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | base maintainer tooling; an app does not carry it |
| `scripts/dev-packages.mjs` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | base maintainer tooling; an app does not carry it |
| `scripts/new-project.mjs` | modified | +10 / -57 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | base script is longer; the app lacks later changes |
| `scripts/platform-drift.mjs` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | base maintainer tooling; an app does not carry it |
| `scripts/rename.mjs` | modified | +21 / -12 | appearance | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | adds --accent for the brand mark sun |

### GitHub (`.github`)

Modified and base-only files, one row each.

| File | Status | Lines +/- | Classification | Story | Why |
|---|---|---|---|---|---|
| `.github/CODEOWNERS` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | base release and governance file; the seam request template is how the app requests a seam |
| `.github/ISSUE_TEMPLATE/seam_request.yml` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | base release and governance file; the seam request template is how the app requests a seam |
| `.github/workflows/ci.yml` | modified | +0 / -7 | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | base builds packages in CI |
| `.github/workflows/packages.yml` | base-only |  | base ahead (app behind) | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) | base release and governance file; the seam request template is how the app requests a seam |

app-only files, grouped by module and classification. Each file is classified in the JSON.

| Module | Files | Classification | Story | Examples |
|---|---|---|---|---|
| `workflows` | 1 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) | `android.yml` |

## Part 3: Module to adopting story

Platform modules (those with at least one file in the base). "Copies" is the byte-identical plus cosmetic-only file count: those files are deleted when the story adopts the slice. "Real" is the modified count, each row of which is classified in Part 2.

| Area | Module | Copies | Real | Base-only | app-only | Adopting story |
|---|---|---|---|---|---|---|
| api | `(root)` | 1 | 2 | 0 | 0 | - |
| api | `about` | 5 | 3 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `ai` | 222 | 17 | 3 | 19 | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) |
| api | `allowlist` | 9 | 0 | 1 | 0 | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) |
| api | `app-registrations` | 0 | 0 | 2 | 0 | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) |
| api | `auth` | 35 | 3 | 0 | 1 | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) |
| api | `common/(files directly under common)` | 2 | 1 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/constants` | 0 | 1 | 0 | 1 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/cors` | 2 | 0 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/crypto` | 1 | 2 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/decorators` | 2 | 0 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/deployment` | 0 | 0 | 7 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/dto` | 0 | 1 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/event-bus` | 0 | 0 | 13 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/exceptions` | 2 | 0 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/export` | 0 | 0 | 0 | 1 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/filters` | 0 | 2 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/interceptors` | 4 | 0 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/logger` | 4 | 0 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/maintenance` | 14 | 0 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/middleware` | 2 | 0 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/otel` | 9 | 2 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/permissions` | 0 | 0 | 9 | 0 | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) |
| api | `common/principal` | 0 | 0 | 3 | 0 | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) |
| api | `common/profile-image` | 2 | 0 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/registry` | 0 | 0 | 7 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/retention` | 0 | 0 | 7 | 0 | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) |
| api | `common/schemas` | 1 | 3 | 0 | 3 | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) |
| api | `common/services` | 2 | 0 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `common/types` | 0 | 1 | 0 | 0 | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) |
| api | `config` | 0 | 2 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `credentials` | 7 | 0 | 0 | 0 | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) |
| api | `db-backup` | 42 | 9 | 1 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| api | `device-auth` | 18 | 0 | 0 | 0 | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) |
| api | `doctor` | 7 | 2 | 0 | 0 | [PP-10.2](https://github.com/marinoscar/EnterpriseAppBase/issues/717) |
| api | `email` | 21 | 23 | 0 | 5 | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) |
| api | `health` | 9 | 0 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `jobs` | 64 | 6 | 2 | 0 | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) |
| api | `nodes` | 49 | 0 | 1 | 0 | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) |
| api | `notifications` | 48 | 24 | 6 | 7 | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) |
| api | `openapi` | 15 | 1 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `pat` | 6 | 2 | 0 | 0 | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) |
| api | `prisma` | 3 | 0 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `settings` | 14 | 9 | 1 | 0 | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) |
| api | `storage` | 58 | 3 | 2 | 3 | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) |
| api | `telemetry` | 90 | 2 | 1 | 0 | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) |
| api | `test-auth` | 7 | 0 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api | `user-credentials` | 8 | 0 | 0 | 0 | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) |
| api | `users` | 11 | 0 | 1 | 0 | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) |
| api-test | `(root)` | 10 | 1 | 1 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| api-test | `about` | 1 | 1 | 0 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| api-test | `ai` | 20 | 4 | 0 | 9 | - |
| api-test | `auth` | 4 | 0 | 1 | 0 | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) |
| api-test | `broadcasts` | 2 | 1 | 0 | 0 | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) |
| api-test | `db-backup` | 3 | 0 | 1 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| api-test | `device-auth` | 1 | 0 | 0 | 0 | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) |
| api-test | `doctor` | 0 | 1 | 0 | 0 | [PP-10.2](https://github.com/marinoscar/EnterpriseAppBase/issues/717) |
| api-test | `errors` | 1 | 0 | 0 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| api-test | `event-bus` | 0 | 0 | 1 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| api-test | `fixtures` | 5 | 1 | 0 | 79 | - |
| api-test | `health` | 1 | 0 | 0 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| api-test | `helpers` | 7 | 0 | 2 | 0 | - |
| api-test | `integration` | 5 | 1 | 0 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| api-test | `jobs` | 14 | 1 | 0 | 0 | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) |
| api-test | `maintenance` | 1 | 1 | 0 | 0 | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) |
| api-test | `mocks` | 5 | 0 | 0 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| api-test | `nodes` | 12 | 1 | 0 | 0 | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) |
| api-test | `notifications` | 2 | 2 | 1 | 1 | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) |
| api-test | `openapi` | 2 | 1 | 0 | 0 | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| api-test | `prisma` | 0 | 1 | 1 | 0 | [PP-10.6](https://github.com/marinoscar/EnterpriseAppBase/issues/747) |
| api-test | `rbac` | 2 | 0 | 0 | 0 | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) |
| api-test | `retention` | 0 | 0 | 2 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| api-test | `settings` | 6 | 1 | 0 | 2 | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) |
| api-test | `storage` | 2 | 0 | 0 | 1 | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) |
| api-test | `telemetry` | 4 | 0 | 0 | 0 | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) |
| api-test | `test-auth` | 1 | 0 | 0 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| api-test | `user-credentials` | 1 | 0 | 0 | 0 | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) |
| api-test | `users` | 1 | 0 | 0 | 0 | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) |
| web | `(root)` | 1 | 3 | 0 | 0 | app shell (stays) |
| web | `__tests__` | 161 | 37 | 7 | 260 | - |
| web | `components/admin` | 21 | 1 | 0 | 2 | app shell (stays) |
| web | `components/ai` | 32 | 3 | 0 | 0 | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) |
| web | `components/auth` | 0 | 3 | 0 | 1 | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) |
| web | `components/common` | 9 | 1 | 0 | 8 | app shell (stays) |
| web | `components/datatable` | 37 | 7 | 0 | 1 | platform-web (PP-10.8 to PP-10.11) |
| web | `components/device-activation` | 5 | 0 | 0 | 0 | app shell (stays) |
| web | `components/doctor` | 1 | 0 | 0 | 0 | [PP-10.2](https://github.com/marinoscar/EnterpriseAppBase/issues/717) |
| web | `components/home` | 0 | 0 | 1 | 0 | app shell (stays) |
| web | `components/navigation` | 1 | 4 | 0 | 0 | app shell (stays) |
| web | `components/notifications` | 1 | 0 | 0 | 0 | app shell (stays) |
| web | `components/pwa` | 0 | 2 | 0 | 1 | app shell (stays) |
| web | `components/settings` | 12 | 3 | 1 | 16 | - |
| web | `components/telemetry` | 28 | 8 | 0 | 0 | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) |
| web | `components/user` | 0 | 0 | 1 | 0 | app shell (stays) |
| web | `config` | 0 | 3 | 0 | 3 | app shell (stays) |
| web | `contexts` | 3 | 2 | 0 | 1 | app shell (stays) |
| web | `hooks` | 46 | 0 | 0 | 63 | - |
| web | `pages` | 10 | 3 | 1 | 24 | - |
| web | `pages/Admin` | 21 | 5 | 0 | 5 | platform-web (PP-10.8 to PP-10.11) |
| web | `services` | 13 | 6 | 0 | 26 | - |
| web | `theme` | 0 | 5 | 1 | 2 | app shell (stays) |
| web | `types` | 0 | 1 | 0 | 0 | - |
| web | `utils` | 3 | 0 | 0 | 17 | - |
| cli | `(root)` | 22 | 6 | 2 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| cli | `__fixtures__` | 0 | 0 | 10 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| cli | `commands` | 9 | 1 | 0 | 3 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| cli | `deploy` | 69 | 15 | 0 | 6 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| cli | `init` | 2 | 0 | 0 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| cli | `node` | 54 | 1 | 0 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| cli | `tui` | 29 | 13 | 0 | 10 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| prisma | `(root)` | 2 | 0 | 0 | 0 | [PP-10.6](https://github.com/marinoscar/EnterpriseAppBase/issues/747) |
| prisma | `catalog` | 0 | 0 | 1 | 0 | [PP-10.6](https://github.com/marinoscar/EnterpriseAppBase/issues/747) |
| prisma | `migrations` | 21 | 0 | 2 | 31 | [PP-10.6](https://github.com/marinoscar/EnterpriseAppBase/issues/747) |
| prisma | `schema.prisma` | 0 | 1 | 0 | 0 | [PP-10.6](https://github.com/marinoscar/EnterpriseAppBase/issues/747) |
| prisma | `seed` | 0 | 2 | 0 | 0 | [PP-10.6](https://github.com/marinoscar/EnterpriseAppBase/issues/747) |
| infra | `compose` | 10 | 2 | 0 | 1 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| infra | `nginx` | 2 | 1 | 0 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| infra | `otel` | 1 | 0 | 0 | 0 | [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) |
| stack-agent | `(root)` | 7 | 0 | 0 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| packages | `(root)` | 0 | 0 | 1 | 0 | platform packages |
| packages | `platform-api` | 0 | 0 | 13 | 0 | platform packages |
| packages | `platform-cli` | 0 | 0 | 9 | 0 | platform packages |
| packages | `platform-contract` | 0 | 0 | 13 | 0 | platform packages |
| packages | `platform-db` | 0 | 0 | 11 | 0 | platform packages |
| packages | `platform-infra` | 0 | 0 | 12 | 0 | platform packages |
| packages | `platform-web` | 0 | 0 | 9 | 0 | platform packages |
| packages | `shared` | 0 | 5 | 0 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| scripts | `(root)` | 2 | 2 | 4 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| github | `(root)` | 2 | 0 | 1 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| github | `ISSUE_TEMPLATE` | 3 | 0 | 1 | 0 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| github | `workflows` | 3 | 1 | 1 | 1 | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |

app-only modules (no base counterpart) are domain code and stay in the app, except the harvested features that [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) replaces with the platform versions:

| Module | Files | Classification | Story |
|---|---|---|---|
| api `activity` | 18 | domain | - |
| api `admin-factory-reset` | 8 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) |
| api `android-app` | 23 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) |
| api `check-ins` | 8 | domain | - |
| api `coach` | 180 | domain | - |
| api `exercises` | 8 | domain | - |
| api `gyms` | 41 | domain | - |
| api `health-documents` | 13 | domain | - |
| api `health-export` | 22 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) |
| api `health-profile` | 9 | domain | - |
| api `health-summary` | 16 | domain | - |
| api `health-sync` | 8 | domain | - |
| api `intake` | 18 | domain | - |
| api `measurements` | 50 | domain | - |
| api `memory` | 20 | domain | - |
| api `onboarding` | 9 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) |
| api `programs` | 42 | domain | - |
| api `progress-photos` | 11 | domain | - |
| api `sleep` | 4 | domain | - |
| api `training-adaptation` | 45 | domain | - |
| api `training-agents` | 193 | domain | - |
| api `training-usage` | 6 | domain | - |
| api `user-data` | 9 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) |
| api `workouts` | 29 | domain | - |
| web `components/coach` | 15 | domain | - |
| web `components/goals` | 5 | domain | - |
| web `components/gyms` | 24 | domain | - |
| web `components/health` | 28 | domain | - |
| web `components/intake` | 10 | domain | - |
| web `components/onboarding` | 3 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) |
| web `components/progress` | 7 | domain | - |
| web `components/today` | 10 | domain | - |
| web `components/train` | 19 | domain | - |
| web `components/training` | 64 | domain | - |
| web `pages/Train` | 6 | domain | - |
| cli `android` | 34 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) |
| android `(root)` | 8 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) |
| android `app` | 97 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) |
| android `gradle` | 3 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) |
| android `scripts` | 1 | domain extension (needs a seam) | [PP-10.13](https://github.com/marinoscar/EnterpriseAppBase/issues/753) |

## Part 4: Cross-check against the manual measurement

The manual measurement of 2026-10-04 compared the app with the base before the registry, event-bus, deployment-mode, permission and retention work landed in the base. This table sets its API figures beside this report.
A module that did not change in the base since then matches (cosmetic and real counts equal, within one file). A module the base did change shows the difference as real drift, and every such file is classed `base ahead`.

| Module (`apps/api/src`) | Manual: identical / comment-only / real / app-only | This report: identical / cosmetic / real / app-only | Reading |
|---|---|---|---|
| `doctor` | 9 / 0 / 0 / 0 | 7 / 0 / 2 / 0 | two real files: the base moved the check registry onto the generic registry |
| `allowlist` | 9 / 0 / 0 / 0 | 9 / 0 / 0 / 0 | matches; one base-only permission declaration file added since |
| `credentials` | 7 / 0 / 0 / 0 | 7 / 0 / 0 / 0 | matches |
| `device-auth` | 18 / 0 / 0 / 0 | 18 / 0 / 0 / 0 | matches |
| `health` | 9 / 0 / 0 / 0 | 9 / 0 / 0 / 0 | matches |
| `prisma` | 3 / 0 / 0 / 0 | 3 / 0 / 0 / 0 | matches |
| `test-auth` | 7 / 0 / 0 / 0 | 7 / 0 / 0 / 0 | matches |
| `user-credentials` | 8 / 0 / 0 / 0 | 8 / 0 / 0 / 0 | matches |
| `users` | 11 / 0 / 0 / 0 | 11 / 0 / 0 / 0 | matches; one base-only permission declaration file added since |
| `about` | 2 / 6 / 0 / 0 | 2 / 3 / 3 / 0 | three real files: the base added the deployment mode field since |
| `telemetry` | 57 / 34 / 1 / 0 | 57 / 33 / 2 / 0 | one cosmetic file counted real here: a snapshot whose test names carry issue numbers |
| `jobs` | 56 / 13 / 1 / 0 | 55 / 9 / 6 / 0 | five more real files: event-bus wake-up in the worker and service, retention docs in the handler README |
| `nodes` | 30 / 19 / 0 / 0 | 30 / 19 / 0 / 0 | matches; one base-only permission declaration file added since |
| `db-backup` | 48 / 3 / 0 / 0 | 39 / 3 / 9 / 0 | nine real files: the base added the deployment mode restore guard |
| `storage` | 57 / 1 / 3 / 3 | 57 / 1 / 3 / 3 | matches; two base-only permission declaration files |
| `settings` | 15 / 0 / 8 / 0 | 14 / 0 / 9 / 0 | one more real file than the manual count; one base-only permission declaration file |
| `common` | 43 / 5 / 12 / 5 | 42 / 5 / 13 / 5 | one more real file; 46 base-only files are the new seams (registry, permissions, event bus, deployment, retention) |
| `notifications` | 41 / 9 / 22 / 7 | 40 / 8 / 24 / 7 | two more real files (the stream service now uses the event bus); six base-only files |
| `email` | 20 / 1 / 23 / 5 | 20 / 1 / 23 / 5 | matches |
| `ai` | 215 / 8 / 16 / 19 | 214 / 8 / 17 / 19 | one more real file; base-only: permissions and the runs purge |
| `auth` | 33 / 2 / 3 / 1 | 33 / 2 / 3 / 1 | matches |
| `pat` | 6 / 0 / 2 / 0 | 6 / 0 / 2 / 0 | matches |
| `openapi` | 15 / 0 / 1 / 0 | 15 / 0 / 1 / 0 | matches |
| `config` | 1 / 1 / 0 / 0 | 0 / 0 / 2 / 0 | two real files: the base added the deployment mode block |

Headline, API: 80.9% of the base files are identical or cosmetic-only (the spec states 78%). The unchanged modules agree with the manual figures, so the normaliser is sound. No mismatch points at a script defect.

## Part 5: Other areas

Facts from the manual measurement, confirmed against the report:

| Area | Finding |
|---|---|
| Collector | `infra/otel/otel-collector-config.yaml` is normalised-identical to the base: only comments differ. |
| nginx | `infra/nginx/nginx.conf` adds the SSE locations `/api/coach/chat/stream` and `/api/ai/training/stream`, `= /api/admin/android-app/releases` (`client_max_body_size 160m`), `/api/android-app/download/`, `= /.well-known/assetlinks.json` and `geolocation=(self)`. It lacks the base `worker_rlimit_nofile`, `worker_connections 16384` and `multi_accept on`. |
| Worker env prefix | `infra/compose/worker.compose.yml` uses the `EVOPATHCLI_*` prefix (identity rename); it is normalised-identical to the base. |
| Compose | `base.compose.yml` lacks the base nginx `ulimits` block; `.env.example` lacks the base deployment-mode section. `fake-ai.compose.yml` is app-only. |
| Migrations | 20 of the base migrations are shared: 19 byte-identical, and `20260930120000_add_job_trace_context`, whose SQL differs only in its first comment line. `add_worker_node_vitals` is `20260930100000` in the app and `20260928100000` in the base with identical SQL. The base has one migration the app lacks (`20261006120000_add_retention_created_at_indexes`); the app has 30 of its own. |
| Prisma models | All 31 base models exist in the app. the app adds 46 models and extra relation fields on `User`, `PersonalAccessToken`, `PushSubscription` and `StorageObject`. |
| Stack agent | `apps/stack-agent/src` is identical to the base (7 files, 2 cosmetic). |
| Shared identity | `packages/shared` differs by design: the identity of the app, its theme colours and `accentColor`. The base `packages/` tree (68 files) holds the platform package sources. |

## Part 6: Backport candidates

Every file classed `generic improvement (backport candidate)` holds behaviour the base does not have and that carries no the app concept. The base backports each one before the slice that owns it deletes the local copy here.

| Candidate | Files | Story that deletes the copy |
|---|---|---|
| Shared CSV helper (formula neutralising, BOM) and its use in the telemetry export | `apps/api/src/common/export/csv.ts`, `apps/api/src/telemetry/export/telemetry-export.service.ts` | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) / [PP-10.4](https://github.com/marinoscar/EnterpriseAppBase/issues/719) |
| `deriveSigningKey` in `common/crypto/secret-cipher.ts` | `apps/api/src/common/crypto/secret-cipher.ts`, `apps/api/src/common/crypto/secret-cipher.spec.ts` | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| Zod issue details (`details.issues`) and the `412 PRECONDITION_FAILED` code | `apps/api/src/common/filters/http-exception.filter.ts`, `apps/api/src/common/dto/error.dto.ts` | [PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718) |
| `@AuthCredential()` and `PatService.resolveToken` | `apps/api/src/auth/decorators/auth-credential.decorator.ts`, `apps/api/src/pat/pat.service.ts`, `apps/api/src/auth/guards/jwt-auth.guard.ts` | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) |
| `ai-provider-filename`, log-safe `AiError` detail, `SseFrame`, OpenAI web-search sources, CSV and PDF output extensions | `apps/api/src/ai/runtime/ai-provider-filename.ts`, `apps/api/src/ai/core/ai-error.ts`, `apps/api/src/ai/http/ai-sse.ts`, `apps/api/src/ai/providers/openai/openai-responses.mapper.ts`, `apps/api/src/ai/storage/ai-output-writer.ts` | [PP-10.10](https://github.com/marinoscar/EnterpriseAppBase/issues/751) |
| Email attachments: `EmailAttachment`, `composeEmailMessage`, both providers | `apps/api/src/email/email.types.ts`, `apps/api/src/email/templates/email-template.types.ts`, `apps/api/src/email/providers/ses-email.provider.ts`, `apps/api/src/email/providers/smtp-email.provider.ts` | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) |
| Storage status endpoint and the web notice that uses it | `apps/api/src/storage/status/storage-status.controller.ts`, `apps/web/src/services/storage.ts`, `apps/web/src/components/common/FeatureUnavailableNotice.tsx` | [PP-10.8](https://github.com/marinoscar/EnterpriseAppBase/issues/749) |
| Session-expired state and the cross-tab refresh Web Lock | `apps/web/src/services/api.ts`, `apps/web/src/contexts/AuthContext.tsx` | [PP-10.7](https://github.com/marinoscar/EnterpriseAppBase/issues/748) |
| `DataTableRowAction.disabledReason` | `apps/web/src/components/datatable/types.ts`, `apps/web/src/components/datatable/desktop/RowActionsCell.tsx` | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| Deploy edge-config reconcile and deploy preferences | `apps/cli/src/deploy/edge-config.ts`, `apps/cli/src/deploy/preferences.ts`, `apps/cli/src/deploy/update.ts` | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| CLI version manifests kept out of release lockstep | `apps/cli/src/deploy/app-version.ts` | [PP-10.11](https://github.com/marinoscar/EnterpriseAppBase/issues/752) |
| Node telemetry test: filter the stuck-job reaper out of the shared mock (flake fix) | `apps/api/test/nodes/node-telemetry.integration.spec.ts` | [PP-10.9](https://github.com/marinoscar/EnterpriseAppBase/issues/750) |

All 57 files classed as a generic improvement, for the backport issue to work from:

- `apps/api/src/ai/core/ai-error.spec.ts`
- `apps/api/src/ai/core/ai-error.ts`
- `apps/api/src/ai/http/ai-sse.ts`
- `apps/api/src/ai/providers/openai/openai-hosted-tools.spec.ts`
- `apps/api/src/ai/providers/openai/openai-responses.mapper.ts`
- `apps/api/src/ai/runtime/ai-provider-filename.spec.ts`
- `apps/api/src/ai/runtime/ai-provider-filename.ts`
- `apps/api/src/ai/storage/ai-output-writer.ts`
- `apps/api/src/auth/decorators/auth-credential.decorator.ts`
- `apps/api/src/auth/decorators/index.ts`
- `apps/api/src/auth/guards/jwt-auth.guard.spec.ts`
- `apps/api/src/auth/guards/jwt-auth.guard.ts`
- `apps/api/src/common/crypto/secret-cipher.spec.ts`
- `apps/api/src/common/crypto/secret-cipher.ts`
- `apps/api/src/common/dto/error.dto.ts`
- `apps/api/src/common/export/csv.ts`
- `apps/api/src/common/filters/http-exception.filter.spec.ts`
- `apps/api/src/common/filters/http-exception.filter.ts`
- `apps/api/src/email/email-test-send.service.spec.ts`
- `apps/api/src/email/email-test-send.service.ts`
- `apps/api/src/email/email.types.ts`
- `apps/api/src/email/index.ts`
- `apps/api/src/email/providers/ses-email.provider.spec.ts`
- `apps/api/src/email/providers/ses-email.provider.ts`
- `apps/api/src/email/providers/smtp-email.provider.spec.ts`
- `apps/api/src/email/providers/smtp-email.provider.ts`
- `apps/api/src/email/templates/email-template.types.spec.ts`
- `apps/api/src/email/templates/email-template.types.ts`
- `apps/api/src/email/templates/index.spec.ts`
- `apps/api/src/email/templates/index.ts`
- `apps/api/src/pat/pat.service.spec.ts`
- `apps/api/src/pat/pat.service.ts`
- `apps/api/src/storage/status/dto/storage-status.dto.ts`
- `apps/api/src/storage/status/storage-status.controller.spec.ts`
- `apps/api/src/storage/status/storage-status.controller.ts`
- `apps/api/src/telemetry/export/telemetry-export.service.ts`
- `apps/api/test/nodes/node-telemetry.integration.spec.ts`
- `apps/api/test/storage/storage-status.integration.spec.ts`
- `apps/cli/src/deploy/app-version.test.ts`
- `apps/cli/src/deploy/app-version.ts`
- `apps/cli/src/deploy/edge-config.test.ts`
- `apps/cli/src/deploy/edge-config.ts`
- `apps/cli/src/deploy/preferences.test.ts`
- `apps/cli/src/deploy/preferences.ts`
- `apps/cli/src/deploy/update.test.ts`
- `apps/cli/src/deploy/update.ts`
- `apps/web/src/__tests__/contexts/AuthContext.sessionExpired.test.tsx`
- `apps/web/src/__tests__/hooks/useStorageStatus.test.tsx`
- `apps/web/src/components/common/FeatureUnavailableNotice.tsx`
- `apps/web/src/components/datatable/__tests__/RowActionsCell.test.tsx`
- `apps/web/src/components/datatable/desktop/RowActionsCell.tsx`
- `apps/web/src/components/datatable/types.ts`
- `apps/web/src/components/settings/ProfileSettings.tsx`
- `apps/web/src/contexts/AuthContext.tsx`
- `apps/web/src/hooks/useStorageStatus.ts`
- `apps/web/src/services/api.ts`
- `apps/web/src/services/storage.ts`

## Part 7: What the base has that the app lacks

These are not the app changes to protect. They arrive by adopting the packages, and the matching local files are simply replaced.

- **Generic registry primitive** and the **permission and role registry** (`common/registry`, `common/permissions`, `*.permissions.ts` beside each module, `prisma/catalog/permissions.json`).
- **Event bus** (`common/event-bus`, `jobs/job-wake.ts`) used by the job worker wake-up and the notification stream fan-out across replicas.
- **Deployment mode** (`common/deployment`): the `DEPLOYMENT_MODE` setting and the SaaS restore guard in db-backup, about and the web backup page.
- **Retention purges** (`common/retention`, `notifications/retention`, the AI runs purge) and their index migration.
- **Telemetry tokens** in the web theme (`theme/telemetryTokens.ts`) and the telemetry dashboard that reads them.
- **Maintainer tooling**: package docs and pack checks, the drift script, `CODEOWNERS`, the seam request issue template and the packages workflow. An app does not carry these.


## Part 8: Re-checks at adoption

Each adoption story re-runs the drift script for its slice against the base commit the package was cut from, and records the result here. The tables above stay as measured at the baseline.

### Doctor ([PP-10.2](https://github.com/marinoscar/EnterpriseAppBase/issues/717), 2026-10-07)

Re-run of `scripts/platform-drift.mjs` (areas `api`, `api-test`, `web`) with the base at `c928ba29a3411e43d6970da8e9b8dc5bf1c9657f`, the parent of the commit that moved the Doctor into `@marinoscar/platform-api/doctor`, against the app's `origin/main` at `6da517eb`. The four web files were also compared with `14949ef99da07523de059d3cc8908699c1c7211b`, the parent of the commit that bound the packaged page.

| Path | Result | Class |
|---|---|---|
| `apps/api/src/doctor/` (7 of 9 files) | identical | cosmetic |
| `apps/api/src/doctor/doctor-check.registry.ts`, `doctor-check.registry.spec.ts` | modified: the base built the registry on the generic registry primitive and freezes it after bootstrap | base ahead (app behind) |
| `apps/api/test/doctor/doctor.integration.spec.ts` | modified: the base also asserts its `core.deployment-mode` check, which this app does not have yet ([PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718)) | base ahead (app behind) |
| `apps/web/src/pages/Admin/DoctorPage.tsx`, `hooks/useDoctor.ts`, `services/doctor.ts`, `components/doctor/CheckRow.tsx` | identical | cosmetic |

No app-side delta, so nothing was ported to the base. The adoption deleted every path above except the integration spec, which stays as the app's wiring test (now importing the package, and pinning the app's 27 check ids). The package's registry freezes after bootstrap; every check of this app registers in `onModuleInit`, so none is affected. Ledger row: [README.md, Adopted slices](README.md#3-adopted-slices).

### Core and otel-core ([PP-10.3](https://github.com/marinoscar/EnterpriseAppBase/issues/718), 2026-10-07)

Re-run of `scripts/platform-drift.mjs` (area `api`) with the base at `2ea79890d16e9af58d5dd9c4969d886e32bb7092`, the parent of the first commit that moved code into `@marinoscar/platform-api/core` (the otel-core moves started later, from `7cc98b96`; in between only the registry import paths of `app-metric.registry.ts` and the app-metrics spec changed), against the app's `origin/main` at `3e3a0565`. Each differing file was then diffed by hand against the package source of `0.1.0-next.2`.

| Path | Result | Class |
|---|---|---|
| `apps/api/src/common/dto/error.dto.ts`, `common/exceptions/database-seed.exception.ts`, `common/exceptions/verbatim-error-body.exception.ts`, `common/filters/http-exception.filter.spec.ts`, `common/crypto/encryption-key-startup-check.ts`, `common/decorators/trace.decorator.ts` | identical | cosmetic |
| `apps/api/src/common/filters/http-exception.filter.ts` | normalised-identical: the zod `details.issues` and the 412 `PRECONDITION_FAILED` mapping are in the package too (comments differ) | cosmetic |
| `apps/api/src/common/crypto/secret-cipher.ts`, `secret-cipher.spec.ts` | modified: the app's `deriveSigningKey(purpose)` (issue #285) and its spec; everything else identical to the package | generic improvement (backport candidate); kept as the local shim `common/crypto/signing-key.ts` |
| `apps/api/src/common/otel/telemetry-gate.ts`, `request-span-attributes.ts` (and specs), `service-name.ts`, `instance-id.ts` (and specs), `apps/api/src/instrumentation.ts` | identical or normalised-identical (issue numbers) | cosmetic |
| `apps/api/src/common/otel/app-metrics.service.ts`, `app-metrics.service.spec.ts` | modified: 26 health and coach names and 19 recorders added inline | domain extension (needs a seam): moved to `apps/api/src/app-metrics/` and registered through the app-metric registry |
| `apps/api/src/common/otel/app-metrics.module.ts` | normalised-identical | cosmetic |
| `apps/api/src/main.ts` | modified: the base checks `DEPLOYMENT_MODE` at startup | base ahead (app behind); only the core and otel-core lines were adopted |
| `apps/api/src/common/registry/*`, `common/principal/*`, `common/otel/app-metric.registry.ts` and the other `app-metric.*` and `platform-app-metrics.ts` files | base-only | base ahead (app behind); the registry and principal arrive with the package, the app-metric files were added as the base has them |

No app-side delta was ported to the base by this story: the one generic improvement (`deriveSigningKey`) is a seam request. Ledger rows: [README.md, Adopted slices](README.md#3-adopted-slices) and [Local exceptions](README.md#4-local-exceptions).
