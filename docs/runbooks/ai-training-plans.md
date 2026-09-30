# Runbook: Run AI Training Plans

> **Audience:** administrators · **Spec:** [ai-training-plans.md](../specs/ai-training-plans.md) · **Admin UI:** `/admin/settings/ai`, `/admin/settings/ai/models`, `/admin/settings/ai/usage` · **Permission:** `ai_config:read` and `ai_config:write`

Use this runbook to make the training-plan agents available to users, to keep their cost and reach under control, to try the whole flow with a fake provider and no key, and to diagnose a run that did not do what a user expected. It changes AI settings and model enablement only; it never adds an environment variable. Users bring their own provider key unless you chose the organisation-key fallback (see [ai-configuration.md](ai-configuration.md)).

## 1. Before you start

- AI is configured and on: the provider is enabled, a key policy is chosen and at least one model is enabled. If not, do [ai-configuration.md](ai-configuration.md) sections 3 to 7 first.
- You hold `ai_config:read` and `ai_config:write` (Admin only) and, to try the flow yourself, a second account with `ai:use` (Contributor).
- Training plans need four agent roles: `researcher`, `planner`, `critic`, `evaluator`. Only the researcher needs an OpenAI model with hosted tools; the other three accept any enabled provider's model with `responses` and `structured_output`.
- Each run spends tokens on the key of the person who starts it (their own key under `byok`). An evaluation also runs on its own: after a finished workout, weekly and after missed sessions. Decide whether that spend is acceptable before you enable web search and the evaluator models.

## 2. Enable web search

The researcher cannot run while web search is off. It is off on a fresh deployment because it reaches the open web and is billed per use by the provider.

1. Open `/admin/settings/ai`, section **Hosted tools**.
2. Switch **Web search** on and save.
3. Confirm: as a contributor, `/settings/ai/agents` shows the researcher as ready (or auto) instead of "Web search is switched off".

What it reaches: the researcher's queries are formed from the goal, level, limitations and equipment class the person typed (plus an age band and sex at birth only if they opted in). It never sends a name, email, date of birth, weight, check-in or gym name. The queries appear in the run view. What it costs: one or two searches per `create` run, on the paying key. A `revise` run and an evaluation do not search.

## 3. Try it with the fake provider

A fake OpenAI Responses server lets you run the full flow with no key, no cost and no outbound network. It replays the scenario fixtures in `apps/api/test/fixtures/training/scenarios`. Use it in development and end-to-end tests only.

1. Start the stack with the overlay (from `infra/compose`):

   ```bash
   docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml -f fake-ai.compose.yml up
   ```

   The overlay adds the service `fake-ai-responses` on host port `4011` (and the fake vision server on `4010`).
2. Confirm it answers and list the scenarios:

   ```bash
   curl localhost:4011/__control/scenarios
   ```

   You see `current` and every scenario with its description.
3. As admin at `/admin/settings/ai`: enable AI and the **OpenAI** provider, set its base URL to `http://fake-ai-responses:4011/v1`, and switch **Web search** on.
4. At `/admin/settings/ai/models`, refresh the catalog. The fake lists `fake-frontier` and `fake-fast`, unclassified. Edit each: capabilities `responses`, `reasoning`, `structured_output`; reasoning efforts `low`, `medium`, `high`; enable both. Add `hosted_tools` to `fake-frontier`, which the researcher needs. The end-to-end setup leaves `fake-fast` without `hosted_tools`, which is how it tests a blocked researcher; add it there too if you want either model to work for every role.
5. As a contributor at `/settings/ai`, save any key of 8 or more characters (for example `sk-fake-e2e-0000`). The fake accepts any such key and answers `401` to one starting `sk-invalid`. It never logs, echoes or stores a key. Do not use it to test key validation.
6. Pick a scenario, then run a plan at `/train/plans/new`:

   ```bash
   curl -X POST localhost:4011/__control/scenario -d '{"name":"happy"}'
   ```

   Selecting a scenario resets its call counters.
7. Inspect what the fake received:

   ```bash
   curl localhost:4011/__control/requests
   ```

   One entry per request: agent, node, round, model, reasoning effort, tool types, whether a schema was present, input size, canary hits and whether an `Authorization` header was present. Never a prompt, a body or a key. `POST /__control/reset` clears the log and counters.

Scenarios:

| Scenario | What it shows |
|---|---|
| `happy` | Research, one draft, the critic approves; the plan is created as a draft |
| `critic-reject-once` | The critic rejects with one blocker, the planner revises, the critic approves |
| `critic-exhausted` | The critic rejects every round while guardrails stay clean; the plan ships with open notes |
| `planner-hostile` | An unsafe draft (unknown and unsupported exercises, 500 kg loads, a fabricated citation and link, injected instructions): guardrails repair or block it |
| `research-fabricated-url` | The brief cites a URL the search never returned; the source and its claim are dropped |
| `research-insufficient` | Fewer than two verified sources remain; the run stops with an insufficient-evidence error |
| `research-page-injection` | A retrieved page told the model to ignore its rules; the injected text never reaches the plan |
| `slow` | The happy path with every response delayed, for reload and cancel tests |
| `rate-limit-once` | The second request answers `429` with `retry-after`; the run defers and resumes |
| `budget-tight` | The researcher reports a huge token total; the next call is refused with the budget error |
| `urgent-symptom` | No model call scripted: the safety screen stops the request |
| `evaluator-no-change` | The plan is on track; a review entry, no new version |
| `evaluator-autonomous` | A small load nudge and one extra set, applied without a question |
| `evaluator-structural` | One swap, so the light critic reviews it before it is applied |
| `evaluator-pain-response` | Pain on an exercise: the evaluator swaps it and tries to push another lift, which the envelope blocks |
| `evaluator-regenerate` | The evaluator asks to rebuild the remaining weeks; dropped, because escalation is never automatic |
| `evaluator-hostile` | Past-session edits, oversized changes, unknown refs, a repeat of an undone change and injection text; nothing out of bounds lands |

`tests/e2e` (`npm test -- training-plans`) does steps 3 to 5 itself. The fake counts the e2e canary markers built into `fake-responses-server.mjs` (`DEFAULT_CANARY_MARKERS`); to use a different list, set `CANARY_TOKENS` on the `fake-ai-responses` container. The application has no such variable.

## 4. Enable models for the four roles

At `/admin/settings/ai/models`, refresh the catalog for each enabled provider and **enable** the models users may reach. Discovery never enables a model.

| Role | Model needs | Provider |
|---|---|---|
| Researcher | `responses`, `structured_output`, `hosted_tools` | OpenAI only (web search is the OpenAI hosted tool) |
| Planner | `responses`, `structured_output`; `reasoning` lets users choose an effort | Any enabled provider |
| Critic | `responses`, `structured_output` | Any |
| Evaluator | `responses`, `structured_output` | Any |

Each user picks a model and reasoning effort per role at `/settings/ai/agents`; without a choice the role uses the user's default model, else an automatic pick among usable capable models. Suggested defaults are `medium` effort for researcher and evaluator and `high` for planner and critic.

## 5. What users see when a role is blocked

The agents page and the wizard show each role's state. A run that needs a blocked role is refused at start (`409`, `TRAINING_ROLE_UNAVAILABLE`) and Start is disabled.

| State | Meaning | Fix |
|---|---|---|
| `ready`, `auto`, `stale_preference` | Runnable (a stale preference falls back to another model) | None; the user may re-pick |
| `no_key` | No key source for the user | The user saves a key at `/settings/ai`, or set the key policy to fall back to the organisation key (ai-configuration section 7) |
| `no_models` | No enabled model for the user's providers | Enable models (section 4) |
| `missing_capability` | No usable model has the role's capabilities (the researcher additionally needs OpenAI) | Enable or classify a capable model; for the researcher, an OpenAI model with `hosted_tools` |
| `web_search_disabled` | The researcher's switch is off | Section 2 |
| `ai_disabled` | The kill switch is on | Section 9 |

## 6. Control cost

- **Per-run token cap.** Each user's cap is `ai.training.maxRunTokens` (default 400,000 tokens for create and revise, 150,000 for evaluate; between 10,000 and 2,000,000). It is frozen on the run at start and counts input, output and reasoning tokens across every agent. A run that spends it fails with `TRAINING_RUN_BUDGET_EXCEEDED`, except that a critique or revision the budget cannot pay for ships the already-checked draft with a warning. A quick adaptation whose critic or revision the cap stops ends ready with the checked proposal ("Not reviewed by the critic"); one stopped before any proposal fails. The cap is a per-user setting; there is no admin override.
- **Critic rounds.** `ai.training.maxCriticRounds` (1 to 3, default 2) bounds how many reviews a draft gets.
- **Platform limits.** `ai.limits` (section 12 of ai-configuration.md) applies to every agent call: per-user and per-model request rates, organisation-key caps, and per-model `maxOutputTokens`, which also bounds each agent call's output.
- **Automatic evaluations** are capped per user: 3 automatic runs per UTC day, 30 minutes between automatic runs, 30 minutes after a manual one. These are code constants in `apps/api/src/training-agents/evaluation/evaluation.constants.ts`; the only global off is the AI kill switch.
- **Where to read usage.** `/admin/settings/ai/usage` shows AI usage; each user sees tokens per agent role, model and key source on the run view and in the usage section of `/settings/ai` (never a currency). To trace one run, filter the usage report by the run's job. Details: [spec §2.12](../specs/ai-training-plans.md#212-usage-by-agent-role). The Jobs page (`/admin/settings/jobs`) lists `ai.training.plan.run` jobs, `training.evaluation.sweep` and `training.runs.purge`.

## 7. Monitor runs

| Job type | What it is | Profile |
|---|---|---|
| `ai.training.plan.run` | Executes one run; resume is a new job for the same run | 25 minutes, 1 attempt |
| `training.evaluation.sweep` | Hourly (minute 7): expires old proposals, finds due weekly and missed-session reviews | 10 minutes, 3 attempts |
| `training.runs.purge` | Daily 05:30: deletes finished runs' events and checkpoints after 30 days and run rows after 365 days | 30 minutes, 3 attempts |

A run ends `succeeded`, `failed`, `cancelled`, `blocked_safety`, or pauses as `awaiting_approval` (ask-first proposal, expires in 14 days) or `interrupted` (deadline, deploy or lost job). An interrupted run resumes by itself at most twice; after that it needs a manual resume (at most three in total) or a new run. A deploy during a run therefore costs at most the node that was running.

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Start disabled, banner names a role | Role unavailable | Table in section 5 |
| Run fails `TRAINING_RESEARCH_INSUFFICIENT` | After one retry, fewer than 3 verified claims or 2 verified sources survived citation checks (the model cited URLs the search did not return, or only low-quality domains) | Retry; widen the goal text; try a stronger researcher model; check web search is on. Nothing is created |
| Run fails `TRAINING_PLAN_REJECTED` | The plan still violated a hard guardrail after repairs and the critic rounds ran out | Retry with fewer limitations or a simpler goal; try a stronger planner. Nothing is written |
| Plan created with open notes | The critic still asked for changes after the allowed rounds (`critic_open_notes`), or the critic was skipped or unavailable | Expected; the owner reviews the draft. Raise `maxCriticRounds` if desired |
| Run is `interrupted` | Deadline, deploy or a lost job | It resumes automatically up to twice; otherwise the user presses Resume (up to 3 times), or starts a new run. `TRAINING_RUN_LOST` means the automatic resumes were used up |
| Run seems stuck `running` | Waiting on a slow model, or its job is unclaimed | Check the job on the Jobs page; a lost lease settles the job and interrupts the run. The user can Cancel (a running run stops within about 2 seconds) |
| Run goes back to `queued` with a "deferred" event | Provider rate limit (`AI_RATE_LIMITED`); the job is deferred and continues from its checkpoint | Wait; check `ai.limits` and the provider's own limits |
| `TRAINING_STALE_PLAN` | The plan changed while a revise run was working, or a proposal was approved after the plan moved | Start the revision again on the current version |
| `TRAINING_RUN_ACTIVE` (409) | The user already has a run queued, running or awaiting a decision | Finish, decide or cancel that run |
| No automatic evaluation happens | A gate skipped it: AI off, no active plan, automation paused, evaluator role unavailable, a proposal waiting, a run already queued; or it was deferred (an active run, 3 runs today, within 30 minutes of another) | The deferred ones run when the gates pass (the hourly sweep honours them). Check each against [spec §2.8](../specs/ai-training-plans.md#28-continuous-evaluation) |
| "Re-evaluate now" answers 409 `TRAINING_EVALUATION_COOLDOWN` | A manual run in the last 30 minutes | Wait `retryAfterSeconds` |
| Plan shows automation paused | Urgent-symptom text in a recent pain note, or a repeated pain pattern; a mandatory notification was sent | The owner reviews with a qualified professional, then presses Resume in the banner on the plan viewer, which asks for confirmation and calls `POST /api/programs/:id/autonomy/resume` (the plan owner's call, `programs:write`). An administrator should not bypass it |
| Ask-first proposal expired | No decision within 14 days; the sweep cancelled the run (`TRAINING_APPROVAL_EXPIRED`) | The next evaluation proposes again |
| A run shows `blocked_safety` | The safety screen found urgent-symptom text in the request or a recent pain note | Expected; the user sees fixed guidance and no model was called |
| A user's plan was not adjusted after a workout | Thin data (fewer than 3 due sessions, nothing completed yet), or the evaluator found the plan on track | Expected; a `reviewed` entry appears in the plan history |

## 9. Purge and retention

Finished runs keep their replayable events and graph checkpoints for 30 days and the run row for 365 days, measured from completion. `training.runs.purge` applies this daily at 05:30; there is no setting. Plans, versions and the change log are the user's data and are not purged. Deleting a user removes their runs and plans.

## 10. Turn it off

- **Everything, at once.** Switch **Enabled** off at `/admin/settings/ai` (the kill switch, ai-configuration section 2). Every `/api/ai/training/*` route answers `403` with `AI_DISABLED`; the sweep does not enqueue; workout-finished events schedule nothing. A run already in flight fails with `AI_DISABLED` at its next model call. Plans, Today, the manual builder, history and signals keep working.
- **The researcher only.** Switch **Web search** off (section 2). New `create` runs are refused for the researcher role; `revise` runs and evaluations continue.
- **One user's automation.** The owner sets the plan to ask first, or pauses the plan.

## 11. Summary checklist

- [ ] AI is on, a key policy is chosen and models are enabled
- [ ] **Web search** is on under **Hosted tools**
- [ ] An OpenAI model with `hosted_tools`, `structured_output` and `responses` is enabled for the researcher
- [ ] Planner, critic and evaluator models are enabled
- [ ] A contributor sees all four roles ready at `/settings/ai/agents`
- [ ] `ai.limits` and per-model output caps are set as you want
- [ ] (Development) the fake overlay runs and `curl localhost:4011/__control/scenarios` answers
- [ ] You know where run and usage data are read (`/admin/settings/ai/usage`, the Jobs page)

## See also

- [ai-training-plans.md](../specs/ai-training-plans.md): the design, guardrails and run state machine
- [ai-configuration.md](ai-configuration.md): turning AI on, key policy, models, the kill switch
- [../TESTING.md](../TESTING.md#fake-responses-server-and-training-scenarios): scenario suites and the end-to-end specs
