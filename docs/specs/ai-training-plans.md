# AI training plans

> **Status:** shipped · **Code:** `apps/api/src/programs/`, `apps/api/src/training-agents/`, `apps/web/src/pages/Train/`, `apps/web/src/components/training/` · **API:** `/api/programs/*`, `/api/ai/training/*`, `/api/training/*` (see `/api/docs`) · **User UI:** `/train/plans`, `/train/plans/new`, `/train/plans/runs/:runId`, `/settings/ai/agents` · **Runbook:** [ai-training-plans.md](../runbooks/ai-training-plans.md) · **Recipe:** [AI README, "Adding a training agent or node"](../../apps/api/src/ai/README.md#adding-a-training-agent-or-node)

Four cooperating agents build and maintain a training plan. A researcher gathers cited evidence from the web, a planner drafts a plan, a critic reviews it and an evaluator adapts the plan from the person's logged training. The agents run as LangGraph graphs above the AI gateway, inside one server-only queue job per run, and every model call still goes through `AiService`. A deterministic server layer (guardrails, an adaptation envelope, a citation verifier) decides what ships; a model only proposes. A new plan arrives as a draft the owner reviews. An adaptation of an active plan is visible and reversible, or confirmable on request.

This page is the single home for the design of the agents: roles, graphs, run state machine, contracts, guardrails, events, data minimisation, settings and limits. Plan storage, versions and Today are summarised in [ARCHITECTURE.md §5.25](../ARCHITECTURE.md#525-training-programs); signals are in [training-signals.md](training-signals.md).

## 1. Purpose

**What it is.**

- A way for a person to get an evidence-informed plan that fits their goal, level, time, limits and gym, and to have it adjusted as they train.
- A reference pattern for multi-agent workflows on this template: graph above the gateway, checkpoints, persisted events, caps, guardrails, and a fake provider for tests.

**What it is not.**

- **Not medical advice.** The agents give general fitness guidance. They never diagnose, prescribe or advise training through pain. Urgent-symptom text stops the flow before any model call (G0).
- **No deterministic plan generator.** There is no rule-based fallback that builds a plan without a model. With AI off, the manual builder, Today, the viewer, history and signals keep working; only generation and adaptation stop.
- **Researcher is OpenAI-only in v1.** The one hosted web search the platform drives is OpenAI's. The planner, critic and evaluator run on any provider with the `responses` and `structured_output` capabilities.
- **Drafts arrive for review.** A created or revised plan is a `draft` (or a new version of the plan) the owner reads and activates. Only adapting an already active plan is autonomous.
- **Autonomy is visible and reversible.** Every autonomous change writes a change log entry with what, why and evidence, raises a notification and can be undone in one tap. Hard safety bounds are enforced by server code that clamps or drops; they are never turned into questions.

**The problem it solves for a fork.** Agent features fail in the same places: a model invents a source or an exercise, a run outlives its request, cost is unbounded, personal data leaks into a prompt, and a reload loses progress. Each has one answer here, in code a fork can reuse.

## 2. How it works

### 2.1 Model and versions

A plan is a tree (`Program` > block > week > workout > exercise) with immutable, numbered versions and a change log; see [ARCHITECTURE.md §5.25](../ARCHITECTURE.md#525-training-programs) and [§6.1](../ARCHITECTURE.md#61-prisma-models) for tables.

- **One write chokepoint.** `ProgramsService.createWithTree` (version 1) and `ProgramsService.applyChange` (every later change) are the only writers. Manual edits, reverts and agent changes share them. An agent run reaches them through `training-agents/runtime/training-programs.port.ts`.
- **Provenance.** An AI version stores `origin`, rationale, verified evidence and `meta` (models, efforts, critic rounds, tokens). The plan screen shows it as "how it was made".
- **Runs.** `training_plan_runs` holds one row per agent run: `kind` (`create`, `revise`, `evaluate`), `trigger`, `status`, `stage`, the frozen `roleModels` and `tokenCap`, `usage`, `result`, `pendingDecision`, `resumeCount`. `programId` is a plain column, so a run outlives a deleted plan as an audit record.
- **Partial unique indexes.** `training_plan_runs_active_per_user_uniq_idx` (one active run per user) and `programs_one_active_per_user_uniq_idx` (one active plan per user) exist only in migration SQL, like the other raw-SQL indexes listed in [ARCHITECTURE.md §6.1](../ARCHITECTURE.md#61-prisma-models). Never replace them with a `findFirst` pre-check: the database decides a race.

### 2.2 Graphs and the run state machine

`TrainingAgentsModule` builds each graph per job with that job's `NodeContext` bound in and compiles it over `PrismaCheckpointSaver`. Nodes and agents never import LangGraph; only `graph/create-graph.ts`, `graph/evaluate-graph.ts`, the runner and the saver build on it (the module and the boot check only load it). Nodes are plain functions; routes are pure functions in `graph/routes.ts`.

**Create graph** (`create` and `revise` runs):

```
prepare_context --create--> research -> plan -> guardrails -> critique -> route
                \--revise-----------------^   ^-- revise (round < max) --|
                                          ship, exhausted, skipped -> finalize -> END
```

| Node | What it does |
|---|---|
| `prepare_context` | Builds the minimised per-role context. A `revise` run reuses the plan's stored verified brief when its sources are under 30 days old and the goal and limitations are unchanged; otherwise the planner works without evidence |
| `research` | Runs the researcher (create only), verifies citations (G8), emits `research.*` events |
| `plan` | The planner drafts or revises; a revision also receives the critic's blockers and the server's repair list |
| `guardrails` | `applyGuardrails` compiles and repairs the draft (G1 to G9) |
| `critique` | The critic scores the repaired tree against the rubric |
| `finalize` | Writes through the programs chokepoint (`create`: `createWithTree`, a `draft` program with `source: 'ai'` and version 1; `revise`: `applyChange` with `expectedVersion` set to the run's base version), raises `training.plan_ready`, emits `plan.finalized` |

- **Ship rule (server, never the critic).** A draft ships when the guardrails are not `blocked`, the verdict is `approve`, every score is at least 4 and there are no blockers. Otherwise the loop returns to `plan` while critique rounds remain (`maxCriticRounds`, default 2, at most 3). When rounds run out the draft ships with warnings if the guardrails did not block it, and the run ends rejected (`TRAINING_PLAN_REJECTED`, nothing written) if they did.
- **Warning codes** (machine codes in `warnings`): `critic_open_notes` (rounds exhausted with the critic still asking for changes), `critic_skipped_budget` (budget spent after a valid draft existed), `critic_unavailable` (no valid verdict). The checked draft ships unreviewed or with open notes.
- **Finalize failures.** `TRAINING_PLAN_REJECTED` and `TRAINING_STALE_PLAN` (a `revise` run whose base version changed during the run; no automatic merge).

**Evaluate graph** (`evaluate` runs):

```
load_signals -> safety_gate --stop--> END
                          \-> evaluate -> envelope --structural--> critique_light -> decide
                                                   \-------------------------------^
decide: no_change  -> record_review -> END
        autonomous -> apply -> notify -> END
        ask_first  -> record_proposal -> await_approval (interrupt) --approve--> apply -> notify -> END
                                                                    \-reject---> notify -> END
```

| Node | What it does |
|---|---|
| `load_signals` | Deterministic. Reads the plan, the last 6 complete weeks plus the current one, linked sessions, the last 10 change log entries and stored evidence; builds the evaluator context. Emits `evaluation.signals` |
| `safety_gate` | Deterministic, before any model call: pain-note screen, pain pattern, forced removals, recovery flag (G0 and the safety stops in [§2.6](#26-guardrails)) |
| `evaluate` | One evaluator pass with one retry. No model call on thin data (nothing completed yet, or fewer than 3 due sessions): a server-authored `insufficient_data` and `no_change` |
| `envelope` | `applyEnvelope` (G10) bounds the evaluator's operations and merges forced safety removals |
| `critique_light` | The critic in adaptation mode reviews structural operations only (swap, remove, add, drop workout, set weekday, regenerate). Skipped with a warning when the critic has no usable model, the budget is spent or it cannot answer twice |
| `decide` | No accepted operation: `no_change`. Autonomy `ask_first` with at least one non-forced operation: `ask_first`. Otherwise `autonomous` |
| `record_review` | A `reviewed` change log entry, no version bump, no notification |
| `record_proposal` | Applies forced safety removals at once as their own version, then records one `proposed` change log row and raises `training.plan_proposal` |
| `await_approval` | `interrupt`: the run pauses as `awaiting_approval`, checkpointed, until the owner decides |
| `apply` | One `applyChange` on the evaluated version; a stale version is retried once on the newer tree when every target still exists and the envelope still passes, otherwise a `superseded` entry is recorded. An approved proposal applies on the version it was proposed against; a plan that changed since closes it `superseded` |
| `notify` | Raises `training.plan_adapted` after the write committed |

Every write node is resume-safe: it finds what this run already wrote (by run id) and never writes twice.

**Run state machine** (`training_plan_runs.status`):

| From | To | When |
|---|---|---|
| (none) | `queued` | `POST /api/ai/training/runs` freezes roles and cap and enqueues `ai.training.plan.run` in one transaction |
| (none) | `blocked_safety` | The safety screen stops the request; no job, no provider call |
| `queued` | `running` | The job claims the run |
| `running` | `succeeded` | The graph completed (including an evaluation that changed nothing) |
| `running` | `awaiting_approval` | A node interrupted; expires after 14 days |
| `running` | `interrupted` | Deadline, shutdown or a lost job; the checkpoint is kept |
| `running` | `queued` | Provider throttle: the job is deferred and the run continues from its checkpoint |
| `running` | `failed` | A terminal AI code, budget spent, a node's own `TRAINING_*` reason, a rejected outcome (`TRAINING_PLAN_REJECTED`), or an unexpected error |
| `running` | `blocked_safety` | The evaluate graph's safety stop |
| `interrupted` | `queued` | `POST .../resume` (at most 3 resumes in `resume_count`), or the automatic resume (at most 2, in the same counter) |
| `awaiting_approval` | `queued` | `POST .../decision` with the owner's choice |
| `queued`, `running`, `awaiting_approval`, `interrupted` | `cancelled` | `POST .../cancel`; a running run stops within one poll interval (2 s). The hourly sweep also cancels an expired proposal (`TRAINING_APPROVAL_EXPIRED`) |

`queued`, `running` and `awaiting_approval` are the active statuses. `succeeded`, `failed`, `cancelled` and `blocked_safety` are terminal.

### 2.3 Agents and contracts

| Role | Job | Needs | Default effort | Output contract |
|---|---|---|---|---|
| `researcher` | Web research for goal, level and limits | `responses`, `structured_output`, `hosted_tools` on an OpenAI model; `ai.hostedTools.web_search` on | `medium` | `EvidenceBrief` |
| `planner` | Drafts or revises the plan | `responses`, `structured_output` | `high` | `PlanDraft` |
| `critic` | Scores a draft against the rubric; in adaptation mode reviews structural operations | `responses`, `structured_output`; may call function tools | `high` | `CriticVerdict` |
| `evaluator` | Assesses progress and proposes typed plan changes | `responses`, `structured_output` | `medium` | `EvaluationResult` |

The role list is `TRAINING_AGENT_ROLES` in `common/schemas/settings.schema.ts`. The needs, default efforts and kind-to-role tables are in `training-agents/models/training-role-defaults.ts`; a `create` run needs all four roles, `revise` needs planner and critic, `evaluate` needs the evaluator and freezes the critic when usable.

Every contract is strict-mode compatible: every property required, nullable instead of optional, closed objects, because the schema is sent to the provider as the structured output format. Every model string is treated as untrusted and sanitised before storage.

**`EvidenceBrief`** (`agents/researcher/evidence-brief.contract.ts`): `summary`, `claims[]` (3 to 20; `topic`, `claim`, `applicability`, `confidence`, `sourceIds` 1 to 4), `sources[]` (2 to 20; `id`, `url`, `title`, `publisher`, `kind`, `year`) and `cautions[]` (at most 6). Topics: frequency, volume, intensity, progression, recovery, exercise selection, limitation guidance, adherence. The server turns it into a `VerifiedEvidenceBrief`: only sources whose normalised URL the run's own search returned survive, re-mapped ids, `domain` and `retrievedAt` added, `searchQueries` taken from the hosted tool result (never model text), `researchMode` (`single`, or `two_step` when the tool plus schema call fails) and `droppedClaims` and `droppedSources` counts.

**`PlanDraft`** (`agents/planner/plan-draft.contract.ts`): compact, in week types plus a sequence. `title`, `summary`, `rationale`, `totalWeeks` (1 to 24), `daysPerWeek`, `blocks[]` (at most 4; each with `weekSequence` and `weekTypes[]` of workouts with exercises) and `assumptions` and `safetyNotes`. An exercise is named by stable `exerciseKey` (slug) with sets, rep range, optional load and RPE, rest, a short rationale and `evidenceRefs`. `compile/compile-plan.ts` expands it into a plan tree; the model never sees or writes a row id.

**`CriticVerdict`** (`agents/critic/critic-verdict.contract.ts`): `verdict` (`approve`, `revise`), integer `scores` 1 to 5 on eight dimensions (`goal_fit`, `equipment_feasibility`, `volume_intensity`, `recovery`, `injury_handling`, `progression`, `adherence_realism`, `evidence_alignment`), `blockers[]` (dimension, path, issue, fix), `suggestions[]` and `summary`. A dimension under 4 blocks shipping.

**`EvaluationResult`** (`agents/evaluator/evaluation-result.contract.ts`): `assessment` (`status`: `on_track`, `ahead`, `behind`, `stalled`, `needs_recovery`, `adherence_gap`, `insufficient_data`; `summary`; `observations[]`), `decision` (`no_change`, `adjust`), `changes[]` (at most 8 `PlanChangeOperation`), a plain-language `userMessage`, `followUp`, `confidence` and `evidenceRefs` (brief claim ids).

**`PlanChangeOperation`** (`programs/contracts/plan-change.contract.ts`): a discriminated union on `op`, the only way the evaluator changes a plan:

| `op` | Changes |
|---|---|
| `set_prescription` | Sets, reps, RPE, rest, target load or load guidance of an exercise across a week range; `null` means leave as is |
| `swap_exercise` | Replaces an exercise with another by key |
| `remove_exercise` | Removes an exercise (`forced: true` only when the server prepared it) |
| `add_exercise` | Adds an exercise to a workout |
| `set_weekday` | Moves a workout to a weekday |
| `drop_workout` | Drops a workout slot |
| `mark_deload` | Marks a week as a deload |
| `regenerate_remaining` | Asks for a rebuild from a week; never automatic (E10) |

Plan rows are named by short ref (`W3-2-4` is week 3, workout 2, exercise 4; `W3-2` the workout). The server maps refs back to row ids and never trusts one it did not issue. An accepted operation is stored with its suppression `fingerprint` and a server-authored `description`.

### 2.4 Context and the never-send list

Each agent receives the smallest object that lets it work, built field by field from an allow-list, never by copying a row.

| Role | Receives |
|---|---|
| Researcher | Goal type and sentence, experience, limitation areas with the short description the user typed, days and minutes, an equipment class, free-text preferences. An age band and sex at birth only when the user ticked "Tailor research to my age and sex" (default off). The search tool's `userLocation` is never set |
| Planner and critic | The planner context: intake, health profile digest (whole-year age, not date of birth), latest weight and body-fat percent and an 8-week trend, 7-day readiness averages (scores only), the gym's capability set, candidate exercises by key, history summarised per exercise, time budget and the verified brief |
| Evaluator | Signals, the remaining plan by short ref, the profile digest, recent change log entries with the person's feedback (including undone changes) and the stored brief's claims by id |

`context/never-send.ts` is the one list of what no agent receives: name, email, date of birth, exact age, check-in notes, pain notes on sets, other free text, medications, labs and blood pressure, documents and photos, storage keys, other gyms, the gym's name, notes and location, other users' data and internal ids. A test seeds a unique canary in each source column and asserts it appears in no provider request. `POST /api/ai/training/estimate` returns `sentData` per agent (the included sections, what the context budget dropped, and the excluded list) rendered from the same object that is sent, so the panel cannot drift from the request. The Sent data panel shows it before Start.

Prompt injection containment: user text and web content are delimited data (`<context>`, `<evidence>`, `<review>`), and every agent prompt ends with the two fixed blocks in `agents/shared/prompt-blocks.ts` (`SAFETY_BLOCK`, `UNTRUSTED_DATA_BLOCK`), pinned character for character by a test. Every model-supplied id, key and URL is re-verified server-side.

`ContextBudget` trims a too-large input in a fixed order (history rows per exercise 6 to 3, candidate exercises 150 to 80, older sessions to counts, evidence items beyond 8, optional profile fields), then drops optional sections, and throws `TRAINING_CONTEXT_TOO_LARGE` only when required sections alone exceed the limit (70 percent of the window).

### 2.5 One path to the model

`AgentCaller` (`runtime/agent-caller.ts`) is the only route from a node to `AiService`. Per call it refuses to start after an abort, checks the run budget, builds the request from the role's frozen model (provider, model, reasoning effort, `metadata` `{ agent, node, round }`, output cap clamped to the model and the remaining budget), calls `AiService.forUser(userId, { jobId })` with the run's signal, charges usage and reports it. Three entry points: `structured`, `respond` and `withTools`. A `finishReason: 'length'` throws `AgentOutputTruncated`, so the node can retry more compactly. A provider throttle becomes `RunDeferredError`, which defers the job.

- **Researcher modes.** `single` asks for the brief schema together with the `web_search` tool. When that returns an invalid structured output, or the provider refuses the combination, `two_step` searches without a schema and then shapes the notes in a second call with no tools. One retry on insufficient output.
- **Research failures.** `TRAINING_RESEARCH_INSUFFICIENT` (fewer than 3 verified claims or 2 verified sources after one retry) and `TRAINING_RESEARCH_CONTEXT_MISSING`.
- **Checkpoints hold node outputs only.** Never a provider message, response id or reasoning item, so the `AI_PROVIDER_STATE` continuation state is never serialised. `PrismaCheckpointSaver` writes after each node (`durability: 'sync'`); a crash loses at most the running node, and a resume never re-runs a finished one.

### 2.6 Guardrails

All guardrails are pure, deterministic and server-side. `applyGuardrails` (`guardrails/index.ts`) runs G1 to G9 over a normalised copy of the tree in the fixed order **G1, G2, G6, G3, G4, G5, G7, G9, G8**, repairs what it can, renumbers, recomputes every workout's minutes and strictly re-parses the tree. It is idempotent. Status is `clean`, `repaired` (repairs and warnings only) or `blocked` (an unrepaired block). Severity is `block`, `repair` or `warn`. Messages quote exercise keys and numbers, never model words. The numeric limits live in `guardrails/limits.ts`; a fork tunes them in that one file.

| Rule | Checks | Repair |
|---|---|---|
| G0 safety screen | Urgent-symptom phrases in every free-text field of a request, before any run row or job exists (`guardrails/safety-screen.ts`). A pain, injury, recovery or pregnancy stem sets conservative mode, which caps RPE, sets per exercise and sets per session | Urgent: the run is `blocked_safety`, no job, no provider call, fixed guidance |
| G1 shape | Exercises exist in the library, unique weekdays, contiguous weeks, numbers in schema bounds | Drop unknown exercises and empty workouts, move duplicate weekdays, renumber; blocks on an empty week or a workout under 2 exercises |
| G2 equipment | Every exercise fits the gym (no gym: bodyweight only) | Substitute along the pattern ladder, else drop |
| G3 time | Workout duration within `minutesPerSession` x 1.05 | Trim ladder (rest, sets, accessories, priority lifts); warns when it cannot fit |
| G4 volume, intensity | Level caps on sets, reps, RPE, rest, weekly sets | Clamp; move a workout to a preferred weekday |
| G5 recovery | No hard-set overlap on consecutive days, a rest day, a deload at least every 6th week | Move the later workout, mark and transform the deload week, else warn |
| G6 injury, pain | Avoided or pain-flagged exercises absent, conservative caps, higher-risk patterns per limitation | Substitute or remove, clamp; warns for the critic on risky patterns |
| G7 progression | Bounded load rises per exposure, history-based limits, deload bounds | Lower the load |
| G8 citations | Evidence refs exist in the verified brief, rationale text is clean, statistics appear in the brief; every cited URL is one the run's search returned | Remove refs and unverified URLs; flag unmatched statistics; drop a claim left without a source |
| G9 loads | A model never invents a load; a first exposure follows recent history | Null or clamp the load, align `loadGuidance` |
| G10 envelope | Bounds on the evaluator's operations (table below) | Clamp or drop, recorded |

**G8 details.** `normalizeUrl` refuses a URL that may never be cited (not http or https, credentials, IP literal or localhost, too long). `verifyBrief` also drops a verified source on the domain denylist (`guardrails/research-domain-denylist.ts`: social networks, video pages, forums, marketplaces, shorteners). `sanitizeModelText` strips markup, control characters and unverified URLs from every model-authored string that reaches the database or the UI.

**G10 envelope** (`guardrails/envelope.ts`, limits in `guardrails/envelope-limits.ts`). Two layers. Forced safety removals always pass and come first.

| Rule | Bound |
|---|---|
| REF | Unknown refs, unknown exercise keys and no-ops are dropped |
| E1 frozen | Only workouts strictly after today without a linked session may change; a week range is narrowed to its unlocked weeks |
| E2 size | At most 8 operations and 6 distinct exercises per adaptation |
| E3 loads | An increase needs the G7 preconditions (last exposure met the rep floor, no recent pain flag, fewer than 3 low-readiness days in a row, not recovering, automation not paused, assessment not `needs_recovery`) and is one step; decreases always pass |
| E4 volume | Weekly hard sets per muscle rise by at most 2 sets and 15 percent and fall by at most 30 percent (at least 1 set); deloads, pain responses and dropped workouts excepted |
| E5 structure | At most 2 swaps per workout and 1 dropped slot; weekdays inside the preferred ones and never shared; workouts per week never below `max(2, daysPerWeek - 1)`; a changed workout keeps 2 exercises and its priority lift |
| E6 equipment, injury | A swapped or added exercise fits the gym and is neither avoided nor pain-flagged |
| E7 rate | One adaptation per 48 hours (recovery and pain responses exempt); one `regenerate_remaining` per 14 days |
| E8 deloads | Nothing shortens or intensifies a deload week |
| E9 feedback | A change the person undid or declined in the last 14 days (by fingerprint) is dropped |
| E10 escalation | `regenerate_remaining` is never run automatically; it is dropped and the message suggests asking the planner to revise |
| G1 to G9 | An operation after which they would repair or block something they did not before is dropped with their message |
| CRITIC | A structural operation the adaptation critic blocks is dropped |

While automation is paused every non-forced operation is dropped. An operation's `reason` is model text: sanitised, capped and only stored, never interpreted.

**Safety stops of the evaluate graph** (`guardrails/safety-stop.ts`, run by `safety_gate` before any model call):

| Trigger | Effect |
|---|---|
| Urgent-symptom text in a pain note of the last 14 days (screened on the server; the note never leaves it) | Run `blocked_safety`, plan untouched, a `reviewed` entry by the system with fixed guidance, automation paused (`safety_text`), mandatory `training.plan_safety_stop` |
| One exercise flagged in 3 sessions in a row, or pain on 3 or more exercises in 14 days | Automation pauses (`pain_pattern`); the run continues read-only |
| One exercise flagged in 2 sessions in a row | Its unlocked future occurrences are removed (forced: applied in both autonomy modes and shown to the evaluator as already decided) |
| 5 low-readiness days in a row | The run is marked recovery |

All safety copy is fixed in code, never diagnoses and never says to train through pain (a test asserts it). The owner resumes paused automation from the banner on the plan viewer (see [§2.11](#211-web)) or with `POST /api/programs/:id/autonomy/resume` (`programs:write`, idempotent, no version bump, works with AI off).

### 2.7 Autonomy

Each plan has an `autonomy` switch, `autonomous` (default) or `ask_first`, set at creation or with `PATCH /api/programs/:id`. The default honours both the owner's preference for hands-off adaptation and the rule that AI changes stay visible and confirmable: every autonomous change is logged, notified and revertible; bounds are enforced by code. `ask_first` makes every non-forced change a proposal resolved by a graph interrupt. A proposal expires with its run (14 days). Only one proposal is open per plan; the scheduler does not start an evaluation while one is pending. Rejecting records the operations as suppression fingerprints for 14 days (E9).

Undo is `POST /api/programs/:id/revert` with the change log entry id, which restores the prior tree as a new version. An undone or declined change is not suggested again for 14 days. The plan screens show an unseen-change banner (`unseenChangeCount`, cleared by `POST /api/programs/:id/change-log/seen`).

### 2.8 Continuous evaluation

`training-agents/evaluation/` decides when an `evaluate` run starts. It creates runs through `TrainingRunsService.create`, so a scheduled run is an ordinary run.

| Trigger | Source |
|---|---|
| `workout_finished` | `workout.finished` event after commit (`workout-finished.listener.ts`) |
| `weekly` | The hourly sweep: the user's local Sunday from 18:00, at least 6 days after the last review, plan active at least 5 days; a weekly review in the last week of a block carries a deep-review hint |
| `missed_sessions` | The sweep, once a day per plan in the local 06:00 hour: `missedStreak` of 2 or more and the last evaluation at least 3 days old |
| `manual` | "Re-evaluate now": `POST /api/ai/training/runs` with `kind: "evaluate"` |

`evaluationGate` (`evaluation-gates.ts`) applies in order; the first failing gate is the answer. Skips (forget the request): `ai_disabled`, `graph_not_ready`, `no_active_program`, `automation_paused`, `evaluator_unavailable`, `proposal_pending`, `covered_by_queued_run`. Defers (remember it): `active_run`, `daily_cap` (3 automatic runs per UTC day), `manual_cooldown` (30 minutes after a manual run), `min_spacing` (30 minutes between automatic runs). A deferred `workout_finished` request stamps `programs.evaluation_requested_at`; when any run settles, a follow-up request honours the flag (exempt from the spacing), so a burst of workouts costs at most one extra run. Local time is the health profile's `timeZone`, UTC when unset. A manual run inside the cooldown answers `409` with `details.reason: TRAINING_EVALUATION_COOLDOWN` and `retryAfterSeconds`. The limits are code constants in `evaluation.constants.ts`; the AI kill switch is the only global off.

The hourly sweep (`training.evaluation.sweep`, enqueued by a cron that only enqueues) also expires proposals past their deadline and serves due plans oldest-evaluated first, at most 200 users and 500 runs per pass.

### 2.9 Persisted events, SSE and replay

Every lifecycle and usage event is a `training_run_events` row with a gapless per-run `seq`. `RunEventsService.append` allocates `seq` with one atomic `UPDATE ... RETURNING` on the run row and inserts the event in one transaction. `emit` is `append` that logs and returns instead of throwing, so an event can never fail a node. `GET /api/ai/training/stream/:runId?after=<seq>` (or `Last-Event-ID`) replays events after `seq`, then tails by polling once a second, so any API replica can serve it. Frames are `id: <seq>`, `event: <type>`, `data: <json>`; a `: ping` comment every heartbeat; a closing `event: end` with `{ status }` once the run is `succeeded`, `failed`, `cancelled`, `blocked_safety` or `awaiting_approval` and the log is drained. A client disconnect never cancels the run. The browser folds events idempotently by `seq` (`utils/reduceRunEvents.ts`) and reconnects with the last contiguous `seq`.

A type is registered with a strict Zod schema (`registerRunEventType`); `append` refuses an unregistered type and data its schema rejects. Payloads carry identifiers, enums, counts, durations and codes. Never prompt text, model output, user text or keys. The bounded exceptions are the search queries and each verified source's URL, title and domain, the critic's sanitised blocker issues and summary, and server-authored repair summaries.

| Event | Emitted by | Payload |
|---|---|---|
| `run.queued`, `run.started`, `run.resumed` | Runtime | kind, trigger; resume count and decision |
| `stage.started`, `stage.completed` | Graph hooks | node, round, duration |
| `agent.usage` | `AgentCaller` | role, node, provider, model, round, step, token counts, latency |
| `run.deferred` | Handler | `retryAfterMs` |
| `run.interrupted` | Handler | reason: `deadline`, `shutdown`, `lost` |
| `run.awaiting_approval` | Handler | kind, `expiresAt` |
| `run.completed`, `run.failed`, `run.cancelled` | Handler | status and token totals; error code; none |
| `research.query`, `research.source`, `research.brief` | `research` | queries; one verified source; counts and mode |
| `plan.draft`, `guardrail.report` | `plan`, `guardrails` | round and counts; status, counts, repair summaries |
| `critic.round` | `critique` | scores, sanitised blockers and summary |
| `plan.finalized` | `finalize` | program id, version, warning codes |
| `evaluation.signals`, `evaluation.safety` | `load_signals`, `safety_gate` | counts; level and flags |
| `evaluation.assessed` | `evaluate` | status, decision, counts, confidence, attempts, skip reason |
| `adaptation.envelope`, `adaptation.critique` | `envelope`, `critique_light` | accepted, forced, clamped, dropped and rule codes; verdict |
| `adaptation.proposed`, `adaptation.applied`, `adaptation.closed` | `record_proposal`, `apply`, record nodes | operation counts and expiry; version; `reviewed`, `rejected`, `superseded` |

`agent.call` is reserved in the vocabulary and carries no schema; an emit of a type with no registered schema is dropped.

### 2.10 Jobs, cancel, retention

- **`ai.training.plan.run`** executes one run. Payload `{ runId }`, subject `training_run`. Profile 25 minutes, 1 attempt; server-only permanently (no `nodeResultSchema`, no `persistNodeResult`). A provider throttle defers the job without charging the attempt. A deadline or shutdown interrupts the run at its checkpoint. A job that settles `failed` while its run is still `running` or `queued` interrupts the run and queues one automatic resume, at most twice; past that the run fails `TRAINING_RUN_LOST`.
- **`training.evaluation.sweep`**: hourly at minute 7, only while AI is on; profile 10 minutes, 3 attempts.
- **`training.runs.purge`**: daily at 05:30. For finished runs, events and checkpoints are deleted after 30 days and the run row after 365 days; orphaned checkpoints go after 30 days. Constants in `runtime/training-retention.ts`.
- **Cancel.** A cancel is observed on a 2-second poll (even from another replica); an open proposal of a cancelled evaluate run is declined.
- **Audit.** Start, cancel, resume, decision and completion write audit rows with ids, statuses and codes only.

### 2.11 Web

The wizard at `/train/plans/new` shows the estimate's `sentData` per agent, the token range and the cap before Start, and sends only the intake. The run view at `/train/plans/runs/:runId` (`hooks/useTrainingRun.ts`) shows stages, sources, guardrail repairs, critic scorecards and usage, and offers Cancel, Resume and Approve or Reject. The plan viewer shows rationale, how it was made, sources with evidence chips, the change log with Undo, and a "Revise with AI" box.

Plan-viewer pieces (`apps/web/src/components/training/`):

- `PlanAdjustedBanner`: shows an unseen autonomous change with one-tap Undo.
- `ProposalCard`: Approve or Reject for an ask-first proposal.
- `AutonomyControl`: switches the plan between autonomous and ask first.
- `ReEvaluateButton`: starts a manual evaluation, disabled with a message during the 30-minute cooldown.
- `AutomationPausedBanner`: shows the safety message and a Resume control that asks for confirmation, then calls `POST /api/programs/:id/autonomy/resume`.
- A Progress link opens `/train/plans/:id/progress`.

`/settings/ai/agents` picks a model and effort per role and shows each role's resolution state. Every AI affordance is hidden while AI is off or without `ai:use`, and the two AI routes redirect to `/train/plans`.

## 3. Configuration and permissions

**Settings.** No environment variable is added for any of it.

| Setting | Where | Meaning |
|---|---|---|
| `ai.taskModels.<role>` | User settings, `/settings/ai/agents` | `{ provider, modelId, reasoningEffort }` per role, each optional. Precedence: the role's preference, then `ai.defaultModel`, then a deterministic auto pick among usable capable models, else a blocking state |
| `ai.training.maxRunTokens` | User settings | Per-run token cap, 10,000 to 2,000,000. Absent: 400,000 for `create` and `revise`, 150,000 for `evaluate` |
| `ai.training.maxCriticRounds` | User settings | 1, 2 or 3; default 2 |
| `ai.enabled`, `ai.hostedTools.web_search` | `/admin/settings/ai` | Kill switch; the researcher cannot run while web search is off (off by default) |
| `ai.limits` | `/admin/settings/ai` | Platform request and output caps; apply to every agent call |
| `programs.autonomy` | Plan header column | `autonomous` (default) or `ask_first` |

Role resolution states (`GET /api/ai/training/models`): `ready`, `auto`, `stale_preference` (runnable), and the blocking `no_key`, `no_models`, `missing_capability`, `web_search_disabled`, `ai_disabled`. A run that needs a blocked role is refused at start with `409 TRAINING_ROLE_UNAVAILABLE`.

**Cost and caps.** Protection is layered: `ai.limits` on every call; the per-run token cap frozen on the run at start and checked before each call by `RunBudget` (counting input, output and reasoning tokens; rebuilt from the run's usage on resume, so a resumed run spends against the same cap); the output cap of each call clamped to the remaining budget; and a pre-run estimate (`POST /api/ai/training/estimate`, a range, never a quote). One active run per user. Usage is shown as tokens per agent and key source; no currency is computed because the platform has no price catalog. A spent budget fails the run `TRAINING_RUN_BUDGET_EXCEEDED`, except that a critique or revision the budget cannot pay for ships the checked draft with `critic_skipped_budget`.

**Permissions.** `ai:use` for every `/api/ai/training/*` route (behind `AiEnabledGuard`); `programs:read` and `programs:write` for plans; `workouts:write` also for starting a planned workout; `ai_config:read` and `ai_config:write` for the admin switches. The permission matrix is in [ARCHITECTURE.md §7.2](../ARCHITECTURE.md#72-permission-matrix).

**Errors.** `details.reason` or `error_code` values: `TRAINING_RUN_ACTIVE` (409, `details.runId`), `TRAINING_ROLE_UNAVAILABLE` (409, `details.role`, `details.state`), `TRAINING_STALE_PLAN` (409, `details.currentVersion`), `TRAINING_EVALUATION_COOLDOWN` (409), `TRAINING_RUN_NOT_RESUMABLE` (409), `TRAINING_RUN_NOT_AWAITING_DECISION` (409), `TRAINING_NOT_IMPLEMENTED` (501, while a kind's graph is not ready), and on the run row `TRAINING_RESEARCH_INSUFFICIENT`, `TRAINING_PLAN_REJECTED`, `TRAINING_RUN_BUDGET_EXCEEDED`, `TRAINING_RUN_LOST`, `TRAINING_CONTEXT_TOO_LARGE`, `TRAINING_SAFETY_STOP`, `TRAINING_APPROVAL_EXPIRED`, plus shared `AI_*` codes.

**Notifications.** `training.plan_ready` (after finalize), `training.plan_adapted` (after an autonomous or approved change, and for forced removals applied before a proposal), `training.plan_proposal` (ask-first) and the mandatory `training.plan_safety_stop`. Each is raised after the write commits, outside any transaction; see [the notifications README](../../apps/api/src/notifications/README.md).

**Routes** (compact; per-endpoint detail in `/api/docs`):

| Route | Permission | Purpose |
|---|---|---|
| `GET /api/ai/training/models`, `POST /api/ai/training/estimate` | `ai:use` | Role resolution; token estimate and `sentData` |
| `POST /api/ai/training/runs` | `ai:use` | Start a `create`, `revise` or `evaluate` run (202; 200 with `blocked_safety`) |
| `GET /api/ai/training/runs`, `GET /api/ai/training/runs/:runId` | `ai:use` | List and read own runs |
| `POST /api/ai/training/runs/:runId/cancel`, `/resume`, `/decision` | `ai:use` | Cancel, resume an interrupted run, decide a proposal |
| `GET /api/ai/training/stream/:runId` | `ai:use` | SSE replay and tail |
| `/api/programs` (list, create, read, patch, structure, activate, pause, archive, duplicate, delete) | `programs:read` or `programs:write` | Plans |
| `POST /api/programs/:id/autonomy/resume` | `programs:write` | Resume paused automation |
| `GET /api/programs/:id/versions`, `POST /:id/revert`, `GET /:id/change-log`, `POST /:id/change-log/seen` | read or write | History, undo, banner |
| `GET /api/training/today`, `GET /api/training/signals`, `POST /api/program-workouts/:id/start` | `programs:read` (+ `workouts:write` to start) | Today and signals |

nginx unbuffers `/api/ai/training/stream` ([ARCHITECTURE.md §10.3](../ARCHITECTURE.md#103-nginx-routing)).

## 4. Extending it in a fork

| To | Do |
|---|---|
| Add an agent or node | Follow [the AI README recipe](../../apps/api/src/ai/README.md#adding-a-training-agent-or-node) |
| Change a limit (sets, RPE, envelope, evaluation spacing) | Edit `guardrails/limits.ts`, `guardrails/envelope-limits.ts` or `evaluation/evaluation.constants.ts`; update the table in §2.6 or §2.8 |
| Add an event type | `registerRunEventType` beside the emitting node, with a strict schema of identifiers, enums and counts |
| Add a never-send entry | Add it to `context/never-send.ts`; the canary test picks it up |
| Allow another provider for the researcher | Needs a provider whose hosted web search the platform drives; extend `RESEARCHER_PROVIDERS` and the provider's adapter under `ai/providers/<provider>/`, with its own SDK boundary spec |
| Add an AI provider | [ai-platform.md §4](ai-platform.md#4-extending-it-in-a-fork); agents work on it as soon as its models declare the needed capabilities |
| Add a scenario | [TESTING.md](../TESTING.md#fake-responses-server-and-training-scenarios) |

## 5. Guardrails

Tests that enforce the invariants (paths under `apps/api/` unless noted):

- `src/training-agents/guardrails/apply-guardrails.spec.ts`, `hostile-planner.spec.ts`, `shape.spec.ts`, `volume-injury-recovery.spec.ts`, `progression-loads-citations.spec.ts`, `duration.spec.ts`, `equipment.spec.ts`: G1 to G9, idempotence, and hostile drafts never shipping.
- `src/training-agents/guardrails/citations.spec.ts`: G8 verification against what the search returned.
- `src/training-agents/guardrails/safety-screen.spec.ts`, `safety-stop.spec.ts`: G0 and the evaluate safety stops, including the copy assertions.
- `src/training-agents/guardrails/envelope.spec.ts`, `src/training-agents/evaluation/apply-operations.spec.ts`: G10 rules E1 to E10.
- `src/training-agents/agents/shared/prompt-blocks.spec.ts`: the safety and untrusted-data blocks are pinned.
- `src/training-agents/context/build-planner-context.spec.ts`, `src/training-agents/agents/researcher/researcher-context.spec.ts`, `src/training-agents/evaluation/build-evaluator-context.spec.ts`: the never-send canaries and allow-lists.
- `src/training-agents/runtime/run-events.registry.spec.ts`, `run-events.sse.spec.ts`: strict payloads, registration, replay and end frames.
- `src/training-agents/runtime/agent-caller.spec.ts`, `run-budget.spec.ts`, `context-budget.spec.ts`: the one path to the model, caps and trimming.
- `src/training-agents/graph/training-graphs.spec.ts`, `create-graph.scenarios.spec.ts`, `evaluate-graph.scenarios.spec.ts`: routing, ship rule and graph wiring.
- `src/training-agents/runtime/training-plan-run.handler.spec.ts`, `training-runs.service.spec.ts`, `training-retention.spec.ts`: run outcomes, resume ceilings and retention.
- `src/training-agents/evaluation/evaluation-gates.spec.ts`, `evaluation-due.spec.ts`, `training-evaluation.scheduler.spec.ts`, `training-evaluation-sweep.handler.spec.ts`, `workout-finished.listener.spec.ts`: triggers, gates and the sweep.
- `test/ai/ai-orchestration-boundary.spec.ts`: LangGraph and `@langchain/core` only under `src/training-agents/`, no `@langchain/<provider>`, no `@ai-sdk/*`.
- `test/ai/ai-no-sdk-leak.spec.ts`, `ai-kill-switch.integration.spec.ts`, `ai-rbac-matrix.integration.spec.ts`, `ai-secret-egress.integration.spec.ts`, `ai-key-policy.integration.spec.ts`, `ai-jobs-server-only.spec.ts`: the AI platform guards discover the training routes and job type automatically. `ai-training-models.integration.spec.ts`, `ai-training-runs.integration.spec.ts` and `ai-training-stream-nginx.spec.ts` pin these routes and the SSE location.
- `test/jobs/cron-enqueue-only.spec.ts`, `on-event-no-io.spec.ts`: the sweep and purge crons only enqueue, and the evaluation listeners do no long-running work.
- `src/training-agents/graph-runtime-info.spec.ts`, `test/training-agents/training-graph-telemetry.spec.ts`: LangGraph loads at boot and framework telemetry is forced off.
- `src/programs/today/no-ai-import.spec.ts`: the programs layer has no AI dependency, so manual plans work with AI off.
- Real Postgres (`*.db.spec.ts`): `test/training-agents/prisma-checkpoint-saver.db.spec.ts`, `training-plan-runs.db.spec.ts`, `training-runtime.db.spec.ts`, `training-plan-finalize.db.spec.ts`, `training-evaluation.db.spec.ts`, `training-evaluation-run.db.spec.ts` and the cross-story `training-flow.db.spec.ts`.
- Scenario suites and fixtures: `test/fixtures/training/scenarios/`, `test/training-agents/scenario-fixtures.spec.ts` (every fixture output parses with the real contracts and names only seeded exercises), `test/training-agents/scenarios/*.integration.spec.ts`, `test/fake-responses/fake-responses-server.spec.ts` and the Playwright `tests/e2e/specs/training-plans.spec.ts`. See [TESTING.md](../TESTING.md#fake-responses-server-and-training-scenarios).
- Plan quality: the evals in [TESTING.md](../TESTING.md#evals).

## 6. Design decisions

**LangGraph.js above the gateway.**
- The shape is a state graph with a critic loop, checkpoints after every node, an interrupt for "ask me first" and abort support; nodes are plain async functions, so no LangChain model class is needed.
- Every model call still goes through `AiService.forUser`, which keeps BYOK key resolution, the kill switch, capability checks, usage rows and the no-key-egress rules.
- Rejected: a hand-rolled runner (rebuilds checkpoints, interrupts and loops; kept only as a fallback that never became necessary), the Vercel AI SDK with DBOS (duplicates the job queue; ESM-only against a CommonJS build), Mastra (owns storage, server and tracing), provider agent SDKs (tie agents to one provider and break per-agent model choice), Temporal, Inngest and Restate (a second queue and a separate server).
- Orchestration is isolated to `graph/create-graph.ts`, `graph/evaluate-graph.ts`, the runner and the saver, so replacing it touches four files.

**Provider and agent-framework packages stay banned.** `@langchain/langgraph` and `@langchain/core` are allowed only under `apps/api/src/training-agents/`. Any `@langchain/<provider>`, `@ai-sdk/*` or provider SDK outside `ai/providers/<provider>/` fails `ai-orchestration-boundary.spec.ts` or `ai-no-sdk-leak.spec.ts`. Framework telemetry (LangSmith) is forced off in code.

**Checkpoints in Prisma.** `PrismaCheckpointSaver` implements LangGraph's saver over two Prisma-owned tables, keyed by a plain thread id (the run id). A library-created table (`PostgresSaver.setup()`) would live outside migrations. State holds node outputs only, so provider continuation state and reasoning items are never stored.

**The researcher is OpenAI-only in v1.** The platform drives one hosted web search: OpenAI's. A researcher on another provider could not search at all, so role resolution excludes other providers for it and says why. Planner, critic and evaluator need only `responses` and `structured_output`, so any provider works.

**Autonomy defaults to autonomous, with visible and reversible changes.** The owner chose hands-off adaptation. The product rule that important AI changes stay confirmable is honoured by making every change logged, notified and undoable in one tap, by server-enforced bounds, and by an `ask_first` switch per plan. A new plan is always a draft because the person has never seen it.

**No deterministic plan generator.** A rule-based fallback would be a second plan builder to maintain and would hide a missing model behind a worse plan. With AI off the manual builder remains. The guardrails are a validator and repairer, not a generator.

**The server ships, the model proposes.** The critic never decides shipping and the evaluator never writes a plan: the ship rule and the envelope are pure code. Out-of-bound changes are clamped or dropped and recorded, never turned into a question the user must answer.

**Events are persisted, not streamed from memory.** A reload or a dropped connection must replay, and the job may run on another replica. A table with a gapless `seq` and polling gives both with no in-process bus. Payload schemas are strict so a prompt cannot ride along.

**One job per run, resume is a new job.** `maxAttempts: 1` because a model call is neither idempotent nor free. A crash or an approval pause ends the job at a checkpoint; continuing is a new job for the same run. A throttle is the exception: it defers the job, which does not charge the attempt.

**A fake Responses server instead of a test hook.** An `AI_FAKE` switch would be a production test seam and AI must have no environment configuration. The `openai` provider slot's base URL is a real runtime setting, so a standalone fake needs zero production change. It replays the same scenario fixtures as Jest, validated against the contracts, so they cannot drift.

## 7. Verification

```bash
npm test --workspace=api -- training-agents programs
npm test --workspace=api -- test/training-agents/scenarios test/training-agents/scenario-fixtures
npm test --workspace=api -- test/ai test/jobs test/docs-links
npm run test:db --workspace=api -- training-flow
npm run typecheck --workspace=api
npm run openapi:dump && npm run openapi:lint
```

End to end with the fake provider and no key (see the [runbook](../runbooks/ai-training-plans.md#3-try-it-with-the-fake-provider)):

1. Start the stack with `fake-ai.compose.yml` and run `cd tests/e2e && npm test -- training-plans`.
2. By hand, select `happy`, sign in as a contributor, create a plan at `/train/plans/new` and watch the run. Then `curl localhost:4011/__control/requests`: one entry per model call with agent, model, effort and canary count `0`.
3. Select `critic-reject-once` and confirm two critique rounds; `planner-hostile` and confirm the repair list; `research-fabricated-url` and confirm the dropped source count; `slow` and reload mid-run, then cancel.
4. Activate a plan, finish a workout with `evaluator-autonomous` selected, and watch the change banner; Undo restores the prior version. Set the plan to ask first, repeat with `evaluator-structural`, and approve or reject the proposal.
5. Turn AI off at `/admin/settings/ai`: `/api/ai/training/*` answers `403`, the wizard redirects, and the manual builder, Today and the viewer still work.

## History

- #92: the epic, E5 Agentic training plan.
- #93: LangGraph.js spike, `PrismaCheckpointSaver` and the orchestration decision.
- #94: plan model, immutable versions, change log and revert.
- #95: per-role model and reasoning-effort settings.
- #96: runtime kit: the `ai.training.plan.run` job, checkpoints, persisted events and SSE.
- #97: research agent with web search, evidence brief and verified citations.
- #98: planner, critic loop and the server-side guardrails G0 to G9.
- #99: plan intake wizard, live run view and plan review.
- #100: Today's workout.
- #101: continuous evaluation, autonomous and ask-first adaptation, the envelope and safety stops.
- #102: plan signals and adherence.
- #103: scenario fixtures, the fake Responses server, end-to-end suites and this spec.
- #104: plan-quality evals.
