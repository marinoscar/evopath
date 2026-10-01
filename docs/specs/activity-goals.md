# Activity Goals and Check-ins

> **Status:** shipped (goals, check-in entries, workout auto-credit, progress and history, Goals page, Today card) · **Code:** `apps/api/src/activity/`, `apps/web/src/pages/Train/GoalsPage.tsx`, `apps/web/src/components/goals/`, `apps/web/src/components/today/TodayGoals.tsx` · **API:** `/api/goals/*`, `/api/activity-entries/*` (see `/api/docs`, tags "Goals" and "Activity entries") · **User UI:** `/train/goals` and the Today "Goals" card · **Runbook:** none · **Recipe:** [section 4](#4-extending-it-in-a-fork)

A goal is a target a user sets for everyday movement: "walk 4 times a week", "150 minutes of cardio a week", "8,000 steps a day". The user checks in by hand ("I did it", minutes or steps), and a finished workout credits matching goals on its own. The server counts everything, once, deterministically, per local day and per Monday-to-Sunday week; the web only draws the result. Goals sit beside the training plan, not inside it: a plan prescribes sessions, a goal measures activity. No AI is involved, so goals work with AI switched off.

## 1. Purpose

- **What it is.**
  - A small set of per-user targets (`activity_goals`) with a status lifecycle and a cap of 10 active goals.
  - A log of activity (`activity_entries`) that goals count from. A row is a manual check-in, a workout-derived credit or, in the future, an imported reading.
  - Pure counting rules (matching, source precedence, on track, streak) behind `GET /api/goals/progress` and `GET /api/goals/:id/history`.
  - A shape ready for device sync: provenance columns, an idempotent keyed batch and a precedence rule that lets a measured value win over a typed one (section 2.9).
- **What it is not.**
  - Not a training plan. A goal prescribes nothing and adapts nothing; the plan and its evaluator ([ai-training-plans.md](ai-training-plans.md)) never read goals.
  - Not a second active plan. See [section 6](#6-design-decisions).
  - Not a device integration. No importer, OAuth flow or provider setting exists; no client can write a row with source `integration`.
  - Not a coaching feature itself. The AI Coach reads progress through `GoalProgressService` and reacts to check-ins (section 2.8); goals work with the coach off.
- **Problem it solves.** A person who wants to "walk more" has nothing to log against: workouts are structured sessions and the plan is one prescription. Goals give a lightweight, forgiving target (backdate a week, say "I did it" without numbers) and credit the work already logged.

## 2. How it works

### 2.1 Data model

| Table | Holds |
|---|---|
| `activity_goals` | One goal: `title` (at most 80 characters), `activityKind`, `customLabel`, `metric`, `target`, `period`, `status`, `startsOn` (local day), `version` (optimistic concurrency), timestamps. Cascades with the user. Indexed by `(userId, status)` |
| `activity_entries` | One unit of activity on one local day: `occurredOn`, optional `occurredAt`, `activityKind`, `completed`, optional `durationSeconds`, `steps`, `distanceMeters`, `source`, optional `workoutId`, optional `provider` and `externalId`, `note` (at most 280). Cascades with the user and with the workout. Indexed by `(userId, occurredOn)` and `workoutId` |

| Vocabulary | Values |
|---|---|
| `ActivityKind` | `walk`, `run`, `cardio_any`, `workout_any`, `custom`, `steps`. `steps` is entry-only: a goal never has it as a kind |
| `GoalMetric` | `sessions`, `minutes`, `steps`, `distance_m` |
| `GoalPeriod` | `week`, `day` |
| `GoalStatus` | `active`, `paused`, `archived` |
| `ActivitySource` | `manual`, `workout`, `integration` |

- **Units are metric, always.** Durations are seconds and distances meters in the API. The web converts distance to the Health Profile unit system (`useDistanceUnit`); the server never does.
- **Days are local.** "Today" is the Health Profile time zone's current day (UTC when unset), resolved by `CheckInsService.today`. Weeks start on **Monday** (`weekStartOf` from the training signals).
- **CHECK constraints** (migration SQL, mirrored by the Zod bounds in `activity.constants.ts`): `activity_goals_target_chk` (target above 0), `activity_goals_sessions_week_chk` (a `sessions` goal is weekly), `activity_goals_kind_chk` (no `steps` kind), and on entries steps 0 to 200,000, duration 0 to 86,400 s and distance 0 to 1,000,000 m.
- **Two raw-SQL partial unique indexes** exist only in migration SQL. Prisma cannot express them; never declare them as `@@unique` and never replace them with a `findFirst` pre-check:
  - `activity_entries_provider_external_uniq_idx` on `(user_id, provider, external_id) WHERE provider IS NOT NULL`: a re-sent imported reading replaces its earlier row.
  - `activity_entries_workout_kind_uniq_idx` on `(workout_id, activity_kind) WHERE workout_id IS NOT NULL`: one derived entry per workout per kind, which makes auto-credit idempotent under concurrent syncs.
- **Seeded exercises.** `outdoor_walk` ("Outdoor walk") and `hike` ("Hike") join `outdoor_run` in the library: body part `full_body`, pattern `cardio`, tracking mode `distance_time`, no equipment. Aliases: `outdoor_run` jog, jogging, run, running; `outdoor_walk` walk, walking, stroll; `hike` hiking, trail walk (`EXERCISE_ALIASES` in `apps/api/prisma/seed-data.ts`). Their slugs are permanent; auto-credit keys on them.

### 2.2 Goal lifecycle

```
active <-> paused        archive: active | paused -> archived (final)
```

| Action | Legal from | Refusal otherwise |
|---|---|---|
| `pause` | `active` | 409 `GOAL_ILLEGAL_TRANSITION` |
| `resume` | `paused` | 409 `GOAL_ILLEGAL_TRANSITION` (an archived goal never returns); 409 `GOAL_LIMIT_REACHED` at the cap |
| `archive` | `active`, `paused` | none; archived is final |

- Asking for the state a goal is already in is a no-op that returns the goal.
- Every write (edit or transition) bumps `version`.
- **Cap.** At most 10 active goals per user (`MAX_ACTIVE_GOALS`), checked on create and on resume inside a transaction that first locks the user's row (`SELECT ... FOR UPDATE`), so two concurrent creates cannot both pass the count. Paused and archived goals do not count. Over the cap is 409 `GOAL_LIMIT_REACHED`.
- **Edit.** `PATCH /api/goals/:id` requires `If-Match` with the goal `version` (bare `4`, `"4"` or `W/"4"`) and is judged on the **merged** goal. A missing header is 428 `IF_MATCH_REQUIRED`; a stale one is 412 `GOAL_VERSION_MISMATCH` with `details.currentVersion`; an archived goal is 409 `GOAL_ARCHIVED`. The write itself is conditional on the version, so an edit that races between the read and the write is also a 412. `GET /api/goals/:id` returns the version as the `ETag` header.
- **Shape rules** (400 `INVALID_GOAL`): a `sessions` goal needs `period: week`; a `custom` goal needs `customLabel` (ignored and stored null for other kinds); `steps` is a metric, never a kind (a Zod refusal, `VALIDATION_ERROR`).
- **`startsOn`** defaults to today (local) and may lie within 366 days either side of it (400 `START_DATE_OUT_OF_RANGE`). Entries before `startsOn` never count, and periods before it are not part of the streak or history.
- **Templates.** `GET /api/goals/templates` returns a fixed list: `walk_4x_week`, `cardio_150_min_week`, `steps_8000_day`, `workout_3x_week` (`GOAL_TEMPLATES`). A template is a prefill for the create form, not a stored link.
- **Targets** are integers from 1 to 1,000,000 in the goal's unit: sessions, whole minutes, steps or whole meters.

### 2.3 Entries and check-ins

| Check-in | Body |
|---|---|
| "I did it" | `{ "activityKind": "walk" }` |
| Minutes | `{ "activityKind": "walk", "durationSeconds": 1800 }` |
| Steps (a daily total) | `{ "activityKind": "steps", "steps": 8000 }` |

- Every entry the API writes is `source: manual`, `POST` and the batch alike. The body is strict: a client cannot send `source`, `workoutId` or `occurredAt`.
- `occurredOn` defaults to today and must be today or at most 7 days back, in the user's local days (400 `ENTRY_DATE_OUT_OF_RANGE`), on create, edit and batch alike. A `steps` entry must carry `steps` (400 `INVALID_ENTRY`, or a Zod refusal).
- `completed` defaults to true. It matters only to `sessions` goals; a `minutes` goal counts a duration whatever `completed` says.
- `PATCH` and `DELETE` act on manual entries only. A workout-derived or imported entry is 409 `ENTRY_DERIVED`: edit or delete the workout instead. Another user's entry is a 404.
- `GET /api/activity-entries?from&to&kind` lists a range of at most 400 days (400 `RANGE_TOO_LARGE`), oldest first, workout-derived entries included.
- **Batch.** `POST /api/activity-entries/batch` takes 1 to 500 entries in one transaction and answers `{ created, updated }`.
  - With both `provider` and `externalId`, a row is an `INSERT ... ON CONFLICT` on `activity_entries_provider_external_uniq_idx`: it replaces the caller's earlier manual row with the same pair. A repeated pair inside one batch keeps the last occurrence.
  - An existing row with that pair that is not manual is left alone and counted in neither total.
  - Without both fields (half a pair included) the entry is a plain insert.

### 2.4 Workout auto-credit

A completed workout materialises entries (source `workout`, `workoutId` set, `occurredOn` the workout's local `date`). The mapping is the pure `derivedEntriesFor` (`workout-activity.ts`):

| Entry kind | Created when |
|---|---|
| `workout_any` | Always, for a completed workout; `durationSeconds` is the workout's duration |
| `walk` | An `outdoor_walk` or `hike` exercise has a completed set |
| `run` | An `outdoor_run` exercise has a completed set |
| `cardio_any` | Any exercise of movement pattern `cardio` has a completed set |

- Duration and distance of `walk`, `run` and `cardio_any` are the sums over the matching exercises' **completed** sets; a prefilled target the user never ticked is not activity. They are null when no completed set carries the value, and are clamped to the table's ranges.
- A workout that is not completed credits nothing.
- A workout logged through `POST /api/workouts/quick-cardio` is created completed and emits `workout.finished`, so it is credited the same way ([workouts.md](workouts.md#25-logging-semantics)).
- **Three paths keep the rows equal to the workout** (`WorkoutActivitySyncService`):
  1. The `workout.finished` event, emitted after the finish commits, runs `syncWorkout` (`workout-activity.listener.ts`), so a goal is credited the moment a workout ends. A failure is logged with ids and swallowed: finishing a workout never depends on goals.
  2. Every progress read and every entry list first calls `reconcileRecent`, which re-derives the workouts of the last 14 local days (`DERIVED_RECONCILE_DAYS`). This catches an edit to a completed workout (sets, date), a workout created already completed without the event, and a workout that is no longer completed.
  3. Deleting a workout cascades its entries through the foreign key.
- Writes are diffed (an unchanged workout writes nothing) and go through `activity_entries_workout_kind_uniq_idx`, so concurrent syncs converge on one row per kind.
- Edits outside the 14-day window are not re-derived. Older workouts keep the credit they last had.

### 2.5 Counting rules

All of it is pure code in `goal-progress.ts` (no Nest, no Prisma, no clock); `GoalProgressService` loads rows and calls it.

**Matching.** An entry counts toward a goal only if it is on or after `startsOn`, carries what the metric counts, and its kind matches.

| Goal kind | Counts entries of kind |
|---|---|
| `walk` | `walk` |
| `run` | `run` |
| `cardio_any` | `walk`, `run`, `cardio_any` |
| `workout_any` | `workout_any` (the one every completed workout gets, and manual ones) |
| `custom` | `custom` |
| any kind, metric `steps` | every entry with a `steps` value, whatever its kind |

| Metric | The entry must carry |
|---|---|
| `sessions` | `completed: true` |
| `minutes` | `durationSeconds` |
| `distance_m` | `distanceMeters` |
| `steps` | `steps` |

**Precedence, per goal and local day: `integration` over `workout` over `manual`.** Only the entries of the highest source present that day count. The others are returned with `superseded: true`. A manual "I did it" walk and a walk workout on the same day are therefore one session, and a manual 6,000 steps loses to an imported 8,200.

**Counting within the winning source of a day:**

| Metric | Rule |
|---|---|
| `sessions` | Workout-derived: distinct `workoutId` (a workout's derived `walk` and `cardio_any` rows are one session). Otherwise one per entry |
| `minutes`, `distance_m` | Workout-derived: per workout the largest matching value (its `cardio_any` row already includes its walk), summed. Otherwise the sum. The period total is `floor(seconds / 60)` minutes or `floor(meters)` |
| `steps` | The **maximum** of the day, because steps are daily totals. A week goal sums its days |

### 2.6 Progress, on track and streak

`GET /api/goals/progress?date=` returns one `GoalProgress` per **active** goal for the period holding `date` (default today; at most 1 day ahead and 400 days back, else 400 `DATE_OUT_OF_RANGE`).

| Field | Definition |
|---|---|
| `periodStart`, `periodEnd` | The Monday-to-Sunday week, or the day itself |
| `done`, `target`, `remaining` | Done in goal units; `remaining` is `max(0, target - done)` |
| `daysLeft` | Days from `date` to the period end, `date` included (0 once over) |
| `hit` | `done >= target` |
| `onTrack` | True when hit. `sessions`: `remaining <= daysLeft`. Other metrics: `done >= target x elapsedFraction`, where `elapsedFraction` is the share of the period's days fully before `date` (so Monday morning, or a day goal's own day, is on track at zero) |
| `streakPeriods` | Consecutive hit periods immediately before the current one, going back no further than the period holding `startsOn` and 400 days. The current period never counts |
| `entries` | The period's matching entries, oldest first, each with `superseded` |

`GET /api/goals/:id/history?limit=&date=` returns up to `limit` periods (default 12, at most 100), newest first, starting with the period holding `date` and stopping at the one holding `startsOn`, each `{ periodStart, periodEnd, done, target, hit }`.

### 2.7 Web

- **`/train/goals`** (`GoalsPage.tsx`) is a Train destination, **not** a settings page, so it is not in `ADMIN_SECTIONS` or `USER_SETTINGS_SECTIONS`. `RequirePermission` on `goals:read` guards the route and redirects to `/train`. Active, Paused and Archived are three views of one list, so they are tabs. The page offers New goal (from a template or custom), Edit, Pause, Resume, Archive and each goal's history.
- **Today "Goals" card** (`TodayGoals.tsx`, registered as card `goals` in `apps/web/src/config/todayCards.tsx`) shows a progress ring and one line per active goal, on track, behind or hit, and a Check in button that opens the check-in sheet (`CheckInSheet.tsx`: I did it, Minutes, Steps; today back to seven days). With no active goal it links to `/train/goals`.
- `goals:write` enables every write; the API enforces both permissions and decides every number shown. Layout follows the `sm` breakpoint gates of the [settings UI spec](settings-ui.md#breakpoint-gates).

### 2.8 Consumers and the check-in event

- **`GoalProgressService`** (exported by `ActivityModule`) is the programmatic read API: `progressForUser`, `evaluateGoal` and `historyForGoal`. Its results carry `elapsedFraction` on top of the HTTP shape. The AI Coach is its consumer: the sweep and the finish and check-in jobs read every active goal's period, the chat tool `get_goals` reads a compact summary, and the weekly review lists the goals. See [ai-coach.md](ai-coach.md).
- **`activity.entry.recorded`** (`apps/api/src/activity/activity-events.ts`, EventEmitter2) is emitted by `ActivityEntriesService` **after** a manual check-in committed: `create` once its row exists, and `batch` once its transaction committed and wrote at least one row. An edit or a delete emits nothing. The payload is ids and an instant only (`userId`, `recordedSince`); the coach's listener turns it into the server-only job `coach.activity_recorded`, which plans a `goal_hit` message. The event key is permanent: listeners subscribe by string, and a listener must return quickly and never throw.
- Workout credit has its own trigger, the `workout.finished` event (section 2.4).

### 2.9 Sync-ready by design (future device import)

External integrations (Oura, Health Connect, Samsung Health, Apple Health) are future work and are **not** built: there is no importer, OAuth code or provider setting, and no HTTP route can write `source: integration`. The model is shaped so one can be added without a migration of meaning:

- `source: integration` already ranks above `workout` and `manual`, so a measured reading wins the day (steps: an imported daily total beats a typed one).
- `provider` and `externalId` with the partial unique index make a re-sent reading replace its earlier row instead of duplicating it. The batch route already honours the pair for manual rows, so a client can prove idempotency today.
- `occurredAt` carries a reading's timestamp; `occurredOn` stays the local day all rules use.
- `PATCH` and `DELETE` already refuse non-manual rows (`ENTRY_DERIVED`), and the keyed batch never overwrites one, so a user's edit cannot fight an importer.
- Steps are daily totals taken as a per-day maximum, so a provider that re-sends a growing total all day is safe.

A real importer adds a server-side writer (a job, per the queue rules in [job-queue.md](job-queue.md)) that inserts `integration` rows through the same index, plus provider settings configured at runtime like every other provider ([CLAUDE.md](../../CLAUDE.md) security guidelines), never environment variables.

## 3. Configuration and permissions

- **Env vars:** none. **Settings keys:** none. The feature is always on; there is no admin page and no `AiEnabledGuard`.
- **Permissions** (matrix in [ARCHITECTURE.md §7.2](../ARCHITECTURE.md#72-permission-matrix); all three seeded roles hold both):

| Permission | Guards |
|---|---|
| `goals:read` | Every `GET` under `/api/goals` and `/api/activity-entries`; the `/train/goals` route and the Today card |
| `goals:write` | Every other method: create, edit, transition, check-in, batch, delete |

Owner-scoped throughout: another user's goal or entry is a 404, never a 403. Compact route table; bodies, parameters and every `details.reason` are in `/api/docs` (`npm run openapi:dump`).

| Route | Permission |
|---|---|
| `GET /api/goals` (`?status=`, default `active`) | `goals:read` |
| `GET /api/goals/templates` | `goals:read` |
| `GET /api/goals/progress` (`?date=`) | `goals:read` |
| `GET /api/goals/:id`, `GET /api/goals/:id/history` | `goals:read` |
| `POST /api/goals` | `goals:write` |
| `PATCH /api/goals/:id` (`If-Match` required) | `goals:write` |
| `POST /api/goals/:id/pause`, `/resume`, `/archive` | `goals:write` |
| `GET /api/activity-entries` (`?from&to&kind`) | `goals:read` |
| `POST /api/activity-entries`, `POST /api/activity-entries/batch` | `goals:write` |
| `PATCH`, `DELETE /api/activity-entries/:id` | `goals:write` |

Refusal reasons (`details.reason`, `ACTIVITY_REASONS` in `activity.constants.ts`):

| Status | Reason | Cause |
|---|---|---|
| 400 | `INVALID_GOAL` | A cross-field goal rule failed |
| 400 | `START_DATE_OUT_OF_RANGE` | `startsOn` more than 366 days from today |
| 400 | `ENTRY_DATE_OUT_OF_RANGE` | Entry day outside today minus 7 .. today |
| 400 | `INVALID_ENTRY` | A `steps` entry without `steps` (edit) |
| 400 | `RANGE_TOO_LARGE` | Entry list range over 400 days |
| 400 | `DATE_OUT_OF_RANGE` | Progress or history `date` outside the allowed window |
| 409 | `GOAL_LIMIT_REACHED` | 10 active goals (create or resume) |
| 409 | `GOAL_ARCHIVED` | Edit of an archived goal |
| 409 | `GOAL_ILLEGAL_TRANSITION` | Pause, resume or archive from a state that forbids it |
| 409 | `ENTRY_DERIVED` | Edit or delete of a workout-derived or imported entry |
| 412 | `GOAL_VERSION_MISMATCH` | Stale `If-Match` (carries `currentVersion`) |
| 428 | `IF_MATCH_REQUIRED` | `PATCH` without `If-Match` |

## 4. Extending it in a fork

| To | Do |
|---|---|
| Add a goal template | Append to `GOAL_TEMPLATES` in `activity.constants.ts` (a permanent `key`, a kind, metric, target and period that pass the goal rules). Update the template-count assertion in `apps/api/test/activity/goals.integration.spec.ts` |
| Change a bound (active cap, backdating window, batch size, reconcile window) | Edit the constant in `activity.constants.ts`; the Zod schemas, CHECK constraints and this spec quote the same numbers, so change the migration CHECK and section 2 together |
| Add an activity kind | Add the enum value in `schema.prisma` and a migration, to `ACTIVITY_KINDS` (and `GOAL_ACTIVITY_KINDS` if a goal may track it), to `KINDS_FOR_GOAL` in `goal-progress.ts`, and to the web option lists and formatters (`apps/web/src/utils/goalFormat.ts`). Update the matching table in section 2.5 |
| Credit another exercise to a kind | Add its slug to `WALK_EXERCISE_SLUGS` or `RUN_EXERCISE_SLUGS`, or extend `derivedEntriesFor` for a new rule. Reconcile re-derives the last 14 days on the next read; older workouts need a one-off sync via `WorkoutActivitySyncService.syncWorkout` |
| Add a metric | Extend `GoalMetric`, `entryMetricValue` and `toGoalUnits` in `goal-progress.ts`, and the web formatters. Decide its per-day rule in `evaluateDay` first |
| Read goal progress from another feature | Import `ActivityModule` and inject `GoalProgressService` (`progressForUser`, `evaluateGoal`, `historyForGoal`); never query the goal tables of another user. Call it after a write commits |
| Import readings from a device | Section 2.9: insert `integration` rows server-side through `activity_entries_provider_external_uniq_idx` from a queue job, never from a client route |
| Keep goals through a data reset | Already decided: `activity_entries` and `activity_goals` are deleted by `user-data/user-data-purge.ts`. See [user-data-reset.md §4](user-data-reset.md#4-extending-it-in-a-fork) |

## 5. Guardrails

- `apps/api/src/activity/goal-progress.spec.ts`: matching, precedence, counting per metric, on track, streak and history as pure functions, including the week and day boundaries.
- `apps/api/src/activity/workout-activity.spec.ts`: the auto-credit mapping, completed-set sums and clamping.
- `apps/api/test/activity/goals.integration.spec.ts`: the HTTP contract through the real guards. Declared permission metadata of every goals and entries route, `401` and `403` without the exact permission, the templates, the cap, `If-Match` (`428`, `412`, conditional write, merged-goal validation), transitions, `ETag`, owner scoping, the 7-day window, the 400-day range, batch bounds and "no client-claimed source".
- `apps/api/test/activity/activity.db.spec.ts`: on real Postgres, keyed batch idempotence and races, never overwriting an imported row, auto-credit on finish, edit and delete (cascade), the partial unique indexes, steps precedence, back-dating in the user's own time zone and the active cap under concurrent creates.
- `apps/api/test/user-data/user-data-reset.db.spec.ts` and `apps/api/test/admin-factory-reset/admin-factory-reset.db.spec.ts`: both tables are deleted by the user reset and the factory reset.
- `apps/web/src/__tests__/pages/Train/GoalsPage.test.tsx`, `components/today/TodayGoals.test.tsx`, `config/todayCards.test.ts`, `services/goals.test.ts`, `utils/goalFormat.test.ts`: the page, the card, the client and the formatters.

## 6. Design decisions

- **Goals, not multiple active plans.** A plan is a versioned prescription with an evaluator, an adaptation envelope, signals and a Today resolver, all built around exactly one active plan (`programs_one_active_per_user_uniq_idx`). "Walk 4 times a week" next to a lifting plan would need several active plans and break every one of those assumptions. A goal is lightweight: it prescribes nothing and credits any workout, plan-linked or not. Rejected: relaxing the one-active-plan index; a goals-only "plan" kind.
- **Materialised workout entries, not computed on read.** A stored row per (workout, kind) lets one query count every source with the same precedence code, and lets a future importer share the table. The cost is keeping rows equal to the workout, paid by the finish event, the 14-day reconcile and the cascade. Rejected: joining `set_logs` at read time (a second counting path, no precedence against manual rows).
- **Reconcile on read, as well as on the event.** The event alone misses edits to a completed workout and workouts created completed. A bounded re-derive of 14 days on read is cheap and self-healing. Rejected: a periodic job (more moving parts, stale between runs).
- **The listener runs inline, not as a job.** It writes at most four rows of one workout, which is bounded work outside the queue rule's "long-running" definition ([job-queue.md](job-queue.md#all-long-running-work-is-a-job)). It never fails the finish.
- **Precedence per day, not a merge.** Summing a typed 30 minutes and a workout's 30 minutes would double count one walk. One winning source per day is easy to explain and to test. Rejected: de-duplicating by time overlap (needs timestamps that manual entries do not have).
- **Steps are a daily maximum.** A step count is a running total for the day, so two readings are the same steps seen twice.
- **Monday weeks in the user's time zone.** The same week the training signals use, so "this week" means one thing in the app.
- **Manual-only API.** No client can claim `integration`, so the precedence rule cannot be used to override a user's own history before an importer exists. Tests create `integration` rows directly.
- **`If-Match` with 412 and 428.** Goals use the standard HTTP codes for a stale or missing precondition. Training programs answer 409 and 400 for the same cases ([API.md](../API.md#optimistic-concurrency-if-match)); the two families are documented separately and not unified.
- **Seven days of backdating.** Long enough to log a forgotten walk, short enough that last month's totals are not rewritten by a typo.

## 7. Verification

```bash
npm test --workspace=api -- goal-progress workout-activity
npm test --workspace=api -- test/activity/goals.integration
npm run test:db --workspace=api -- activity user-data-reset admin-factory-reset
npm run test:run --workspace=web -- GoalsPage TodayGoals goalFormat todayCards
npm run openapi:dump && npm run openapi:lint
```

Observe: all suites pass and `/api/docs` lists the "Goals" and "Activity entries" tags. Then in the app:

1. Open `/train/goals`, create **Walk 4 times a week** from the template and check in "I did it" on today: the Today card shows 1 of 4.
2. Log and finish a workout containing **Outdoor walk** with a completed set: the goal still reads 1 of 4 that day (the same walk is one session) and the manual entry is returned with `superseded: true`.
3. `PATCH /api/goals/:id` without `If-Match` answers 428; with a stale version, 412.
4. Create 10 active goals, then an 11th: 409 `GOAL_LIMIT_REACHED`.
5. `POST /api/activity-entries` with `occurredOn` eight days ago answers 400 `ENTRY_DATE_OUT_OF_RANGE`.

## History

- Epic #260 (cardio and everyday activity): #261 seeded the walk and hike exercises and their aliases; #266 added the goals table and API; #267 added activity entries, the keyed batch and workout auto-credit; #268 added progress, history, the Goals page and the Today card. Prescribing duration and distance in plans is documented in [workouts.md](workouts.md), [training-signals.md](training-signals.md) and [ai-training-plans.md](ai-training-plans.md).
- Device integrations (Oura, Health Connect, Samsung Health, Apple Health) are tracked in #270 and are not built.
