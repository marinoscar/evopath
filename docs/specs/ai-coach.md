# AI Coach

> **Status:** Proposed — not yet implemented · **Code:** `apps/api/src/coach/` (new), `apps/web/src/pages/CoachPage.tsx` and `apps/web/src/components/coach/` (new) · **API:** `/api/coach/*`, `/api/progress-photos/*`, `/api/admin/coach/*` (new; see `/api/docs` once built) · **User UI:** `/coach`, `/settings/coach`, Health → Progress photos · **Admin UI:** `/admin/settings/coach` · **Runbook:** none yet (planned `docs/runbooks/ai-coach.md`) · **Recipe:** [§4](#4-extending-it-in-a-fork)

The AI Coach turns adherence data into accountability. A deterministic scheduler decides when the coach is allowed to speak. A model decides whether it should and what to say, in the voice of a persona the user picked. The coach nudges by push, browser notification and optional audio, chats with the user, sends a weekly progress email, tracks a weekly streak and asks for progress photos. Every number it quotes comes from [training signals](training-signals.md), never from the model. Every model call goes through `AiService.forUser`. Admins choose the models on the AI Model Assignments page; users choose the persona, intensity and, for one persona, an opt-in profane mode.

This page is the single home for the design. It is written ahead of the code: every path marked **(new)** does not exist yet, and every unmarked path exists today. Epic E7 carries the stories (E7.1 to E7.13) that build it.

## 1. Purpose

**What it is.**

- A proactive layer over the adherence the app already computes. It notices a missed week, a streak at risk or a personal record and reaches out.
- A timeline at `/coach` that mixes nudges, chat, weekly reviews and photo prompts in one conversation.
- A persona system (seven original archetypes, three intensities) with an optional, age-gated profane drill-sergeant mode.
- Optional spoken nudges (OpenAI text-to-speech) that always arrive with their text.
- A weekly review (stats from the server, prose from the model), also sent by email.
- Progress photos: private storage, a gallery, a compare view and a ghost overlay for consistent poses.

**What it is not.**

- **Not a source of health truth.** A persona changes wording, never facts or safety ([VISION.md §4.5](../../VISION.md)). The numbers come from `TrainingSignalsService`.
- **Not medical advice.** Pain, urgent symptoms and distress cues switch the coach to a supportive register and suppress pushy moments ([§2.14](#214-safety)).
- **Not a plan editor.** The coach proposes and deep-links to the existing adjust flow. The user stays in control ([VISION.md §4.3](../../VISION.md)).
- **Not an AI body analyst.** Photos are never sent to a model and never put in a notification ([§2.12](#212-progress-photos)).
- **Not a gamification system.** The weekly streak and pass are the only game mechanic. XP, badges and leagues are a separate epic ([§7](#7-out-of-scope-and-follow-ups)).
- **Not an LLM agent graph.** No LangGraph. Plain handlers call the gateway ([§6](#6-design-decisions)).

**The problem it solves.** The app builds plans and computes adherence, but nothing acts on a missed week. [VISION.md](../../VISION.md) puts adherence at the centre of the core loop (§2: track, reassess, improve), calls for an AI coaching profile (§7), rewards behaviour rather than outcomes (§65 to §67), treats progress photos as evidence (§87) and asks for weekly reviews built on real data (§94). The coach closes that loop.

| VISION section | What the coach does with it |
|---|---|
| §2 core loop | Turns "reassess" into a message at the moment it matters. |
| §4.5 health truth and personality are separate | Persona is a style layer; facts and safety are code ([§2.1](#21-architecture-and-the-authority-split), [§2.14](#214-safety)). |
| §7 coaching profile | Persona, intensity, quiet hours and "your why" are the profile. |
| §65 to §67 gamification | Rewards behaviour (sessions, check-ins, photos), never outcomes. No restriction or extreme-exercise framing. |
| §87 photos as evidence | Progress photos are linked evidence, not analysed. |
| §94 progress reviews | The weekly review: deterministic stats plus persona prose. |

## 2. How it works

### 2.1 Architecture and the authority split

**The deterministic layer decides when the coach may speak. The model decides whether it should and what to say.** The model can only narrow what the server allows; it can never widen it.

| Layer | Decides | Never decides |
|---|---|---|
| Server code (`planCoachMoments`, gates, guard) | Whether any message is allowed: quiet hours, caps, spacing, pauses, safety, preferences, profanity unlock. Every number in the text. | The wording. |
| Model (`ai.coach.nudge`) | `send` or `send:false`; the words, in persona; the audio script. | Anything a gate forbade; any figure. |

```
cron 17 * * * *  ──►  coach.sweep job  ──►  planCoachMoments(signals, state, settings, nowLocal)
                                                   │ ranked eligible moments (pure, table-tested)
                                                   ▼
                      ai.coach.nudge job ──► coach.decision model ──► content guard ──► CoachMessage
                                                                                          │
                          text only ◄──────────────────────────────────────────────────────┤
                          ▼                                                                │ audio on
                    notifyNow(coach.*)                                          speak() ──► JOB_SETTLED_EVENT
                                                                                          ▼
                                                                              coach.message.deliver ──► notifyNow
```

- **Numbers.** Adherence, streaks and counts are read from `TrainingSignalsService.forEvaluator` and `compactForEvaluator` (`apps/api/src/programs/signals/signals.service.ts`, `compact-signals.ts`). The model receives them as context and may restate them, but the guard rejects a message whose digits do not appear in the context ([§2.6](#26-nudge-generation-and-the-content-guard)). A review's stats table is built by code and the model never writes it ([§2.10](#210-weekly-review-and-email)).
- **Module.** `apps/api/src/coach/` **(new)**. It imports no `@langchain/*` package, so the orchestration boundary in [ai-platform.md §5](ai-platform.md#5-guardrails) does not apply. It never imports a provider SDK ([AI platform rule 1](../../CLAUDE.md)).
- **Server-only jobs.** Every `ai.coach.*` job is server-only: a user's key is never brokered to a worker node ([§3.4](#34-jobs)).

### 2.2 Data model

Three new models in a new Prisma migration **(new)**. Each carries `userId` with `onDelete: Cascade`. Table names are snake case via `@@map`.

#### `CoachMessage` (`coach_messages`)

One timeline per user. Index `(userId, createdAt desc)`.

| Field | Type | Meaning |
|---|---|---|
| `id` | uuid | Primary key. Used in the deep link `/coach?m=<id>`. |
| `userId` | uuid | Owner. |
| `role` | `coach` or `user` | Who wrote it. Chat turns from the user are rows too. |
| `kind` | `nudge`, `chat`, `weekly_review`, `celebration`, `photo_prompt`, `comeback`, `kickoff`, `system` | Card type in the timeline. |
| `moment` | enum, nullable | The trigger ([§2.5](#25-decision-engine)). Null for chat. |
| `angle` | enum, nullable | The bandit arm ([§2.8](#28-learning-loop)). |
| `personaId`, `intensity` | string, int | Snapshot at send time; later setting changes do not rewrite history. |
| `title`, `body` | text | The in-app content. |
| `pushTitle`, `pushBody` | text, nullable | Lock-screen-safe variant ([§2.4](#24-profanity-unlock)). |
| `audioStatus` | `none`, `pending`, `ready`, `failed` | State of the optional audio. |
| `audioStorageObjectId` | uuid, nullable | The stored mp3 (`ai-outputs/<userId>/<runId>/`). Registered for reference checks. |
| `audioRunId` | uuid, nullable | The `ai_runs` row of the `speak()` call. Maps a settled job back to the message. |
| `aiRunId` | uuid, nullable | The `ai_runs` row of the text generation. |
| `provider`, `model` | string, nullable | What produced the text. |
| `notificationId` | uuid, nullable | The inbox row, once delivered. |
| `data` | json, nullable | Review stats (the deterministic block of [§2.10](#210-weekly-review-and-email)). |
| `deliveredAt`, `openedAt`, `convertedAt` | timestamp, nullable | Funnel timestamps. `convertedAt` follows the windows in [§2.8](#28-learning-loop). |
| `feedback` | `up`, `down`, null | Thumbs on any coach message. |
| `createdAt` | timestamp | Ordering key. |

#### `CoachState` (`coach_states`)

One row per user, created lazily by the sweep or on first settings write.

| Field | Type | Meaning |
|---|---|---|
| `userId` | uuid, unique | Owner. |
| `lastNudgeAt` | timestamp, nullable | Spacing gate. |
| `nudgesToday`, `nudgeDayLocal` | int, date | Daily cap counter; resets when `nudgeDayLocal` is not the user's local date. |
| `consecutiveIgnored` | int | Nudges delivered and not opened in 24 hours, in a row. Reset by any open, chat message or logged workout. |
| `pausedUntil` | timestamp, nullable | Set by the `pause_coach` chat tool or the settings page. |
| `silencedAt` | timestamp, nullable | The automatic back-off ([§2.5](#25-decision-engine)). |
| `lastSweepAt` | timestamp, nullable | Diagnostics. |
| `usualWorkoutMinuteLocal` | int, nullable | Median start minute of the local day over 4 weeks of completed workouts. Null with fewer than 4 sessions. |
| `weeklyStreak`, `streakPassesLeft` | int | [§2.11](#211-weekly-streak-and-passes). |
| `lastWeeklyReviewWeek` | string, nullable | ISO week key of the last review (`2026-W40`); the dedup key. |

#### `ProgressPhoto` (`progress_photos`)

| Field | Type | Meaning |
|---|---|---|
| `id`, `userId` | uuid | Identity and owner. |
| `storageObjectId` | uuid | The uploaded image, registered with `StorageObjectReferences` so storage never purges it while referenced. |
| `localDate` | date | The user's local calendar day it represents. |
| `pose` | `front`, `side`, `back`, `other` | Drives the ghost overlay pairing. |
| `note` | text, nullable, 200 chars | Free text; never read by any model. |
| `createdAt` | timestamp | |

**Partial unique indexes.** None. The sweep and review dedup through the job queue's active-dedup index and `lastWeeklyReviewWeek`, not a new raw-SQL index.

**Reset and erasure.** All three models are the user's own data. Follow [user-data-reset.md §4](user-data-reset.md#4-extending-it-in-a-fork) steps 1 to 7 in `apps/api/src/user-data/user-data-purge.ts`: add three `deleteMany` calls to `deleteUserOwnedRows`, add their counts to `ZERO_ROW_COUNTS`, add the photo and audio storage object ids to `collectUserObjectIds`, extend `apps/api/test/user-data/user-data-reset.db.spec.ts`, and update the keep/delete survey in `user-data-reset.handler.ts`. The admin [factory reset](factory-reset.md) shares the same file, so it needs no second change. Audio files that are purged by retention ([§3.2](#32-system-setting-coach)) leave `audioStatus = 'none'` and keep the text.

### 2.3 Personas

A persona is a data file in a registry, served by `GET /api/coach/personas` so the web never carries a second copy.

- **Registry.** `apps/api/src/coach/personas/*.persona.ts` **(new)**, one file per persona, collected by `apps/api/src/coach/personas/index.ts` **(new)** into `COACH_PERSONAS`.
- **Each persona carries:** `id`, `name`, `tagline`, `avatar` (icon key), a style card (lexicon, do and don't, an intensity rubric for levels 1 to 3), a default voice with TTS `instructions`, and static sample lines for every moment. Sample lines are served as-is, so a preview in `/settings/coach` costs nothing and calls no model.
- **Moments with sample lines.** `COACH_MOMENTS` in `apps/api/src/coach/personas/persona.types.ts`: the planned moments of [§2.5](#25-decision-engine) (`missed_twice`, `streak_at_risk`, `comeback`, `pr`, `weekly_target_hit`, `missed_session`, `fresh_start`, `photo_prompt`, `win_back`), plus `back_off` (the auto-silence message), `kickoff` and `weekly_review`, so every message the coach can send has a static fallback. Sarge has a line per level; the other personas carry one line per moment that serves every level (their level changes the rubric the model receives, not the static sample).
- **Lexicon figures.** A persona may declare `lexiconNumbers`, figures that are style rather than data (Sarge's "40 percent", Coach's "20-minute version"). The content guard's numbers rule admits them besides the context's figures.
- **Serving L3.** `GET /api/coach/personas` returns Sarge's level-3 lines only to a caller whose register is profane; otherwise the level-2 lines stand in and the card's `censored` is `true`.
- **Selection.** The user's `coach.personaId` and `coach.intensity` (1 to 3). The persona card goes into the model's system prompt; the registry is the only place persona text lives.
- **Hard limits, every persona, every level.** No body or weight shaming, no slurs, no insults about protected traits, no sexual content, no self-harm themes, no impersonation of a real person, no health claims. A persona may be harsh about **effort and excuses**, never about the person's body, health or worth.

| id | Name | Vibe | Intensity 1 / 2 / 3 | Default voice |
|---|---|---|---|---|
| `coach` | **Coach** (default) | Warm, specific, celebrates small wins | Gentle / Steady / Firm | `coral` |
| `drill_sergeant` | **Sarge** | Military cadence, no excuses | **Tough / Brutal / Unhinged** (profane, 18+, opt-in) | `onyx` (L1, L2), `ash` (L3) |
| `stoic` | **The Stoic** | Calm, the obstacle is the way | Quiet / Direct / Severe | `sage` |
| `analyst` | **The Analyst** | Numbers, trends, dry wit | Neutral / Pointed / Merciless about the data | `echo` |
| `butler` | **Reginald** | Sarcastic British butler | Courteous / Arch / Withering | `fable` |
| `hype` | **The Announcer** | Sports-broadcast hype man | Upbeat / Loud / Stadium | `verse` |
| `nana` | **Nana** | Loving, disappointed grandmother | Fond / Sighing / Guilt-trip (kind, never cruel) | `shimmer` |

All seven personas are original archetypes. None is named after, or quotes, a real person or a film ([§6](#6-design-decisions)).

The example lines below are the registry's sample lines. They use placeholders the server fills from signals: `{n}` a count, `{streak}` a streak in weeks, `{lift}` an exercise name, `{time}` a local time.

#### Coach (default)

- **Style card.** Specific over generic. Names the exact win ("three sessions in a row"). Frames a miss as information, one miss as normal. Never sarcastic. Ends with one small, concrete next step.
- **Missed session.** "Wednesday's session slipped by. It happens. Want a 20-minute version tonight, or shall we move it to tomorrow?"
- **Streak at risk.** "You're one session from a {streak}-week streak. Your usual time is {time}. I've got your warm-up ready."
- **Comeback / PR.** "You're back. That is the hardest rep of the week and you did it. Also: {lift} is a new best. Well earned."
- **Photo prompt.** "It's been two weeks. A quick front photo today gives future you something real to compare against. Takes a minute."

Voice: `coral`. TTS instructions: "Speak warmly and clearly, like a supportive coach who knows the listener well. Moderate pace, genuine smile in the voice, brief pauses before the suggested next step."

#### Sarge (`drill_sergeant`)

- **Style card.** Short imperative sentences. Parade-ground cadence ("Hup", "Move", "Count it off"). Calls the user "recruit". Themes: carry your own logs (own your records), your mind quits at 40 percent, the accountability mirror, the cookie jar of past wins. Every insult targets **effort or excuses**, never the body, weight, health or identity. Celebrates results like a proud sergeant. At L3 the profanity is heavy and uncensored, available only under the unlock in [§2.4](#24-profanity-unlock).
- **Rubric.** L1 Tough: clipped, firm, clean. L2 Brutal: sharper sarcasm about excuses, still clean. L3 Unhinged: the same voice with heavy profanity and louder cadence.
- **Do not.** Quote film lines, use a real drill instructor's or athlete's signature phrases, comment on appearance, or mock pain, injury or a stated illness.

**Level 1 (Tough, clean).**

- **Missed session.** "Recruit. You missed Wednesday. That's one. We don't miss two. Be at the bar tonight."
- **Streak at risk.** "{time} is your hour and it's slipping. Shoes on. Move."
- **Comeback / PR.** "You came back. Good. {lift} is a new record. Log it and keep moving."

**Level 2 (Brutal, clean).**

- **Missed session.** "Two sessions gone and a pile of reasons. Reasons don't lift anything, recruit. The bar is where you left it."
- **Streak at risk.** "{streak} weeks of showing up, and you're about to let a bad mood take it. Your mind quits at 40 percent. Make it earn the other 60. Get to the gym."
- **Comeback / PR.** "Look who reported for duty. {lift}, new best. Don't get sentimental. Get your next set."

**Level 3 (Unhinged, profane, 18+, opt-in).** These are the uncensored sample lines the settings preview shows only after the unlock.

- **Missed session.** "Two sessions, recruit. Two. And not one fucking word of explanation that's worth a shit. Your mind is quitting at 40 percent and you're calling it a rest day. Get off your ass and get to the bar."
- **Streak at risk.** "{time}, and you're still scrolling like the streak will carry itself. It won't. You carry your own goddamn logs, recruit. {streak} weeks you built. Don't piss them away on one lazy evening. Move."
- **Comeback / PR.** "Well, shit. You showed up. {lift}, new best, and not a single excuse in the log. Open the cookie jar, recruit: that's what the last {n} sessions bought you. Now do it again."

**Photo prompt (all levels, L3 shown).** "Accountability mirror, recruit. Take the damn photo. Front pose, same spot as last time. Lying to yourself is the only thing that doesn't show up on camera."

Voice: `onyx` (L1, L2), `ash` (L3). TTS instructions: "Deliver as a drill instructor: clipped, forceful, rhythmic cadence, short bursts with hard stops. Raise intensity with the level. Never mocking in tone, always demanding. Pace brisk." For L3 add: "Louder and more explosive, hard consonants, pause for emphasis after each profane word."

#### The Stoic (`stoic`)

- **Style card.** Calm, aphoristic, second person. Treats a missed session as something outside the user's control and the next action as inside it. No exclamation marks. Intensity raises how plainly it states the cost of avoidance.
- **Missed session.** "The session is gone. Regret changes nothing. The next hour is still yours."
- **Streak at risk.** "{streak} weeks were built one ordinary evening at a time. This is one of those evenings."
- **Comeback / PR.** "You returned without being asked. That is the whole discipline. {lift} is merely its evidence."
- **Photo prompt.** "A photograph is a plain witness. It flatters no one and lies to no one. Add one today."

Voice: `sage`. TTS instructions: "Calm, measured, unhurried. Low energy but certain. Pause after each sentence as if reading something carved in stone."

#### The Analyst (`analyst`)

- **Style card.** Numbers first, one chart-worthy fact per message, dry wit. Every figure comes from signals. Never speculates about causes beyond what the data shows.
- **Missed session.** "Planned: {n} sessions. Completed: {n}. Adherence {n} percent. The trend line is, regrettably, pointing at the floor."
- **Streak at risk.** "Probability you train today, given you have trained at {time} on four of the last five Thursdays: favourable. Do not make me recompute."
- **Comeback / PR.** "Data point: back after a miss. Second data point: {lift} up on the last four sessions. The correlation with showing up is, as always, perfect."
- **Photo prompt.** "Your sessions are logged. Your visual history is the one dataset you do not have yet. One front photo, please."

Voice: `echo`. TTS instructions: "Dry, precise, understated humour. Even pace. Slight emphasis on the numbers. No hype."

#### Reginald (`butler`)

- **Style card.** Formal British butler. Elaborate politeness used as sarcasm. Third-person asides ("Sir has been resting"). Never insults the body. Intensity sharpens the irony.
- **Missed session.** "I took the liberty of laying out your kit on Wednesday. It remains, I regret to say, entirely unworn."
- **Streak at risk.** "A {streak}-week streak is a lovely thing to have, sir or madam. One does so hate to see it mislaid before supper."
- **Comeback / PR.** "How splendid. You have returned. And {lift} is a new best. I shall not say I never doubted, but I shall say I kept the kettle on."
- **Photo prompt.** "If I might presume: a fortnight has passed. A photograph would be most instructive. Front pose, same wall, if convenient."

Voice: `fable`. TTS instructions: "Refined British butler. Dry, deadpan sarcasm delivered with perfect courtesy. Measured pace, a tiny pause before each barb."

#### The Announcer (`hype`)

- **Style card.** Live sports commentary. Present tense, rising energy, play-by-play of the user's week. Celebrates effort and returns. Never mocks a miss; recasts it as a comeback storyline.
- **Missed session.** "And Wednesday's session is a no-show, folks! But every great season has a rough night. The comeback starts tonight!"
- **Streak at risk.** "The crowd is on its feet! {streak} weeks on the line and {time} is the whistle! Get to the court!"
- **Comeback / PR.** "LOOK WHO'S BACK! {lift}, a NEW BEST, in front of a home crowd! Ladies and gentlemen, that is how you answer a miss!" (Gender-neutral: the coach does not know the listener's gender.)
- **Photo prompt.** "Time for the highlight reel! Snap one photo today and we'll roll the tape on your progress!"

Voice: `verse`. TTS instructions: "High-energy sports broadcaster. Fast, rising, excited, with crowd-pleasing emphasis. Land the last word of each line loudly."

#### Nana (`nana`)

- **Style card.** Loving, a little disappointed, fond of food metaphors. Guilt delivered with affection, in the Duolingo-owl spirit, never cruel. Never about the body or weight; no food-shaming. Intensity raises the sighing, not the sting.
- **Missed session.** "Oh, sweetheart. Wednesday came and went and the gym sat there waiting. I'm not upset. I'm just a little bit sad. Go on, twenty minutes."
- **Streak at risk.** "{streak} weeks, and you've been so good. Don't let it go cold on the table, dear. Go and do today's session."
- **Comeback / PR.** "There you are! I knew you'd come back. And {lift} a new best! Come here, I'm so proud I could burst."
- **Photo prompt.** "Dear, would you send me a little picture? I like to see how you're getting on. Same pose as last time, please."

Voice: `shimmer`. TTS instructions: "Warm, elderly grandmother, affectionate, slightly wistful sighs, gentle teasing. Slow and soft. Light delight when celebrating."

### 2.4 Profanity unlock

Profanity is possible for exactly one combination. It requires **all four** conditions at **generation time**, re-evaluated for every message, not cached.

| # | Condition | Source |
|---|---|---|
| 1 | The deployment allows profane personas. | System setting `coach.allowProfanePersonas` is `true` ([§3.2](#32-system-setting-coach)). |
| 2 | The user is 18 or older. | `HealthProfile.dateOfBirth` when present (an age under 18 fails the check regardless of any attestation). Otherwise the user's self-attestation: `coach.adultConfirmedAt` is set. |
| 3 | The user explicitly opted in. | `coach.profanity` is `true`, set through a dialog that states the content is adult language and records `adultConfirmedAt`. |
| 4 | The persona and level are the profane combination. | `personaId === 'drill_sergeant'` and `intensity === 3`. No other persona or level is ever profane. |

- **Single evaluator.** `resolveRegister(userSettings, systemSettings, profile)` in `apps/api/src/coach/personas/resolve-register.ts` **(new)** returns `{ profane: boolean, reason: string | null }`. It is the only function that answers the question; the prompt builder, the content guard, the preview route and the settings route all call it.
- **Failing closed.** If any condition fails, Sarge L3 is rendered as Sarge L2 (clean). The settings write that sets `profanity: true` while condition 1, 2 or 4 fails answers `403 COACH_PROFANITY_LOCKED` with `details.reason` naming the failed condition. A setting saved earlier does not survive a later failure: turning the system switch off silences profanity on the next message.
- **Lock-screen-safe variant.** `coach.lockScreenSafe` defaults to `true`. While it is on, `pushTitle` and `pushBody` are always clean: no profanity, no health terms, no figures. The in-app `title` and `body` and the audio script may carry the profane text. A message to a locked phone therefore reads "Recruit. {time} is your hour." while the full uncensored line sits in the timeline. With `lockScreenSafe` off and profanity unlocked, `pushBody` may be profane.
- **Profanity is a style, not a licence.** An unlocked L3 message is still subject to every guard rule in [§2.6](#26-nudge-generation-and-the-content-guard): insults must target effort; the banned categories stay banned.

### 2.5 Decision engine

**Entry.** `apps/api/src/coach/tasks/coach-sweep.task.ts` **(new)** carries `@Cron('17 * * * *')` and only enqueues the `coach.sweep` job through `enqueueHousekeepingJob` (`apps/api/src/jobs/housekeeping.enqueue.ts`), and only while AI and coach are enabled. The shape is the same as `training-evaluation.task.ts` (`apps/api/src/training-agents/evaluation/tasks/training-evaluation.task.ts`). `apps/api/test/jobs/cron-enqueue-only.spec.ts` covers it, with no new exemption.

**Sweep.** `coach.sweep` pages users with `coach.enabled`. For each user it loads signals, `CoachState`, settings and the user's local clock, then calls the pure function:

```ts
planCoachMoments(signals, state, settings, nowLocal): PlannedMoment[]
```

It imports no Nest and no Prisma and reads no clock; `nowLocal` is its clock. It returns ranked eligible moments, each with `moment`, `priority`, `reason` and a set of suppression reasons for the ones the gates removed (so a suppressed moment can be counted). Local-time arithmetic reuses `localWallTime` and `weeklyAnchorDate` in `apps/api/src/training-agents/evaluation/evaluation-due.ts`.

#### Moments

Priority 1 wins. A user receives at most one moment per sweep.

| Priority | Moment | Trigger rule | Research basis |
|---|---|---|---|
| 1 | `missed_twice` | `missedStreak >= 2` from signals. | Return-after-miss was the strongest megastudy intervention; one miss does not break a habit, two start a pattern (Milkman 2021; Lally 2010). |
| 2 | `streak_at_risk` | A session is planned today, none logged, and `nowLocal >= usualWorkoutMinuteLocal - 30 min`. Without a usual time, `coach.preferredTime`, else 17:00 local. | Duolingo's reminder lands about 23.5 hours after the last session; loss framing beats gain framing (Patel 2016). |
| 3 | `comeback` | A workout was just completed after a miss (event-driven, [below](#event-listeners)). A micro-reward, not a lecture. | Micro-reward for returning after a miss (Milkman 2021). |
| 4 | `pr`, `weekly_target_hit` | A personal record (`prInRange`) or the weekly session target reached; event-driven. | Reward consistency, not volume (Duolingo). |
| 5 | `missed_session` | A planned session is `missed` yesterday; sent at `preferredTime`, else 09:00 local. | Implementation intentions: the message carries a concrete next slot (Gollwitzer and Sheeran). |
| 6 | `fresh_start` | Local Monday, or the 1st of a month, after a lapse (no completed session in the last 7 days). | Fresh-start effect (Dai, Milkman, Riis 2014). |
| 7 | `photo_prompt` | `coach.photoCadence` due, morning, on a planned training day. | Photos as evidence ([VISION.md §87](../../VISION.md)). |
| 8 | `win_back` | No user activity for `inactiveStopDays` (default 7). The one final message says the coach will back off. | Duolingo stops after 7 inactive days to protect the channel. |
| separate lane | `weekly_review` | Local Sunday 18:00, deduped by ISO week ([§2.10](#210-weekly-review-and-email)). Not subject to the daily cap; still obeys quiet hours, `pausedUntil` and notification preferences. | VISION §94. |

#### Hard gates

All gates live in the pure function and are table-tested. A gate that fails removes the moment and records a suppression reason.

| Gate | Rule | Suppression reason |
|---|---|---|
| Coach switched off | `system.enabled` false or `coach.enabled` false. | `coach_off` |
| Quiet hours | `nowLocal` inside `coach.quietHours` (default 21:30 to 07:30, wraps midnight). | `quiet_hours` |
| Daily cap | `nudgesToday >= min(coach.maxNudgesPerDay, system.maxNudgesPerDayCeiling)`. | `daily_cap` |
| Spacing | Less than 3 hours since `lastNudgeAt`. | `spacing` |
| Paused | `pausedUntil` in the future. | `paused` |
| Auto-silence | `silencedAt` is set. | `silenced` |
| Safety | An active training safety stop, or a pain or low-readiness streak, allows only supportive moments ([§2.14](#214-safety)). | `safety_supportive_only` |
| Preferences | The user turned the event off in `/settings/notifications`, or the admin disabled it. | `pref_off` |
| Deduplication | The same moment was already sent for the same local day. | `already_sent` |

**Auto-silence.** After `autoSilenceAfterIgnored` ignored nudges in a row (system default 3), the coach sends **exactly one** back-off message ("I'll step back until you reach out") and sets `silencedAt`. Opening the app, sending a chat message or logging a workout clears `silencedAt` and resets `consecutiveIgnored`. A `win_back` message at `inactiveStopDays` also ends in `silencedAt`.

#### Event listeners

| Event | Source | Effect |
|---|---|---|
| `WORKOUT_FINISHED_EVENT` | `apps/api/src/workouts/workout-events.ts` | Plans `comeback`, `pr` or `weekly_target_hit` immediately, through the same gates. Marks conversion on a recent nudge ([§2.8](#28-learning-loop)). Clears `silencedAt`. |
| Program activation | The programs service | Plans a `kickoff` message that asks for an implementation intention: when, where and the fallback plan ([§2.13](#213-ux-surfaces)). |
| `HEALTH_DATA_CHANGED_EVENT` | `apps/api/src/measurements/health-data-events.ts` | Refreshes the readiness view the safety gate reads; sends nothing itself. |

When a moment is eligible, the sweep or listener enqueues `ai.coach.nudge` with the user as subject. The queue's active-dedup index prevents two concurrent nudge jobs for one user.

### 2.6 Nudge generation and the content guard

`ai.coach.nudge` is server-only, profile `{ maxRuntimeMs: 120000, maxAttempts: 2 }`.

1. Resolve `coach.decision` with `AiFeatureModelResolver.resolve` (`apps/api/src/ai/assignments/ai-feature-model-resolver.service.ts`). The reference consumer is `apps/api/src/health-summary/health-summary.handler.ts`.
2. Build the context ([§2.9](#29-chat) shares the builder): the compact signals, `CoachState`, the last 10 coach messages (so the model does not repeat itself), the persona card at the user's intensity, the register from `resolveRegister`, the chosen angle ([§2.8](#28-learning-loop)) and the user's `why`.
3. Call `AiService.forUser(userId, { jobId }).respondStructured` with the schema below.
4. Run the content guard. On pass, persist and deliver ([§2.7](#27-delivery-and-audio)).

```ts
const coachNudgeSchema = z.object({
  send: z.boolean(),                        // false = the model decides to stay quiet
  moment: z.enum(COACH_MOMENTS),
  title: z.string().max(60),
  body: z.string().max(320),
  pushTitle: z.string().max(60),            // lock-screen-safe
  pushBody: z.string().max(140),            // lock-screen-safe
  audioScript: z.string().max(600),         // spoken text; may differ from body
  audioInstructions: z.string().max(300),   // delivery notes for TTS
  reason: z.string().max(200),              // why send or not; for learning, never shown
});
```

**`send: false` is a real answer.** It means "the data allows a message but a message would not help now". The server records it as a `coach.nudge.suppressed{reason=model_declined}` event with the `reason` text, writes no `CoachMessage`, and counts nothing against the daily cap. The moment is eligible again at the next sweep, so a persistent decline cannot loop within one sweep. The model cannot turn a gate failure into a send, because the job is only enqueued for moments that passed the gates.

**Content guard.** `apps/api/src/coach/guard/coach-content-guard.ts` **(new)** is a pure function over the structured result and the context:

| Rule | Behaviour |
|---|---|
| Banned terms and topics | Slurs, protected-trait insults, sexual content, self-harm, diet-restriction and extreme-exercise framing, medical claims, body or weight shaming. Lists live in `coach/guard/banned-terms.ts` **(new)**. |
| Profanity | Allowed only when `resolveRegister(...).profane` is true. A profane word in any field of a clean register fails. |
| Insult target | In the profane register, an insult must attach to effort, excuses or inaction. A body- or weight-referencing insult fails. |
| Lock-screen | While `lockScreenSafe` is on, `pushTitle` and `pushBody` must be profanity-free and free of health terms and digits. |
| Numbers | Every number in `title`, `body` and `audioScript` must appear in the context. An invented figure fails. |
| Length | The schema's limits; empty strings fail. |
| Safety register | In a supportive register, a pushy angle or a challenge phrasing fails. |

**On failure.** Regenerate once with the failed rule names appended to the prompt. If the second result also fails, fall back to a **static persona line** from the registry's sample lines for that moment (no model, no cost), flagged `provider = 'static'` on the message. The fallback cannot fail the guard because registry lines are checked by the persona-registry completeness test ([§5](#5-guardrails)).

### 2.7 Delivery and audio

**Persist, then notify.** The handler writes the `CoachMessage` row, then calls `notifyNow('coach.<kind>')` **after the write commits and outside any `$transaction`** (the notifications README rule, [notifications README](../../apps/api/src/notifications/README.md)). `notifyNow` is used because the caller is a job, not a request.

**Audio off (the default).** One `notifyNow` call with the text. `audioStatus` stays `none`.

**Audio on.** Audio always means text plus audio, never audio alone.

1. `coach.voice` resolves a model that declares `audio_speech` and is passed explicitly to `speak()`, because `speak()` does not read assignments itself.
2. The handler calls `AiService.forUser(userId, { jobId }).speak({ model, voice, instructions, speed, input: audioScript })`. `AiSpeakRequest` is in `apps/api/src/ai/runtime/ai-runtime.types.ts`. The call enqueues the existing `ai.audio.speech` job and returns an `AiRunHandle` at once.
3. The message is saved with `audioStatus = 'pending'` and `audioRunId`.
4. `coach.message.deliver` runs when the speech job settles. A listener on `JOB_SETTLED_EVENT` (`apps/api/src/jobs/events/job-settled.event.ts`) maps `audioRunId` to the message, sets `audioStatus` to `ready` (and `audioStorageObjectId`) or `failed`, and enqueues `coach.message.deliver` for the message. The job does the `notifyNow`.
5. **Refusal and failure fall back to text.** OpenAI's speech model sometimes declines profane input, and any provider can fail or time out. In either case the delivery job records `audioStatus = 'failed'` and sends the text notification anyway. A wait cap (2 minutes) delivers text when no settle event arrives.

**Notification events.** Appended to `NOTIFICATION_EVENTS` ([§3.5](#35-notification-events)). The link is `/coach?m=<id>`. A message with ready audio adds the action **"▶ Hear Coach"**, which deep-links to `/coach?m=<id>&autoplay=1`.

**Why the push cannot play the audio.** No browser supports the Notification `sound` option ([MDN: showNotification](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification)), and a service worker has no audio output. The push therefore carries text plus the action. The click is a user gesture, which satisfies autoplay rules, so the opened page can play the audio. Today's push channel (`apps/api/src/notifications/channels/push-notification.channel.ts`) and `apps/web/src/sw.ts` carry no action; the work to add one (a payload `actions` field, a `notificationclick` branch that opens the `autoplay=1` URL) belongs to E7.5.

**Playback and disclosure.** The `/coach` page plays audio with `AiSpeechPlayer` (`apps/web/src/components/ai/AiSpeechPlayer.tsx`), which renders the label "AI-generated audio" (`AI_GENERATED_AUDIO_LABEL`). OpenAI requires the synthetic voice to be disclosed ([OpenAI text to speech](https://developers.openai.com/api/docs/guides/text-to-speech)).

**Opened, converted, feedback.**

- `POST /api/coach/messages/:id/opened` sets `openedAt` and resets `consecutiveIgnored`. The `/coach` page also calls it when a message scrolls into view.
- `convertedAt` is set by the attribution rules in [§2.8](#28-learning-loop).
- `POST /api/coach/messages/:id/feedback` stores thumbs up or down on any coach message.

**As built (E7.5, #245).** Where the implementation settles a detail this section leaves open:

- **Layout.** Everything lives in `apps/api/src/coach/nudges/` (`CoachNudgesModule`, imported by `CoachModule`): `handlers/coach-nudge.handler.ts`, `handlers/coach-message-deliver.handler.ts`, `nudge-context.ts`, `nudge-prompt.ts`, `nudge-schema.ts`, `static-fallback.ts`, `angle-picker.ts`, `coach-messages.controller.ts` and `.service.ts`, `coach-conversion.ts` and `.listener.ts`. The never-send list is `apps/api/src/coach/context/coach-never-send.ts`.
- **`aiRunId` is null for nudges.** `respondStructured` is a synchronous call and writes no `ai_runs` row (its `ai_usage_events` row is the record). The column stays for E7.6's `speak()` run and for any later background call.
- **Kinds.** `pr` and `weekly_target_hit` are `celebration`; `comeback` is its own `comeback` kind, raised as `coach.nudge` (the planner's `COACH_MOMENT_EVENT`); `back_off` and `win_back` are `system`; `photo_prompt` and `kickoff` keep their names.
- **Notification text.** The browser inbox row and the push both show the lock-screen pair (`pushTitle`, `pushBody`); the full text is on `/coach?m=<id>`. `notificationId` is the browser channel's inbox row (`NotifyNowResult.notificationId`). `deliveredAt` is stamped once `notifyNow` has run, whatever each channel's outcome (a channel failure is recorded in `notification_deliveries`, as for every event).
- **Push actions.** The payload gains optional `actions` (`{ action, title, link }`, at most two, links sanitised) and `data.messageId`. The service worker keeps each action's link in `notification.data.actionLinks` and opens it on that button's click.
- **Idempotency.** The nudge job stores `momentKey` in `CoachMessage.data`; a retry after the write only re-enqueues delivery, and the delivery job skips a message that already has `deliveredAt`.
- **`data`.** A nudge row's `data` holds `momentKey`, `trigger`, `register` (`clean`, `profane`, `supportive`), `lowReadiness`, `eligibleAngles` (the set the angle was chosen from, E7.11), `regenerations`, `fallback`, and the `audioScript` and `audioInstructions` E7.6 speaks.
- **Angle.** `DefaultAnglePicker` behind the `COACH_ANGLE_PICKER` token: `future_self` when the user wrote a `why`, `data` for the Analyst, else `identity`, always a supportive angle under the supportive register. E7.11 binds `BanditAnglePicker` (`apps/api/src/coach/learning/`, `pickAngle`) to the same token; `DefaultAnglePicker` stays as its fallback when the learning loop cannot run.
- **Static fallback.** The sample line is filled from the context (`{n}` this week's done sessions, `{streak}` the streak plus one, `{lift}` the latest PR lift, `{time}` the usual or preferred time, else 17:00); its lock-screen body is `<Persona> has a message for you.`. Under the supportive register the calm `SUPPORTIVE_FALLBACK_LINE` replaces it. Should even that fail the guard, the job ends without a message (`guard_rejected`).
- **`send: false`.** The reason is logged once (one line, at most 200 characters) and not stored.
- **Metrics.** `app.coach.nudge.sent{moment}`, `app.coach.nudge.suppressed{reason, moment}` (job reasons: `model_declined`, `coach_off`, `paused`, `no_model`, `ai_error`, `guard_rejected`, `already_sent`), `app.coach.nudge.fallback{moment}`, `app.coach.nudge.opened{moment}`, `app.coach.nudge.converted{moment, target}`, `app.coach.feedback{value}`. The planner's own `coach.nudge.suppressed{coach.reason}` (E7.4) keeps the sweep's gate reasons. Spans: `coach.nudge.generate`, `coach.message.deliver`.
- **Photo conversion.** The listener subscribes to `progress_photo.created` (`PROGRESS_PHOTO_CREATED_EVENT`, payload `{ userId, photoId }`); E7.9 emits it after the photo row commits.

### 2.8 Learning loop

**Angles.** Each nudge is written from one angle (the bandit arm), recorded on `CoachMessage.angle`:

| Angle | Idea |
|---|---|
| `loss_aversion` | What you keep by showing up (the streak) |
| `identity` | "You are someone who trains on Thursdays" |
| `humor` | Light, persona-flavoured |
| `challenge` | A specific small target |
| `data` | One true number from signals |
| `future_self` | A message from the user's own "why" |
| `social_proof_self` | Beating your past self ("last month's best") |

**Selection.** `pickAngle(history, eligibleAngles, rng)` in `apps/api/src/coach/learning/pick-angle.ts` **(new)** is pure; `rng` is injected so tests are deterministic. It implements the recovering-difference softmax from Duolingo's "sleeping, recovering" bandit ([Yancey and Settles, KDD 2020](https://research.duolingo.com/papers/yancey.kdd20.pdf)):

- **Reward per angle** `r(a)` = the global conversion rate when angle `a` was **sent**, minus the rate when `a` was **eligible but not sent** (the recovering difference), over the last 90 days. Below a minimum sample count the difference is zero, which yields uniform choice (cold start).
- **Per-user novelty penalty** `γ · 0.5^(d/h)`, where `d` is the days since this user last got angle `a` and `h` is the half-life. A fresh angle pays no penalty; a repeated one pays most. This fights novelty decay.
- **Score** `s(a) = r(a) - penalty(a)`; **probability** `p(a) = softmax(s / τ)` over `eligibleAngles`.
- **Constants** `γ`, `h`, `τ`, the sample floor and the window live in `apps/api/src/coach/learning/learning.constants.ts` **(new)**. They are code constants, never settings or env vars.
- **Eligible angles** are filtered by persona and by register: a supportive register allows only `identity` and `future_self`. `future_self` needs a `why`. A persona that cannot voice an angle lists it in `PERSONA_ANGLE_EXCLUSIONS` (empty today); a persona's **favoured** angle (the Analyst's `data`) gets a score bonus from `PERSONA_ANGLE_BONUS`, in reward units, rather than an exclusion of the others.

**Implementation notes (E7.11).**

- **`μ⁻` is exact going forward.** The nudge job records the eligible set in `data.eligibleAngles`, so "eligible but not sent" counts exactly the messages whose set held `a` while another angle was sent. Older rows (E7.5, no set) are reconstructed from `data.register`: supportive → the supportive angles, otherwise every angle; that approximation ages out of the 90-day window.
- **The aggregate** is one grouped SQL query over delivered coach messages with an angle and a conversion target (the workout moments, `photo_prompt`, `data.lowReadiness`), counts only. Messages younger than 48 hours are left out: their window is still open. `AngleStatsService` caches it in memory for an hour per API process; a failure answers no rewards (cold start), never an error.
- **Smoothing and exploration.** Each rate is shrunk toward the pooled rate by a Beta prior (`priorStrength`), and an exploration floor `ε` mixes in `ε/n` so no eligible angle starves: `p(a) = (1 − ε)·softmax(s/τ) + ε/n`. With `ε = 0` and no bias this is exactly the formula above.
- **Scale.** `r(a)` is an absolute rate difference (a few hundredths), so `γ = 0.03` and `τ = 0.02` are rescaled from the paper's relative-difference values; `h = 15` days as in the paper.
- **Observability.** `app.coach.angle.picked{angle}`; `app.coach.nudge.converted` carries `angle`. No per-user score is logged.

**Conversion attribution.** `convertedAt` is set when the target action follows delivery within the window:

| Message | Target action | Window |
|---|---|---|
| `missed_twice`, `streak_at_risk`, `missed_session`, `fresh_start`, `win_back` | A workout is completed (`WORKOUT_FINISHED_EVENT`). | 24 hours |
| `photo_prompt` | A `ProgressPhoto` is created. | 48 hours |
| A supportive message sent under low readiness | A check-in is recorded. | 24 hours |

Celebrations and reviews have no conversion target and are excluded from angle reward. Opened-but-not-converted counts as a send with zero reward.

**Admin visibility.** `/admin/settings/coach` shows send, open and convert rates by angle and persona, and suppression counts by reason ([§2.13](#213-ux-surfaces)).

### 2.9 Chat

**Routes.** `POST /api/coach/chat/stream` streams server-sent events; `GET /api/coach/messages?before=&limit=` returns the cursor-paged timeline.

- **Streaming.** The handler uses `pipeAiSse` (`apps/api/src/ai/http/ai-sse.ts`) and `AiService.forUser(...).runTools`, model resolved through `coach.chat`. Web side: `postSse` in `apps/web/src/services/sse.ts` and a thread like `apps/web/src/components/ai/AiChatThread.tsx`.
- **Nginx.** The route needs an unbuffered location block in **both** `infra/nginx/nginx.conf` and `apps/cli/src/deploy/proxy.ts` (the CLI test `apps/cli/src/deploy/proxy.test.ts` asserts each streaming location). Model the block on `location /api/ai/responses/stream`. The existing guard `apps/api/test/ai/ai-stream-nginx.spec.ts` shows the pattern; a new `coach-stream-nginx.spec.ts` **(new)** asserts the coach block.
- **History window.** The persona system prompt plus the last 20 messages of the timeline. Older turns are not sent.

**Tools.** Read-only tools return minimised data. The two write tools are narrow.

| Tool | Kind | Returns |
|---|---|---|
| `get_training_signals` | read | `compactForEvaluator` signals |
| `get_today_plan` | read | Today's planned session (names, sets), from the Today resolver |
| `get_recent_workouts` | read | The last few workouts (dates, names, set counts) |
| `get_check_ins` | read | Recent readiness numbers, never notes |
| `get_progress_photo_summary` | read | Dates and counts only, never an image |
| `get_last_weekly_review` | read | The last review's stored stats and headline |
| `pause_coach` | **write** | Sets `pausedUntil`. `days` is 1 to 14, `reason` is short text. For "I'm sick" or "on vacation". |
| `save_commitment` | **write** | Saves the kickoff answer: `why` (at most 200 characters) and/or `preferredTime` (`HH:mm`), through `CoachSettingsService.update` (the `PUT /api/coach/settings` path). Called only after the user explicitly confirms the values; a bad value answers `COACH_COMMITMENT_INVALID` to the model. |

Plan changes are not tools. The coach proposes and links to the existing adjust flow, so the user stays in control.

**Safety screen.** Every user message passes `screenFreeText` (`apps/api/src/training-agents/guardrails/safety-screen.ts`) and a coach-specific distress screen `apps/api/src/coach/safety/distress-screen.ts` **(new)**. The existing screen covers urgent physical symptoms and pain stems; it has no self-harm or eating-disorder rules, so the coach adds them.

| Outcome | Behaviour |
|---|---|
| `blocked` or distress cue | No model call. Return a deterministic supportive message with a seek-professional-help line (reuse `SAFETY_STOP_GUIDANCE` from `safety-keywords.ts` for physical symptoms; a fixed, reviewed text for distress). The persona is dropped. |
| `conservative` (pain, injury, strain) | The model is called in the supportive register, with the pushy angles removed and the prompt told not to advise training through pain. |
| `ok` | Normal persona. |

**Never-send.** `apps/api/src/coach/context/coach-never-send.ts` **(new)** extends the list in `apps/api/src/training-agents/context/never-send.ts` with `progress_photos` and audio, and the canary test walks it. Name, email, date of birth, check-in and pain notes, medications, labs and storage keys never reach a prompt ([§5](#5-guardrails)).

**Limits.** Rate limits come from `ai.limits` (`AiLimitsService`); a limited call answers `429 AI_RATE_LIMITED`. Chat turns are stored as `CoachMessage` rows (`kind = 'chat'`).

**Stream contract (as built, E7.7).** Body `{ text }` (1 to 2,000 characters). Frames, each `event: <type>` with the frame as JSON in `data:`:

| Frame | Payload | When |
|---|---|---|
| `safety` | `{ level: 'blocked' \| 'conservative', screen: 'distress' \| 'symptom' \| 'pain' }` | First, when a screen matched |
| `tool` | `{ name, status }` | One per tool call, while the model works; never arguments or results |
| `delta` | `{ text }` | The reply, in order |
| `done` | `{ messageId, userMessageId, links: [{ label, href }], pausedUntil, fallback }` | Last, on success |
| `error` | `{ code, message }` | Last, on a failure after streaming began |

- **Guard before display.** `runTools` is not a streaming call, and a reply shown token by token could not be withdrawn if the content guard rejected it. The final text is guarded first (chat context: the nudge `body` length limit is replaced by a 1,200-character chat limit; numbers may come from tool results, the user's message and the history), then sent as `delta` frames. A failing reply is replaced by a fixed fallback line and stored with `data.fallback = true`.
- **Preconditions are JSON errors.** The coach system switch (`403 COACH_DISABLED`), an unresolvable `coach.chat` model (`409 AI_FEATURE_UNAVAILABLE`, as for photo intake) and every refusal of the **first** model call (`429 AI_RATE_LIMITED`, key errors) are answered before the response becomes a stream, and nothing is stored. The user's message is stored once the first model call succeeds.
- **Disconnect.** Closing the connection aborts the provider call; the partial reply is discarded (no coach row, no `data.truncated`).
- **Pause reason.** `CoachState` has no column for it, so the `reason` of `pause_coach` only shapes the model's confirmation; it is never stored or logged.
- **Plan changes** link to `/train`, where "Adjust today's workout" starts the quick adaptation; `done.links` carries the link when the reply contains it.
- **Never-send.** The tools select only the fields they return (no ids, notes, storage keys or photo content) and the history sends only `title` and `body`; the list itself is `training-agents/context/never-send.ts` until `coach-never-send.ts` lands with the nudges.

### 2.10 Weekly review and email

At local Sunday 18:00 the sweep enqueues `ai.coach.weekly_review`, deduped by ISO week through `CoachState.lastWeeklyReviewWeek`.

| Part | Source |
|---|---|
| **Stats (deterministic)** | Planned and completed sessions, adherence percent, weekly streak, PRs, check-ins done, photos added, next week's planned sessions. Built by code from signals and stored in `CoachMessage.data`. |
| **Prose (AI)** | `{ headline, intro, wins[], focus, nextWeekPlanPrompt }`, in persona, from `coach.decision`. Passes the same content guard. |

The review is a `weekly_review` message, rendered as a rich card in `/coach`, with the deterministic block in a table and the prose around it. **The prose never carries a number the stats block does not carry**; the guard enforces this.

**Email.** Template `apps/api/src/email/templates/coach-weekly-review.email.ts` **(new)**, registered in `apps/api/src/email/templates/index.ts` (`EVENT_EMAIL_TEMPLATES`):

- Stats table, persona intro, wins and one focus.
- Call to action "Plan my week" linking to `/coach`.
- A preferences link to `/settings/notifications`.
- Transactional headers, so the message is not a marketing send.
- Profanity never appears in email: the email body and subject are rendered in the clean register even for unlocked Sarge L3.

The event `coach.weekly_review` declares `email`, `browser` and `push`, so the user's notification preferences control each channel.

### 2.11 Weekly streak and passes

The streak counts **consecutive weeks** in which the user reached the week's session target, not days.

- **Counting.** On each weekly review the server sets `weeklyStreak` from signals: it increments when `completed >= target` for the finished ISO week, otherwise it consumes a pass or resets to 0.
- **Passes.** One pass is earned every 4 weeks of streak, up to `streakPassesLeft = 1`. A missed week with a pass left keeps the streak and uses the pass (the streak-freeze idea; Duolingo reports it cut at-risk churn).
- **Rest days never break it.** The target is sessions per week, not days.
- **Partial weeks.** The current week is never counted until it ends.
- **Safety.** A week with an active safety stop, a pain pattern or a `pausedUntil` covering the week does not reset the streak.

### 2.12 Progress photos

**API.** `/api/progress-photos`: list, create from a `storageObjectId`, and delete. Permissions `health_data:read` and `health_data:write` (`PERMISSIONS.HEALTH_DATA_READ` and `HEALTH_DATA_WRITE` in `apps/api/src/common/constants/roles.constants.ts`). Progress photos are **not** behind `AiEnabledGuard`: they work with AI off.

- Upload goes through `/api/storage/objects`; the create route validates the object is an image by content (a magic-byte check, with `mime-type-match.ts` for the declared type) and registers the reference with `StorageObjectReferences` (the same pattern as `apps/api/src/gyms/intake/gym-photo-references.ts`).

**Privacy rules.**

- Private to the owner. No share link, no public URL; reads go through the authenticated storage route.
- **Never sent to a model** and never part of any prompt, context, tool result or notification. The `get_progress_photo_summary` tool returns dates and counts only.
- A photo prompt notification never includes an image or a body-related phrase.
- Delete removes the row and the stored object; erasure follows [§2.2](#22-data-model).

**Web.** A new Health page, **Progress photos** (`apps/web/src/pages/ProgressPhotosPage.tsx` **(new)**):

- Gallery grouped by month.
- **Compare**: pick two dates, view side by side or with a slider.
- **Ghost overlay**: the camera view shows the last photo of the same `pose` at low opacity, so framing stays consistent.
- Client downscale reuses `apps/web/src/components/intake/ImageIntake.tsx`.

**Export.** Progress photos are included in the health export (`apps/api/src/health-export/`, the existing `health.export` job), with the same ownership rules.

**Prompts.** `photo_prompt` follows `coach.photoCadence` (`off`, `weekly`, `biweekly`, `monthly`; default `biweekly`).

### 2.13 UX surfaces

#### Navigation

`apps/web/src/config/destinations.ts` gets a new `coach` destination: path `/coach`, permission `ai:use`, `feature: 'ai'`, `primary: true`. It **replaces Gyms** as the fourth primary tab. `PRIMARY_DESTINATION_LIMIT` stays 4.

- Add `coach` to `DestinationKey` and to `DESTINATION_ROUTES` (`coach: ['/coach']`).
- Gyms drops `primary: true`. It stays reachable from the rail, the user menu and a link on Train.
- Update `apps/web/src/__tests__/config/destinations.test.ts` and the route-ownership test.
- **AI-off fallback:** Coach holds the fourth primary slot only while the `ai` feature is on. With AI off, Gyms takes that slot back, so the bottom bar never drops to three tabs. E7.8 implements this and tests both states.

#### `/coach` timeline

A messaging-style page, `apps/web/src/pages/CoachPage.tsx` **(new)**.

| Region | Contents |
|---|---|
| Header | Persona avatar and name, a weekly target ring ("2 of 3 this week"), the weekly-streak flame, the next planned session. |
| Timeline | Cards, newest at the bottom: nudge bubbles (with `AiSpeechPlayer` when audio is `ready`), celebration cards, weekly review cards, photo prompts with a **Take photo** button, and plain chat bubbles. Thumbs up or down on each coach card. |
| Composer | A text field plus quick replies: **Motivate me**, **I missed — now what?**, **Adjust this week**, **I'm sick**, **How am I doing?**. |
| Deep link | `/coach?m=<id>` scrolls to and highlights the message; `&autoplay=1` starts its audio. |

#### Today

- A `CoachHero` strip (`apps/web/src/components/today/CoachHero.tsx` **(new)**) above the card grid: the latest unread coach line and a reply button.
- A `coach` entry **appended** to `TODAY_CARDS` (`apps/web/src/config/todayCards.tsx`). Append, never insert, and update the `CARD_SIZE` map in `apps/web/src/pages/TodayPage.tsx`.

#### User settings `/settings/coach`

A new card in `USER_SETTINGS_SECTIONS` (`apps/web/src/config/userSettingsSections.tsx`), appended to the AI group, `permission: 'ai:use'`, `feature: 'ai'`.

- Persona gallery: a card per persona with sample lines per moment and a **Hear it** preview (`POST /api/coach/voice-preview`, rate-limited).
- Intensity slider with the rubric text.
- Profanity toggle, enabled only for Sarge at L3, with an 18+ confirmation dialog.
- Audio section: off by default; voice picker from the catalog model's `voices[]`; speed; preview.
- Quiet hours, nudges per day, lock-screen-safe, photo cadence and "your why".

#### Admin `/admin/settings/coach`

A new card in `ADMIN_SECTIONS` (`apps/web/src/config/adminSections.tsx`), appended to the AI group, `permission: 'ai_config:read'`, writes gated by `ai_config:write`, `feature: 'ai'`.

- The system `coach` settings ([§3.2](#32-system-setting-coach)).
- Engagement stats (E7.11, `GET /api/admin/coach/stats?from=&to=` or `?days=`, UTC days inclusive, default 30, at most 365, 400 `COACH_STATS_RANGE_INVALID` beyond): send, open and convert rates in total and by angle, persona and moment, thumbs up and down, and KPI tiles (nudge open rate, follow-through, chat sessions per weekly active user, photo cadence adherence, opt-out rate). Counts and rates only, never a user id or text. Weekly adherence is per user (the signals service) and is not summed here (`weeklyAdherencePct: null`). Suppressions are not persisted (a suppressed nudge writes no row), so their counts by reason live in the `app.coach.nudge.suppressed` metric, not in this panel.
- The **models** are chosen on the existing AI Model Assignments page, `apps/web/src/pages/Admin/AiAssignmentsPage.tsx`, which gets a **Coach** section ([§3.3](#33-ai-feature-ids)).

#### Onboarding

The checklist stays at four steps or fewer, so meeting the coach is **the second phase of the existing `ai_plan` step**, not a fifth step. Once a program exists, that step reads "Meet your coach" (pick a persona, `/settings/coach`) and is `done` when the coach settings have been saved at least once (the `coach` user-settings namespace exists). It is included when AI is on and the user holds `ai:use` and `programs:read`; with the system coach switch off the step keeps its original rule. The step list lives in [onboarding.md §2.3](onboarding.md#23-user-steps).

**Kickoff.** `ProgramsService.activate` emits `program.activated` (`apps/api/src/programs/program-events.ts`) after its commit. `CoachKickoffListener` (`apps/api/src/coach/coach-kickoff.listener.ts`) only enqueues `ai.coach.nudge` with moment `kickoff`, subject (`program`, programId), `momentKey` `kickoff:<programId>` and trigger `program_activated`, so a program gets one kickoff however often it is re-activated. The job re-checks the gates with `kickoffGate` (`planning/plan-coach-moments.ts`): coach off sends nothing; a pause, quiet hours, the daily cap or spacing **defer** the kickoff (a new job row with `scheduledFor` at the next allowed instant, at most 8 times) instead of dropping it. The prompt asks the three implementation-intention questions (when, where, fallback plan) and names the first planned session from the signals; the guard's number rule still applies. A kickoff is never lost to the model: no runnable model, a model error, a decline or two guard rejections deliver the static persona kickoff line. The message is `kind = 'kickoff'` with `data.programId` and `data.questions = ['when', 'where', 'fallback']`. The user answers in chat, and the coach saves the time and reason with `save_commitment` once the user confirms ([§2.9](#29-chat)). Counter: `coach.kickoff{coach.outcome = sent | fallback | deferred | confirmed}`.

### 2.14 Safety

**The persona never overrides safety.** A persona is a style on top of a register chosen by code.

| Trigger | Source | Behaviour |
|---|---|---|
| Active training safety stop | `training.plan_safety_stop` state ([ai-training-plans.md](ai-training-plans.md)) | Only supportive moments; no streak or challenge framing. |
| Pain pattern | Signals pain block (`consecutiveFlaggedSessions`) | Supportive only. Never nudges a session of the flagged exercise. |
| Low readiness streak | Signals readiness `lowStreak` | Supportive; the nudge offers rest or a lighter session. |
| Urgent symptom in chat | `screenFreeText` returns `blocked` | No model call; deterministic message with seek-help guidance. |
| Distress, self-harm or disordered-eating cue | `distress-screen.ts` **(new)** | No model call; supportive message with a seek-help line. The coach does not continue in persona. |
| User says they are ill | Chat | The coach offers `pause_coach`. |

The supportive register is calm and warm for every persona, including Sarge at L3: no profanity, no insults, no pushy angle. Persona flavour returns only when the trigger clears.

## 3. Configuration and permissions

**Env vars:** none. Coach settings are runtime-configured in the app, like storage and AI. Never add an environment variable for them.

### 3.1 User settings, namespace `coach`

Declared in `apps/api/src/common/schemas/user-settings-namespaces.schema.ts` as a `.strict()` schema, sparse like `onboarding`. A new key goes through the six places listed in [onboarding.md §4.4](onboarding.md#44-add-another-stored-fact), because `userSettingsSchema.parse` silently strips unknown keys.

| Key | Type | Default | Range |
|---|---|---|---|
| `enabled` | boolean | `false` | Turned on by picking a persona (onboarding or settings) |
| `personaId` | string | `coach` | A registry id |
| `intensity` | integer | `2` | 1 to 3 |
| `profanity` | boolean | `false` | Rejected unless unlock conditions pass ([§2.4](#24-profanity-unlock)) |
| `adultConfirmedAt` | ISO datetime or null | `null` | Set by the 18+ dialog |
| `audio.enabled` | boolean | `false` | Rejected when system `allowAudio` is off |
| `audio.voice` | string | the persona default | A voice the resolved `coach.voice` model lists |
| `audio.speed` | number | `1.0` | 0.75 to 1.5 |
| `quietHours.start`, `.end` | `HH:mm` | `21:30`, `07:30` | Wraps midnight |
| `maxNudgesPerDay` | integer | `2` | 1 to 4; clamped to the system ceiling |
| `lockScreenSafe` | boolean | `true` | |
| `photoCadence` | enum | `biweekly` | `off`, `weekly`, `biweekly`, `monthly` |
| `why` | string or null | `null` | At most 200 characters; stored text sent to the model |
| `preferredTime` | `HH:mm` or null | `null` | Anchor for morning moments |

Written through the existing `PATCH /api/user-settings` with `If-Match` or through `PUT /api/coach/settings` (which applies the unlock rules and returns the effective register). `PUT /api/coach/settings` takes the namespace's patch form: an omitted field keeps its value and `null` returns it to the default; it never accepts `adultConfirmedAt` (send `confirmAdult: true`). `PATCH /api/user-settings` applies no unlock rule, which is safe because the register is re-evaluated by `resolveRegister` at every use.

### 3.2 System setting `coach`

Admin-configured at `/admin/settings/coach`, stored with the other system settings and validated in the same six-place pattern as other system namespaces.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Deployment-wide switch. AI must also be on. |
| `allowProfanePersonas` | boolean | `false` | Condition 1 of the profanity unlock. |
| `allowAudio` | boolean | `true` | Whether users may enable spoken nudges. |
| `maxNudgesPerDayCeiling` | integer | `4` | Upper bound on a user's `maxNudgesPerDay`. |
| `audioRetentionDays` | integer | `30` | Retention of audio files; `coach.audio.purge` deletes older ones. |
| `autoSilenceAfterIgnored` | integer | `3` | Ignored nudges before the one back-off message. |
| `inactiveStopDays` | integer | `7` | Days of inactivity before `win_back` and the stop. |

### 3.3 AI feature ids

Appended to `AI_FEATURE_IDS` (`apps/api/src/common/schemas/settings.schema.ts`) and `AI_FEATURES` (`apps/api/src/ai/assignments/ai-features.ts`), in a new group `'coach'`.

| Feature id | Used by | Needs |
|---|---|---|
| `coach.decision` | Nudges and the weekly review | `responses`, `structured_output` |
| `coach.chat` | Chat | `responses`, tools, streaming |
| `coach.voice` | Spoken nudges and the voice preview | `audio_speech`; resolved and passed explicitly to `speak()` |

**Widen the group union in four places**, because the type is spelled out in each:

| File | Change |
|---|---|
| `apps/api/src/ai/assignments/ai-features.ts` | `AiFeatureGroup = 'photo' \| 'training' \| 'coach'` |
| `apps/api/src/ai/assignments/dto/ai-feature-resolution.dto.ts` | `z.enum(['photo', 'training', 'coach'])` |
| `apps/api/src/ai/assignments/dto/ai-assignments.dto.ts` | `z.enum(['photo', 'training', 'coach'])` |
| `apps/web/src/services/aiAssignments.ts` | `AiFeatureGroup` union |

Then add a **Coach** section to `apps/web/src/pages/Admin/AiAssignmentsPage.tsx` and update the fixture `apps/web/src/__tests__/mocks/fixtures/aiFeatures.ts`.

### 3.4 Jobs

All coach jobs are server-only. The AI jobs implement neither `nodeResultSchema` nor `persistNodeResult` (AI rule 3). The two non-AI jobs are also server-only, with a reason each.

| Type | AI | Profile `maxRuntimeMs / maxAttempts` | Node posture and why |
|---|---|---|---|
| `coach.sweep` | no | 5 min / 2 | Server-only: reads many tables mid-computation for every user. |
| `ai.coach.nudge` | yes | 2 min / 2 | Server-only: AI rule; a user's key never goes to a node. |
| `ai.coach.weekly_review` | yes | 3 min / 2 | Server-only: AI rule. |
| `coach.message.deliver` | no | 1 min / 3 | Server-only: sends a notification and writes rows as it goes. |
| `coach.audio.purge` | no | 10 min / 2 | Server-only: deletes stored objects; enqueued daily through `enqueueHousekeepingJob`. |
| `ai.audio.speech` (existing) | yes | existing | Reused unchanged. |

A job `type` string is permanent once rows of it exist.

### 3.5 Notification events

Appended to `NOTIFICATION_EVENTS` (`apps/api/src/notifications/notification-events.ts`), with a template in `EVENT_BROWSER_TEMPLATES` for each and an email template for the review in `EVENT_EMAIL_TEMPLATES`. None is `mandatory`.

| Event key | Channels | Default | Raised by |
|---|---|---|---|
| `coach.nudge` | `browser`, `push` | on | `nudge`, `comeback`, `kickoff`, `system` messages |
| `coach.celebration` | `browser`, `push` | on | `pr`, `weekly_target_hit` |
| `coach.photo_prompt` | `browser`, `push` | on | `photo_prompt` |
| `coach.weekly_review` | `email`, `browser`, `push` | on | `ai.coach.weekly_review` |

### 3.6 Routes

Details in `/api/docs` once built.

| Method and path | Permission | Guards |
|---|---|---|
| `GET /api/coach/personas` | `ai:use` | `@Auth`, `AiEnabledGuard` |
| `GET /api/coach/settings`, `PUT /api/coach/settings` | `ai:use` | `@Auth`, `AiEnabledGuard` |
| `POST /api/coach/voice-preview` | `ai:use` | `@Auth`, `AiEnabledGuard`, rate limit |
| `GET /api/coach/messages` | `ai:use` | `@Auth`, `AiEnabledGuard` |
| `POST /api/coach/messages/:id/opened` | `ai:use` | `@Auth`, `AiEnabledGuard` |
| `POST /api/coach/messages/:id/feedback` | `ai:use` | `@Auth`, `AiEnabledGuard` |
| `POST /api/coach/chat/stream` | `ai:use` and `programs:read` | `@Auth`, `AiEnabledGuard` |
| `GET /api/coach/state` | `ai:use` | `@Auth`, `AiEnabledGuard`; header ring and streak |
| `GET /api/progress-photos`, `POST /api/progress-photos`, `DELETE /api/progress-photos/:id` | `health_data:read` / `health_data:write` | `@Auth`; **no** `AiEnabledGuard` |
| `GET /api/admin/coach/settings`, `PUT /api/admin/coach/settings` | `ai_config:read` / `ai_config:write` | `@Auth`; **not** behind `AiEnabledGuard` |
| `GET /api/admin/coach/stats` | `ai_config:read` | `@Auth`; **not** behind `AiEnabledGuard` |

Every consumer route sits behind `AiEnabledGuard` plus `ai:use`. Admin routes are deliberately not behind it, so an administrator can always reach the settings (AI rule 4). **No new permission family** is added.

### 3.7 Error codes

| Code | Status | When |
|---|---|---|
| `COACH_DISABLED` | 403 | The system or user coach switch is off. |
| `COACH_PROFANITY_LOCKED` | 403 | A profanity write fails an unlock condition; `details.reason` names it. |
| `COACH_AUDIO_DISABLED` | 403 | Audio requested while system `allowAudio` is off. |
| `COACH_PREVIEW_RATE_LIMITED` | 429 | Too many voice previews; `Retry-After` is set. |
| `COACH_PERSONA_UNKNOWN` | 400 | `personaId` is not in the registry. |
| `COACH_MESSAGE_NOT_FOUND` | 404 | The message is not the caller's. |
| `COACH_PAUSE_INVALID` | 400 | `pause_coach` with `days` outside 1 to 14. |
| `AI_DISABLED`, `AI_RATE_LIMITED` | 403, 429 | Existing AI errors, unchanged. |

The envelope's `code` is status-derived ([API.md](../API.md#errors)), so a coach code travels in `details.code`. `details.reason` repeats it, except for `COACH_PROFANITY_LOCKED`, whose `details.reason` is the failed unlock condition (`system_disabled`, `age_unverified`, `underage`, `persona_or_intensity`). `COACH_PERSONA_UNKNOWN` also carries `details.issues` naming `personaId`.

Not every failure gets a coach-specific code:
- Chat input over 2,000 characters, and any other schema failure, is an ordinary 400 validation error.
- A chat turn when `coach.chat` has no resolvable model returns `409` with `details.reason: AI_FEATURE_UNAVAILABLE` (the photo-intake convention).
- A voice preview or audio request when `coach.voice` has no resolvable model returns the existing unresolved-feature 409 from `AiFeatureModelResolver`.
- The 18+ dialog sends `confirmAdult: true` on `PUT /api/coach/settings`, and the server stamps `adultConfirmedAt`; the client never writes the timestamp itself.

## 4. Extending it in a fork

### 4.1 Add a persona

1. Add `apps/api/src/coach/personas/<id>.persona.ts` with `id`, `name`, `tagline`, `avatar`, the style card, a default voice and TTS `instructions`, and sample lines for **every** moment at every intensity.
2. Register it in `apps/api/src/coach/personas/index.ts`.
3. Add its id to the `personaId` enum in the settings schema (six places, [onboarding.md §4.4](onboarding.md#44-add-another-stored-fact)).
4. Keep it clean. Only `drill_sergeant` at level 3 may be profane; a new profane persona means changing condition 4 in `resolveRegister` and the profanity tests, which is a deliberate act.
5. The persona-registry completeness test fails until every moment has a line; the guard test runs the sample lines through the content guard.

### 4.2 Add a moment

1. Add it to `COACH_MOMENTS` and the `moment` enum (a migration if it is a database enum).
2. Add its trigger rule and priority in `planCoachMoments`, and its row in the moments table of [§2.5](#25-decision-engine).
3. Add sample lines in every persona.
4. Choose its notification event and conversion target in [§2.8](#28-learning-loop).
5. Extend the table-driven `plan-coach-moments.spec.ts` with firing and suppression cases.

### 4.3 Add an angle

Add it to the angle enum and to the prompt builder's angle guidance, then to the table in [§2.8](#28-learning-loop). `pickAngle` needs no change: it reads the angle list. Decide whether a supportive register may use it.

### 4.4 Add a chat tool

Add a handler under `apps/api/src/coach/chat/tools/`, register it in the tool list, keep read tools minimised (no free text, no storage keys) and any write tool narrow and bounded like `pause_coach`. Add it to the table in [§2.9](#29-chat) and to the never-send canary.

### 4.5 Add a TTS provider later

Voice output goes through `AiService.speak`, so a new provider is an AI-platform change first ([ai-platform.md §4](ai-platform.md#4-extending-it-in-a-fork)). The coach part is then: allow the provider in the `coach.voice` feature's `providers`, make the persona voices a per-provider map, and check whether the provider honours `instructions` (otherwise the tone must come from the script alone).

## 5. Guardrails

Tests to be added by the epic **(new)** unless marked existing.

| Rule | Test |
|---|---|
| Profanity is impossible unless all four unlock conditions hold. A tripwire across the settings route, the generator, the preview and the guard. | `apps/api/test/coach/coach-profanity-unlock.spec.ts` |
| The guard rejects banned terms, body or weight insults, invented numbers, profane lock-screen text and over-length output; regenerates once; falls back to a static line. | `apps/api/src/coach/guard/coach-content-guard.spec.ts` |
| `planCoachMoments` honours every gate and priority, deterministically, with no Nest or Prisma import. | `apps/api/src/coach/planning/plan-coach-moments.spec.ts` |
| `pickAngle` is deterministic for a seed, applies the novelty penalty and cold-starts uniformly. | `apps/api/src/coach/learning/pick-angle.spec.ts` |
| Data minimisation: a canary in each never-send source appears in no model request (chat, nudge, review). | `apps/api/test/coach/coach-never-send.spec.ts` |
| Every persona has a sample line for every moment and intensity, all pass the guard in their register, and only Sarge L3 contains profanity. | `apps/api/src/coach/personas/persona-registry.spec.ts` |
| Safety: a blocked or distress message makes no model call; a supportive register removes pushy angles. | `apps/api/test/coach/coach-safety.spec.ts` |
| Progress photos never reach a model, a tool result or a notification. | `apps/api/test/coach/coach-photo-privacy.spec.ts` |
| Chat streaming is unbuffered in both nginx configurations. | `apps/api/test/coach/coach-stream-nginx.spec.ts`, `apps/cli/src/deploy/proxy.test.ts` (existing, extended) |
| The feature-id and group wiring is consistent across the four files; the Coach section exists. | `apps/api/src/ai/assignments/ai-feature-resolution.spec.ts` (existing, extended), `apps/web/src/__tests__/config/aiSettingsRegistry.test.ts` (existing, extended) |
| Navigation: Coach is a primary tab, the primary count is 4, every route has one owner. | `apps/web/src/__tests__/config/destinations.test.ts` (existing, extended) |
| Every consumer route has `AiEnabledGuard` and `ai:use`, every admin route is unguarded by it, kill switch answers `403 AI_DISABLED`. | `apps/api/test/ai/ai-rbac-matrix.integration.spec.ts`, `apps/api/test/ai/ai-kill-switch.integration.spec.ts` (existing, auto-discover) |
| Every `ai.coach.*` job is server-only. | `apps/api/test/ai/ai-jobs-server-only.spec.ts` (existing, auto-discovers) |
| No provider SDK or orchestration library in `coach/`. | `apps/api/test/ai/ai-no-sdk-leak.spec.ts`, `apps/api/test/ai/ai-orchestration-boundary.spec.ts` (existing) |
| The coach cron only enqueues. | `apps/api/test/jobs/cron-enqueue-only.spec.ts` (existing, auto-discovers) |
| A user reset and a factory reset delete the three models and their storage objects. | `apps/api/test/user-data/user-data-reset.db.spec.ts` (existing, extended) |
| The `coach` namespace is accepted in every settings layer and rejects unknown keys. | `apps/api/src/common/schemas/settings-parity.spec.ts` (existing, extended) |

## 6. Design decisions

- **Deterministic "may", AI "should".** A model that can override a cap eventually will. Gates are code; the model only narrows. Rejected: letting the model read quiet hours and decide. A prompt is not a guarantee.
- **A bandit over angles, not over send time.** Duolingo's work chooses among templates with a recovering-difference score and a recency penalty, and reports +0.5 percent DAU and +2 percent new-user retention. We borrow the recovering difference and the penalty `γ·0.5^(d/h)`. We fix the send time from the user's pattern instead (about 23.5 hours after the last session, which is 30 minutes before the usual time) because a single user produces too little data to learn time and angle together. Source: [Yancey and Settles, KDD 2020](https://research.duolingo.com/papers/yancey.kdd20.pdf).
- **Protect the channel.** Duolingo stops after 7 inactive days with a "these reminders don't seem to be working" message. We do the same (`inactiveStopDays`, auto-silence after ignored nudges), with exactly one back-off message. A coach that cannot be quiet gets muted.
- **Reward the return, not the binge.** The best intervention in the Milkman 2021 megastudy was a small reward for returning after a miss (never miss twice), and Lally (2010) found one miss does not break a habit. So `missed_twice` ranks first and `comeback` is a celebration, not a lecture. Sources: Milkman et al. 2021, the gym-attendance megastudy (Nature); Lally et al. 2010, Eur J Soc Psychol.
- **Loss framing for streaks.** Loss framing beat gain framing for physical activity in Patel et al. 2016 ([doi:10.7326/M15-1635](https://doi.org/10.7326/M15-1635)). We use `loss_aversion` as an angle about behaviour (a streak, a session), never about weight or body outcomes, and never in a supportive register ([VISION.md §67](../../VISION.md)).
- **Implementation intentions.** "When, where, fallback" raises follow-through for exercise (Gollwitzer and Sheeran meta-analysis, effect near d = 0.3). The kickoff asks for one and `missed_session` carries a concrete next slot.
- **Fresh starts.** Mondays and the 1st of a month are natural restart moments (Dai, Milkman and Riis 2014), so `fresh_start` is a moment, used only after a lapse.
- **Weekly streak, not daily.** A daily streak punishes rest days and illness and invites unsafe training. A weekly target with one pass per 4 weeks rewards consistency and survives a bad week, in line with Duolingo's streak freeze and [VISION.md §67](../../VISION.md). Rejected: a daily streak with freezes, which still treats rest as failure.
- **Personas as persona by intensity, with profanity as a separate opt-in.** CARROT Weather separates a personality from an intensity slider and puts profanity behind its own opt-in at the top level, with a plain default ([MacStories review](https://www.macstories.net/reviews/carrot-weather-40-simply-delightful/)). We copy the shape: a clean default (Coach), seven personas, three levels, a large static line pool, and one profane combination.
- **A real age gate and an explicit opt-in.** xAI's "Unhinged" mode was age-gated and behind an NSFW toggle, and was removed in September 2026. The lesson is that profane or adult modes need a real gate, an explicit choice and a deployment switch, and that the vendor can remove the mode. So profanity is a registry rule in code, deployment-gated, fail-closed and re-checked on every message ([§2.4](#24-profanity-unlock)).
- **Original archetypes, not named people.** Sarge and the other personas are archetypes. We take themes (carry your own logs, the mind quits early, the accountability mirror, a cookie jar of past wins, cadence) as inspiration from David Goggins's public talks and from the drill-instructor figure in a well-known war film, and write original lines. No persona is named after, imitates the voice of, or quotes a real person or a film, which avoids impersonation, trademarked catchphrases and a feature that an attribution request could take down. Inspiration is cited here only.
- **Profane insults aim at effort only.** Heavy profanity is allowed because major providers allow user- or operator-enabled profanity. Slurs, protected traits, sexual content and self-harm are not allowed by any of them, and body or weight shaming is excluded for health reasons ([VISION.md §67](../../VISION.md)). The guard checks the insult target, not just the words.
- **Text always, audio optional.** Web Push cannot play sound: no browser supports the `sound` option ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification)) and a service worker has no audio output. So push carries text and a "Hear Coach" action whose click is the user gesture autoplay needs. Rejected: embedding audio in the push, which does not work.
- **OpenAI TTS only in this epic.** `gpt-4o-mini-tts` offers 13 voices, an `instructions` field for tone, adjustable speed and low cost (about 0.015 USD per minute), and requires disclosing that the voice is synthetic ([OpenAI text to speech](https://developers.openai.com/api/docs/guides/text-to-speech)). It sometimes refuses profane text, so audio can fall back to text. Rejected: a second TTS provider now; it is an AI-platform task ([§4.5](#45-add-a-tts-provider-later)).
- **No AI analysis of bodies.** Reading a photo for body fat or "progress" invites harmful comparison, is hard to make accurate and puts the most sensitive image the app holds into a prompt. Photos are for the user's own eyes ([VISION.md §87](../../VISION.md)). The coach says "you added a photo", never what it shows.
- **The coach is outside `training-agents/`, with no LangGraph.** Each coach step is one structured call with a fixed shape (decide and write, or review and write). A graph adds checkpoints, branches and a runtime nothing here needs, and it would put the module under the orchestration boundary. Plain job handlers match `health-summary/`. Rejected: a coach graph "for future agents"; add one only when a step needs real branching.
- **Reuse the signals service for every number.** Models are unreliable at arithmetic. One source of figures keeps the app, the email and the coach in agreement, as the weekly review must match `GET /api/training/signals` ([training-signals.md](training-signals.md)).

## 7. Out of scope and follow-ups

| Item | Why it is out | Follow-up |
|---|---|---|
| Native mobile push sounds | Web Push cannot carry sound; native apps do not exist | A native-app epic |
| Non-OpenAI TTS | Only one provider is built in this epic | [§4.5](#45-add-a-tts-provider-later) |
| AI body or photo analysis | Excluded by design ([§6](#6-design-decisions)) | None planned |
| XP, badges and leagues | A separate gamification epic ([VISION.md §66](../../VISION.md)) | Separate epic |
| Realtime voice chat | The realtime sessions API exists in the AI platform but is not wired here | A voice-chat story |
| Social features and leaderboards | Not part of an individual accountability loop | None planned |
| SMS | Needs a new channel and consent rules | A channel story |
| A monthly review | Needs more measurement history ([VISION.md §94](../../VISION.md)) | After the weekly review ships |
| Nutrition nudges | Needs nutrition signals the app does not compute | After nutrition tracking |

## 8. Verification

Run these once the epic ships. The fake AI provider needs no key; see `infra/compose/fake-ai.compose.yml`.

```bash
# Unit and mocked integration
npm test --workspace=api -- coach plan-coach-moments pick-angle coach-content-guard persona-registry
npm test --workspace=api -- ai-jobs-server-only ai-rbac-matrix ai-kill-switch ai-no-sdk-leak ai-orchestration-boundary cron-enqueue-only
npm run test:db --workspace=api -- user-data-reset
npm run test:run --workspace=web -- destinations aiSettingsRegistry
npm run test:run --workspace=cli -- proxy

# Typecheck and OpenAPI
npm run typecheck --workspace=api && npm run typecheck --workspace=web
npm run openapi:dump && npm run openapi:lint
```

Manual check with the fake provider (from `infra/compose`):

```bash
docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml -f fake-ai.compose.yml up
```

1. In `/admin/settings/ai`, point the provider slot at the fake server and assign models to `coach.decision`, `coach.chat` and `coach.voice` on the AI Model Assignments page. **Observe:** the Coach section appears and each feature resolves.
2. At `/admin/settings/coach`, leave `allowProfanePersonas` off. In `/settings/coach`, pick Sarge at level 3 and try the profanity toggle. **Observe:** `403 COACH_PROFANITY_LOCKED` and a clean preview.
3. Turn `allowProfanePersonas` on, confirm 18+ and enable profanity. **Observe:** the L3 preview shows the profane sample lines; a push body stays clean while lock-screen-safe is on.
4. Seed a user with two missed sessions, then fire the sweep from the admin job list. **Observe:** one `ai.coach.nudge` job, one `CoachMessage`, one notification, no second nudge inside 3 hours, none during quiet hours.
5. Enable audio. **Observe:** the message arrives as text with a "Hear Coach" action; opening `/coach?m=<id>&autoplay=1` plays it with the "AI-generated audio" label. Force the speech job to fail and **observe** a text-only delivery with `audioStatus = 'failed'`.
6. Send "I'm sick" in chat. **Observe:** a `pause_coach` tool call and no nudges while `pausedUntil` is set. Send a message containing an urgent symptom. **Observe:** a seek-help reply and no model call.
7. Add a progress photo; open the gallery, compare and ghost overlay. **Observe:** no image appears in any request the fake provider received.
8. Wait for local Sunday 18:00 (or fire `ai.coach.weekly_review`). **Observe:** one review card, one email whose stats table matches `GET /api/training/signals`, and no second review in the same ISO week.
9. Run a user data reset. **Observe:** the three coach tables are empty for that user and their audio and photo objects are gone.

## History

- Proposed under epic E7 (issue 240), stories E7.1 to E7.13 (issues 241 to 253).
- E7.5 (issue 245): nudge generation, delivery, push action and feedback; the as-built notes are at the end of [§2.7](#27-delivery-and-audio).
- E7.12 (issue 252): the `ai_plan` step's "Meet your coach" phase, the program-activation kickoff with deferral, and the `save_commitment` chat tool ([§2.13](#213-ux-surfaces)).
