# Platform adoption ledger

> **Design:** [platform-packages spec](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/specs/platform-packages.md) in EnterpriseAppBase · **Baseline:** [drift-baseline.md](drift-baseline.md) · **Tracking:** issues labelled `platform-packages` in `marinoscar/EnterpriseAppBase`, under the [retrofit epic](https://github.com/marinoscar/EnterpriseAppBase/issues/669)

This app started as a fork of EnterpriseAppBase and carries copies of its platform code (doctor, telemetry, jobs, nodes, notifications, AI platform, settings, storage, email, db-backup, the CLI core and infra fragments).
It is the first adopter of the `@marinoscar/platform-*` packages that replace those copies slice by slice.
This ledger records what has moved, at which version, and what stays local on purpose.

## 1. Purpose

- Tell a contributor, human or agent, which code is platform code and therefore read-only here.
- Record each adopted slice with the package version, the local paths that were deleted and the file that registers the app's extensions.
- Record every local exception, with the seam request that will remove it.
- Point at the measured starting point: [drift-baseline.md](drift-baseline.md).

The rule that follows from it is in [CLAUDE.md](../../CLAUDE.md#mandatory-platform-code-lives-in-packages).

## 2. How this app consumes the platform

| Part | How it works |
|---|---|
| Packages | Published on npm under the `@marinoscar` scope, versions pinned exactly in the workspace `package.json` files. No `file:`, `link:` or workspace path points at the platform. |
| Upgrades | [`renovate.json`](../../renovate.json) opens one grouped PR, "platform packages", for `@marinoscar/platform-*` only, following the `latest` dist-tag. [`.github/dependabot.yml`](../../.github/dependabot.yml) ignores those packages and keeps every other dependency. |
| Pre-release check | The manual workflow [`platform-next.yml`](../../.github/workflows/platform-next.yml) installs a pre-release (default dist-tag `next`) of every platform package already present, then runs the typechecks and the three test suites. It never commits and never opens a PR. Production never receives a pre-release. |
| Local development | Use a `next` pre-release or `yalc`. Never `npm link` a platform package: two copies of a package break its single-instance registries. |

Run the pre-release check from the Actions tab (`platform-next`, input `version`), or from a script:

```bash
gh workflow run platform-next.yml -f version=next
```

The workflow also accepts a `repository_dispatch` event of type `platform-next`, with `client_payload.version`.
Sending that event from EnterpriseAppBase needs a token with access to this repository, which only the owner can create.
No secret is stored for it here.

## 3. Adopted slices

One row per slice, appended by the story that adopts it. Empty until the first adoption.

| Slice | Package and version | Local paths deleted | Extension registrations (file:symbol) | Issue | Date |
|---|---|---|---|---|---|

## 4. Local exceptions

A file that is a copy of platform code but stays, because the package has no seam for it yet.
Each row links the seam request and is removed when the seam ships. Empty today.

| Local file | Why it stays | Seam request | Removed when |
|---|---|---|---|

## 5. How to request a seam

When the app needs a platform behaviour that has no extension point:

1. File a seam request in EnterpriseAppBase with the [seam request template](https://github.com/marinoscar/EnterpriseAppBase/issues/new?template=seam_request.yml). Name the file or behaviour, the registry or option you expected and the drift baseline row it comes from.
2. If the app can wait, wait for the seam and adopt it through a Renovate PR.
3. If it cannot wait, eject the one file. Add a row under Local exceptions with the seam request link, and mark the file with a comment that names the link.
4. When the seam ships, delete the file and its row in the same PR that bumps the package.

## 6. Rollback

- **The tag.** `MonoRepo` marks the last commit of this repository before any program change. To inspect or return to it: `git checkout MonoRepo`. Creating it is an owner step (agent sessions cannot push tags).
- **One story.** Each adoption story lands as one PR. Revert it with `git revert -m 1 <merge-commit>`; the previous slices stay adopted.
- **A package version.** Pin the previous version in the workspace `package.json` files and run `npm install`. Renovate's next PR proposes the newer one again.
