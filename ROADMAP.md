# Roadmap

Where EvoPath is going and in what order. The product intent lives in [VISION.md](VISION.md); this file sequences it into phases and epics. The GitHub issues hold the implementation detail, and this file does not repeat it.

## 1. How to read this file

- A **phase** is a group of related capabilities, delivered in order.
- An **epic** is a deployable, end-to-end testable slice inside a phase. Phase 1 epics (E1-E6) are already filed and link to their issues. Later phases list **items**; each item is filed as an epic before work starts (see [How epics get filed](#5-how-epics-get-filed)).
- Every item names its VISION sections, what it depends on, and a **testable when** line: the observable result that marks it done.
- VISION section numbers appear as `§n`.

### Status legend

| Status | Meaning |
|---|---|
| Planned | Scoped, not started |
| In progress | At least one child issue has an open branch |
| Done | Merged and its "testable when" line holds |

Every item below is **Planned**.

## 2. Principles for every epic

- **Vertical slice.** Each epic ships something deployable and testable end to end: schema, API, UI and tests together, never a layer alone.
- **Multi-model AI.** AI uses a language model, a vision model, or both, through the platform's provider abstraction ([docs/specs/ai-platform.md](docs/specs/ai-platform.md)). No feature is tied to one vendor.
- **Photo-first.** Wherever a user would type structured data, they can share pictures instead. AI drafts; the user reviews and overwrites. Photos stay linked to the object they created ([§87](VISION.md#87-photos-as-evidence)).
- **Manual entry always works.** Every domain supports manual entry with AI off ([§88](VISION.md#88-manual-entry-everywhere)); AI accelerates and never gates.
- **Provenance and editing everywhere.** Every value records where it came from (manual, AI-drafted, imported), and every AI-assisted object is editable ([§4.3](VISION.md#43-ai-proposes-the-user-remains-in-control), [§4.4](VISION.md#44-provenance-is-a-first-class-product-concept), [§88](VISION.md#88-manual-entry-everywhere), [§89](VISION.md#89-editing-everywhere)).
- **Measure, understand, plan, act.** Each phase feeds the loop of [§84](VISION.md#84-evopaths-core-intelligence-model): measure the person, understand where they are, plan, act, then check whether it worked.
- **Template rules apply.** Work follows [CLAUDE.md](CLAUDE.md): registry-driven settings pages, queue jobs for long-running work, server-side AI only.

## 3. Phases

| Phase | Theme | Status |
|---|---|---|
| 1 | Workouts, basic health metrics, gyms, UI | Planned |
| 2 | Goals and weekly progress | Planned |
| 3 | Health record depth | Planned |
| 4 | Nutrition | Planned |
| 5 | Intelligence and engagement | Planned |
| 6 | Trust and reach | Planned |
| Deferred | Not planned | n/a |

### Phase 1: Workouts, basic health metrics, gyms, UI

Suggested build order: E1, E2 (E2.1-E2.5), E3, E2.6, E4, E5, E6. E2.6 waits for E3.1.

### E1. App shell & navigation redesign

| | |
|---|---|
| Epic | [#26](https://github.com/marinoscar/evopath/issues/26) |
| Status | Planned |
| Goal | Replace the template shell with a health-app shell: primary navigation for Today, Train, Health and Gyms, a Today dashboard with placeholder cards, and progressive disclosure so the first screen stays simple. |
| Testable when | A new user signs in, sees the new navigation and an empty-state home, and reaches every Phase 1 area (as placeholders where the epic has not shipped) on desktop and phone widths. |
| VISION | [§69](VISION.md#69-health-dashboard), [§70](VISION.md#70-progressive-disclosure), [§90](VISION.md#90-user-experience-principle-do-not-force-completion), [§91](VISION.md#91-user-experience-principle-preserve-momentum) |
| Depends on | None (first in build order). New pages follow the registry rules in [CLAUDE.md](CLAUDE.md). |
| Children | E1.1 [#29](https://github.com/marinoscar/evopath/issues/29), E1.2 [#31](https://github.com/marinoscar/evopath/issues/31), E1.3 [#33](https://github.com/marinoscar/evopath/issues/33), E1.4 [#36](https://github.com/marinoscar/evopath/issues/36), E1.5 [#37](https://github.com/marinoscar/evopath/issues/37), E1.6 [#41](https://github.com/marinoscar/evopath/issues/41) |

### E2. Health profile & basic body metrics

| | |
|---|---|
| Epic | [#45](https://github.com/marinoscar/evopath/issues/45) |
| Status | Planned |
| Goal | Capture the core profile (date of birth, sex at birth, height, units) and record basic body metrics (weight, body fat, waist) by quick entry, with an editable history and source recorded on every value. |
| Testable when | A user completes the profile, logs and edits a weight entry by hand, sees the history and its units, and (E2.6) reads a scale or body-metric photo into a draft they can overwrite. |
| VISION | [§6](VISION.md#6-user-health-profile), [§9](VISION.md#9-measurement-metadata), [§14](VISION.md#14-body-composition), [§15](VISION.md#15-body-composition--quick-entry), [§18](VISION.md#18-measurement-method), [§20](VISION.md#20-vital-signs-and-common-health-metrics) |
| Depends on | E1. E2.6 also depends on E3.1 (photo intake). |
| Children | E2.1 [#47](https://github.com/marinoscar/evopath/issues/47), E2.2 [#50](https://github.com/marinoscar/evopath/issues/50), E2.3 [#53](https://github.com/marinoscar/evopath/issues/53), E2.4 [#56](https://github.com/marinoscar/evopath/issues/56), E2.5 [#60](https://github.com/marinoscar/evopath/issues/60), E2.6 [#64](https://github.com/marinoscar/evopath/issues/64) (photo read, blocked by E3.1) |

### E3. Gyms, equipment & AI Scan Gym (vision)

| | |
|---|---|
| Epic | [#27](https://github.com/marinoscar/evopath/issues/27) |
| Status | Planned |
| Goal | Register training locations, keep an equipment catalog with capabilities and photos, and let a vision model draft the catalog from pictures of a gym. E3.1 is the photo-intake foundation that other epics reuse. |
| Testable when | A user creates a gym by hand with equipment, then shares photos of a gym, reviews the AI-drafted equipment list, edits or rejects items, and saves; with AI off, manual entry still works end to end. |
| VISION | [§35](VISION.md#35-training-locations), [§38](VISION.md#38-gym-equipment-catalog), [§39](VISION.md#39-equipment-capabilities), [§40](VISION.md#40-gym-equipment-photo-recognition), [§41](VISION.md#41-equipment-photos), [§87](VISION.md#87-photos-as-evidence) |
| Depends on | E1. E3.1 uses the AI platform ([docs/specs/ai-platform.md](docs/specs/ai-platform.md)). |
| Children | E3.1 [#34](https://github.com/marinoscar/evopath/issues/34) (photo-intake foundation), E3.2 [#40](https://github.com/marinoscar/evopath/issues/40), E3.3 [#43](https://github.com/marinoscar/evopath/issues/43), E3.4 [#48](https://github.com/marinoscar/evopath/issues/48), E3.5 [#51](https://github.com/marinoscar/evopath/issues/51), E3.6 [#55](https://github.com/marinoscar/evopath/issues/55) |

### E4. Exercise library & workout logging

| | |
|---|---|
| Epic | [#58](https://github.com/marinoscar/evopath/issues/58) |
| Status | Planned |
| Goal | Provide an exercise library and log workouts (sets, reps, load, time) with edit and history; a logged workout can be prefilled from a photo of a workout sheet or screen. |
| Testable when | A user finds an exercise, logs a workout by hand, edits it afterwards, and sees it in history; a shared photo prefills a draft workout that the user corrects before saving. |
| VISION | [§29](VISION.md#29-fitness-and-training), [§30](VISION.md#30-workout-types), [§32](VISION.md#32-workout-logging), [§42](VISION.md#42-exercise-substitution), [§88](VISION.md#88-manual-entry-everywhere), [§89](VISION.md#89-editing-everywhere) |
| Depends on | E1, E3 (gyms and equipment). E4.5 depends on E3.1. |
| Children | E4.1 [#62](https://github.com/marinoscar/evopath/issues/62), E4.2 [#65](https://github.com/marinoscar/evopath/issues/65), E4.3 [#66](https://github.com/marinoscar/evopath/issues/66), E4.4 [#67](https://github.com/marinoscar/evopath/issues/67), E4.5 [#68](https://github.com/marinoscar/evopath/issues/68) (prefill from photo), E4.6 [#69](https://github.com/marinoscar/evopath/issues/69), E4.7 [#70](https://github.com/marinoscar/evopath/issues/70) |

### E5. Training programs & Today's workout

| | |
|---|---|
| Epic | [#28](https://github.com/marinoscar/evopath/issues/28) |
| Status | Planned |
| Goal | Persistent training programs built from the exercise library, with a Today's workout view that starts a logging session, progress tracking and progressive overload. |
| Testable when | A user creates a program by hand, opens Today's workout, logs it through E4 logging, and sees progress against the plan. |
| VISION | [§31](VISION.md#31-persistent-training-programs), [§33](VISION.md#33-training-progress), [§34](VISION.md#34-progressive-overload), [§43](VISION.md#43-time-aware-workouts) |
| Depends on | E4. |
| Children | E5.1 [#30](https://github.com/marinoscar/evopath/issues/30), E5.2 [#32](https://github.com/marinoscar/evopath/issues/32), E5.3 [#35](https://github.com/marinoscar/evopath/issues/35), E5.4 [#38](https://github.com/marinoscar/evopath/issues/38), E5.5 [#39](https://github.com/marinoscar/evopath/issues/39), E5.6 [#42](https://github.com/marinoscar/evopath/issues/42), E5.7 [#44](https://github.com/marinoscar/evopath/issues/44) |

### E6. AI workout generation (language + vision)

| | |
|---|---|
| Epic | [#46](https://github.com/marinoscar/evopath/issues/46) |
| Status | Planned |
| Goal | Generate workouts and programs with a language model, grounded in the user's profile, equipment and history, and with vision input (photos of a gym or equipment) as context. The user reviews and edits every draft. |
| Testable when | A user asks for a workout for a chosen gym, receives a draft that only uses that gym's equipment, edits it and saves it as a program or ad-hoc workout; with AI off, E4 and E5 remain fully usable. |
| VISION | [§30](VISION.md#30-workout-types), [§31](VISION.md#31-persistent-training-programs), [§42](VISION.md#42-exercise-substitution), [§60](VISION.md#60-ai-coach-capabilities), [§62](VISION.md#62-ai-provider-choice), [§64](VISION.md#64-ai-transparency), [§75](VISION.md#75-workout-safety) |
| Depends on | E3, E4, E5. |
| Children | E6.1 [#49](https://github.com/marinoscar/evopath/issues/49), E6.2 [#52](https://github.com/marinoscar/evopath/issues/52), E6.3 [#54](https://github.com/marinoscar/evopath/issues/54), E6.4 [#57](https://github.com/marinoscar/evopath/issues/57), E6.5 [#59](https://github.com/marinoscar/evopath/issues/59), E6.6 [#61](https://github.com/marinoscar/evopath/issues/61), E6.7 [#63](https://github.com/marinoscar/evopath/issues/63) |

### Dependency diagram (Phase 1)

```
E1 App shell
 ├──> E2 Health profile & body metrics (E2.1-E2.5)
 └──> E3 Gyms, equipment & AI Scan Gym
        │  E3.1 photo intake ──> E2.6 photo read of body metrics
        │                   └──> E4.5 workout prefill from photo
        └──> E4 Exercise library & logging   (also needs E1)
               └──> E5 Programs & Today's workout
                      └──> E6 AI workout generation   (also needs E3, E4)
```

### Phase 2: Goals and weekly progress

| Item | Scope | VISION | Depends on | Testable when |
|---|---|---|---|---|
| Goals | Structured goals with categories, targets and progress tracking | [§25](VISION.md#25-goals)-[§28](VISION.md#28-goal-progress) | E2, E4, E5 | A user creates a goal, logs data, and sees progress computed against it |
| GPS-aware gym detection prompt | Prompt to switch to a registered gym when the device is near it | [§36](VISION.md#36-gps-aware-gym-context), [§37](VISION.md#37-temporary-training-locations) | E3 | Arriving near a saved gym offers that gym as the workout location; declining changes nothing |
| Weekly progress review (basics) | A weekly summary of workouts, metrics and goal movement | [§33](VISION.md#33-training-progress), [§69](VISION.md#69-health-dashboard) | E4, E5, Goals | After a week of activity the user opens a summary that matches their logged data |

Filed as an epic before work starts.

### Phase 3: Health record depth

| Item | Scope | VISION | Depends on | Testable when |
|---|---|---|---|---|
| Document library | Store medical documents linked to the record | [§10](VISION.md#10-medical-document-library) | E2 | A user uploads, views and deletes a document |
| AI document extraction | Extract values from documents into a reviewable draft with provenance | [§11](VISION.md#11-ai-document-extraction), [§4.4](VISION.md#44-provenance-is-a-first-class-product-concept) | Document library, E3.1 | An uploaded lab PDF yields a draft the user edits and accepts; each saved value links to its source |
| Biomarkers and reference ranges | Track biomarkers over time against reference ranges | [§12](VISION.md#12-biomarker-tracking), [§13](VISION.md#13-reference-ranges) | E2 | A user enters a result by hand and sees it against its range |
| DEXA and advanced body composition | Detailed and regional body-composition entry and reports | [§16](VISION.md#16-body-composition--detailed-manual-entry), [§17](VISION.md#17-dexa-and-advanced-body-composition), [§19](VISION.md#19-derived-body-composition-values) | E2, AI document extraction | A DEXA report is entered or extracted, edited and charted over time |
| Medications (label photo) | Medication list and timeline, entered by hand or from a label photo | [§22](VISION.md#22-medications)-[§24](VISION.md#24-medication-timeline) | E3.1 | A user adds a medication from a label photo, corrects it and sees it on a timeline |
| Vitals beyond basics | Blood pressure, heart rate and subjective wellness check-ins | [§20](VISION.md#20-vital-signs-and-common-health-metrics), [§21](VISION.md#21-subjective-wellness-and-check-ins) | E2 | A user logs and edits each vital and sees its trend |
| Health timeline | One chronological view across the record | [§68](VISION.md#68-health-timeline) | Items above | Entries from several domains appear in date order and link back to their source |
| Duplicate detection | Flag likely duplicate entries and documents | [§72](VISION.md#72-duplicate-detection) | Document library, Biomarkers | Re-adding the same result prompts the user before saving a second copy |
| Revision history | Keep prior versions of corrected data | [§71](VISION.md#71-data-correction-and-revision-history) | E2 | Editing a value keeps the previous one viewable |

Each item is filed as an epic before work starts.

### Phase 4: Nutrition

| Item | Scope | VISION | Depends on | Testable when |
|---|---|---|---|---|
| Meal logging with photo recognition | Log meals by hand or from a photo; AI drafts food items | [§45](VISION.md#45-meal-record), [§47](VISION.md#47-food-photo-recognition), [§48](VISION.md#48-homemade-food-estimation), [§49](VISION.md#49-meal-photo-preservation), [§50](VISION.md#50-manual-food-entry) | E3.1 | A meal photo yields an editable draft; the saved meal keeps its photo |
| Food items | Food records with calories and macros | [§46](VISION.md#46-food-item) | None in Phase 4 | A user creates and edits a food item by hand |
| Nutrition targets and daily summary | Targets and a daily rollup | [§57](VISION.md#57-nutrition-targets), [§58](VISION.md#58-daily-nutrition-summary) | Meal logging | The daily summary matches logged meals against targets |
| Recipes and AI recipe creation | Manual recipes; AI drafts recipes the user edits | [§51](VISION.md#51-recipes), [§52](VISION.md#52-ai-recipe-creation) | Food items | A recipe is created by hand or drafted by AI, then edited and saved |
| Meal plans and grocery lists | Plan a week of meals and derive a grocery list | [§53](VISION.md#53-meal-planning)-[§55](VISION.md#55-grocery-lists) | Recipes, Targets | A meal plan produces a grocery list the user can edit |
| Nutrition preferences | Diet, allergies and dislikes that shape plans | [§56](VISION.md#56-nutrition-preferences), [§76](VISION.md#76-nutrition-safety) | None in Phase 4 | Saved preferences constrain generated recipes and plans |

Each item is filed as an epic before work starts.

### Phase 5: Intelligence and engagement

| Item | Scope | VISION | Depends on | Testable when |
|---|---|---|---|---|
| AI health coach | Conversational coach with agentic tools; every change it proposes is confirmable | [§59](VISION.md#59-ai-health-coach)-[§61](VISION.md#61-agentic-ai-concept) | Phases 1-2 | The coach proposes a change, the user reviews it, and nothing is saved until they confirm |
| Coaching profile and personality | User-controlled coaching style and communication preferences | [§7](VISION.md#7-ai-coaching-profile), [§4.5](VISION.md#45-health-truth-and-ai-personality-are-separate) | AI health coach | Changing personality alters tone and not facts |
| Per-capability model choice | Choose different models for extraction, reasoning and vision | [§62](VISION.md#62-ai-provider-choice), [§63](VISION.md#63-bring-your-own-key) | AI health coach | A user selects a model per capability and calls use it |
| Personal baseline | Compare the user to their own history | [§85](VISION.md#85-personal-baseline) | Phase 3 vitals | A metric is shown relative to the user's own baseline |
| Weekly and monthly reviews | Periodic AI-assisted reviews of what is working | [§84](VISION.md#84-evopaths-core-intelligence-model) | Phase 2 weekly review | A review cites the data behind each statement |
| Gamification | XP, streaks, badges and quests, within the safety limits | [§65](VISION.md#65-gamification)-[§67](VISION.md#67-gamification-safety) | Phases 1-2 | Streaks and badges update from real activity; no reward encourages unsafe behaviour |

Each item is filed as an epic before work starts.

### Phase 6: Trust and reach

| Item | Scope | VISION | Depends on | Testable when |
|---|---|---|---|---|
| Privacy controls | User controls over what is stored and shown | [§77](VISION.md#77-privacy-and-user-control) | Phases 1-3 | A user changes a privacy setting and the change takes effect |
| Data export and delete | Export everything; delete on request | [§79](VISION.md#79-user-data-ownership) | Phases 1-3 | An export contains the user's records; deletion removes them |
| AI data-sharing transparency | Show what is sent to an AI provider | [§78](VISION.md#78-ai-data-sharing-transparency), [§64](VISION.md#64-ai-transparency) | Phase 5 | Before or after an AI call the user can see what was shared |
| Wearable and device import | Import readings from devices, marked as such in provenance | [§9](VISION.md#9-measurement-metadata), [§86](VISION.md#86-source-hierarchy-and-trust) | Phase 3 vitals | Imported readings appear with a device source and can be edited |

Each item is filed as an epic before work starts.

### Deferred

Explicitly out of scope for now ([§82](VISION.md#82-explicitly-deferred-areas)):

- Direct EHR integrations
- Physician portals
- Family/caregiver accounts
- Genetics
- CGM-specific features
- Lab ordering
- Insurance integration
- Appointment scheduling
- Provider messaging
- Clinical decision support
- Direct medical diagnosis
- Direct medical treatment recommendations
- Advanced preventive-care orchestration
- Full clinical interoperability
- Social network features

## 4. Dependencies between phases

Phase 1 comes first; Phase 2 builds on its logging and gyms. Phases 3 and 4 both reuse the E3.1 photo-intake foundation and can proceed in either order. Phase 5 needs data from Phases 1-3. Phase 6 follows once the data it protects and exports exists.

## 5. How epics get filed

- Every feature and bug fix is tracked by an issue filed before work starts ([CLAUDE.md](CLAUDE.md), issue-driven development).
- Larger initiatives use the epic template, [.github/ISSUE_TEMPLATE/epic.yml](.github/ISSUE_TEMPLATE/epic.yml): `gh issue create --template epic.yml`. Child feature issues reference the epic.
- Each feature is built in its own worktree and branch (`worktrees/<short-name>`, `<type>/<short-name>`), as [CLAUDE.md](CLAUDE.md) describes.
- When an epic is filed, its item here gains an issue link and its status moves with the work.

## 6. Change log

- 2026-09-29: first version; Phase 1 epics E1-E6 filed, Phases 2-6 scoped.
