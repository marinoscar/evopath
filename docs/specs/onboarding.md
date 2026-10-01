# First-run onboarding

> **Status:** shipped · **Code:** `apps/api/src/onboarding/`, `apps/web/src/components/onboarding/`, `apps/web/src/contexts/OnboardingContext.tsx`, `apps/web/src/hooks/useOnboarding.ts`, `apps/web/src/pages/Admin/SetupGuidePage.tsx`, `apps/web/src/components/today/TodayOnboarding.tsx`, `apps/web/src/components/onboarding/ActivationMetrics.tsx`, `apps/web/src/components/common/FeatureUnavailableNotice.tsx` · **API:** `GET /api/onboarding`, `GET /api/admin/onboarding/metrics` (see `/api/docs`, tag `Onboarding`) · **Admin UI:** `/admin/settings/setup` · **Recipe:** [§4](#4-extending-it-in-a-fork)

First-run onboarding gives every new account one next step instead of an empty app. A one-time welcome dialog leads into a short checklist: a **Setup guide** for administrators and a **Get started** card for everyone else. Each step is ticked from real state, never by hand. The server derives the steps on every request; the only thing stored is three small facts of UI state in the `onboarding` user-settings namespace. Administrators also see how well it works: an aggregate activation rate over recent sign-ups. Where a feature is not set up, its entry points say so instead of failing.

## 1. Purpose

**The two audiences.**

| Audience | Who | What the app looks like on day one | What they need |
|---|---|---|---|
| Administrator | Holds `system_settings:read` | Inert: storage is blank, AI is off, there is no email delivery, no Web Push and no allowlist entries | The few settings that must exist before other people can sign in and succeed, then the optional features |
| Regular user | Viewer or Contributor | Empty: no profile, no gym, no workout, no plan | The shortest path to the first logged workout, the activation event |

**What it is.**

- A welcome dialog shown once per user.
- A derived checklist of three to seven steps, per audience.
- A way back in: the **Getting started** item in the user menu.

**What it is not.**

- Not a product tour. There are no tooltips, spotlights or coach marks ([§6](#6-design-decisions)).
- Not a second source of truth. A step's status is computed from the data it is about, so it cannot drift from it.
- Not a diagnostic. The administrator steps reuse the [Doctor](doctor.md); the full report stays at `/admin/settings/doctor`.
- Not a gate. Nothing is blocked while a step is open; every feature page stays reachable.
- Not per-user analytics. The metrics are aggregates; no row about one user leaves the database ([§2.8](#28-activation-metrics)).

### 1.1 Design principles

| Principle | Evidence | How it shows up here |
|---|---|---|
| Short checklists beat long tours | Chameleon's tour benchmarks: a tour of seven or more steps completes at about 16%, a three-step tour at about 72% | Users see at most four steps; administrators see six in two groups of three; no tour |
| Tick steps from real state | Shopify's app onboarding guidelines: reflect what the merchant has actually set up rather than asking them to mark it | `done` is derived from a saved profile, a gym row, a completed workout, a Doctor check; there is no "mark as done" control |
| One welcome screen, leading into a checklist | The same guidelines and NN/g: a single orienting moment with one primary action, then persistent guidance | The dialog has one primary button that opens the checklist surface for the role |
| Dismissible and resumable | NN/g: onboarding must never trap the user | Every exit marks the welcome seen; the card can be dismissed; **Getting started** reopens both |
| Never show a step the user cannot do | Shopify and NN/g: an unactionable step is noise | A step whose permission the caller lacks, or whose feature is off, is omitted, not shown as blocked |
| Accessible dialog | W3C ARIA Authoring Practices, dialog (modal) pattern | `aria-labelledby` and `aria-describedby`, focus moved in and returned, Escape closes, no motion under `prefers-reduced-motion`, full screen below `sm` |

## 2. How it works

### 2.1 Stored and derived state

| Kind | Where | Holds |
|---|---|---|
| Stored | `user_settings.value.onboarding` (no new table, no migration) | `welcomeSeenAt`, `checklistDismissedAt`, `goal` |
| Derived | `GET /api/onboarding`, computed per request | Every step's `done` or `todo`, the counts, `requiredDone` |

The stored namespace is sparse, like every optional namespace: absent means "never seen, never dismissed, no goal".

| Key | Type | Meaning |
|---|---|---|
| `welcomeSeenAt` | ISO datetime or `null` | The welcome dialog was closed, by any route |
| `checklistDismissedAt` | ISO datetime or `null` | The user hid the Get started card |
| `goal` | `strength`, `hypertrophy`, `fat_loss`, `endurance`, `general` or `null` | The optional answer on the welcome dialog |

The goal set is `programs.goal` minus `custom`, which needs free text the dialog does not collect. The schema is `onboardingSettingsSchema` in `apps/api/src/common/schemas/user-settings-namespaces.schema.ts`, and it is `.strict()`.

The web writes the namespace through the existing `PATCH /api/user-settings` with `If-Match`, body `{ "onboarding": { ... } }`. The merge is shallow: provided keys replace, and an explicit `null` clears a key (`mergeOnboarding` in `apps/api/src/settings/user-settings/user-settings.service.ts`).

### 2.2 The endpoint is read-only

`OnboardingService` never writes. It does not read the namespace through `UserSettingsService`, whose `getSettings` creates a default row on first read; it selects the `user_settings` row directly and treats an absent or unparseable namespace as all `null`. A `GET` therefore leaves the database unchanged for a user with no settings row.

### 2.3 User steps

Each step is an existence query. A step is included only when the caller may perform it.

| Step id | Label | Done when | Included when | Link |
|---|---|---|---|---|
| `health_profile` | Complete your health profile | A `health_profiles` row exists for the user | `health_data:read` | `/settings/health-profile` |
| `gym` | Add your gym | The user owns at least one gym | `gyms:read` | `/gyms/new` |
| `first_workout` | Log your first workout | The user has at least one workout with status `completed` | `workouts:read` | `/train` |
| `ai_plan` | Create an AI training plan; once a program exists, **Meet your coach** | No program: never. A program: the coach settings were saved at least once (the `coach` user-settings namespace exists). With the system coach switched off: the user has at least one program | AI is enabled, and `ai:use`, and `programs:read` | `/train/plans/new`; once a program exists, `/settings/coach` |

**Order depends on the goal.**

| Goal | Order |
|---|---|
| `fat_loss`, `endurance`, `general`, or none | `health_profile`, `gym`, `first_workout`, `ai_plan` |
| `strength`, `hypertrophy` | `gym`, `first_workout`, `health_profile`, `ai_plan` |

A lifter's first need is a place to train and a logged session; the profile can follow. If the AI policy cannot be read, the `ai_plan` step is left out rather than failing the response.

**`ai_plan` has two phases.** The checklist is capped at four steps ([§1.1](#11-design-principles)), so the AI Coach's "pick a persona" step is not a fifth step: it is the second phase of `ai_plan` ([ai-coach.md §2.13](ai-coach.md#213-ux-surfaces)).

1. While the user has no program, the step reads "Create an AI training plan", links to `/train/plans/new` and is `todo`.
2. Once a program exists, the same step id reads "Meet your coach", links to `/settings/coach`, and is `done` when the `coach` namespace exists in `user_settings.value`: the user saved the coach settings at least once (`PUT /api/coach/settings`).

The `coach` namespace is read from the same direct `user_settings` select as the onboarding namespace, so the endpoint stays read-only. While the system coach switch is off (`coach.enabled` in system settings), the second phase is skipped and the step is `done` once a program exists, as before; a failed read of that switch does the same.

### 2.4 Administrator steps

The `admin` block is present only when the caller holds `system_settings:read`, the permission the Doctor requires. Six steps in two groups:

| Step id | Group | Label | Done when | Doctor checks | Link |
|---|---|---|---|---|---|
| `storage` | `required` | Connect object storage | Every mapped check is `pass` | `storage.config`, `storage.bucket` | `/admin/settings/storage` |
| `email` | `required` | Set up email delivery | Every mapped check is `pass` | `email.config` | `/admin/settings/email` |
| `allowlist` | `required` | Invite your first users | At least one `allowed_emails` entry other than `INITIAL_ADMIN_EMAIL` (compared case-insensitively) | none: a count | `/admin/settings/users` |
| `ai` | `features` | Turn on AI | Every mapped check is `pass` | `ai.enabled`, `ai.providers` | `/admin/settings/ai` |
| `push` | `features` | Enable Web Push | Every mapped check is `pass` | `push.vapid` | `/admin/settings/push` |
| `backup` | `features` | Schedule database backups | Every mapped check is `pass` | `backup.schedule` | `/admin/settings/db-backup` |

- **Reuse, not re-derivation.** `OnboardingService` calls `DoctorService.run` for the categories `storage`, `email`, `ai`, `push` and `backup`, so the steps share the Doctor's 15 second cache, its per-check timeouts and its read-only guarantee ([doctor.md](doctor.md#24-the-service)). No configuration probe is written twice.
- **`skip` is not `pass`.** AI switched off makes `ai.enabled` a `skip`, so the AI step is `todo` until AI is on. That is the intent: it is an optional feature the checklist invites the administrator to enable.
- **`detail`.** For a `todo` step, the first non-`pass` mapped check's `remedy`, falling back to its `detail`. For a `done` step, `null`.
- **`requiredDone`** is true when every `required` step is `done`. It decides whether the Today setup card still shows.

### 2.5 The response

```
GET /api/onboarding[?refresh=true]

{
  welcomeSeenAt, checklistDismissedAt, goal,          // the stored state, each null when unset
  user:  { steps, completed, total },                 // always present
  admin: { steps, completed, total, requiredDone } | null
}
Step = { id, group: 'required'|'features'|null, status: 'done'|'todo',
         label, detail: string|null, href }
```

`refresh=true` is forwarded to the Doctor and bypasses its cache for the administrator steps. It is a string enum (`true` or `false`), not a coerced boolean, for the reason given in `apps/api/src/onboarding/dto/onboarding.dto.ts`.

### 2.6 Web surfaces

| Surface | Where | Behaviour |
|---|---|---|
| **Welcome dialog** | `WelcomeDialog`, mounted once in `Layout` | Opens when `welcomeSeenAt` is `null`. Every way out (primary button, **Later**, Escape, backdrop) marks it seen, so it never returns on its own |
| **Setup guide** | `/admin/settings/setup`, `SetupGuidePage` | The administrator checklist in its two groups, a **Re-check** button (`refresh=true`), a link to the Doctor and the **Activation** section ([§2.8](#28-activation-metrics)) |
| **Get started card** | Today, `getStarted` | The user steps. Hidden when every step is done or `checklistDismissedAt` is set |
| **Set up the app card** | Today, `adminSetup` | Shown to an administrator until `requiredDone`, with a progress line linking to the guide |
| **Getting started** | User menu | Clears `welcomeSeenAt` and `checklistDismissedAt`, so the dialog and the card return |
| **Plan wizard seed** | `PlanWizardPage` | The wizard's initial `goalType` is `settings.onboarding.goal` when set, otherwise its existing default |

- **One fetch.** `OnboardingProvider` runs the query once around the authenticated shell; the dialog, both cards, the menu and the guide read the same state. With no provider above (a component rendered alone) the hook is inert and requests nothing.
- **Writes are optimistic**, so closing the dialog closes it at once; the state is re-read afterwards so every surface agrees.
- **The checklist list is shared.** `OnboardingChecklist` renders a real list of links with status in words and an icon (never colour alone) and a "3 of 5" text progress. The Today card and the Setup guide both use it.

### 2.7 The experience per role

| | Administrator (`system_settings:read`) | Regular user |
|---|---|---|
| Welcome dialog, once | States that some configuration must exist before people can use the app. **Start setup** opens `/admin/settings/setup`; **Later** dismisses | A greeting, one optional goal question as chips, and **Get started**. The goal is saved when chosen |
| Checklist | Setup guide: **Required** (storage, email, allowlist) then **Features** (AI, Web Push, backups), each with its status, the Doctor's remedy and a link to the page that fixes it | Get started card at the top of Today: up to four steps, ordered by goal |
| On Today | "Set up the app" until the required steps pass | The card, until done or dismissed |
| Also sees | The user Get started card (administrators are users too) | Nothing administrative: no `admin` block, no Setup guide card |
| Re-entry | **Getting started** in the user menu; the Setup guide card in the admin hub | **Getting started** in the user menu |

The Setup guide appears in the admin hub (General group) as a card declared in `ADMIN_SECTIONS`, per the [Settings UI pattern](settings-ui.md).

### 2.8 Activation metrics

`GET /api/admin/onboarding/metrics` answers "do new users reach their first workout?". `OnboardingMetricsService` runs one read-only aggregate `SELECT`, bounded by the cohort. It is an on-demand read, not a queue job, and returns no per-user row.

**Definitions.**

| Term | Definition |
|---|---|
| Cohort | Users with `created_at` in the last `days` days (query `days`, 1 to 365, default 30) |
| Eligible | Cohort users created at least 7 days ago, so their activation window has closed |
| Activated | Eligible users whose first completed workout (`MIN(ended_at)` over workouts with status `completed`) is within 7 days of `created_at` |
| Activation rate | `activated / eligible`; `null` when no user is eligible |
| Median hours to first workout | Median of the hours from sign-up to the first completed workout, over cohort users with at least one such workout (eligible or not), rounded to one decimal; `null` when none |
| Step funnel | Per user step, `completed` (cohort users with the step done now, by the same rules as [§2.3](#23-user-steps)) and `rate` (`completed / cohortSize`; `null` for an empty cohort). For `ai_plan` that is a program plus, while the system coach switch is on, a saved `coach` namespace |

- **Counted only over eligible users.** A user who signed up yesterday has not had 7 days yet, so counting them would bias the rate down. They count in `cohortSize`, the median and the funnel.
- **The window constant** is `ACTIVATION_WINDOW_DAYS` in `apps/api/src/onboarding/dto/onboarding-metrics.dto.ts`; the response echoes it as `activationWindowDays`.
- **No-workout users are excluded from the median.** A negative or missing first-workout interval never counts as zero hours.

```
GET /api/admin/onboarding/metrics[?days=30]

{ windowDays, activationWindowDays: 7, cohortSize, eligible, activated,
  activationRate: number|null, medianHoursToFirstWorkout: number|null,
  steps: [{ id: 'health_profile'|'gym'|'first_workout'|'ai_plan',
            completed, rate: number|null }] }
```

The **Activation** section of the Setup guide (`ActivationMetrics`, fed by `useOnboardingMetrics`) shows a window selector (7, 30 or 90 days), three tiles (New users, Activation rate, Median time to first workout) and the funnel as a list. Every number is also written as text ("12 of 40, 30%"); the progress bars only repeat it. An empty cohort reads "No new users in this window". It is a section of the page, not a card or a tab ([Settings UI pattern](settings-ui.md)).

### 2.9 Feature-unavailable notices

A control that cannot work because a feature is not configured is replaced by `FeatureUnavailableNotice` (`apps/web/src/components/common/FeatureUnavailableNotice.tsx`), so it neither vanishes silently nor fails on use.

| Prop | Meaning |
|---|---|
| `feature` | `ai`, `storage` or `push` |
| `variant` | `inline` (default, an info `Alert`) or `empty` (built on `EmptyState`) |
| `detail` | Optional extra sentence, such as what still works |

- **Copy.** Title "{Feature} isn't enabled yet" (AI, Storage, Web Push), body "Your administrator hasn't set this up yet."
- **Administrators.** A viewer holding the area's admin read permission sees a **Set it up** button instead of the body, linking to the admin page. The permission only picks the words; the admin route and API enforce their own gates.

| Feature | Admin permission | Set it up link |
|---|---|---|
| `ai` | `ai_config:read` | `/admin/settings/ai` |
| `storage` | `storage_config:read` | `/admin/settings/storage` |
| `push` | `push:read` | `/admin/settings/push` |

**Entry points.**

| Feature | Where | Shown when |
|---|---|---|
| AI | `PlansPage` (the plans list) | AI is off |
| AI | `PhotoReadButton` with `showUnavailable` | AI is known off and the caller holds the photo-read permissions; otherwise the button is omitted |
| Storage | `GymPhotos`, `PrefillButton`, `PhotoReadButton`, `ProfileSettings` (profile image) | `GET /api/storage/status` answers `configured: false` |
| Push | `NotificationSettings` (the push toggle) | Web Push is not enabled |

The storage answer comes from `useStorageStatus` ([storage-providers.md](storage-providers.md#3-configuration-and-permissions)). An unknown answer (request failed or still loading) never blocks anything and shows no notice: the notice appears only on a definite `configured: false`.

## 3. Configuration and permissions

**Settings.** The `onboarding` namespace of `user_settings` ([§2.1](#21-stored-and-derived-state)). There are no system settings and no environment variables. `INITIAL_ADMIN_EMAIL` (see `infra/compose/.env.example`) is read only to exclude the bootstrap administrator from the allowlist step.

**Permissions.** No new permission.

| Permission | Gates |
|---|---|
| `user_settings:read` | `GET /api/onboarding` (every role holds it) |
| `user_settings:write` | Writing the namespace through `PATCH /api/user-settings` |
| `system_settings:read` | The `admin` block of the response, the Setup guide card and route, and `GET /api/admin/onboarding/metrics` |
| `storage:read` | `GET /api/storage/status`, which feeds the storage notices |
| `ai_config:read`, `storage_config:read`, `push:read` | Only the wording of a notice (**Set it up** versus the administrator hint) |
| `health_data:read`, `gyms:read`, `workouts:read`, `programs:read`, `ai:use` | Whether the matching user step is offered |

**Route.** Details in `/api/docs`.

| Method | Path | Guards | Purpose |
|---|---|---|---|
| `GET` | `/api/onboarding` | `@Auth()`, `user_settings:read` | The caller's derived checklist and stored UI state; query `refresh` |
| `GET` | `/api/admin/onboarding/metrics` | `@Auth()`, `system_settings:read` | Aggregate activation numbers; query `days` |

## 4. Extending it in a fork

### 4.1 Add a user step

1. In `apps/api/src/onboarding/onboarding.service.ts`, add the id to `UserStepId` and an entry to `USER_STEPS` (`id`, `label`, `href`).
2. Add the id to both `DEFAULT_ORDER` and `LIFTING_ORDER`.
3. In `userBlock`, register a check in the `checks` map, inside the permission test that governs it. The check is a cheap existence query returning a boolean. Leave it unregistered when the caller cannot perform the step, so the step is omitted.
4. Keep it read-only and do not store completion anywhere.
5. Extend the onboarding service tests with the new step, including the case where the permission is missing.

The web needs no change: `OnboardingChecklist` renders whatever steps the API returns. Keep the list to four or fewer; past that the evidence in [§1.1](#11-design-principles) turns against you.

### 4.2 Add an administrator step

1. Make sure a [Doctor check](doctor.md#4-extending-it-in-a-fork) reports the capability. If you need a new category, add it to `ONBOARDING_DOCTOR_CATEGORIES`.
2. Add an `AdminDoctorStepDef` (`id`, `group`, `label`, `href`, `checks`) and place it in `adminBlock`: in the `required` run if other people cannot succeed without it, otherwise in `FEATURE_STEPS`.
3. `href` must be a route that exists, normally the check's own `settingsPath`.
4. For a step that is a fact rather than a health check (like the allowlist), compute a boolean in `adminBlock` and emit the step directly, as `allowlist` does.
5. Extend the service tests: a mapped `pass` gives `done`, anything else `todo` with the remedy as `detail`.

### 4.3 Add a goal

Add the value to `ONBOARDING_GOALS` (it must also be a `programs.goal`), then to the goal chips in `WelcomeDialog` and, if it should order the steps like a lifter's, to `LIFTING_GOALS`.

### 4.4 Add another stored fact

The namespace is validated in six places, because `userSettingsSchema.parse` silently strips unknown keys. A new key goes through all of them: `onboardingSettingsSchema`, `userSettingsSchema` in `settings.schema.ts`, the PUT and PATCH DTOs in `settings/dto/update-user-settings.dto.ts`, `UserSettingsValue` in `common/types/settings.types.ts`, `toResponse` and `mergeOnboarding` in `user-settings.service.ts`, and the web `UserSettings` type.

## 5. Guardrails

| Guard | Enforces |
|---|---|
| `apps/api/src/onboarding/onboarding.service.spec.ts` | Step derivation, goal ordering, permission omission, Doctor mapping, read-only |
| `apps/api/test/onboarding/onboarding.integration.spec.ts` | Route permissions and response shape for `GET /api/onboarding` |
| `apps/api/test/settings/onboarding-settings.integration.spec.ts` | The `onboarding` namespace through `PATCH /api/user-settings`, including `null` clearing |
| `apps/api/src/onboarding/onboarding-metrics.service.spec.ts` | The metric arithmetic: rate, `null` cases, rounding, funnel rates |
| `apps/api/test/onboarding/onboarding-metrics.integration.spec.ts` | `system_settings:read` on the metrics route, `days` validation, response shape |
| `apps/api/test/onboarding/onboarding-metrics.db.spec.ts` | The SQL on real Postgres: eligibility, the 7 day window, the median excluding users without a workout |
| `apps/api/src/storage/status/storage-status.controller.spec.ts` | `{ configured }` follows the Doctor's decision; an unreadable configuration is `false` |
| `apps/api/test/storage/storage-status.integration.spec.ts` | `storage:read` on the route and no provider, bucket or credential in the response |
| `apps/web/src/__tests__/components/onboarding/OnboardingChecklist.test.tsx`, `WelcomeDialog.test.tsx`, `planWizardGoal.test.tsx` | The shared list, the dialog's exits and goal, the wizard seed |
| `apps/web/src/__tests__/components/today/TodayOnboarding.test.tsx`, `apps/web/src/__tests__/components/navigation/UserMenuGettingStarted.test.tsx` | The Today cards and the **Getting started** menu item |
| `apps/web/src/__tests__/pages/Admin/SetupGuidePage.test.tsx` | The administrator checklist and **Re-check** |
| `apps/web/src/__tests__/components/settings/NotificationSettings.test.tsx`, `apps/web/src/__tests__/pages/UserNotificationsPage.test.tsx`, `apps/web/src/__tests__/pages/HealthPagePhotoRead.test.tsx` | The push, storage and AI notices at their entry points |
| `apps/web/src/__tests__/components/common/FeatureUnavailableNotice.test.tsx`, `apps/web/src/__tests__/hooks/useStorageStatus.test.tsx` | The notice copy and **Set it up** switch by permission; the storage hook never blocks on an unknown answer |
| `apps/web/src/__tests__/components/onboarding/ActivationMetrics.test.tsx` | The Activation section: tiles, window selector, funnel text, empty cohort |
| `tests/e2e/specs/onboarding.spec.ts` | The welcome dialog and checklist end to end |
| `apps/web/src/__tests__/config/settingsRegistry.test.ts` | The Setup guide is a registry card with the exact permission its endpoint enforces |
| `apps/web/src/__tests__/config/todayCards.test.ts` | The Today card order, including the onboarding cards at the top |
| `apps/api/test/openapi/openapi-document.spec.ts` | The OpenAPI document builds with both endpoints in it |
| `apps/api/test/docs-links.spec.ts` | Every link in this spec resolves |

## 6. Design decisions

- **A checklist on Today, not a `/welcome` page.** A dedicated route is one more destination to register, one more thing to bounce a returning user past, and a place users learn to skip. The dialog plus a card puts guidance where people already land and lets it disappear when it has done its job.
- **No automatic tours.** A forced sequence of tooltips is the long-tour pattern the completion data argues against. It also breaks on every layout change and is hostile to keyboard and screen-reader users. Help in context is left to the feature-unavailable notices ([§2.9](#29-feature-unavailable-notices)).
- **No manual ticks.** A checkbox the user sets drifts from reality: people tick what they intend, and skip what they did. A step derived from a row cannot be wrong and needs no maintenance.
- **Completion is not persisted from a `GET`.** Recording "step done" (for analytics, say) inside the read would make a safe method write, create a `user_settings` row for a user who has none, and race between tabs. The endpoint stays read-only; the derived state is the truth.
- **Reuse the Doctor for administrator steps.** Re-deriving "is storage configured" would be a second probe to keep in step with the first. The Doctor already has the cache, the timeouts and the remedies. The cost is that a step's status follows the Doctor's vocabulary (`skip` reads as `todo`).
- **One optional question, not a questionnaire.** Each extra question lowers completion. The goal is the one answer that is used immediately: it orders the checklist and seeds the plan wizard. It can be skipped.
- **Activation is a first workout in 7 days, over eligible users.** The first logged workout is the event the checklist exists to cause. Dividing by the whole cohort would count users still inside their window as failures. The window is fixed so the number is comparable across periods.
- **Aggregates computed on read, not events recorded.** The metric reads existing rows, so it needs no write path, no migration and no backfill, and it stays correct if a step is completed in any way. The cost is that it cannot say when a step was done, only that it is done now.
- **A notice, not a disabled control.** A greyed button gives no reason. The notice says what is missing and who can fix it, and links an administrator straight there.
- **The storage flag is a boolean for everyone.** Regular users need to know whether uploads can work, never which provider or bucket. The route returns only `configured`, decided by the Doctor's own predicate, so there is no second definition of "complete".
- **"Meet your coach" is a phase of `ai_plan`, not a fifth step.** The coach needs a persona choice, and the checklist is capped at four. A plan comes first because the coach has nothing to hold the user to without one, so the step that asked for a plan asks for the coach next. Done is "the coach settings were saved once", read from the namespace's existence, so no completion fact is stored.
- **`unavailable` is not a status.** A step the caller cannot perform is omitted, so the response has two statuses and the UI never explains a step the user cannot act on.

## 7. Out of scope and follow-ups

- **Tooltip tours.** Guided tours are not built and are not planned (see [§6](#6-design-decisions)).
- **Per-step event emission.** Emitting a log line or span attribute the first time a step flips to `done` is not built. It needs a write path that is not a `GET`; the aggregates in [§2.8](#28-activation-metrics) cover the reporting need.
- **Time series.** The metrics are one window ending now. A trend over past cohorts is not stored.

## 8. Verification

```bash
npm test --workspace=api -- onboarding storage-status
npm run test:db --workspace=api -- onboarding-metrics
npm run test:run --workspace=web -- onboarding SetupGuidePage NotificationSettings HealthPagePhotoRead
npm run typecheck --workspace=api
npm run typecheck --workspace=web
```

By hand, with the app running (development sign-in as a test user works):

1. As a fresh Admin, the welcome dialog opens on `/`. **Start setup** opens `/admin/settings/setup`, where Storage, Email and Invite your first users are `todo`.
2. Configure storage at `/admin/settings/storage`, return and press **Re-check**. Storage reads `done`; a repeat without **Re-check** can lag by up to 15 seconds.
3. As a fresh Viewer, the dialog shows the goal chips. Pick **Strength** and choose **Get started**. The Today card lists the gym first, and no AI step appears while AI is off.
4. Add a gym. Reload: its step is ticked and the dialog does not return.
5. Open the user menu and choose **Getting started**. The dialog and the card return.
6. At 375px wide the dialog is full screen and the card does not sit under the bottom bar.
7. With a bearer token as a Viewer, `curl -H "Authorization: Bearer $TOKEN" http://localhost:3535/api/onboarding` returns `"admin": null`.
8. As an Admin, scroll the Setup guide to **Activation**. Switch the window between 7, 30 and 90 days; with no sign-ups in range it reads "No new users in this window".
9. `curl -H "Authorization: Bearer $TOKEN" "http://localhost:3535/api/admin/onboarding/metrics?days=30"` returns the counts; as a Viewer it answers `403`, and `days=0` answers `400`.
10. With storage unconfigured, `GET /api/storage/status` returns `{"data":{"configured":false}}`, and a Viewer sees "Storage isn't enabled yet" in place of the gym photo upload. With AI off, the plans list shows "AI isn't enabled yet" (an Admin sees **Set it up**).

## History

- #203 added first-run onboarding: the `onboarding` user-settings namespace, `GET /api/onboarding`, the welcome dialog, the Today cards and the Setup guide.
- #204 added `GET /api/storage/status` and `FeatureUnavailableNotice` at the AI, storage and push entry points.
- #212 added `GET /api/admin/onboarding/metrics` and the Activation section of the Setup guide.
- #252 (AI Coach E7.12) turned the `ai_plan` step into "Meet your coach" once a program exists, done when the coach settings were saved, with the activation funnel following the same rule.
