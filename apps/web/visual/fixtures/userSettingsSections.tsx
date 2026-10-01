/**
 * FROZEN per-user settings registry for the visual regression harness — issue #222.
 *
 * DO NOT SYNC THIS FILE WITH `src/config/userSettingsSections.tsx`. THAT IS THE POINT.
 *
 * `apps/web/visual/vite.config.ts` swaps every import of the live
 * `config/userSettingsSections.tsx` for this module, so `/settings` and the
 * compact AppBar title resolver draw THIS registry in the harness, and
 * appending a card to the live `USER_SETTINGS_SECTIONS` moves no baseline.
 *
 * Content is a snapshot of the live registry as of #222, kept whole so the
 * baselines did not move when the seam went in: five groups, `Profile` and
 * `Access Tokens` (asserted by `user-hub.spec.ts`), a `permission`-gated card
 * (`Health Profile`) and two `feature: 'ai'` cards hidden while AI is off.
 *
 * Change it only when a spec needs a different shape, and regenerate the
 * baselines that move in the same change. Never import a value from the live
 * module: `src/__tests__/visual/registryFixtures.test.ts` fails if you do.
 */

import PersonIcon from '@mui/icons-material/Person';
import PaletteIcon from '@mui/icons-material/Palette';
import NotificationsIcon from '@mui/icons-material/Notifications';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart';
import PsychologyIcon from '@mui/icons-material/Psychology';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import type { SettingsSectionDef } from '../../src/config/settingsRegistry';

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
    ],
  },
  {
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
    ],
  },
  {
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

export const USER_HUB_PATH = '/settings';
export const USER_HUB_TITLE = 'Settings';
