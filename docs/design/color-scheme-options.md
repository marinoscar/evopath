# Colour scheme options

> **Status:** proposal, decision pending · **Mock-up:** [color-studio/index.html](color-studio/index.html) · **Code:** `apps/web/src/theme/` · **Vision:** [../../VISION.md](../../VISION.md)

Four candidate colour schemes for EvoPath, one recommendation (Tidal Teal), and the plan to ship whichever is chosen. The hex values below are the ones the mock-up renders.

## 1. Purpose and status

- **Purpose:** pick one palette for the web app in light and dark mode before any theme code changes.
- **Status:** proposal. No candidate is implemented. The theme in `apps/web/src/theme/` is unchanged.
- **Mock-up:** [color-studio/index.html](color-studio/index.html) renders every candidate with Material UI components in light and dark. Its screens are Today, Health, Telemetry dashboard, Components and Tokens. The logic lives in [color-studio/studio.jsx](color-studio/studio.jsx).
- **How to open it:** the page loads React 18 and MUI 5 as UMD bundles from CDNs, plus the Inter font from Google Fonts. Open it in a browser with network access. It does not render from a text viewer or offline.
- **Scope:** the mock-up is a design aid. It is separate from the app (the app runs on MUI 9 with its own build) and is not imported by it.

## 2. What is wrong today

Source: `apps/web/src/theme/light.ts` and `dark.ts`.

| # | Finding | Effect |
|---|---|---|
| 1 | Light `primary.main` is the brand teal `#0f766e` (`THEME_COLOR` from `packages/shared`), but its `light` and `dark` tints are MUI default blues (`#42a5f5`, `#1565c0`). | Hover, focus and gradient states drift to blue next to a teal brand. |
| 2 | Secondary is purple `#9c27b0`, unrelated to the brand. | It has no job in the product: it marks neither AI content nor training effort. |
| 3 | Dark primary is the MUI default light blue `#90caf9`. | The brand teal disappears in dark mode. |
| 4 | Dark surfaces are `#121212` and `#1e1e1e` with pure white text. | Neutral grey with maximum-contrast text is harsh for long reading and has no brand tint. |
| 5 | Charts (telemetry `MetricSeriesChart`) cycle primary, secondary, warning, success, error, info, grey. | Series colours double as status colours, so a plain line can read as "error" or "success". |

The telemetry dashboard already pairs severity colours with an icon and a word. That rule stays.

## 3. Design principles for the palette

Derived from [VISION.md](../../VISION.md): the product is a "Personal Health Operating System" built on the loop Measure, Understand, Plan, Act, Track, Reassess. Its principles include provenance as a first-class concept, AI proposes and the user controls, uncertainty stays visible, and the interface stays calm.

| Principle | Rule for the palette |
|---|---|
| Calm clinical trust | Low-chroma tinted neutrals for surfaces. No pure black, no pure white text in dark mode. |
| One brand hue | Primary carries navigation and primary actions only. |
| Warm effort accent | A warm secondary is reserved for training and effort content. |
| Distinct AI accent | A tertiary hue marks AI-proposed content, so it is always distinguishable from user-entered and measured data. |
| Reserved status colours | Success, warning, error and info are never reused as chart series and never appear without an icon or a word. |
| Neutral provenance | Provenance chips are neutral and outlined, so they inform without competing with data. |
| Designed dark mode | Dark mode uses its own desaturated accents and tinted surfaces. It is not an inversion of light. |
| Colour-vision safe charts | Series colours are validated for colour-vision deficiency in both modes. |

## 4. The four candidates

Values are light / dark unless stated. Chart series are listed in assignment order.

| | A. Tidal Teal (recommended) | B. Indigo Clinic | C. Evergreen Path | D. Graphite Pulse |
|---|---|---|---|---|
| **Idea** | Keep the brand teal, add coral for effort and violet for AI. | Lab-grade indigo with navy dark mode. | Warm, growth-and-path story in greens and stone. | Performance energy: graphite with an orange spark. |
| **Primary** | `#0F766E` / `#4FCDBC` | `#4338CA` / `#A5A8F6` | `#1E6E47` / `#7FD39B` | `#BA3E0A` / `#FF8A4C` |
| **Primary container** | `#CCF0EA` / `#0F4F49` | `#E1E1FB` / `#33358A` | `#D2EFDC` / `#1C5236` | `#FFE1D2` / `#6B2B0C` |
| **Secondary** | Coral `#B8441F` / `#F0906E` | Cyan `#0E7490` / `#5CD3E6` | Ochre `#8F6410` / `#E3B657` | Sky `#0B6AA6` / `#6FB9F0` |
| **Tertiary** | Violet `#4F49C4` / `#B4ABF4` | Coral `#C2410C` / `#F29572` | Plum `#7A3E8E` / `#D1A3E0` | Lime `#4D7C0F` / `#A6D45E` |
| **Light bg / paper** | `#F2F7F6` / `#FFFFFF` | `#F4F5FB` / `#FFFFFF` | Warm stone `#F6F5F0` / `#FFFDF9` | `#F5F5F4` / `#FFFFFF` |
| **Dark bg / paper** | `#0B1413` / `#122020` | `#0B1020` / `#121936` | `#101410` / `#171C17` | `#0B0B0C` / `#151517` |
| **Chart, light** | `#0d9488 #d97706 #4f46e5 #db2777 #0284c7 #65a30d` | `#4f46e5 #eb6834 #0891b2 #d99a00 #e0479a #008300` | `#1f8a4c #7e3f8f #b7791f #0369a1 #c2410c #0e8fa3` | `#ea580c #0284c7 #65a30d #db2777 #7c3aed #0d9488` |
| **Chart, dark** | `#1fa396 #c98500 #9085e9 #d55181 #3987e5 #6f9a1a` | `#9085e9 #d95926 #1f9ea8 #c98500 #d55181 #008300` | `#3a9f62 #9f80cf #c98500 #3987e5 #d95926 #1f9ea8` | `#d95926 #3987e5 #6a9a1f #d55181 #9085e9 #1f9e92` |
| **Strengths** | Continuity with the existing brand, icons and manifest. Clinical calm. Best for long reading and dense dashboards. | Lab-grade look, closest to Apple Health and Oura. Dark navy flatters charts. | Warm "growth and path" story. | Performance energy in the Whoop and Strava mould. |
| **Risks** | Teal is common in health apps. Differentiation comes from the coral and violet system and from typography, not the hue. | Full rebrand (icons, manifest `theme_color`). Indigo reads "SaaS admin". The yellow chart slot needs direct labels in light mode. | Brand green and success green share a hue, so "good" status loses meaning. Warm neutrals fight the cool telemetry charts. | Orange primary collides with warning semantics. Loud for medical content. Weakest for a provenance-heavy, long-reading product. |

### Candidate A in full

| Role | Light | Dark |
|---|---|---|
| Background | `#F2F7F6` | `#0B1413` |
| Paper | `#FFFFFF` | `#122020` |
| Surface container 1 | `#E7EFEE` | `#192B2A` |
| Surface container 2 | `#DBE6E5` | `#213634` |
| Text primary | `#0E1F1D` | `#E3EEEC` |
| Text secondary | `#4A605D` | `#9CB2AE` |

### Shared status colours

All four candidates use the same status set. Each is always shown with an icon or a word.

| Status | Light | Dark |
|---|---|---|
| Success | `#1B7F4A` | `#62C68E` |
| Warning | `#9C5A00` | `#E6B452` |
| Error | `#B42318` | `#F28B82` |
| Info | `#0B6AA6` | `#7DB9EE` |

## 5. Validation done

| Check | Scope | Target |
|---|---|---|
| Colour-vision-deficiency validator | Every candidate's chart series, light and dark | Adjacent pairs simulated with the Machado 2009 model, OKLab ΔE of at least 8 |
| Normal-vision separation | Same series | ΔE of at least 15 |
| Series against surface | Same series | At least 3:1 contrast |
| WCAG contrast, live | Tokens tab of the mock-up, per candidate and mode | Primary on paper, on-primary, body and secondary text, status on paper, outline 3:1 |

- All candidates passed the validator in both modes. The yellow slot in Indigo Clinic light relies on direct labels, as the validator notes.
- The Tokens tab recomputes the WCAG ratios in the browser. Open it to check any value.

## 6. Recommendation

Adopt **A. Tidal Teal**.

- **Continuity:** the brand teal already drives the icons, the manifest and `THEME_COLOR`. A keeps all of them, so there is no rebrand and no icon regeneration.
- **Calm:** a tinted teal-grey neutral set suits long reading of lab results and plans. It matches the "calm, not overwhelming" principle.
- **Dashboards:** the dark teal-black surfaces and the validated six-colour series keep dense telemetry and health charts legible.
- **Accents with jobs:** coral is the effort accent for training. Violet is the AI accent, so AI-proposed content is always distinguishable. Status colours stay reserved.
- **Dark mode:** the brand hue survives in dark mode as `#4FCDBC`, which fixes the disappearing teal.
- **Known risk:** teal is common in health apps. Distinctiveness comes from the coral and violet roles and from typography.

## 7. Implementation plan once decided

Applies to A. File the GitHub issue first, as [CLAUDE.md](../../CLAUDE.md) requires for a feature, before any worktree or branch exists.

| Step | Work | Owner |
|---|---|---|
| 1 | Move `apps/web/src/theme/` to `createTheme({ cssVariables: true, colorSchemes: { light, dark } })`. Replace the `lightTheme` and `darkTheme` pair and read the mode with `useColorScheme`. Keep `THEME_COLOR` from `packages/shared` as the light `primary.main`, as the comment in `light.ts` requires. | `frontend-dev` |
| 2 | Add palette extensions through module augmentation: `tertiary`, surface container levels and chart series. | `frontend-dev` |
| 3 | Add a chart palette helper. Replace the ad-hoc series list in the telemetry charts (`MetricSeriesChart.tsx`) so series never use status colours. | `frontend-dev` |
| 4 | Only if B, C or D is chosen: update `themeColor` and `backgroundColor` in `packages/shared/identity.json` and regenerate the icons. Skip for A. | `frontend-dev` |
| 5 | Add or update theme tests, then regenerate the visual baselines under `tests/visual/`. | `testing-dev` |
| 6 | Update this page to status "shipped" or move the final palette into the web theme documentation. List any new doc in [../README.md](../README.md). | `docs-dev` |

## Research basis

- **Material Design 3 colour roles:** primary, secondary and tertiary accents, their containers, and surface container levels. See m3.material.io/styles/color/roles.
- **Material dark-theme guidance:** desaturated accents around tone 80, no pure black surfaces, at least 4.5:1 text contrast. See m2.material.io/design/color/dark-theme.html.
- **MUI CSS theme variables:** `createTheme({ cssVariables: true, colorSchemes: { light, dark } })` with the `useColorScheme` hook. See mui.com/material-ui/customization/css-theme-variables/configuration/.
- **Category trend:** health and fitness apps favour dark-first dashboards with one high-energy accent. Whoop pairs near-black with red. Apple Health pairs white with blue. 2026 trend articles describe the same pattern.
