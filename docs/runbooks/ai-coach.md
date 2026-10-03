# Runbook: Run the AI Coach

> **Audience:** administrators · **Spec:** [ai-coach.md](../specs/ai-coach.md) · **Admin UI:** `/admin/settings/coach`, `/admin/settings/ai/assignments` · **Permission:** `ai_config:read` and `ai_config:write`

Use this runbook to switch the AI Coach on for a deployment, to choose its models, to decide whether adult language and spoken messages are allowed, to tune how often it may reach out, to read how users respond, to estimate what it costs and to find out why a user did not get a nudge, an audio clip or a weekly email. It changes the system `coach` setting and the three coach model assignments only; it never adds an environment variable. For what the coach is and why it behaves as it does, see the [spec](../specs/ai-coach.md). This runbook links to the spec for rules and does not restate them.

## 1. Before you start

- AI is configured and switched on, with a key policy and at least one enabled model. If not, do [ai-configuration.md](ai-configuration.md) first. The coach is hidden and every `/api/coach/*` route answers `403 AI_DISABLED` while AI is off. The admin routes under `/api/admin/coach/*` stay reachable.
- You hold `ai_config:read` and `ai_config:write` (Admin only). To try the coach yourself you also need an account with `ai:use` and `programs:read` (Contributor), because the chat and the header state need both.
- The coach spends tokens on the key of the person it acts for: their own key under `byok`, or the organisation key. Read [section 6](#6-estimate-the-cost) before you enable it for everyone.
- Weekly review emails need working outbound email (`/admin/settings/email`). Nudges and the review also reach users by browser notification and Web Push only when Web Push is set up ([vapid-keys.md](vapid-keys.md)).
- A user's local time (quiet hours, "Sunday 18:00") comes from the **time zone in their health profile**. A user with none, or an unknown one, is planned in UTC.
- Nothing here needs a backup. The settings are plain values you can set back.

## 2. Enable the coach

The coach has three switches, and all three must be on for a user to receive anything.

| Switch | Where | Default |
|---|---|---|
| AI | `/admin/settings/ai` | off |
| Coach, deployment-wide | `/admin/settings/coach`, **Coach enabled** | on |
| Coach, per user | `/settings/coach`; picking a persona turns it on | off |

1. Open `/admin/settings`, then the **Coach** card in the AI group (`/admin/settings/coach`). The card is hidden while AI is off.
2. Confirm **Coach enabled** is on. Leave **Allow adult language** off and decide **Allow spoken messages** now (see [section 3](#3-allow-adult-language) and [section 4](#4-allow-spoken-messages)). Save.
3. Choose the models. Open `/admin/settings/ai/assignments` (the **Coach** section) and assign one model to each feature:

   | Feature id | Used for | The model must support |
   |---|---|---|
   | `coach.decision` | Nudges and the weekly review | `responses`, `structured_output` |
   | `coach.chat` | Chat | `responses`, tools, streaming |
   | `coach.voice` | On-demand **Listen** on a message, and the voice preview | `audio_speech` |

   A feature with no model of its own uses the **Organization default** when that model can serve it, and otherwise an automatic pick among the enabled models. Pin a model per feature to control cost. A model that lacks a needed capability is not offered for that feature.
4. Confirm as a contributor: `/settings/coach` lists the personas; picking one turns the coach on for that user; `/coach` loads. Today shows a coach card, and Coach is the fourth tab of the phone bottom bar (Gyms keeps that slot while the coach is hidden from a user).
5. Within an hour after a user turns the coach on, the hourly sweep plans for them. To watch it, open `/admin/settings/jobs` and look for `coach.sweep` (see [section 9](#9-monitor-and-troubleshoot)).

What users see when a piece is missing:

| State | What the user sees |
|---|---|
| Coach switched off by you | A notice on `/settings/coach`: the coach sends nothing until it is back on. Turning it on is refused (`COACH_DISABLED`). |
| No usable `coach.decision` model | Nudges are not sent (the job ends `no_model`); the weekly review is written from static persona prose instead. |
| No usable `coach.chat` model | The chat answers `409` with `AI_FEATURE_UNAVAILABLE`; the composer shows an error and nothing is stored. |
| No usable `coach.voice` model | Messages arrive as text only; the voice picker reports that no voices are available. |

## 3. Allow adult language

Adult language is possible for exactly one persona and level: Sarge at level 3 ("Unhinged"). It is off by default and it takes four things together, checked again for every message. The rules are in [spec §2.4](../specs/ai-coach.md#24-profanity-unlock); the operator's part is the first one.

1. In `/admin/settings/coach`, switch **Allow adult language** on and save.
2. Tell users what they must do themselves. In `/settings/coach` a user must pick Sarge, set the intensity to Unhinged, and confirm in the dialog that they are 18 or older. A user whose health profile holds a date of birth under 18 can never unlock it, whatever they confirm. A user with no date of birth is asked to confirm.

What users see while it is locked:

| Reason | Text on `/settings/coach` |
|---|---|
| You switched it off | "Adult language is switched off for this deployment by your administrator." |
| Not confirmed 18+ | "Confirm you are 18 or older to unlock adult language." |
| Under 18 in the health profile | "Adult language is only for people aged 18 or over, and the date of birth in your health profile says you are under 18." |
| Another persona or level | "Adult language applies only to Sarge at Unhinged (level 3)." |

Until it is unlocked, Sarge at level 3 is written as Sarge at level 2 (clean). Turning **Allow adult language** off again re-locks every user at once: the next message is clean, with no cleanup step. The lock-screen text of a push is clean even for an unlocked user, supportive messages are always calm and clean, and the weekly email is always clean.

To verify: as a contributor with an unconfirmed profile, open `/settings/coach` and observe the level is locked with the reason above. Turn the switch on, confirm 18+, pick Sarge at Unhinged, and observe the lock clear. Turn the switch off and observe it lock again.

## 4. Allow spoken messages

Audio is an option on top of text, and it is **generated only on request** (#259): every message arrives as text at once, and a clip is made only when the user presses **Listen** on it (or the push's **Hear Coach** button). Nothing is spoken in the background, so a deployment pays only for clips someone asked to hear.

1. In `/admin/settings/coach`, switch **Allow spoken messages** on (the default) and save. Off means no one can enable audio, and a user who tries gets `COACH_AUDIO_DISABLED`.
2. Assign a `coach.voice` model on `/admin/settings/ai/assignments`. Only a provider adapter with a speech port can serve it. Today that is OpenAI (a `tts-*` or `*-tts` model such as `gpt-4o-mini-tts`; the `tts-1` family speaks nine of the 13 voices). The Azure OpenAI, OpenAI-compatible, Gemini and Anthropic adapters have no speech port, so no model of theirs qualifies.
3. Set **Keep spoken audio for (days)** (default 30, 1 to 3650). The daily `coach.audio.purge` job deletes audio files older than that (counted from when the clip was requested) and keeps the message text. A purged clip is generated again if the user presses **Listen** again.
4. Each user turns audio on in `/settings/coach` and picks a voice and a speed (0.75 to 1.5). **Hear it** plays a sample line (a demo line, never the user's data). Previews are limited to 10 per 10 minutes per user, per API process (`COACH_PREVIEW_RATE_LIMITED`, with `Retry-After`).

How audio is made, and what happens when it fails:

- The message is saved and delivered as text straight away. When the user's audio is on and spoken messages are allowed, the push carries a **Hear Coach** button that opens `/coach?m=<id>&autoplay=1` (a push cannot play sound itself). On `/coach`, **Listen** (or that autoplay link) calls `POST /api/coach/messages/:id/audio`: it answers at once with ready audio, joins a clip already being made, or queues one `ai.audio.speech` run; `coach.audio.settle` records the result. No second notification is sent. The clip plays with the label "AI-generated audio".
- **Limit.** At most 20 new clips per 10 minutes per user, per API process (`COACH_AUDIO_RATE_LIMITED`, with `Retry-After`), separate from the preview limit. Replaying a ready clip does not count.
- **Refusal.** OpenAI's speech model sometimes declines profane text. A declined run, or one that produces under 1 KiB of audio, is recorded as `refusal`. It is never retried or rephrased automatically; the user may press **Listen** again.
- **Any other failure** is `provider_error`; no result within 2 minutes is `timeout`. The message keeps its text and stores `audioStatus = failed` with `data.audioFailure = { reason, code, at }` (`code` is the AI error code, never provider text). With no `coach.voice` model, **Listen** answers `409 AI_FEATURE_UNAVAILABLE` and nothing is recorded.

## 5. Tune how often it speaks

All limits are in `/admin/settings/coach`. The rules behind them are in [spec §2.5](../specs/ai-coach.md#25-decision-engine); the keys are in [spec §3.2](../specs/ai-coach.md#32-system-setting-coach).

| Setting | Default | Range | Effect |
|---|---|---|---|
| Nudges per user per day, at most | 4 | 1 to 4 | The ceiling. A user's own **Nudges per day** (default 2) is clamped to it. The weekly review is outside this cap. |
| Back off after ignored nudges | 3 | 1 to 20 | After that many nudges in a row that were never opened, the coach sends one back-off message and goes quiet. Opening the app, chatting or logging a workout ends the silence. |
| Stop after inactive days | 7 | 1 to 90 | After that many days with no activity the coach sends one win-back message and stops. |

Fixed in code, not settings: a minimum of 3 hours between two nudges, and quiet hours that each user sets (default 21:30 to 07:30, in their own time zone). To change those, change the code.

Effects of changing a value are immediate for the next sweep. Lowering the ceiling does not delete anything already sent.

## 6. Estimate the cost

These are **estimates, not measurements**. They assume token sizes typical for these prompts, and they leave the price out because it depends on the models you assign. Read the real numbers on `/admin/settings/ai/usage` after a week.

| Event | Model calls | Rough size per event (assumed) | Notes |
|---|---|---|---|
| Nudge | 1 structured call at `coach.decision` | about 3,000 to 5,000 input tokens, up to 1,500 output (the cap), usually a few hundred | A call where the model decides not to send (`model_declined`) still costs the same. |
| Weekly review | 1 call (2 when the in-app register is profane, to write a clean email) | about 5,000 input, up to 1,500 output | One per user per ISO week at most. |
| Chat turn | 1 to 20 model round trips at `coach.chat`, plus at most 2 calls without tools (a final round, a regeneration); no output limit of the coach's own | A tool result can be large (a workout history carries every set and note), and each one is sent back on every later round trip | Tools are read-only. A deployment output cap in `ai.limits`, when set, still applies. |
| Listen (on request only) | 1 speech call, the first time a message is played | A spoken line is at most 600 characters, about 20 to 40 seconds | At about $0.015 per minute (OpenAI's published rate for `gpt-4o-mini-tts`), roughly half a cent or less per clip. Replays of a ready clip are free. Check the current rate with the provider. |

Per user, using the defaults:

- At most 4 nudges a day is the hard ceiling, and the default per-user cap is 2 (about 60 a month at most). Most users get far fewer, because most days no moment is eligible. Plan on 20 to 60 nudge calls a month for an active user.
- At most 1 weekly review a week (about 4 or 5 a month).
- Audio costs only what users choose to hear: one clip per message they press **Listen** on, at most 20 new clips per 10 minutes per user. A user who listens to every nudge at the default cap (2 a day) stays well under a dollar a month at that rate; most listen to far fewer.
- Chat is the least predictable: it costs what the user chats. Per-user and per-model request rates in `ai.limits` ([ai-configuration.md](ai-configuration.md)) bound it.

To turn a token count into money, multiply by your models' per-million-token prices. Put a cheaper model on `coach.decision` (it writes a short structured message) and a stronger one on `coach.chat` if cost matters. To cap spending quickly, lower the ceiling, turn **Allow spoken messages** off, or switch **Coach enabled** off.

## 7. Read engagement

`/admin/settings/coach` ends with an **Engagement** panel (also `GET /api/admin/coach/stats`, permission `ai_config:read`). It shows counts and rates only, never a user id or a message text. Choose a range of up to 365 UTC days (default 30); a longer or reversed range answers `400` with `COACH_STATS_RANGE_INVALID`.

| KPI | Meaning |
|---|---|
| Nudge open rate | Opened of sent, over delivered coach messages (every kind except chat replies). |
| Follow-through | Of messages with a target (a workout moment or a photo prompt), the share followed by the target action in time: 24 hours for a workout or check-in, 48 hours for a photo. |
| Chat sessions per active user | Chat days per user who trained or chatted in the last 7 days of the range. |
| Photo cadence kept | Coach users with a photo cadence who added a photo within it. |
| Opt-out rate | Users who switched the coach off after setting it up, of those off plus those on. |

Tables break the funnel down by angle, persona and moment, with thumbs up and down. A rate shows a dash when its denominator is zero. Weekly adherence is not summed across users, so that tile is always empty.

Suppressions are not rows, so the panel cannot show them; they are a metric ([section 9](#9-monitor-and-troubleshoot)). The metrics are listed in [telemetry.md](../specs/telemetry.md#metric-reference) (names starting `app.coach.` and `coach.`) and can be read in the telemetry explorer ([telemetry.md runbook](telemetry.md)).

## 8. The weekly review and its email

At the user's local Sunday 18:00 (caught up until Monday 18:00) the sweep queues `ai.coach.weekly_review`, one per ISO week. The review is a card in `/coach` whose numbers come from the training signals, never from the model, and it is also sent on the channels the user left on for the `coach.weekly_review` notification event (`email`, browser, push).

- **The email needs SMTP.** Set up outbound email first (`/admin/settings/email`). Without it the card still appears and the browser and push channels still work; the email delivery fails and is recorded in `notification_deliveries`.
- The email is always in the clean register, carries a stats table and a link to `/coach`, and is sent with transactional headers.
- A user mutes a channel in `/settings/notifications`. The planner does not apply that mute to the review itself (the card also advances the streak); the dispatcher just skips the muted channels.
- If the model is unavailable, the guard rejects its text, or the last attempt fails, the review is written from static persona prose and still ships. Count those with `app.coach.weekly_review.fallback`.

### Goal messages (nudges and the review)

The coach also speaks about a user's [activity goals](../specs/activity-goals.md). There is no setting to turn this on or off: it follows **Coach enabled**, the user's own coach switch and the notification preferences.

- `goal_at_risk` comes from the hourly sweep. Week goals are checked from the user's morning time (their preferred time, else 09:00 local); day goals from the evening time (usual workout time minus 30 minutes, else their preferred time, else 17:00). A goal that is already hit is never at risk.
- `goal_hit` comes right after a goal check-in or a finished workout that first reaches a goal (the `coach.activity_recorded` or `coach.workout_finished` job).
- Each goal gets at most one of each message per period (week or day), and at most one of each kind per local day. The daily cap, quiet hours, 3-hour spacing, pause and back-off apply as to every nudge.
- A goal paused, archived, deleted or caught up before the message is written ends the job with suppression reason `goal_resolved`: expected, nothing to fix.
- The weekly review lists each goal and the email carries one `Goal:` row per goal. Day goals show days hit out of 7.
- A user who checks in after the coach backed off re-engages it, like logging a workout.

## 9. Monitor and troubleshoot

Where to look, in order:

1. **Doctor** (`/admin/settings/doctor`): AI, model assignments, email and Web Push. It has no coach check of its own; fix what it reports there first ([doctor.md](doctor.md)).
2. **Jobs** (`/admin/settings/jobs`): the coach job types below.
3. **AI Usage** (`/admin/settings/ai/usage`): each coach model call.
4. **Telemetry** (`/admin/settings/telemetry/explorer`): the `app.coach.*` counters.

| Job type | What it does | Profile (max runtime, attempts) |
|---|---|---|
| `coach.sweep` | Hourly at minute 17, only while AI and the coach are on: plans each enabled user's next moment | 5 minutes, 2 |
| `coach.workout_finished` | After a finished workout: plans `comeback`, `pr`, `weekly_target_hit` or `goal_hit` for that user | 1 minute, 2 |
| `coach.activity_recorded` | After a manual goal check-in: plans `goal_hit` for that user | 1 minute, 2 |
| `ai.coach.nudge` | Writes, guards and persists one nudge | 2 minutes, 2 |
| `ai.coach.weekly_review` | Writes one weekly review | 3 minutes, 2 |
| `coach.message.deliver` | Sends one message's notification | 3 minutes, 3 |
| `coach.audio.settle` | Records a requested clip's result (never sends a notification for it) | 30 seconds, 3 |
| `coach.audio.purge` | Daily at 03:23 UTC: deletes audio older than the retention | 10 minutes, 2 |

All are server-only. Every coach job runs on the API process, never on a worker node.

### No nudges arrive

Work down this list.

1. **Switches.** AI on; **Coach enabled** on; the user turned the coach on in `/settings/coach`. The sweep plans only users who have it on.
2. **The sweep runs.** In `/admin/settings/jobs`, `coach.sweep` should succeed each hour. None at all means AI or the coach switch is off, or the API process is not running its scheduler. A failed one shows its error.
3. **Why a moment was dropped.** The planner counts every gate it applies in `coach.nudge.suppressed{coach.reason}`; read it in the telemetry explorer. A job that ran but sent nothing is in `app.coach.nudge.suppressed{reason}`.

   | Reason | Meaning | Fix |
   |---|---|---|
   | `quiet_hours` | The user's local time is inside their quiet hours. | Expected. Check the health-profile time zone is right. |
   | `daily_cap` | The user's cap for the day is spent. | Raise the user's own cap or the ceiling. |
   | `spacing` | Less than 3 hours since the last nudge. | Expected. |
   | `paused` | The user asked the coach to pause (1 to 14 days, from chat). | Wait, or the user can say so in chat. |
   | `silenced` | The back-off message was sent after ignored nudges. | Clears when the user opens the app, chats, logs a workout or records a goal check-in. |
   | `pref_off` | The user turned that notification event off. | The user's choice, in `/settings/notifications`. |
   | `already_sent` | The same moment was already sent that local day (a goal moment: that goal and period). | Expected. |
   | `goal_resolved` | The goal was paused, archived, deleted or caught up before the message was written. | Expected. |
   | `safety_supportive_only` | An active safety stop or pain streak allows only supportive messages. | Expected. |
   | `coach_off` | A switch is off for the user. | See step 1. |
   | `handler_missing` | The nudge job handler is not registered in this process. | Check the API started cleanly and the build is current; restart. |
   | `model_declined` | The model chose to stay quiet. | Expected; it still cost a call. |
   | `no_model` | `coach.decision` resolves no model. | Assign one ([section 2](#2-enable-the-coach)). |
   | `ai_error` | The provider call failed. | Check AI Usage and the key; see [ai-configuration.md](ai-configuration.md). |
   | `guard_rejected` | The text failed the content guard twice, and so did the static fallback. | Rare. Check `app.coach.guard.rejected{reason}`. |

4. **Delivery.** The message is in `/coach` but no push or toast arrived: check `coach.message.deliver` jobs and `app.notifications.deliveries` by outcome, then Web Push setup ([vapid-keys.md](vapid-keys.md)).

### No audio

1. **Switches.** **Allow spoken messages** on; the user turned audio on (otherwise **Listen** answers `403 COACH_AUDIO_DISABLED` and the push has no **Hear Coach** button). Audio is made only when the user presses **Listen**: a message nobody played has `audioStatus` `none`, which is expected.
2. **`coach.voice` resolves a model.** If not, **Listen** answers `409 AI_FEATURE_UNAVAILABLE`. Assign a speech model on `/admin/settings/ai/assignments`. The voice preview answers the same `409` when it is unresolved.
3. **Read the outcome.** `app.coach.audio.requested{outcome}` counts every press: `started`, `ready` (a replay), `pending` (joined a clip in progress), `failed`, `disabled`, `rate_limited`, `no_voice_model`. `app.coach.audio.failed{reason}` shows `provider_error`, `refusal` or `timeout`. A rising `refusal` count means the model declined the text (often profane). A `timeout` points at the `ai.audio.speech` job: look at it in `/admin/settings/jobs`, and check the queue is not backed up. Many `rate_limited` means a user is pressing faster than 20 new clips per 10 minutes.
4. **The clip is gone.** Audio older than the retention is deleted by `coach.audio.purge`; pressing **Listen** again makes a new one.
5. **A voice the model does not speak.** The `tts-1` family speaks nine voices. A request for another is a `provider_error`; the user should pick another voice.

### The weekly email does not arrive

1. The card exists in `/coach` for that week. If not, check `ai.coach.weekly_review` in the Jobs page and `app.coach.weekly_review.skipped{coach.reason}` (`not_due`, `paused`, `coach_off`, `already_sent`).
2. Outbound email works: `/admin/settings/email` and the Doctor.
3. The user has the `coach.weekly_review` email channel on in `/settings/notifications`, and a valid address.
4. The user's time zone: the review is due at their local Sunday 18:00, so a user with no zone is reviewed at 18:00 UTC.

### Chat answers `409 AI_FEATURE_UNAVAILABLE`

No model resolves for `coach.chat`. Assign one that supports tools and streaming on `/admin/settings/ai/assignments`. The user's message is not stored in this case. Other chat refusals: `403 COACH_DISABLED`, `403 AI_DISABLED`, `429 AI_RATE_LIMITED` (see `ai.limits`). The streaming route is `POST /api/coach/chat/stream`; behind a proxy it needs an unbuffered location, which the shipped nginx and the CLI's proxy config already have.

### A chat reply is the generic "couldn't put that answer together" line, or is cut or odd

Each coach chat reply row stores diagnostics in `data` (never text). Read them on `coach_messages` for the message (`kind = 'chat'`, `role = 'coach'`); there is no UI for them. How a turn settles is in [spec §2.9](../specs/ai-coach.md#29-chat) (**Reliability**).

| `data` | Meaning | What to check |
|---|---|---|
| `fallback: true` | The fixed fallback line replaced the reply: the guard failed it on a hard rule after one regeneration, or no text came back at all. `guard` lists the rules. | `guard` with a tone or safety rule (banned term, profanity, insult target) means the model wrote something the guard must block: usually rare, try a stronger `coach.chat` model. An empty `guard` or only `length` with `finishReason` `length` or `content_filter`, or an empty `lastFinishReason`, means the provider returned nothing usable: check the model's limits and the `coach.chat` assignment. |
| `softPass: true` | Delivered anyway: after regeneration the only failures were `invented_number` or `length`. `guard` says which. | Expected now and then. A rising `app.coach.chat.guard_soft_passes{coach.reason}` for `invented_number` means the model quotes figures no tool returned; the reply may contain a wrong number. For `length`, the reply was cut at a sentence boundary at 6,000 characters. |
| `finalRound: true` | The tool loop ended without text, so one more call without tools ran. | `stopReason: steps_exhausted` means the model used all 20 round trips on tools: look at which tools it calls in `app.coach.chat.tool_calls{coach.tool,coach.status}`. `stopReason: completed` with an empty reply points at a reasoning model that spent its budget thinking: check `finishReason`. |
| `retried: true` | The guard failed the first reply; it was regenerated once. | With no `fallback` or `softPass`, the second try passed. |
| `finishReason`, `lastFinishReason` | The provider's reason for the loop's last call, and for the last call without tools. | `length` or `max_tokens` means the model hit its own output ceiling or an `ai.limits` output cap: raise or remove the cap. |

Aggregate view: `app.coach.chat.turns{coach.outcome}` (`model`, `safety`, `fallback`, `soft_pass`), `app.coach.chat.recoveries{coach.recovery}` (`final_round`, `regenerated`) and `app.coach.guard.rejected{reason}` in the telemetry explorer ([section 9](#9-monitor-and-troubleshoot)). A healthy deployment shows `fallback` as a small share of `turns`. Also check that the model supports tools reliably, that the user is not asking the same thing in a way that triggers a banned-topic rule, and that a tool is not failing (`coach.status` other than ok).

### Settings will not save

`403 COACH_PROFANITY_LOCKED` names the unlock condition that failed ([section 3](#3-allow-adult-language)). `403 COACH_AUDIO_DISABLED` means **Allow spoken messages** is off. `403 COACH_DISABLED` means **Coach enabled** is off. See [spec §3.7](../specs/ai-coach.md#37-error-codes).

## 10. Try it without a key

The overlay [`infra/compose/fake-ai.compose.yml`](../../infra/compose/fake-ai.compose.yml) starts two fake servers for development and end-to-end tests ([ai-training-plans.md](ai-training-plans.md#3-try-it-with-the-fake-provider) shows how to start and point at them). Both answer the coach with fixed, digit-free lines that pass the content guard; they do not simulate a persona's voice.

- **Text** (`fake-ai`, port 4010, the OpenAI-compatible provider, model `fake-coach`): classify it `responses`, `structured_output`, `tools` and `streaming`, then assign `coach.decision` and `coach.chat` to it on `/admin/settings/ai/assignments`. It answers the structured nudge (`coach_nudge`, every moment; the kickoff asks when, where and the fallback) and the weekly review prose (`coach_weekly_review`) by schema name, and a chat turn as one `get_training_signals` call followed by an answer built from the tool result (a progress question), or directly (anything else).
- **Speech** (`fake-ai-responses`, port 4011, the `openai` provider, model `fake-tts`): the catalog classifies it as a speech model; assign `coach.voice` to it, allow spoken messages in `/admin/settings/coach`, and give the user a key for the `openai` slot (any string of 8 or more characters). `POST /v1/audio/speech` returns a silent MP3 of about 3 KiB, above the 1 KiB floor the coach treats as real audio.
- **Failure switches**: `POST :4010/__control/coach {"nudge":"send"|"decline"}` makes the fake answer `send: false` (a kickoff is always sent); `POST :4011/__control/speech {"mode":"ok"|"fail"|"refuse"}` makes speech succeed, error, or answer a content-policy refusal (the message is then text only with `audioStatus = failed`). `POST /__control/reset` on either server restores the defaults.
- `npm test -- coach-settings coach-page progress-photos --workers=1` in `tests/e2e` does the setup itself ([TESTING.md](../TESTING.md)).
- Without a model assigned, the settings, the `/coach` page, the progress-photo gallery and a static persona weekly review still work.
- To judge real wording, use a real key and a cheap model on a test account, with the daily ceiling at 1.

## 11. Turn it off

- **For everyone, for now:** in `/admin/settings/coach`, switch **Coach enabled** off and save. The hourly sweep stops enqueueing, the planner and the nudge job send nothing, settings stay stored, and `/settings/coach` shows a notice. Chat answers `403 COACH_DISABLED`. The progress-photo gallery keeps working: it does not depend on the coach.
- **Audio only:** switch **Allow spoken messages** off. Text messages continue.
- **Adult language only:** switch **Allow adult language** off ([section 3](#3-allow-adult-language)).
- **All AI:** the AI kill switch hides the coach and its tab; see [ai-configuration.md](ai-configuration.md).
- A user's **Delete all my data** (`/settings/danger-zone`) removes that user's coach messages, state, progress photos and their audio and photo files.

## 12. Summary checklist

- [ ] AI is on with a key policy and an enabled model ([ai-configuration.md](ai-configuration.md))
- [ ] `/admin/settings/coach`: **Coach enabled** on
- [ ] `coach.decision`, `coach.chat` and `coach.voice` assigned on `/admin/settings/ai/assignments`
- [ ] **Allow adult language** decided (default off)
- [ ] **Allow spoken messages** and **Keep spoken audio for (days)** decided; a speech model assigned if audio is allowed
- [ ] Daily ceiling, back-off and inactive-stop values reviewed
- [ ] Outbound email configured for the weekly review; Web Push configured if you want push
- [ ] A test account picked a persona, saw `/coach`, and received a nudge or, at Sunday 18:00, a review
- [ ] `coach.sweep` succeeds hourly in `/admin/settings/jobs`
- [ ] Cost reviewed on `/admin/settings/ai/usage` after the first week

## Memory

The coach remembers short facts about each user (#325, [ai-memory.md](../specs/ai-memory.md)): the name they want to be called, schedule, equipment, goals, an injury their training must respect, coaching style. It is on by default and inert until AI is on.

- **Where it comes from.** The user asks the coach to remember something (the chat's `remember` tool; a "Memory updated" chip with Undo appears), the user types it in **Settings > Memory**, or, while background learning is on, the `ai.memory.extract` job learns it from the user's own chat messages about five minutes after a conversation.
- **Assign the extraction model.** `memory.extract` on `/admin/settings/ai/assignments` (needs `responses` and `structured_output`; a cheap model is fine). Without a runnable model the background job skips quietly; explicit memories still work.
- **Policy.** System settings `memory`: `enabled` (the feature), `autoExtract` (background learning), `maxPerUser` (50 to 500, default 200), `extractDailyCapPerUser` (default 20 runs per user per UTC day), `purgeAfterDays` (how long deleted and replaced facts can be restored before `memory.purge` erases them; default 30).
- **The user's switches** (`PATCH /api/user-settings`, `memory`): **Memory on**, **Learn automatically**, **Allow health-related memories**. With memory off the coach neither sees nor writes memories, but the user can still list, edit and delete them.
- **What is refused.** A memory that reads as an instruction to the coach, or holds a link, email, code, password or key, card or bank details, a phone number or another person's details, is rejected (`400 MEMORY_CONTENT_REJECTED`, `details.rule`). A health fact while **Allow health-related memories** is off is `400 MEMORY_HEALTH_NOT_ALLOWED`. Over the cap, a user's own add is `409 MEMORY_LIMIT_REACHED`; background learning evicts its own oldest unpinned fact instead.
- **Where it is used.** The coach chat, nudges and weekly review (every category), and the training planner (goal, preference, constraint/injury, schedule, equipment and training history only). Never the researcher's web searches.
- **Monitor.** `ai.memory.extract` and `memory.purge` in `/admin/settings/jobs`; counters `app.memory.added`, `updated`, `deleted`, `noop` and `rejected` (by source, and rule for rejections). Logs carry ids and counts only, never a memory.
- **Troubleshoot.** No facts learned: check `memory.autoExtract` (system and user), the `memory.extract` assignment, and the daily cap. `ai.memory.extract` jobs succeed with "skipped (no_model)" when no model resolves. Near-duplicates are matched with the `pg_trgm` extension the migration installs; without it the API logs once and only exact duplicates are merged.
- **Turn it off.** For everyone: system `memory.enabled` off. Background learning only: `memory.autoExtract` off. A user's **Delete all my data** removes their memories; **Delete all memories** on the Memory page soft-deletes them (restorable until purged).

## See also

- [ai-coach.md](../specs/ai-coach.md): the design, the rules, every setting and error code.
- [ai-configuration.md](ai-configuration.md): turning AI on, key policy, model curation, `ai.limits`.
- [ai-training-plans.md](ai-training-plans.md): the training agents the coach reads its numbers from, and the fake-provider overlay.
- [doctor.md](doctor.md): triage of email, Web Push and AI.
- [telemetry.md](telemetry.md): reading the `app.coach.*` metrics.
- [vapid-keys.md](vapid-keys.md): Web Push keys.
