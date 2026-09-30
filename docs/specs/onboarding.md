# First-run onboarding

> **Status:** shipped · **Code:** `apps/api/src/onboarding/`, `apps/web/src/components/onboarding/`, `apps/web/src/contexts/OnboardingContext.tsx`, `apps/web/src/hooks/useOnboarding.ts`, `apps/web/src/pages/Admin/SetupGuidePage.tsx`, `apps/web/src/components/today/TodayOnboarding.tsx` · **API:** `GET /api/onboarding` (see `/api/docs`, tag `Onboarding`) · **Admin UI:** `/admin/settings/setup` · **Recipe:** [§4](#4-extending-it-in-a-fork)

First-run onboarding gives every new account one next step instead of an empty app. A one-time welcome dialog leads into a short checklist: a **Setup guide** for administrators and a **Get started** card for everyone else. Each step is ticked from real state, never by hand. The server derives the steps on every request; the only thing stored is three small facts of UI state in the `onboarding` user-settings namespace.

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
| `ai_plan` | Create an AI training plan | The user has at least one program | AI is enabled, and `ai:use`, and `programs:read` | `/train/plans/new` |

**Order depends on the goal.**

| Goal | Order |
|---|---|
| `fat_loss`, `endurance`, `general`, or none | `health_profile`, `gym`, `first_workout`, `ai_plan` |
| `strength`, `hypertrophy` | `gym`, `first_workout`, `health_profile`, `ai_plan` |

A lifter's first need is a place to train and a logged session; the profile can follow. If the AI policy cannot be read, the `ai_plan` step is left out rather than failing the response.

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
| **Setup guide** | `/admin/settings/setup`, `SetupGuidePage` | The administrator checklist in its two groups, a **Re-check** button (`refresh=true`) and a link to the Doctor |
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

## 3. Configuration and permissions

**Settings.** The `onboarding` namespace of `user_settings` ([§2.1](#21-stored-and-derived-state)). There are no system settings and no environment variables. `INITIAL_ADMIN_EMAIL` (see `infra/compose/.env.example`) is read only to exclude the bootstrap administrator from the allowlist step.

**Permissions.** No new permission.

| Permission | Gates |
|---|---|
| `user_settings:read` | `GET /api/onboarding` (every role holds it) |
| `user_settings:write` | Writing the namespace through `PATCH /api/user-settings` |
| `system_settings:read` | The `admin` block of the response, and the Setup guide card and route |
| `health_data:read`, `gyms:read`, `workouts:read`, `programs:read`, `ai:use` | Whether the matching user step is offered |

**Route.** Details in `/api/docs`.

| Method | Path | Guards | Purpose |
|---|---|---|---|
| `GET` | `/api/onboarding` | `@Auth()`, `user_settings:read` | The caller's derived checklist and stored UI state; query `refresh` |

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
| `apps/web/src/__tests__/config/settingsRegistry.test.ts` | The Setup guide is a registry card with the exact permission its endpoint enforces |
| `apps/web/src/__tests__/config/todayCards.test.ts` | The Today card order, including the onboarding cards at the top |
| `apps/api/test/openapi/openapi-document.spec.ts` | The OpenAPI document builds with the endpoint in it |
| `apps/api/test/docs-links.spec.ts` | Every link in this spec resolves |

## 6. Design decisions

- **A checklist on Today, not a `/welcome` page.** A dedicated route is one more destination to register, one more thing to bounce a returning user past, and a place users learn to skip. The dialog plus a card puts guidance where people already land and lets it disappear when it has done its job.
- **No automatic tours.** A forced sequence of tooltips is the long-tour pattern the completion data argues against. It also breaks on every layout change and is hostile to keyboard and screen-reader users. Help in context is left to empty states ([§7](#7-out-of-scope-and-follow-ups)).
- **No manual ticks.** A checkbox the user sets drifts from reality: people tick what they intend, and skip what they did. A step derived from a row cannot be wrong and needs no maintenance.
- **Completion is not persisted from a `GET`.** Recording "step done" (for analytics, say) inside the read would make a safe method write, create a `user_settings` row for a user who has none, and race between tabs. The endpoint stays read-only; the derived state is the truth.
- **Reuse the Doctor for administrator steps.** Re-deriving "is storage configured" would be a second probe to keep in step with the first. The Doctor already has the cache, the timeouts and the remedies. The cost is that a step's status follows the Doctor's vocabulary (`skip` reads as `todo`).
- **One optional question, not a questionnaire.** Each extra question lowers completion. The goal is the one answer that is used immediately: it orders the checklist and seeds the plan wizard. It can be skipped.
- **`unavailable` is not a status.** A step the caller cannot perform is omitted, so the response has two statuses and the UI never explains a step the user cannot act on.

## 7. Out of scope and follow-ups

- **Empty states.** "Your administrator has not enabled X" on feature pages is tracked as a follow-up; the checklist already omits steps for a feature that is off.
- **Tooltip tours.** Guided tours are not built and are not planned (see [§6](#6-design-decisions)).
- **Activation analytics.** Emitting a log line or span attribute the first time a step flips to `done`, and any dashboard over it, is not built. It needs a write path that is not a `GET`.

## 8. Verification

```bash
npm test --workspace=api -- onboarding
npm run test:run --workspace=web -- onboarding
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

## History

- #203 added first-run onboarding: the `onboarding` user-settings namespace, `GET /api/onboarding`, the welcome dialog, the Today cards and the Setup guide.
- #204 is the follow-up for feature-disabled empty states.
