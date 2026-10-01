/**
 * The per-user settings information architecture — the same registry shape as
 * `adminSections.tsx`, for the `/settings` surface.
 *
 * Issue #91, epic #90. `/settings` is today one page stacking three cards
 * (Theme, Profile, Personal Access Tokens). Epic #90 splits it into routed
 * destinations behind the same searchable hub the admin console gets (#96), so
 * it needs the same thing the console needs: ONE declaration read by the hub,
 * the AppBar's title resolver, and anything else that later wants to draw the
 * surface.
 *
 * This file deliberately declares only DATA. The `SettingsCardDef` /
 * `SettingsSectionDef` types and both helpers
 * (`visibleSettingsSections`, `settingsPageTitle`) are imported from
 * `adminSections.tsx` and re-used verbatim — which is precisely why those
 * helpers take `sections`, `hubPath` and `hubTitle` as parameters instead of
 * closing over the admin constants. Two copies of the permission gate is the
 * drift the registry exists to prevent, and copying it here to serve a second
 * surface would reintroduce it on day one.
 */

import PersonIcon from '@mui/icons-material/Person';
import PaletteIcon from '@mui/icons-material/Palette';
import NotificationsIcon from '@mui/icons-material/Notifications';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart';
import DescriptionIcon from '@mui/icons-material/Description';
import PsychologyIcon from '@mui/icons-material/Psychology';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import SportsOutlinedIcon from '@mui/icons-material/SportsOutlined';
import PhoneAndroidIcon from '@mui/icons-material/PhoneAndroid';
import AndroidIcon from '@mui/icons-material/Android';
import type { SettingsSectionDef } from './adminSections';

/**
 * The user settings sections, in hub order.
 *
 * NO CARD DECLARES A `permission`, and that is the correct model rather than
 * an omission: every authenticated user owns their own settings, and the API
 * grants `user_settings:read` / `user_settings:write` to all three roles
 * (Admin, Contributor, Viewer). Adding a gate here would be inventing an
 * authorization rule the API does not enforce — the opposite of what this
 * registry is for. `visibleSettingsSections` is still the function the hub
 * calls, so search filtering and empty-section collapsing behave identically
 * to the admin surface; the permission half of the gate simply passes
 * everything through.
 *
 * Access Tokens sits under its own `Security` group rather than under
 * `Account` because a PAT is a long-lived credential: grouping it with display
 * name and theme would put "create a bearer token that outlives your session"
 * one row below "pick a colour scheme".
 */
export const USER_SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    label: 'Account',
    cards: [
      {
        title: 'Profile',
        description: 'Your display name and profile image, and the email you signed in with.',
        Icon: PersonIcon,
        path: '/settings/profile',
      },
      {
        title: 'Appearance',
        description: 'Choose a light, dark, or system-matched theme for this account.',
        Icon: PaletteIcon,
        path: '/settings/appearance',
      },
      {
        // Issue #126, epic #109. NO `permission`, like every card here: the
        // page edits the caller's OWN preferences through
        // `PATCH /api/user-settings`, which the API grants to all three roles,
        // and the registry it renders (`GET /api/notifications/events`) is
        // `@Auth()` with no permissions for exactly that reason — gating this
        // card would leave a Viewer unable to say how they are contacted.
        //
        // Under `Account` rather than `Security`, even though one of the events
        // it lists is a security alert: the card is about how this account is
        // contacted, not about credentials. `Security` holds long-lived
        // credentials (see the group's own note below).
        title: 'Notifications',
        description:
          'Choose which events notify you, and whether they arrive by email or in your browser.',
        Icon: NotificationsIcon,
        path: '/settings/notifications',
      },
    ],
  },
  {
    label: 'Security',
    cards: [
      {
        title: 'Access Tokens',
        description: 'Create and revoke personal access tokens for API and CLI access.',
        Icon: VpnKeyIcon,
        path: '/settings/tokens',
      },
      {
        // Issue #425, epic #419. THE FIRST USER CARD WITH A PERMISSION, and
        // deliberately so. Every other card here edits something the API grants
        // all three roles; `ai:use` is a real grant a deployment can withhold
        // from a role (AI costs money per call), and the `/api/ai/keys`
        // controller enforces exactly this string (`PERMISSIONS.AI_USE`). A card
        // without it would show a Viewer a page whose every call 403s.
        //
        // `feature: 'ai'` hides it while AI is switched off. Security, not
        // Account: a provider API key is a credential, like an access token.
        title: 'AI Keys',
        description:
          'Add your own API key for each AI provider, check it works, and see which models it can reach.',
        Icon: KeyOutlinedIcon,
        path: '/settings/ai',
        permission: 'ai:use',
        feature: 'ai',
      },
    ],
  },
  {
    // Issue #47 (E2.1). A new group, appended after `Security`. Health data is
    // its own class of data with its own grant: `health_data:read` is the exact
    // string `GET /api/health-profile` enforces, and a deployment can withhold
    // it from a role without also blocking theme changes. Writes are gated
    // inside the page on `health_data:write`, not by a second card.
    label: 'Health',
    cards: [
      {
        title: 'Health Profile',
        description:
          'Date of birth, sex at birth, height, units and time zone, used to interpret your measurements.',
        Icon: MonitorHeartIcon,
        path: '/settings/health-profile',
        permission: 'health_data:read',
      },
      {
        // Issue #190 (H6). Appended after Health Profile, and its own
        // destination rather than a tab on it: the profile is one row the user
        // edits, this is a list of files the user owns. `health_data:read` is
        // the exact string every read route of `health-documents.controller.ts`
        // enforces; rename and delete need `health_data:write`, gated inside
        // the page, not by a second card.
        title: 'Health Documents',
        description:
          'View, download, rename and delete the photos and reports you uploaded for your health record.',
        Icon: DescriptionIcon,
        path: '/settings/health-documents',
        permission: 'health_data:read',
      },
      {
        // Issue #283, epic #276. APPENDED after Health Documents. The phones
        // that sync Health Connect activity into activity goals. `goals:read`
        // is the exact string every read route of the health-sync controller
        // enforces (`GET /api/health-sync/devices*`); Unpair needs
        // `goals:write`, gated inside the page, not by a second card. Under
        // `Health` rather than `Security`: the page is about where health
        // activity comes from, even though unpairing revokes a token.
        title: 'Connected devices',
        description:
          'Phones that sync your steps, walks and runs from Health Connect: sync history, diagnostics and unpairing.',
        Icon: PhoneAndroidIcon,
        path: '/settings/connected-devices',
        permission: 'goals:read',
      },
      {
        // Issue #287, epic #276. APPENDED after Connected devices. Download
        // the APK this server hosts and see whether the installed build is
        // current. NO permission, deliberately: the latest-release and
        // download-link routes are `@Auth()` with no permission string, so
        // every signed-in user may install the app. Under `Health` next to
        // Connected devices because the app exists to sync health activity.
        title: 'Android app',
        description: 'Download and install the Android app, check for updates and verify the file.',
        Icon: AndroidIcon,
        path: '/settings/android-app',
      },
    ],
  },
  {
    // A new group, appended after `Health`. `ai:use` is the exact string the
    // `/api/ai/training` controller (and `/api/ai/keys`) enforces, and
    // `feature: 'ai'` hides the card while AI is switched off. Its own group
    // rather than under `Security`: it holds no credential. Models are an
    // administrator's choice (#173); the page shows them read-only.
    label: 'AI',
    cards: [
      {
        title: 'Training agents',
        description:
          'See the model each training-plan agent uses, and cap what a run may spend.',
        Icon: PsychologyIcon,
        path: '/settings/ai/agents',
        permission: 'ai:use',
        feature: 'ai',
      },
      {
        // E7.3 (#243). APPENDED to the AI group. `ai:use` is the exact string
        // `coach-settings.controller.ts` enforces on `GET`/`PUT
        // /api/coach/settings` and `GET /api/coach/personas`, all behind
        // `AiEnabledGuard`, so `feature: 'ai'` hides the card while AI is off
        // (CLAUDE.md AI Platform Rule 5). Its own path, not under
        // `/settings/ai`: the coach is a feature that uses AI, not AI setup.
        title: 'Coach',
        description:
          'Choose your coach persona and intensity, when it may message you, and whether it speaks.',
        Icon: SportsOutlinedIcon,
        path: '/settings/coach',
        permission: 'ai:use',
        feature: 'ai',
      },
    ],
  },
  {
    // Issue #202. A new group, appended LAST (append, never insert) so the
    // one irreversible action on this surface sits below everything else.
    // NO `permission`: every user owns their own data, and
    // `/api/user-data/*` enforces `user_settings:write`, which the API grants
    // to all three roles. No `feature` either — a reset also deletes AI keys
    // and runs, and must stay reachable while AI is switched off.
    label: 'Danger Zone',
    cards: [
      {
        title: 'Delete all my data',
        description:
          'Factory reset: permanently delete your workouts, programs, health data, photos and keys.',
        Icon: DeleteForeverIcon,
        path: '/settings/danger-zone',
      },
    ],
  },
];

/**
 * The user settings hub — the one `/settings` route that owns no card.
 *
 * `USER_HUB_TITLE` is intentionally the same string as `ADMIN_HUB_TITLE`
 * ('Settings'): the two surfaces are never on screen at once, the path
 * disambiguates them for the title resolver, and calling this one "My
 * Settings" in the AppBar would be the only place in the app that names it
 * that way.
 */
export const USER_HUB_PATH = '/settings';
export const USER_HUB_TITLE = 'Settings';
