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
| Packages | Published under the `@marinoscar` scope, pinned exactly in the workspace `package.json` files. No `file:`, `link:` or workspace path points at the platform. Until the packages are on npm (an owner step in EnterpriseAppBase), the pin is the tarball URL of a GitHub prerelease of EnterpriseAppBase (`https://github.com/marinoscar/EnterpriseAppBase/releases/download/platform-v<version>/marinoscar-platform-<x>-<version>.tgz`), recorded in the lockfile with its integrity hash; see EnterpriseAppBase `docs/runbooks/release-platform-packages.md`, "Install from a GitHub release". Since `0.1.0-next.2` both packages depend on `@marinoscar/platform-contract`, which is not on npm either: the root `package.json` pins it to the same release's tarball, and a root `overrides` entry (`"$@marinoscar/platform-contract"`) points every copy at that pin, so the three move together. The packages arrive prebuilt: no image or CI job builds one. |
| Upgrades | [`renovate.json`](../../renovate.json) opens one grouped PR, "platform packages", for `@marinoscar/platform-*` only, following the `latest` dist-tag. [`.github/dependabot.yml`](../../.github/dependabot.yml) ignores those packages and keeps every other dependency. While a pin is a release URL, Renovate has no registry version to compare it with: upgrade by changing the version in every platform URL (all packages share one version; the root `package.json` holds the contract's) and running `npm install`. |
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

One row per slice, appended by the story that adopts it.

| Slice | Package and version | Local paths deleted | Extension registrations (file:symbol) | Issue | Date |
|---|---|---|---|---|---|
| Doctor | `@marinoscar/platform-api` `0.1.0-next.1` (`/doctor`, `/core` host) in `apps/api`; `@marinoscar/platform-web` `0.1.0-next.1` (`/doctor/ui`, `/core` host) in `apps/web`; both from the GitHub prerelease `platform-v0.1.0-next.1` | `apps/api/src/doctor/` (9 files: contract, registry and its spec, controller, module, service and its spec, two DTOs); `apps/web/src/pages/Admin/DoctorPage.tsx`, `apps/web/src/hooks/useDoctor.ts`, `apps/web/src/services/doctor.ts`, `apps/web/src/components/doctor/CheckRow.tsx`, `apps/web/src/__tests__/hooks/useDoctor.test.ts`, `apps/web/src/__tests__/pages/Admin/DoctorPage.test.tsx` | Binding: `apps/api/src/platform/doctor.config.ts:doctorModule` (`DoctorModule.forRoot({ host })`, defaults), `apps/api/src/platform/platform-host.ts:platformHost` (access port), `apps/web/src/platform/platformHost.tsx:AppPlatformHostProvider`, `apps/web/src/config/adminSections.tsx` (`doctorSettingsPage.card`). App-owned checks registered through `DoctorCheckRegistry`: `apps/api/src/android-app/android-app.module.ts:AndroidAssetLinksDoctorCheck` (`android.assetlinks`), `apps/api/src/android-app/android-app.module.ts:AndroidReleasesDoctorCheck` (`android.releases`), `apps/api/src/ai/assignments/ai-assignments.module.ts:AiFeatureAssignmentsDoctorCheck` (`ai.feature-assignments`), `apps/api/src/ai/assignments/ai-assignments.module.ts:AiWebSearchDoctorCheck` (`ai.web-search`). The 23 platform-slice checks keep their modules and ids; only their imports changed. | [marinoscar/EnterpriseAppBase#717](https://github.com/marinoscar/EnterpriseAppBase/issues/717) | 2026-10-07 |
| Core and otel-core | `@marinoscar/platform-api` `0.1.0-next.2` (`/core`, `/otel-core`, `/otel-core/sdk`) in `apps/api`; `@marinoscar/platform-web` `0.1.0-next.2` in `apps/web` (lockstep, no web change); `@marinoscar/platform-contract` `0.1.0-next.2` pinned at the root; all from the GitHub prerelease `platform-v0.1.0-next.2` | `apps/api/src/common/crypto/secret-cipher.ts`, `secret-cipher.spec.ts`, `encryption-key-startup-check.ts`; `apps/api/src/common/filters/http-exception.filter.ts`, `http-exception.filter.spec.ts`; `apps/api/src/common/exceptions/database-seed.exception.ts`, `verbatim-error-body.exception.ts`; `apps/api/src/common/dto/error.dto.ts`; `apps/api/src/common/decorators/trace.decorator.ts`; `apps/api/src/common/otel/telemetry-gate.ts`, `telemetry-gate.spec.ts`, `request-span-attributes.ts`, `request-span-attributes.spec.ts`, `service-name.ts`, `service-name.spec.ts`, `instance-id.ts`, `instance-id.spec.ts`. The 26 health and coach metrics and their 19 recorders left `common/otel/app-metrics.service.ts`, which, as in the base, stays an app file rebuilt on the package's metrics host (with `app-metrics.module.ts`, the new `platform-app-metrics.ts`, `app-metric.manifest.ts` and `telemetry-identity.ts`). The SDK dependencies the app no longer imports left `apps/api/package.json`. | Metric names: `apps/api/src/app-metrics/domain-metrics.module.ts` (`registerAppMetrics(EVOPATH_APP_METRICS)`, declarations in `app-metrics/domain-metric-names.ts`, recorders in `EvoPathMetricsService`). Platform metric declarations: `apps/api/src/common/otel/app-metric.manifest.ts:registerAppMetrics(PLATFORM_APP_METRICS)`. Metrics host: `apps/api/src/common/otel/app-metrics.module.ts` (`OtelMetricsModule.forRootAsync`). SDK: `apps/api/src/instrumentation.ts` (`initializeOtel`), identity bound in `apps/api/src/common/otel/telemetry-identity.ts`. Request span hook: `apps/api/src/main.ts` (`registerRequestSpanAttributes`). Error filter: `apps/api/src/app.module.ts` (`APP_FILTER` `HttpExceptionFilter`). Encryption key check: `apps/api/src/main.ts` (`verifyEncryptionKeyAtStartup`, with a credential-count callback). Registry freeze: `apps/api/src/common/common.module.ts` (`RegistryFreezeService`). | [marinoscar/EnterpriseAppBase#718](https://github.com/marinoscar/EnterpriseAppBase/issues/718) | 2026-10-07 |

## 4. Local exceptions

A file that is a copy of platform code but stays, because the package has no seam for it yet.
Each row links the seam request and is removed when the seam ships. The Doctor slice exports everything this app uses (`DoctorService` and `DoctorCheckReport` for the setup guide included), so it was adopted with no local copy.

| Local file | Why it stays | Seam request | Removed when |
|---|---|---|---|
| `apps/api/src/common/crypto/signing-key.ts` (with `signing-key.spec.ts`) | `deriveSigningKey(purpose)`, the HMAC sub-key of `SECRETS_ENCRYPTION_KEY` the Android APK download links are signed with (`android-app/releases/android-release.service.ts`). This app added it to its copy of the cipher; `@marinoscar/platform-api/core` does not export it. The shim keeps the label `enterpriseappbase:signing-key:v1:` byte for byte (a golden-value spec pins it), so outstanding links stay valid, and validates the master key through the package's `assertEncryptionKeyConfigured`. | [marinoscar/EnterpriseAppBase#822](https://github.com/marinoscar/EnterpriseAppBase/issues/822) in EnterpriseAppBase: "export `deriveSigningKey` from `@marinoscar/platform-api/core`" (a generic improvement, a backport candidate in the drift baseline) | The package exports `deriveSigningKey` with the same label: import it, delete the shim and this row. |

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
