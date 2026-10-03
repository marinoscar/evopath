# Training Signals and Adherence

> **Status:** shipped (contract, pure aggregator, loader, route, compact form for agents) · **Code:** `apps/api/src/programs/signals/` · **API:** `GET /api/training/signals` (see `/api/docs`, tag "Programs") · **Admin UI:** none · **Runbook:** none · **Recipe:** [section 4](#4-extending-it-in-a-fork)

Training signals are facts about how a user is following a training plan: planned versus done sessions, frequency, hard sets per muscle, lift trends, effort, pain flags, readiness and body weight. The server computes them once, deterministically, from a bounded set of rows, on read. A model never derives these numbers itself; an agent reads a compacted copy and decides what they mean. The same numbers answer the user's question "is my plan working?". No AI is involved, so signals work with AI switched off.

## 1. Purpose

- **What it is.** One pure function (`aggregateSignals`) over rows, a loader that fetches those rows for one user and one program, a route, and a compaction function that sizes the result for a prompt.
- **What it is not.**
  - Not advice. Signals are facts; deciding what to change is the agent's job.
  - Not a target setter. Body values are exported as measurements, never as goals.
  - Not precomputed. There is no cron or job; a fast bounded query runs per request.
  - Not a readiness score. The four check-in scales have mixed polarity, so the four averages and a low-day count are exposed instead.
- **Problem it solves.** Models are unreliable at arithmetic and counting, and raw sets cost many tokens. Facts computed here are testable and cheap to hand to an evaluator.

## 2. How it works

### 2.1 Flow

1. `TrainingSignalsService` resolves the program: the caller's `programId` (another user's is a 404), else the caller's active program, else none.
2. `SignalsLoader` reads a bounded row set, every query filtered by `userId`.
3. `aggregateSignals(input)` returns `PlanSignals`. It imports no Nest and no Prisma, reads no clock (`asOf` is the clock) and orders deterministically: weeks ascending, muscles by name, lifts by sessions (descending) then name.
4. `compactSignals` shrinks the result for agent prompts (section 2.4).

Every numeric field is a finite number or `null`, never `NaN` or `Infinity`. Weights are kilograms. Dates are the user's local calendar days (`YYYY-MM-DD`). Free text (pain notes, check-in notes, set notes) is never read or exported.

### 2.2 Definitions

The definitions live here; `aggregate-signals.ts` implements them and its header comment repeats them.

| Term | Definition |
|---|---|
| Week | ISO week keyed by its Monday. `partial: true` when it straddles the range edge or is not over at `asOf`. Partial weeks are excluded from `avgPerWeek`. |
| `asOf` | The client's local day on the route; for the evaluator, the server's today in the Health Profile time zone (UTC when unset). It is the aggregator's clock. |
| Planned | Every program workout whose occurrence date (`occurrenceDate` in `today/resolve-today.ts`) lies in the range, using the current plan structure plus archived rows a logged workout points at. A session is **due** when its date is before `asOf` or it was already started; only due sessions count as planned, so today's session never lowers adherence until it is done or the day is over. |
| Status | `done` (linked completed workout), `partial` (done, below 60 percent of planned sets), `in_progress` (linked in-progress workout), `missed` (before `asOf` with none of those), `upcoming` (never missed). A session is matched to its workout by the link, not by the day it was done: one started through "Choose another session" on a different day than its occurrence date is `done` (or `partial`, or `in_progress`), never `missed`, and keeps `plannedFor` at the occurrence date. A session done early counts as due because it was started. |
| Partial | Completed with `setsDone / setsPlanned` below 0.6 (`PARTIAL_SESSION_RATIO`). Planned sets come from the session snapshot, else the current plan. |
| Cardio completion | For a planned exercise with a duration and/or distance target (a cardio prescription), the logged duration (or distance) summed over that exercise's completed non-warm-up sets, divided by the target. With both targets the better of the two ratios counts; with nothing logged it is 0. A cardio prescription without a set count plans one set. |
| Session completion | A session without a cardio prescription keeps the sets rule above. With one, each cardio exercise has its own ratio, the rep exercises share their sets ratio (cardio exercises excluded), and the session ratio is the **lowest** of them: the session is `done` only when every cardio exercise reached 60 percent of its target and the rep exercises meet the sets rule, else `partial`. `completionPct` is that lowest ratio in percent (capped at 100). Targets come from the session snapshot (`plannedExercises`) when the workout was started from the plan, else the current plan, so a later edit of the target does not regrade a logged session. |
| Extra | Completed workouts in the range linked to no plan at all. |
| `adherencePct` | `completed / planned` in percent (one decimal); `null` when planned is 0. A partial session counts as completed. |
| Streaks | `missedStreak` and `completedStreak` count planned sessions in a row, from the most recent due one. |
| Frequency | Every completed workout per week, linked or not. `avgPerWeek` is the mean over complete weeks. |
| Hard set | A completed, non-warm-up set with `reps >= 1` (a duration or distance for time-tracked exercises), credited in full to each **primary** muscle of the exercise. Secondary muscles are not counted. |
| `plannedSets` | Per muscle and week, from the current plan, next to `hardSets`. |
| Tonnage | Sum of `weightKg x reps` over weighted hard sets; `null` when none was weighted. Bodyweight sets count toward sets, not tonnage. |
| Lifts | Working sets as the workout records define them (`workouts/workout-records.ts`). Top set per session: the heaviest, then most reps. `e1rmKg` is that module's Epley estimate, `null` above 12 reps. |
| Lift trend | Over the last up-to-4 sessions with an e1RM: mean of the latest 2 against the earliest 2. Above +2 percent `up`, below -2 percent `down`, else `flat`. Under 3 sessions `insufficient`. |
| `prInRange` | A weight, rep or e1RM record (the workout-record rules) earned inside the range against everything before it. |
| Effort | `avgRpe` over completed non-warm-up sets with an RPE; `setsAtRpe9Plus` counts those at 9 or more. `rpeTrend` compares the mean of the first and second half of the per-session averages (4 or more sessions): above +0.5 `rising`, below -0.5 `falling`, else `flat`, otherwise `insufficient`. |
| Pain | Sessions of an exercise in the last 28 days (`PAIN_WINDOW_DAYS`); a session is flagged when any set carries the pain flag. Exports `lastFlaggedOn`, `flaggedSessions28d` and `consecutiveFlaggedSessions` (from the most recent session), never `painNote`. |
| Readiness | Check-in scores of the last 7 days (`READINESS_WINDOW_DAYS`), numbers only. A **low** day has energy <= 2, sleep quality <= 2, soreness >= 4 or stress >= 4 (soreness and stress: higher is worse). `lowStreak` is the run of low days ending at `asOf`, or the day before when `asOf` has no check-in yet. |
| Body | Weight over the last 8 weeks (`BODY_WINDOW_DAYS`): the latest value and the least-squares slope in kg per week (3 or more points on 2 or more days, else `null`); latest body-fat percent when measured. |

Known simplification: past planned days follow the current plan structure. Agent adaptations touch only unstarted weeks and archiving preserves history, so drift comes only from manual rewrites of the past. When the plan changed inside the range, `planChangedOn` carries the latest change day so a client can say so.

### 2.3 Limits

| Constant (`plan-signals.contract.ts`) | Value | Meaning |
|---|---|---|
| `SIGNALS_MAX_WEEKS` | 26 | Longest range (182 days). |
| `SIGNALS_DEFAULT_WEEKS` | 8 | Default range: the Monday 7 weeks before `to`'s week through `to`. |
| `SIGNALS_MAX_SET_ROWS` | 25,000 | Set rows read per request. Beyond it `range.from` moves forward to the oldest day that fits and `truncated` is `true`. |
| `SIGNALS_AS_OF_WINDOW_DAYS` | 2 | `asOf` may differ from the server's today by at most this many days. |
| `EVALUATOR_COMPLETE_WEEKS` | 6 | The evaluator's range: this many complete weeks plus the current one. |

### 2.4 Compact signals for agents

`compactSignals(signals, { maxExercises: 12, maxWeeks: 8, maxMuscles: 12 })` is pure and deterministic.

- Keeps every total, streak and summary block (frequency, effort, readiness, body).
- Keeps the most recent `maxWeeks` weeks of adherence, frequency, per-muscle volume and planned sessions.
- Keeps the `maxMuscles` muscles with the most hard plus planned sets.
- Keeps the `maxExercises` lifts that matter most: flagged first (pain, a PR in range, a trend up or down), then by sessions.
- Reports what it dropped in `dropped` (weeks, sessions, muscles, exercises, pain).
- Stays under `COMPACT_TOKEN_BUDGET` (6,000 tokens, estimated as `ceil(chars / 4)` of the JSON) for a 26-week user with the default caps.

`TrainingSignalsService.forEvaluator(userId, programId)` and `compactForEvaluator` are the entry points for an agent's context builder.

## 3. Configuration and permissions

- **Env vars:** none.
- **Settings keys:** none.
- **Permission:** `programs:read`. No `AiEnabledGuard`.

| Method and path | Permission | Notes |
|---|---|---|
| `GET /api/training/signals` | `programs:read` | Caller-scoped; response `{ data: PlanSignals }`. |

Query parameters (all optional, unknown keys rejected):

| Parameter | Default | Rule |
|---|---|---|
| `programId` | the caller's active program | A UUID; another user's program is 404. |
| `to` | `asOf` | Real calendar date. |
| `from` | the Monday 7 weeks before `to`'s week | Real calendar date. |
| `asOf` | the server's today in the Health Profile zone (UTC when unset) | Within 2 days of it. |

Errors:

| Status | Cause |
|---|---|
| 400 | Malformed or unreal date, `from` after `to`, or a range over 26 weeks (`details.reason: SIGNALS_RANGE_INVALID` for the service-level check). |
| 400 | `asOf` more than 2 days from the server's today (`details.reason: SIGNALS_AS_OF_OUT_OF_RANGE`). |
| 401 / 403 | Not authenticated / missing `programs:read`. |
| 404 | `programId` is not the caller's. |

A caller with no program gets `200` with `programId: null`, empty adherence and zeroed structures, while frequency, volume, lifts, effort, pain, readiness and body still describe the caller's training.

## 4. Extending it in a fork

- **Add a signal.** Add the field to `plan-signals.contract.ts`, compute it in `aggregate-signals.ts` (keep it pure), extend the loader only if it needs rows it does not read, update the definitions table above and decide in `compact-signals.ts` whether it survives compaction.
- **Change a threshold.** Constants for windows and limits live in the contract; the trend and low-day thresholds live beside their computation. Update the table above in the same change.
- **Feed an agent.** Call `compactForEvaluator`; never hand raw sets to a model.
- **Keep the boundary.** `signals-boundaries.spec.ts` requires the aggregator, compactor and contract to stay free of Nest and Prisma so persona fixtures can run them bare.

## 5. Guardrails

- `apps/api/src/programs/signals/aggregate-signals.spec.ts`: fixture weeks for every definition, thresholds, streaks, and degenerate input without `NaN` or `Infinity`.
- `apps/api/src/programs/signals/aggregate-signals.cardio.spec.ts`: cardio completion by duration and by distance, the better of two ratios, warm-up and uncompleted sets excluded, the 60 percent rule across cardio and rep exercises, snapshot targets, and a reps-only session unchanged.
- `apps/api/src/programs/signals/compact-signals.spec.ts`: caps, flagged lifts kept, drops reported, token budget for a 26-week fixture.
- `apps/api/src/programs/signals/signals-boundaries.spec.ts`: no Nest or Prisma reachable from the aggregator, compactor and contract.
- `apps/api/test/programs/training-signals.integration.spec.ts`: auth, validation, range and `asOf` limits, ownership, empty state.
- `apps/api/test/programs/training-signals.db.spec.ts`: loader correctness against real Postgres, ownership, row cap and the query plan.

## 6. Design decisions

- **Compute on read, not by job.** A bounded fetch and a pure function are fast at personal scale. If it ever gets slow, the work becomes a queue job.
- **Bounded fetch plus pure function, not SQL-only aggregation.** SQL is faster but hard to unit-test and to keep aligned with the workout record maths.
- **Only due sessions are planned.** Counting today's session before the day ends would punish a user who trains in the evening.
- **Primary muscles only.** Fractional credit for secondary muscles is common in coaching tools but hard to explain.
- **Current structure for past weeks.** Rebuilding planned days from version history is heavy for little gain, since agent changes never touch started weeks. `planChangedOn` surfaces the caveat.
- **No readiness score.** Weighting four scales of mixed polarity is an unvalidated clinical-looking claim.
- **Counts, never text.** Pain and check-in notes stay out of the contract, so nothing a user typed reaches a prompt through signals.

## 7. Verification

```bash
npm test --workspace=api -- aggregate-signals compact-signals signals-boundaries training-signals
npm run test:db --workspace=api -- training-signals
npm run openapi:dump && npm run openapi:lint
```

Observe: all suites pass; `GET /api/training/signals` appears in `/api/docs` under "Programs"; `from` after `to` answers 400 and another user's `programId` answers 404.

## History

- E5.9 (issue 102): the signals contract, pure aggregator, compact form, loader, service and `GET /api/training/signals`, under epic 92.
- Epic #260 (cardio and everyday activity): grading a session with a duration or distance prescription by logged duration and distance: #263, on the prescriptions of #262.
