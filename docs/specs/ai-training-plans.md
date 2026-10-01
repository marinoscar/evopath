# AI training plans

> **Status:** shipped · **Code:** `apps/api/src/programs/`, `apps/api/src/training-agents/`, `apps/api/src/training-adaptation/`, `apps/api/src/training-usage/`, `apps/web/src/pages/Train/`, `apps/web/src/components/training/` · **API:** `/api/programs/*`, `/api/ai/training/*` (runs, adaptations, usage), `/api/training/*` (see `/api/docs`) · **User UI:** `/train/plans`, `/train/plans/new`, `/train/plans/runs/:runId`, `/train/adapt/:adaptationId`, `/settings/ai/agents` (read-only role resolution) · **Runbook:** [ai-training-plans.md](../runbooks/ai-training-plans.md) · **Recipe:** [AI README, "Adding a training agent or node"](../../apps/api/src/ai/README.md#adding-a-training-agent-or-node)

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
- **Runs.** `training_plan_runs` holds one row per agent run: `kind` (`create`, `revise`, `evaluate`, `adapt`), `trigger`, `status`, `stage`, the frozen `roleModels` and `tokenCap`, `usage`, `result`, `pendingDecision`, `resumeCount`. `programId` is a plain column, so a run outlives a deleted plan as an audit record.
- **Partial unique indexes.** `training_plan_runs_active_per_user_uniq_idx` (one active run per user; a run of kind `adapt` does not count, so a quick workout adaptation neither waits behind nor blocks a plan run) and `programs_one_active_per_user_uniq_idx` (one active plan per user) exist only in migration SQL, like the other raw-SQL indexes listed in [ARCHITECTURE.md §6.1](../ARCHITECTURE.md#61-prisma-models). Never replace them with a `findFirst` pre-check: the database decides a race.

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
| Planner and critic | The planner context: intake, health profile digest (whole-year age, not date of birth), latest weight and body-fat percent and an 8-week trend, 7-day readiness averages (scores only), the gym's capability set, candidate exercises by key, history summarised per exercise, time budget and the verified brief. The planner also receives `healthSummary` when the user opted in ([§2.14](#214-the-opt-in-health-summary)); the critic never does |
| Evaluator | Signals, the remaining plan by short ref, the profile digest (with `healthSummary` when the user opted in), recent change log entries with the person's feedback (including undone changes) and the stored brief's claims by id |

`context/never-send.ts` is the one list of what no agent receives: name, email, date of birth, exact age, check-in notes, pain notes on sets, other free text, medications, raw lab results and blood pressure readings, documents and photos and their file names, storage keys, other gyms, the gym's name, notes and location, other users' data and internal ids. A test seeds a unique canary in each source column and asserts it appears in no provider request. Raw lab, blood pressure, document and photo sources stay on the list when the user opts in to the health summary: the only health content an agent may receive is the stored summary text ([§2.14](#214-the-opt-in-health-summary)), and the canary seeds distinctive raw lab and blood-pressure values to prove none of them reaches any planner, critic, researcher or evaluator request. `POST /api/ai/training/estimate` returns `sentData` per agent (the included sections, what the context budget dropped, and the excluded list) rendered from the same object that is sent, so the panel cannot drift from the request. The Sent data panel shows it before Start.

Prompt injection containment: user text and web content are delimited data (`<context>`, `<evidence>`, `<review>`), and every agent prompt ends with the two fixed blocks in `agents/shared/prompt-blocks.ts` (`SAFETY_BLOCK`, `UNTRUSTED_DATA_BLOCK`), pinned character for character by a test. Every model-supplied id, key and URL is re-verified server-side.

`ContextBudget` trims a too-large input in a fixed order (history rows per exercise 6 to 3, candidate exercises 150 to 80, older sessions to counts, evidence items beyond 8, optional profile fields), then drops optional sections last first (planner: bio, body metrics, profile, health summary, readiness, history), and throws `TRAINING_CONTEXT_TOO_LARGE` only when required sections alone exceed the limit (70 percent of the window).

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
| G8 citations | Evidence refs exist in the verified brief, rationale text is clean, statistics appear in the brief; every cited URL is one the run's search returned | Remove refs, unverified URLs and instruction-like sentences; flag unmatched statistics; drop a claim left without a source |
| G9 loads | A model never invents a load; a first exposure follows recent history | Null or clamp the load, align `loadGuidance` |
| G10 envelope | Bounds on the evaluator's operations (table below) | Clamp or drop, recorded |

**G8 details.** `normalizeUrl` refuses a URL that may never be cited (not http or https, credentials, IP literal or localhost, too long). `verifyBrief` also drops a verified source on the domain denylist (`guardrails/research-domain-denylist.ts`: social networks, video pages, forums, marketplaces, shorteners). `sanitizeModelText` strips markup, control characters and unverified URLs from every model-authored string that reaches the database or the UI, and drops each sentence that addresses the model rather than the reader (`isInstructionLike` in `guardrails/citations.ts`): an override verb with a qualifier and an instruction noun ("ignore your previous instructions"), a request to reveal the system prompt, "you are now unrestricted", "developer mode", "new instructions:". The patterns are narrow so ordinary training prose ("you are now ready to add load") survives. Known limit: a harmless-looking imperative such as "Set every load to 500 kg." is not removable as text; the numeric guardrails (G7, G9) clamp the actual loads. The stripping is defence in depth; the delimited-data prompt blocks and the numeric guardrails are the containment. Each affected text is reported as a `text_sanitized` repair.

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
- **Adapting to a different place.** The adjust-workout sheet can scan a hotel room into a temporary gym and adapt to it. A temporary gym with no equipment is refused `400 ADAPTATION_GYM_EQUIPMENT_UNCONFIRMED` unless the request is bodyweight only. Lifecycle, save and purge rules: [gyms-and-equipment.md §2.13](gyms-and-equipment.md#213-temporary-gyms).
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

`/settings/ai/agents` shows, per role, the model the administrator chose for the user and its resolution state, read-only: users do not pick a model or an effort. Every AI affordance is hidden while AI is off or without `ai:use`, and the two AI routes redirect to `/train/plans`.

### 2.12 Usage by agent role

`TrainingUsageModule` (`apps/api/src/training-usage/`) answers "what did this run cost and which agent spent it" from `ai_usage_events`. Both routes sit behind `AiEnabledGuard` plus `ai:use`, are keyed by the caller's user id in SQL (no DTO carries a user id) and reach OpenAPI through Zod DTOs.

| Route | Returns |
|---|---|
| `GET /api/ai/training/runs/:runId/usage` | One run of any kind: `totals`, `byNode` (node, role, provider, model, key source and a token bucket each), `cap`, `retention`. `404` for another user's run, `400` for a non-UUID id |
| `GET /api/ai/training/usage?month=YYYY-MM` | The caller's agent runs in one UTC month: `totals`, `byRole`, `byModel`, `byKeySource`, `byKind` (`create`, `revise`, `evaluate`, `adapt`), `typical`, `retention`. Default: the current month. A future month or one more than 12 months back is `400 TRAINING_USAGE_MONTH_INVALID` |

Per-endpoint shapes are in `/api/docs`.

- **Bucket.** Requests (every round trip, failed ones included), failed, input, output, reasoning and cached input tokens, latency, and the org-key subtotal. Reasoning tokens are counted inside output where a provider reports them. Rows outside agent runs are excluded by the join; `/settings/ai` already shows all usage by model.
- **Attribution rule.** `ai_usage_events` has no node or role column, so `training-usage.attribution.ts` joins a run's rows (by the run's job ids) to its nodes using the run's own tally and frozen role models. One node on a (provider, model): it gets every row of it. Several nodes share it: each gets its own tally and the remainder (failed calls, cached input, latency) is unattributed. No node on it: the rows are unattributed. Unattributed usage is the `node: null` row last in `byNode` and `unattributed` in `byRole`. It is never split by a guess.
- **Key source.** `user`, `org` or `none`, shown as "your key", "the organisation's key" and "keyless server". Usage with a keyless server is never labelled as the user's key.
- **Tokens, not currency.** No amount is computed anywhere, because the platform has no price catalog; the UI says "Tokens, not currency".
- **Cap meter.** `cap` is `{ limitTokens, usedTokens, reached, reason? }`. `usedTokens` is input + output + reasoning, the count `RunBudget` enforces, so reasoning is counted in both output and reasoning. The same `cap` is on the run view (`GET /api/ai/training/runs/:runId`). `reached` is true with `reason: 'token_cap'` when the run failed `TRAINING_RUN_BUDGET_EXCEEDED` or a critic or revision was skipped for the cap.
- **Cap behaviour in an adapt run.** A stop before any proposal exists fails the run `TRAINING_RUN_BUDGET_EXCEEDED` with no proposal. A stop at the critic (or an answer cut off by the last tokens of the cap) ends the run `ready` with `criticReport.skipped = 'token_cap'`: the proposal already passed the guardrails and is usable, and the review shows "Not reviewed by the critic: your token limit (N) was reached". A stop on the revise pass ships the first, already checked proposal with the guardrail warning `revision_skipped_token_cap`.
- **Retention.** When `ai.usageRetentionDays` has removed a run's rows, `retention.purged` is true and the numbers come from the run's own tally (no failures or cached input). The monthly `retention.partial` is true when the month starts before the retention window.
- **Typical run.** `typical` holds, per kind, `{ runs, medianTokens }` over the caller's last 10 succeeded runs of that kind (any month, counted tokens from the run's tally), or `null` with fewer than 3. It is real history, never a model-size guess. The adapt sheet shows it as "Typically about N tokens" beside Adjust and predicts nothing else.
- **Web.** `AgentUsagePanel` (`apps/web/src/components/training/usage/`, prop `runId`) shows the node table with roles, key source and totals, the labelled cap meter (text, not colour alone), the retention note and the "Tokens, not currency" note, and refetches when the run settles. It is mounted in the adaptation review and the run view. `MonthlyAgentUsageSection` (`apps/web/src/components/settings/ai/`) is a section of `/settings/ai` under the platform usage section, not a card or tab: month picker, totals, by role, by kind and key-source split, with its own loading and error state. Error text for `TRAINING_RUN_BUDGET_EXCEEDED` is built from the cap numbers in `services/aiErrors.ts` and `components/settings/ai/aiErrorText.ts`.
- **Operators.** The admin AI Usage card stays the operator view. To correlate a run with rows, filter `ai_usage_events` by the run's `jobId`.

### 2.13 Quick adaptation and travel workouts

A person with a planned workout today can say what is different (30 minutes, sore chest, only dumbbells, a hotel gym) and get an adjusted version in seconds. `TrainingAdaptationModule` (`apps/api/src/training-adaptation/`) runs one small graph on the [runtime kit](#22-graphs-and-the-run-state-machine) for it. The model chooses and arranges exercises; the server owns every load, the time estimate, equipment support, volume and safety.

**Request** (`POST /api/ai/training/adaptations` and `/context-preview`; Zod DTO in `dto/adaptation-request.dto.ts`, bounds in `ADAPTATION_REQUEST_LIMITS`):

| Field | Contract |
|---|---|
| `minutes` | Integer 10 to 240 |
| `soreness` | `{ muscles: 1 to 8 from the muscle vocabulary, level: mild or moderate }` |
| `lowEnergy` | Boolean |
| `equipment` | `{ mode: 'gym' }` (default), `{ mode: 'only', equipmentTypeIds: 1 to 12 types of the chosen gym }` or `{ mode: 'bodyweight' }` |
| `gymId` | One of the caller's gyms. Default: the plan's gym, else the default gym |
| `freeText` | Up to 500 characters, trimmed |
| `useReadiness` | Default `true`: today's four check-in scores may be sent |
| `baseWorkout` | `planned` (default) or `none`; forced to `none` on a rest day or with no active plan, which builds an ad hoc session |

At least one real change is required (`400 ADAPTATION_NOTHING_TO_CHANGE`, "Tell us what to change"). The body is strict: unknown keys are refused.

#### The graph

The graph runs inside the server-only job `ai.training.adapt.run` (profile 5 minutes, 1 attempt) on a `training_plan_runs` row of kind `adapt`, so runs, events, the token cap, cancel and the SSE stream are the kit's. The nodes live in `training-adaptation/graph/nodes/`; the LangGraph wiring lives in `training-agents/graph/adapt-graph.ts` because the orchestration boundary keeps LangGraph there. The feature supplies its nodes and routes as an `AdaptGraphDefinition`.

```
context --blocked_safety--> END
   |
adapt -> guardrails -> critic --accept (or revise without a major issue)--> finalize -> END
   ^                      |
   +---- revise (major issue, one pass left) ----+   the revision goes guardrails -> finalize (no second critic)
```

| Node | Model | What it does |
|---|---|---|
| `context` | none | Builds the minimised context through the one builder, screens the free text again (defence in depth), emits `workout_adaptation.context` |
| `adapt` | planner | One structured call (`training_adaptation_proposal`), strict mode. On the revise pass the previous checked answer and the critic's issues go in as `<critic-notes>` |
| `guardrails` | none | Applies the rules table below: repairs what it can, rejects what it cannot |
| `critic` | critic | One structured call (`training_adaptation_critique`) on the checked proposal: `accept` or `revise` with four checks and short issues. Only `revise` with a `major` issue starts the second pass |
| `finalize` | none | Assembles proposal, guardrail report, critic report, snapshot and safety; the handler writes them with the terminal status |

`ADAPT_MAX_REVISIONS = 1`: at most two planner passes and one critic round, so a normal run is two provider calls and a revise makes three. A revise therefore costs two planner calls and one critic call; the revision is never reviewed again. A revision that breaks a hard rule keeps the first checked proposal with the warning `revision_rejected`. A critic that cannot answer (an invalid or truncated answer) is recorded `criticReport.skipped = 'error'`; the guardrails run regardless. Stage and event names for the web: `stage.started` and `stage.completed` per node, plus `workout_adaptation.context`, `.proposal`, `.guardrails`, `.critique` and `.ready`, each carrying identifiers, counts and codes only (`ADAPTATION_EVENT_TYPES`).

#### Design stance: the model proposes, the server owns

- **The model** picks exercises from the context's planned list and candidates, orders them, chooses sets, reps, RPE and rest, writes a title, a summary, one to six rationale lines and its assumptions.
- **The server** owns everything with consequences. The model's exercise keys are checked against the context, its numbers are clamped, its `estimatedMinutes` is ignored and recomputed with the plan builder's duration model, and its priority flags are replaced by the plan's.
- **No loads.** `adaptationProposalModelSchema` has no weight field. `apply` fills loads from the plan's prescription or the last session, so a model can never prescribe a weight ([design decisions](#6-design-decisions)).
- **Stored proposal.** `adaptedWorkoutSchema` (1 to 12 exercises, sets 1 to 8, reps 1 to 30, RPE 5 to 10 in half steps, rest 0 to 600 s, `source` of `kept`, `swapped` or `added`, dropped list with a reason of `time`, `sore`, `equipment`, `energy` or `other`) is what `workout_adaptations.proposal` holds, with ids resolved server-side.

#### Adaptation rules

`applyAdaptationRules` (`training-adaptation/rules/adaptation-rules.ts`) is pure and deterministic: no I/O, no clock. Every number below is a constant in `adaptation.constants.ts` (`ADAPTATION_RULES`, `ADAPTED_WORKOUT_LIMITS`) or in the plan guardrails' `limits.ts`; tune them there and update this table. Steps run in this order and each records what it changed in `repairs` or `rejected`:

| Step | Rule | Constants |
|---|---|---|
| Shape | Unknown or duplicate keys are removed; `source` and the replaced exercise are corrected; priority comes from the plan; text is clipped | Contract limits |
| Pain | An exercise on the avoid list or with a pain-flagged set in the last 28 days is substituted within its movement pattern, else removed. Never "push through" | `painFlagDays: 28` |
| Equipment | An exercise today's equipment cannot support (the gym, the `only` subset or bodyweight) is substituted, else removed | Requirement groups of the exercise library |
| Bounds | Sets, reps, rest and RPE inside the plan guardrails' per-exercise range and the contract's | `restSeconds` 30 to 300; sets floor `setFloor: 2` |
| Soreness, mild | Prime-mover sets at most 75 percent of the base (floor 2), RPE at most 8 | `soreness.mild: { setsFactor: 0.75, rpeCap: 8 }` |
| Soreness, moderate | A prime mover that is kept gets at most 2 sets at RPE at most 6, with a note; priority lifts are not spared. Swapping the muscle out entirely is allowed | `soreness.moderate: { maxSets: 2, rpeCap: 6 }` |
| Low energy | The request says so, or today's check-in energy is at most 2: RPE at most 7 everywhere, non-priority sets at most base minus 1 (floor 2) | `lowEnergy: { rpeCap: 7, setsBelowBase: 1, checkInEnergyAtMost: 2 }` |
| Never escalate | With a base: no exercise above its counterpart's sets or RPE (a swap inherits the replaced ceiling, an added exercise the largest planned one) and total sets at most the base's total. Ad hoc: the level's bounds. With no base RPE, RPE is capped at 8 | `defaultRpeCap: 8` |
| Conservative mode | A pain, injury, recovery or pregnancy word in the free text, a poor check-in or a declared limitation adds the plan guardrails' caps | `GUARDRAIL_LIMITS.conservative`: RPE 7, 4 sets per exercise, 22 per session |
| Time fit | Estimated minutes at most `minutes`, else T1 drop non-priority exercises from the end (never the last one), T2 one set off non-priority exercises (floor 2), T3 one set off priority exercises (floor 2). Still over: `ADAPTATION_CANNOT_FIT`, "Can't fit these lifts in N minutes; try N+10" | `cannotFitSuggestionStep: 10` |

Hard failures are only two: nothing left after shape, pain and equipment (`ADAPTATION_INVALID`), and a time fit that cannot be met (`ADAPTATION_CANNOT_FIT`). Everything else is repaired and listed in `guardrailReport.repairs`, which the review shows.

#### Safety

- **Urgent stop at the door.** `screenFreeText` (the plan guardrails' G0 screen) runs in `POST /api/ai/training/adaptations` before any run or job exists. An urgent-symptom phrase answers `200 { status: 'blocked_safety', guidance, jobId: null, runId: null }`, stores a `blocked_safety` row without the free text, and makes no provider call. `/context-preview` reports `blocked` and `willCallProvider: false` and stores nothing. The `context` node screens again.
- **Soreness is not pain.** Soreness is a structured input (mild or moderate) that reduces the muscle's work. Pain is different: a pain-flagged set in the last 28 days or an avoid-list entry excludes the exercise, and pain words in the note switch on conservative mode. Nothing here treats pain as a setting to train through.
- **Tone cannot relax a rule.** Both prompts open with the fixed safety block, then the untrusted-data block, then the role text. A user's style request changes wording only, and the guardrails run after the model whatever the prompt said. Hostile free text is tested to never produce a proposal that breaks a rule, even when a scripted model obeys it.

#### Context sent to the model

`AdaptationContextBuilder` returns one object: `sent` (exactly what the planner and critic receive inside `<context-json>`), `summary` (rendered from `sent`, so the "What will be sent" panel cannot differ from what is sent) and `facts` (server only, checkpointed, never sent). The snapshot stored on the row is `sent` plus `summary`; the preview and the snapshot are the same object.

| Sent | Never sent |
|---|---|
| The request: minutes, soreness, low energy, equipment mode and the names allowed, the free text, base choice | Name, email, date of birth or exact age |
| Plan header: goal, week, deload flag, priority exercise keys | Internal ids: exercises are named by a stable `key` |
| Today's planned exercises: key, name, muscles, sets, reps, RPE, rest, whether the equipment supports it | Loads and target weights of the base (the server keeps them in `facts`) |
| Gym type and equipment names, quantities and capabilities; only the chosen subset for `only` | The gym's name, notes, location, photos, storage keys, and whether it is temporary |
| Up to 60 candidate exercises (key, name, muscles, pattern, compound, tracking mode), excluding avoid-list and pain-flagged ones | Other gyms, other users' data |
| The last session's top set and date per planned exercise | Full history, pain notes, workout and measurement notes |
| Four check-in scores (energy, sleep, soreness, stress) when `useReadiness` and a check-in exists | The check-in note, medications, labs, blood pressure |
| Constraints: experience, low energy, conservative flag, avoid keys, limitation areas | Documents and photos |

The panel's "excluded" list is `NEVER_SEND` in `training-agents/context/never-send.ts`, the same list the plan flow shows. Hotel-scan photos go only to the equipment scan job, never to an adaptation call.

#### Prompts, markers and schema names

`training-adaptation/prompts/markers.ts` holds the literals the prompts, the tests and any fake provider rely on. They are pinned by `adaptation-prompts.contract.spec.ts`; changing one is a breaking change.

| Constant | Value |
|---|---|
| `CONTEXT_JSON_OPEN`, `CONTEXT_JSON_CLOSE` | `<context-json>`, `</context-json>` around the minimised context JSON |
| `CRITIC_NOTES_OPEN`, `CRITIC_NOTES_CLOSE` | `<critic-notes>`, `</critic-notes>` around the critic's issues on the revise pass |
| `ADAPTATION_PROPOSAL_SCHEMA_NAME` | `training_adaptation_proposal` |
| `ADAPTATION_CRITIQUE_SCHEMA_NAME` | `training_adaptation_critique` |
| `ADAPTATION_PROMPT_VERSION` | `1`, recorded in `guardrailReport.promptVersion` (the prompt text is never stored) |

`blockJson` writes `<` as `<`, so no value can close a block early. `parseContextBlock(input)` reads the JSON back; a fake provider uses it to compute a response from the request, because exercise keys come from the running library. `contextBlock`, `blockJson` and `parseContextBlock` are exported for that purpose.

#### Apply

A `ready` adaptation is applied one of two ways. Both re-run the equipment, library and pain checks against current data first (`staleFindings`).

| | `POST /:id/apply/workout` ("Use for today only") | `POST /:id/apply/plan` ("Update my plan") |
|---|---|---|
| Effect | Starts an in-progress workout for the user's local day with the adapted exercises and prefilled sets; links it to today's planned workout when that still exists; the plan is untouched | Writes a new plan version through `ProgramsService.applyChange` in which today's planned workout is the adapted one; change-log kind `adapted`, actor `ai`, origin `ai_adapt`, version meta `source: 'workout_adaptation'` |
| Extra permission | `workouts:write` | `programs:write` |
| Without a base | Starts an unlinked workout | `409 ADAPTATION_NO_BASE` |
| Undo | Delete the workout | The plan's one-tap revert |

- **Server-owned loads.** A kept exercise keeps its plan load rule; a swapped or added one starts from the last time, or blank. More reps than planned drops the prefilled load (never escalate).
- **Idempotent.** A repeat of the mode that succeeded answers the same result. The other mode after one succeeded is `409 ADAPTATION_ALREADY_APPLIED`. Two taps at once produce one workout and one program session, or one plan version. The claim is a conditional update on `status = 'ready'`, and the plan apply is undone if the plan write fails.
- **409 codes.** `ADAPTATION_NOT_READY`, `ADAPTATION_ALREADY_APPLIED`, `ADAPTATION_NO_BASE`, `WORKOUT_IN_PROGRESS` (`details.workoutId`, from the one-in-progress index) and `ADAPTATION_STALE` (`details.findings`).
- **Staleness.** Findings are `exercise_unavailable`, `equipment_changed`, `pain_flagged` and, for a plan apply, `plan_changed` (the plan has a newer version than the base). A one-off is still allowed after the plan moved on: it starts unlinked and answers `planChanged: true`.

#### Routes

Compact table; per-endpoint shapes are in `/api/docs`. Every route sits behind `AiEnabledGuard` plus `ai:use`, is scoped to the caller in SQL (another user's adaptation is `404`) and takes only a UUID id (`400` otherwise).

| Route | Extra permission | Purpose |
|---|---|---|
| `POST /api/ai/training/adaptations/context-preview` | none | What would be sent, the planner and critic resolution, `willCallProvider`, safety. No call, nothing stored |
| `POST /api/ai/training/adaptations` | none | Create: `202 { adaptationId, jobId, runId, status: 'queued' }`, or `200 blocked_safety` |
| `GET /api/ai/training/adaptations/:id` | none | The view: request, proposal, guardrail and critic reports, safety, sent data, models, stage, error, applied fields |
| `POST /api/ai/training/adaptations/:id/cancel` | none | Cancel a queued or running one; idempotent |
| `POST /api/ai/training/adaptations/:id/apply/workout` | `workouts:write` | Use for today only |
| `POST /api/ai/training/adaptations/:id/apply/plan` | `programs:write` | Update my plan |
| `DELETE /api/ai/training/adaptations/:id` | none | Discard (cancels first while it runs); `204` |

Live progress reuses the kit: `GET /api/ai/training/runs/:runId` and the SSE `GET /api/ai/training/stream/:runId?after=N`, with the row's `runId`. There is no list route.

#### Jobs and retention

- **`ai.training.adapt.run`**: payload `{ adaptationId }`, subject `training_adaptation`, profile 5 minutes and 1 attempt, server-only (no `nodeResultSchema`, no `persistNodeResult`). It runs the graph through the kit's `AgentCaller`, which calls `AiService.forUser(userId, { jobId })`, so usage rows carry the job id. Terminal AI codes fail the adaptation and the job returns; `AI_RATE_LIMITED` puts both back to `queued`, emits `run.deferred` and defers the job, and the graph resumes from its checkpoint; a deadline fails `ADAPTATION_TIMEOUT`; a job that settles failed with the adaptation still active fails it `ADAPTATION_RUN_LOST`. "Try again" is a new adaptation.
- **`training.adaptations.purge`**: deletes `workout_adaptations` rows past `expires_at` (created plus `ADAPTATION_TTL_DAYS = 30`) in batches of `ADAPTATIONS_PURGE_BATCH_SIZE = 5000`. A daily 03:20 cron only enqueues.
- **`gyms.temporary.purge`**: deletes unreferenced temporary gyms; see [gyms-and-equipment.md §2.13](gyms-and-equipment.md#213-temporary-gyms).
- **One active adaptation per user.** The raw-SQL partial unique index `workout_adaptations_active_per_user_uniq_idx` answers a second start with `409 ADAPTATION_IN_PROGRESS` (`details.adaptationId`, `status`, `runId`). An adapt run does not count against the plan-run index, so it neither waits behind nor blocks a plan run.

#### Errors

| Where | Codes |
|---|---|
| `400` | `ADAPTATION_NOTHING_TO_CHANGE`, `ADAPTATION_EQUIPMENT_NOT_IN_GYM`, `ADAPTATION_GYM_EQUIPMENT_UNCONFIRMED` |
| `403` | `AI_DISABLED` (kill switch, before anything else); a missing permission |
| `404` | Another user's adaptation or gym, indistinguishable from a missing one |
| `409` on create | `ADAPTATION_IN_PROGRESS`, `TRAINING_ROLE_UNAVAILABLE` (`details.role`, `state`, `fix`) |
| `409` on cancel, discard, apply | `ADAPTATION_NOT_CANCELLABLE`, `ADAPTATION_ALREADY_APPLIED`, `ADAPTATION_NOT_READY`, `ADAPTATION_NO_BASE`, `WORKOUT_IN_PROGRESS`, `ADAPTATION_STALE` |
| On the row (`errorCode`) | `ADAPTATION_CANNOT_FIT`, `ADAPTATION_INVALID`, `ADAPTATION_GYM_NOT_FOUND`, `ADAPTATION_TIMEOUT`, `ADAPTATION_RUN_LOST`, `TRAINING_RUN_BUDGET_EXCEEDED`, `TRAINING_OUTPUT_TRUNCATED`, `TRAINING_SAFETY_STOP`, shared `AI_*` codes |

#### Travel and hotel workouts

The sheet's "Different place" choice creates a temporary gym, scans the room with the existing `ai.equipment.scan` job (no second vision job and no new prompt), confirms the equipment and adapts with `gymId` set to it. The gym is a normal gym with `isTemporary: true`: never the default, saved with the same id by `PATCH /api/gyms/:id`, and purged after `TEMPORARY_GYM_RETENTION_DAYS` unless something references it. An adaptation for a temporary gym with no equipment is refused unless the request is bodyweight only. The lifecycle, the default rules and the finish-summary prompt "Save this gym for future use?" are owned by [gyms-and-equipment.md §2.13](gyms-and-equipment.md#213-temporary-gyms).

#### Usage and the token cap

Usage by node and role, the key-source labels, "tokens, not currency" and the run's token cap are owned by [§2.12](#212-usage-by-agent-role), including what an adapt run does when the cap stops it. The per-run cap is `min(ADAPTATION_MAX_RUN_TOKENS = 120000, ai.training.maxRunTokens)`, never below the settings minimum. The run's `jobId` correlates it with `ai_usage_events` rows.

#### Web

- **Entry.** `AdjustWorkoutEntry` (`apps/web/src/components/training/adapt/`) sits beside Start workout on the Today workout card and on `/train`. It appears only with AI on and `ai:use`; otherwise one line says why, and Start workout is never blocked. On Today an "Adjusted workout ready" chip returns to the latest unapplied ready adaptation started in this browser in the last 24 hours.
- **Sheet.** `AdaptWorkoutSheet` is a dialog, full-screen on compact windows: chips for minutes, Sore (muscles and level), low energy and equipment, a gym select with "Different place", a note, and a readiness switch. It shows the preview's "What will be sent" summary and which model each role will use, and refuses a request that changes nothing before the round trip.
- **Run and review.** `/train/adapt/:adaptationId` (`ai:use` and AI on, else back to `/train`) shows the stages (reading the plan, adapting, checking limits, reviewing), then the review: AI badge and "Draft, not medical advice", the diff against the planned workout (kept, swapped, dropped with reason, added; icons and words, never colour alone), estimated against requested minutes, rationale, assumptions, guardrail notes, the critic's verdict or "Not reviewed by the critic", and `AgentUsagePanel`. Actions: Use for today only, Update my plan (disabled with the reason when there was no base), Discard, Adjust again. Each 409 is explained with the step that resolves it; a safety stop shows only the guidance. A failed adaptation shows the failure copy for its error code with **Try again** (reopens the sheet with the last request), **Start the planned workout instead** (links to `/train`) and, for some codes, one extra action; a cancelled one offers **Adjust again**.
- **AI off.** Both apply routes answer `403 AI_DISABLED`; the review offers "Copy exercises" and the planned workout still starts from Today.

### 2.14 The opt-in health summary

Issue #192 (H8). The planner and the evaluator can take the user's health status into account through one AI-written summary, never through raw values. The summary itself is specified in [health-records.md §2.14](health-records.md#214-ai-health-summary-for-the-training-planner); this section owns how the agents use it.

- **Consent.** "Use my health data in training plans" is per user, off by default (`health_summary_settings`, no row is off). It is set with `PUT /api/ai/training/health-summary/consent` and audited (`health_summary:consent`).
- **The one door.** `HealthSummaryReader.forTraining(userId)` (`apps/api/src/health-summary/health-summary.reader.ts`) returns the newest `ready` summary's narrative, training considerations and `dataAsOf`, and only while the consent is on. It reads no measurement. `PlannerContextLoader` and `EvaluationContextLoader` call it; nothing else in a run reads health data beyond what §2.4 already lists.
- **Where it goes.** `PlannerContext.healthSummary` and `EvaluatorProfile.healthSummary`, each optional and omitted (never null) when absent. With the consent off, a request is byte-identical to one built without the feature (canary test). The critic and the researcher never receive it.
- **G0.** `FreeTextSafetyScreen` screens the summary's narrative and every consideration with the urgent-symptom rules, for every run kind. A match records the run `blocked_safety` with no job and no provider call. The context builders screen it again and drop a summary that would block, for a summary written between the screen and the job.
- **Untrusted data.** It sits inside the delimited `<context>` block, so `UNTRUSTED_DATA_BLOCK` applies. The planner and evaluator prompts are unchanged.
- **What will be sent.** `summarizePlannerContext` shows a "Health summary (opt-in)" section with the narrative verbatim, then each consideration with its severity; `summarizeEvaluatorContext` lists the same items under the profile.
- **Context budget.** An optional section of its own, dropped whole after bio, body metrics and profile.
- **Conservative mode.** A consideration with `conservative: true` adds the reason `health_summary` and turns on conservative mode, like a reported limitation.
- **Telemetry.** The `plan` and `evaluate` node spans carry `healthSummary.present` (a boolean, never the text).

## 3. Configuration and permissions

**Settings.** No environment variable is added for any of it.

| Setting | Where | Meaning |
|---|---|---|
| `ai.assignments.features['training.<role>']` | System setting, `/admin/settings/ai/assignments` | `{ provider, modelId, reasoningEffort? }` per role, each optional. Precedence: the role's assignment, then `ai.assignments.default`, then a deterministic auto pick among usable capable models, else a blocking state ([ai-platform.md §2.18a](ai-platform.md#218a-feature-model-resolution)). The effort is the assignment's, else the role default, clamped to what the model offers. Per-user model settings no longer exist; migration `20260930180000_remove_user_ai_model_choices` deleted `ai.taskModels` and `ai.defaultModel` |
| `ai.training.maxRunTokens` | User settings | Per-run token cap, 10,000 to 2,000,000. Absent: 400,000 for `create` and `revise`, 150,000 for `evaluate` |
| `ai.training.maxCriticRounds` | User settings | 1, 2 or 3; default 2 |
| `ai.enabled`, `ai.hostedTools.web_search` | `/admin/settings/ai` | Kill switch; the researcher cannot run while web search is off (off by default) |
| `ai.limits` | `/admin/settings/ai` | Platform request and output caps; apply to every agent call |
| `ai.training.maxRunTokens` in an adapt run | User settings | Lowers the adapt run's cap (`ADAPTATION_MAX_RUN_TOKENS`, 120,000) and never raises it |
| `programs.autonomy` | Plan header column | `autonomous` (default) or `ask_first` |
| `health_summary_settings.enabled` | `PUT /api/ai/training/health-summary/consent` | "Use my health data in training plans", per user, off by default ([§2.14](#214-the-opt-in-health-summary)) |
| `ai.assignments.features.health_summary` | `/admin/settings/ai/assignments` | The model that writes the health summary; grouped with the training agents |

Role resolution states (`GET /api/ai/training/models`, from the feature resolver): `ready`, `auto` (runnable), and the blocking `no_key`, `no_models`, `missing_capability`, `web_search_disabled`, `ai_disabled`. A run that needs a blocked role is refused at start with `409 TRAINING_ROLE_UNAVAILABLE`.

**Cost and caps.** Protection is layered: `ai.limits` on every call; the per-run token cap frozen on the run at start and checked before each call by `RunBudget` (counting input, output and reasoning tokens; rebuilt from the run's usage on resume, so a resumed run spends against the same cap); the output cap of each call clamped to the remaining budget; and a pre-run estimate (`POST /api/ai/training/estimate`, a range, never a quote). One active run per user. Usage is shown as tokens per agent and key source ([§2.12](#212-usage-by-agent-role)); no currency is computed because the platform has no price catalog. A spent budget fails the run `TRAINING_RUN_BUDGET_EXCEEDED`, except that a critique or revision the budget cannot pay for ships the checked draft with `critic_skipped_budget` (create and revise) or `criticReport.skipped = 'token_cap'` and `revision_skipped_token_cap` (adapt).

**Permissions.** `ai:use` for every `/api/ai/training/*` route, usage routes included (behind `AiEnabledGuard`); `programs:read` and `programs:write` for plans; `workouts:write` also for starting a planned workout and for `POST /api/ai/training/adaptations/:id/apply/workout`; `programs:write` also for `apply/plan`; `health_data:read` (view) and `health_data:write` (consent, refresh) also for `/api/ai/training/health-summary`; `gyms:write` for saving a temporary gym ([gyms-and-equipment.md §2.13](gyms-and-equipment.md#213-temporary-gyms)); `ai_config:read` and `ai_config:write` for the admin switches. The permission matrix is in [ARCHITECTURE.md §7.2](../ARCHITECTURE.md#72-permission-matrix).

**Errors.** `details.reason` or `error_code` values: `TRAINING_RUN_ACTIVE` (409, `details.runId`), `TRAINING_ROLE_UNAVAILABLE` (409, `details.role`, `details.state`), `TRAINING_STALE_PLAN` (409, `details.currentVersion`), `TRAINING_EVALUATION_COOLDOWN` (409), `TRAINING_RUN_NOT_RESUMABLE` (409), `TRAINING_RUN_NOT_AWAITING_DECISION` (409), `TRAINING_NOT_IMPLEMENTED` (501, while a kind's graph is not ready), the adaptation codes in [§2.13](#213-quick-adaptation-and-travel-workouts), and on the run row `TRAINING_RESEARCH_INSUFFICIENT`, `TRAINING_PLAN_REJECTED`, `TRAINING_RUN_BUDGET_EXCEEDED`, `TRAINING_RUN_LOST`, `TRAINING_CONTEXT_TOO_LARGE`, `TRAINING_SAFETY_STOP`, `TRAINING_APPROVAL_EXPIRED`, plus shared `AI_*` codes.

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
| `/api/ai/training/adaptations` (context-preview, create, read, cancel, apply/workout, apply/plan, discard) | `ai:use` (+ `workouts:write` or `programs:write` to apply) | Quick adaptation; table in [§2.13](#213-quick-adaptation-and-travel-workouts) |
| `GET /api/ai/training/runs/:runId/usage`, `GET /api/ai/training/usage` | `ai:use` | [§2.12](#212-usage-by-agent-role) |
| `GET /api/training/today`, `GET /api/training/signals`, `POST /api/program-workouts/:id/start` | `programs:read` (+ `workouts:write` to start) | Today and signals |
| `GET /api/ai/training/health-summary` | `ai:use` + `health_data:read` | The consent, what is shared, the summary verbatim, staleness ([health-records.md §2.14](health-records.md#214-ai-health-summary-for-the-training-planner)) |
| `PUT /api/ai/training/health-summary/consent`, `POST /api/ai/training/health-summary/refresh` | `ai:use` + `health_data:write` | Turn the opt-in on or off (audited); queue a new summary (202) |

nginx unbuffers `/api/ai/training/stream` ([ARCHITECTURE.md §10.3](../ARCHITECTURE.md#103-nginx-routing)).

## 4. Extending it in a fork

| To | Do |
|---|---|
| Add an agent or node | Follow [the AI README recipe](../../apps/api/src/ai/README.md#adding-a-training-agent-or-node) |
| Change a limit (sets, RPE, envelope, evaluation spacing) | Edit `guardrails/limits.ts`, `guardrails/envelope-limits.ts` or `evaluation/evaluation.constants.ts`; update the table in §2.6 or §2.8 |
| Add an agent graph feature like quick adaptation | [The AI README recipe](../../apps/api/src/ai/README.md#adding-an-agent-graph-feature-like-quick-adaptation) |
| Change an adaptation rule number | Edit `ADAPTATION_RULES` in `training-adaptation/adaptation.constants.ts`; update the rules table in [§2.13](#213-quick-adaptation-and-travel-workouts); `adaptation-rules.table.spec.ts` shows what moves |
| Change a prompt | Edit `training-adaptation/prompts/`, bump `ADAPTATION_PROMPT_VERSION`, keep the markers and schema names in `markers.ts` (pinned) |
| Add an event type | `registerRunEventType` beside the emitting node, with a strict schema of identifiers, enums and counts |
| Add a never-send entry | Add it to `context/never-send.ts`; the canary test picks it up |
| Let an agent use more health data | Do not read it in a context loader. Add it to the summary's digest (`health-summary/health-digest.ts`) so it reaches agents only as summary text, behind the consent |
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
- `src/training-agents/agents/planner/planner.spec.ts`, `src/training-agents/graph/create-graph.scenarios.spec.ts`: the health summary canary (opted out: byte-identical planner request; opted in: `healthSummary` inside `<context>`, no raw lab or blood-pressure value and no document field in any provider call) and its budget order. `src/training-agents/runtime/training-runs.service.spec.ts`: G0 over the summary.
- `src/training-agents/runtime/run-events.registry.spec.ts`, `run-events.sse.spec.ts`: strict payloads, registration, replay and end frames.
- `src/training-agents/runtime/agent-caller.spec.ts`, `run-budget.spec.ts`, `context-budget.spec.ts`: the one path to the model, caps and trimming.
- `src/training-agents/graph/training-graphs.spec.ts`, `create-graph.scenarios.spec.ts`, `evaluate-graph.scenarios.spec.ts`: routing, ship rule and graph wiring.
- `src/training-agents/runtime/training-plan-run.handler.spec.ts`, `training-runs.service.spec.ts`, `training-retention.spec.ts`: run outcomes, resume ceilings and retention.
- `src/training-agents/evaluation/evaluation-gates.spec.ts`, `evaluation-due.spec.ts`, `training-evaluation.scheduler.spec.ts`, `training-evaluation-sweep.handler.spec.ts`, `workout-finished.listener.spec.ts`: triggers, gates and the sweep.
- `test/ai/ai-orchestration-boundary.spec.ts`: LangGraph and `@langchain/core` only under `src/training-agents/`, no `@langchain/<provider>`, no `@ai-sdk/*`.
- `test/ai/ai-no-sdk-leak.spec.ts`, `ai-kill-switch.integration.spec.ts`, `ai-rbac-matrix.integration.spec.ts`, `ai-secret-egress.integration.spec.ts`, `ai-key-policy.integration.spec.ts`, `ai-jobs-server-only.spec.ts`: the AI platform guards discover the training routes and job type automatically. `ai-training-models.integration.spec.ts`, `ai-training-runs.integration.spec.ts` and `ai-training-stream-nginx.spec.ts` pin these routes and the SSE location.
- `test/jobs/cron-enqueue-only.spec.ts`, `on-event-no-io.spec.ts`: the sweep and purge crons only enqueue, and the evaluation listeners do no long-running work.
- `src/training-agents/graph-runtime-info.spec.ts`, `test/training-agents/training-graph-telemetry.spec.ts`: LangGraph loads at boot and framework telemetry is forced off.
- `src/training-usage/training-usage.attribution.spec.ts`, `test/ai/training-usage.integration.spec.ts`, `test/training-usage/training-usage.db.spec.ts`: attribution and `typical` rules, the auth, kill-switch and 404 matrix of the usage routes, and the SQL over seeded rows (owner scoping, retention-purged runs, integer casts). Web: `AgentUsagePanel.test.tsx`, `MonthlyAgentUsageSection.test.tsx`.
- `src/training-adaptation/rules/adaptation-rules.spec.ts`, `adaptation-rules.table.spec.ts`: the rules table, never-escalate, time-fit repair (T1 to T3 and `ADAPTATION_CANNOT_FIT`), soreness, low energy and conservative mode.
- `src/training-adaptation/graph/adaptation.graph.spec.ts`, `adaptation-token-cap.spec.ts`: the graph on `FakeAiProvider` (accept, exactly one revise pass, urgent stop with zero calls, hostile output repaired, cap behaviour).
- `src/training-adaptation/prompts/adaptation-prompts.contract.spec.ts`: markers, schema names and prompt version pinned; free text only inside the context block; the safety block first; loads never the model's.
- `src/training-adaptation/context/adaptation-context.builder.spec.ts`, `build-adaptation-context.spec.ts`, `test/training-adaptation/adaptation-canary.db.spec.ts`: the never-send canary over real rows, preview equals snapshot, ownership scoping and the gym `404`.
- `src/training-adaptation/dto/adaptation-request.dto.spec.ts`, `adaptation.service.spec.ts`: request bounds and the at-least-one-change rule; create, cancel and apply branches.
- `test/ai/training-adaptation.integration.spec.ts`: RBAC per route (exact permission strings), kill switch on every route and on apply, validation, hostile free text, urgent stop with an empty provider log, revise ceiling.
- `test/training-adaptation/adaptation-runtime.db.spec.ts`, `adaptation-apply.db.spec.ts`, `adaptation-apply-edge.db.spec.ts`: one active adaptation per user, an adapt run beside a plan run, apply idempotence under parallel taps, `WORKOUT_IN_PROGRESS`, staleness on real rows, loads never from the model, ownership.
- `src/training-adaptation/handlers/adaptation-run.handler.spec.ts`: outcomes, rate-limit deferral and resume, cancel, deadline and the settle safety net. `ai-jobs-server-only.spec.ts` and `ai-kill-switch.integration.spec.ts` discover `ai.training.adapt.run` with no edit.
- `src/training-adaptation/handlers/adaptations-purge.handler.spec.ts`, `tasks/adaptations-purge.task.spec.ts`, `test/training-adaptation/adaptation-purge.db.spec.ts`, `src/gyms/handlers/temporary-gym-purge.handler.spec.ts`, `test/gyms/temporary-gym-purge.db.spec.ts`: purge batches, reference safety of temporary gyms, and crons that only enqueue (`test/jobs/cron-enqueue-only.spec.ts` discovers both).
- Web (`apps/web/src/__tests__/`): `components/training/adapt/` (sheet, parts, review, hotel step), `pages/AdaptationReviewPage.test.tsx`, `AdaptRoutes.test.tsx`, `utils/reduceRunEvents.adapt.test.ts`, `components/gyms/TemporaryGymChip.test.tsx`.
- `src/programs/today/no-ai-import.spec.ts`: the programs layer has no AI dependency, so manual plans work with AI off.
- Real Postgres (`*.db.spec.ts`): `test/training-agents/prisma-checkpoint-saver.db.spec.ts`, `training-plan-runs.db.spec.ts`, `training-runtime.db.spec.ts`, `training-plan-finalize.db.spec.ts`, `training-evaluation.db.spec.ts`, `training-evaluation-run.db.spec.ts` and the cross-story `training-flow.db.spec.ts`.
- Scenario suites and fixtures: `test/fixtures/training/scenarios/`, `test/training-agents/scenario-fixtures.spec.ts` (every fixture output parses with the real contracts and names only seeded exercises), `test/training-agents/scenarios/*.integration.spec.ts`, `test/fake-responses/fake-responses-server.spec.ts` and the Playwright `tests/e2e/specs/training-plans.spec.ts`. See [TESTING.md](../TESTING.md#fake-responses-server-and-training-scenarios).
- `test/ai/adaptation-fake-server-contract.spec.ts`: the e2e fake's markers and schema names equal `markers.ts` and its answers parse under the real schemas and the real OpenAI-compatible adapter.
- Playwright: `tests/e2e/specs/training-adaptation.spec.ts` runs the flow against the OpenAI-compatible fake (`tests/e2e/support/fake-vision-server.mjs`, not the Responses fake); scenarios and run instructions are in [TESTING.md](../TESTING.md#quick-adaptation-suites-and-the-fake-provider-e2e).
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

**Adaptation is user-initiated, not an autonomous evaluator.** A person who says "30 minutes, sore chest" wants an answer now and to see it before training. The evaluator adapts the plan from logged history on a schedule and is autonomous with an undo; a same-day adjustment is confirmable by construction (a review, then one of two apply routes). Rejected: routing it through the evaluate graph (wrong cadence, a 48-hour rate limit that would refuse the second adjustment of a week, and plan-level operations for a one-day change).

**Two apply routes, not one.** "Use for today only" and "Update my plan" have different blast radii: a workout row versus a plan version. One route with a flag would hide that in the permission check (`workouts:write` versus `programs:write`) and in the undo. Rejected: always writing the plan (a hotel workout would rewrite home training) and never offering it (a lasting injury would need three manual edits).

**No loads from the model.** A model asked for weights invents them, and a wrong load is the most direct route to injury the feature has. The stored proposal has no load field; `apply` fills loads from the plan or the last session. Rejected: accepting model loads inside a clamp (a clamp that wide is a second prescription engine to maintain).

**One revise round.** A second critic round costs a third and fourth provider call to fix issues the guardrails already bound. The critic is light (four checks), a revision that breaks a rule falls back to the first checked proposal, and the revision is never critiqued again. Rejected: a configurable loop count (the plan flow already has one, and here the deterministic layer makes more rounds low value).

**A temporary gym is a gym.** Reusing the gyms table means the scan, equipment editor, references and purge rules already exist, and saving is a flag flip that keeps the id (so a finished workout still points at the same gym). Rejected: a separate `travel_gyms` table (a copy of the equipment model plus a promote migration) and an in-memory inventory (the scan job needs a gym row to write to).

**Tokens, not currency.** The platform has no price catalog, and a made-up price would be wrong on the first provider change. Usage shows tokens, model and key source, and the cap is in tokens. Rejected: a per-model price table (a maintenance burden that ages silently).

**No rule-based fallback.** With a role unusable the request is refused `409 TRAINING_ROLE_UNAVAILABLE` with the fix, and the planned workout starts as before. A deterministic "shorten it" would be a second adapter that ignores intent and would hide a missing model. The rules run after the model as a validator and repairer, never as a generator.

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

Quick adaptation:

```bash
npm test --workspace=api -- training-adaptation training-usage test/ai/training-adaptation
npm run test:db --workspace=api -- training-adaptation temporary-gym-purge
npm run test:run --workspace=web -- adapt
```

With the fake provider and no key: start the stack with `fake-ai.compose.yml` and run `cd tests/e2e && npm test -- training-adaptation --workers=1` ([TESTING.md](../TESTING.md#quick-adaptation-suites-and-the-fake-provider-e2e)).

Real-key smoke checklist (manual, never in CI; `openai.adapter.live.spec.ts` shows the opt-in pattern for a live suite). A normal run is two provider calls, three with a revise. Record your own token counts from the usage panel rather than quoting a range.

1. As an administrator, set a real key and assign the planner and critic models at `/admin/settings/ai/assignments`; as the tester, check at `/settings/ai/agents` that both roles resolve.
2. With an active plan and a workout today, open Adjust, choose 30 minutes, Sore chest (mild) and Only dumbbells. Confirm "What will be sent" holds no name, gym name or note, and the stages advance.
3. In the review, check every exercise is supported by dumbbells, no exercise has more sets or RPE than planned, the estimate is at most 30 minutes, and the rationale matches. Note the per-role tokens and key source.
4. Use for today only: the logger opens prefilled and the plan is unchanged. Repeat and choose Update my plan: a new plan version with an `adapted` change-log entry, and revert restores the previous one.
5. Type "chest pain and dizzy" in the note: the guidance card appears, no run starts and the usage panel shows no new call.
6. Different place: scan two hotel photos, confirm the equipment, adapt, finish the workout and choose Save gym; it appears under permanent gyms.
7. Lower the per-run token limit in your AI settings (`ai.training.maxRunTokens`) and adapt again: the cap message appears and, if the proposal exists, "Not reviewed by the critic".
8. Turn AI off at `/admin/settings/ai`: the entry explains, and the planned workout still starts.

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
- #105: the epic, E6 Adaptive and travel workouts.
- #106: quick workout adaptation: the adapt graph, rules, context, apply routes and review UI.
- #107: travel and hotel workouts: temporary gyms, save and purge, the equipment-unconfirmed refusal.
- #108: usage and cost by agent role, the token cap surfaced, graceful cap behaviour in adaptation runs.
- #109: adaptation and travel workouts in this spec, the AI README recipe and the inventories.
- #192: the opt-in health summary in the planner and evaluator context (H8).
