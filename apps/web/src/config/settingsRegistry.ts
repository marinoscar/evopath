/**
 * The settings-registry MACHINERY, with no registry content: the card and
 * section types, the feature gate, and the two pure functions every consumer
 * runs over a registry (`visibleSettingsSections`, `settingsPageTitle`).
 *
 * Issue #222. Split out of `adminSections.tsx`, which re-exports all of it, so
 * existing imports are unchanged. It lives apart from the data so the visual
 * regression harness (`apps/web/visual/fixtures/`) can swap in a FROZEN
 * fixture registry while still running the real filtering and title logic:
 * a fixture that imported these from `adminSections.tsx` would drag the live
 * registry back in, which is exactly what the fixture exists to keep out.
 *
 * No data belongs in this file. A card goes in `adminSections.tsx` or
 * `userSettingsSections.tsx`.
 */

import type { SvgIconComponent } from '@mui/icons-material';

/**
 * One settings page, fully described for every surface that draws it.
 *
 * `permission` is the API permission string the corresponding controller
 * ALREADY enforces — this registry never invents a permission, it mirrors one.
 * A card with no `permission` is visible to every authenticated user, which is
 * the normal case for the per-user registry in `userSettingsSections.tsx`.
 */
export interface SettingsCardDef {
  title: string;
  description: string;
  /**
   * The icon COMPONENT. Consumers render it themselves so each can pick its
   * own size — see `adminSections.tsx`'s file header.
   */
  Icon: SvgIconComponent;
  /** Route the card navigates to. Absent means "declared but not yet routed". */
  path?: string;
  /** Rendered, but inert — for a page that exists in the IA but is not usable yet. */
  disabled?: boolean;
  /** API permission required to see the card at all; absent means "any authenticated user". */
  permission?: string;
  /**
   * Escape hatch: show the card even when `permission` is not held. Reserved
   * for pages that gate their own CONTENT internally and are still worth
   * reaching — the same distinction `destinations.ts` draws between a
   * REACHABILITY gate and a content gate.
   */
  alwaysShow?: boolean;
  /**
   * A deployment-wide FEATURE this card only exists under (issue #425, epic
   * #419). Absent means "always part of the IA". Present means the card is
   * hidden unless the caller's feature map says that feature is on —
   * `features[feature] === true`, so an omitted map (every caller that
   * predates this field) hides it too, failing closed.
   *
   * A third axis, orthogonal to `permission`: permission asks "may THIS USER
   * see it?", `feature` asks "does it exist in THIS DEPLOYMENT right now?".
   * The `AI Models` card needs both — `ai_config:read` AND AI switched on —
   * while the `AI` card itself deliberately carries no `feature`, because it
   * is the page an administrator switches AI on from.
   *
   * Applied BEFORE `alwaysShow`: a feature that is off means the page is not
   * there to reach, which no content-gating escape hatch can change.
   */
  feature?: SettingsFeatureKey;
}

/**
 * The deployment features a card may be gated on: `ai` (#425) and `telemetry`
 * (#537 — a telemetry store is deployed AND collection is switched on).
 */
export type SettingsFeatureKey = 'ai' | 'telemetry';

/**
 * Which features are on, as `visibleSettingsSections` / `settingsPageTitle` /
 * `isDestinationVisible` read it. Partial: a missing key is "off".
 */
export type SettingsFeatures = Partial<Record<SettingsFeatureKey, boolean>>;

/**
 * Whether a card's `feature` gate (if any) is open under `features`. Exported
 * so every consumer asks the same question the same way.
 */
export function isFeatureEnabled(
  feature: SettingsFeatureKey | undefined,
  features: SettingsFeatures = {},
): boolean {
  return feature === undefined || features[feature] === true;
}

/** A titled group of cards — an `overline` header on the hub, a `ListSubheader` in the rail. */
export interface SettingsSectionDef {
  label: string;
  cards: SettingsCardDef[];
}

/**
 * Filter `sections` to what `hasPermission` allows, optionally also applying
 * the client-side "Search settings" filter, and drop any section left empty.
 *
 * Every consumer runs THIS function rather than its own loop, which is what
 * makes success criterion 6 of epic #90 testable with a single assertion: a
 * card whose permission the user lacks can appear in the hub, the rail, and
 * the title resolver only if it appears in all three, and it appears in none.
 *
 * An empty section is dropped rather than rendered as a bare header, because a
 * group header above nothing reads as a loading failure, not as "you may see
 * none of these".
 *
 * `sections` is a PARAMETER rather than a closure over `ADMIN_SECTIONS`
 * deliberately: issue #96 reuses this function verbatim for the user-settings
 * registry, and a second near-identical copy of the gate is exactly the drift
 * this file exists to prevent.
 *
 * `query` matches the card TITLE only, case-insensitively, and never the
 * description. Matching descriptions too would mean a two-letter query
 * surfacing eight cards because their prose happens to share a word — a worse
 * result set than a strict title match, and one the user cannot predict.
 *
 * `features` (#425) is the deployment feature map a card's `feature` field is
 * checked against. Optional and fail-closed: a caller that passes none hides
 * every feature-gated card, so no pre-existing caller can surface one by
 * accident.
 */
export function visibleSettingsSections(
  sections: SettingsSectionDef[],
  hasPermission: (permission: string) => boolean,
  query = '',
  features: SettingsFeatures = {},
): SettingsSectionDef[] {
  const needle = query.trim().toLowerCase();
  return sections
    .map((section) => ({
      label: section.label,
      cards: section.cards.filter((card) => {
        if (!isFeatureEnabled(card.feature, features)) return false;
        if (needle && !card.title.toLowerCase().includes(needle)) return false;
        if (card.alwaysShow) return true;
        if (!card.permission) return true;
        return hasPermission(card.permission);
      }),
    }))
    .filter((section) => section.cards.length > 0);
}

/**
 * Resolve a pathname to the human title of the page it renders, for the
 * compact drill-down AppBar (#95).
 *
 * LONGEST PREFIX WINS, the same rule `resolveActiveDestination` uses in
 * `destinations.ts`, and it earns its keep the moment a card's route nests:
 * `/admin/settings/users/:id` must resolve to "Users & Allowlist" rather than
 * falling back to the hub title, and a future `/admin/settings/storage/insights`
 * must beat a `/admin/settings/storage` sibling instead of losing to whichever
 * happened to be declared first.
 *
 * Matching respects segment boundaries — `path === pathname` or
 * `pathname` continuing with a `/` — so `/admin/settings/users` does not claim
 * `/admin/settings/users-archive`. A bare `startsWith` is the bug
 * `destinations.ts`'s `owns()` was written to kill.
 *
 * Returns `null` when the path is not under `hubPath` at all. That is the
 * signal the AppBar uses to keep its normal toolbar: a `null` means "this is
 * not a settings surface", which is a different answer from "this is the
 * surface's own hub" (`hubTitle`), and collapsing the two would put a back
 * arrow on every page in the app.
 *
 * `sections`, `hubPath` and `hubTitle` are parameters for the same reason
 * `visibleSettingsSections` takes `sections`: #96 calls this with the user
 * registry and `/settings`.
 *
 * `features` applies the same `feature` gate the hub does (#425): a card whose
 * feature is off does not exist, so it cannot title a page — the path falls
 * back to its next-longest owner or the hub title, exactly as an unregistered
 * path would. Permission is deliberately NOT applied here, as before: a route
 * the user reached is titled whatever its gate said.
 */
export function settingsPageTitle(
  sections: SettingsSectionDef[],
  hubPath: string,
  hubTitle: string,
  pathname: string,
  features: SettingsFeatures = {},
): string | null {
  if (pathname !== hubPath && !pathname.startsWith(`${hubPath}/`)) return null;

  let best: { title: string; length: number } | null = null;
  for (const section of sections) {
    for (const card of section.cards) {
      if (!card.path) continue;
      if (!isFeatureEnabled(card.feature, features)) continue;
      const matches = pathname === card.path || pathname.startsWith(`${card.path}/`);
      if (matches && (!best || card.path.length > best.length)) {
        best = { title: card.title, length: card.path.length };
      }
    }
  }

  return best?.title ?? hubTitle;
}
