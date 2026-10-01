/**
 * FROZEN Today card registry for the visual regression harness — issue #222.
 *
 * DO NOT SYNC THIS FILE WITH `src/config/todayCards.tsx`. THAT IS THE POINT.
 *
 * `apps/web/visual/vite.config.ts` swaps every import of the live
 * `config/todayCards.tsx` for this module, so the Today page in the harness
 * draws THIS list, and adding a card to the live `TODAY_CARDS` moves neither
 * `today-page` baseline.
 *
 * The cards render the REAL `Content` and `Gate` components (the data comes
 * from the `page.route()` mocks in `tests/visual/support/`): only WHICH cards
 * exist, and their copy, are frozen here. Content is a snapshot of the live
 * list as of #222, kept whole so the baselines did not move when the seam went
 * in. The two onboarding cards keep their `Gate`, which renders nothing in the
 * harness exactly as it does in the app for a user with nothing left to do.
 *
 * Change it only when a spec needs a different shape, and regenerate the
 * baselines that move in the same change. The `import type` below is erased at
 * build time; importing a VALUE from the live module is what
 * `src/__tests__/visual/registryFixtures.test.ts` forbids.
 */

import FitnessCenterIcon from '@mui/icons-material/FitnessCenter';
import BatteryChargingFullIcon from '@mui/icons-material/BatteryChargingFull';
import MonitorWeightIcon from '@mui/icons-material/MonitorWeight';
import PlaceIcon from '@mui/icons-material/Place';
import ChecklistIcon from '@mui/icons-material/Checklist';
import RocketLaunchOutlinedIcon from '@mui/icons-material/RocketLaunchOutlined';
import type { TodayCardDef } from '../../src/config/todayCards';
import { TodayBodySnapshot } from '../../src/components/today/TodayBodySnapshot';
import { TodayReadiness } from '../../src/components/today/TodayReadiness';
import { TodayGym } from '../../src/components/today/TodayGym';
import { TodayWorkout } from '../../src/components/today/TodayWorkout';
import {
  AdminSetupGate,
  GetStartedGate,
  TodayAdminSetup,
  TodayGetStarted,
} from '../../src/components/today/TodayOnboarding';

export type { TodayCardDef };

export const TODAY_CARDS: readonly TodayCardDef[] = [
  {
    key: 'adminSetup',
    title: 'Set up the app',
    description: 'What must be configured before people can use the app.',
    Icon: RocketLaunchOutlinedIcon,
    to: '/admin/settings/setup',
    linkLabel: 'Open setup guide',
    area: 'programs',
    Content: TodayAdminSetup,
    Gate: AdminSetupGate,
  },
  {
    key: 'getStarted',
    title: 'Get started',
    description: 'A few first steps to get the most out of the app.',
    Icon: ChecklistIcon,
    to: '/settings',
    linkLabel: 'Open Settings',
    area: 'programs',
    Content: TodayGetStarted,
    Gate: GetStartedGate,
  },
  {
    key: 'workout',
    title: "Today's workout",
    description: 'Your planned session, ready to start.',
    Icon: FitnessCenterIcon,
    to: '/train',
    linkLabel: 'Open Train',
    area: 'programs',
    Content: TodayWorkout,
  },
  {
    key: 'readiness',
    title: 'Readiness',
    description: 'How you feel today: energy, sleep, soreness and stress.',
    Icon: BatteryChargingFullIcon,
    to: '/health',
    linkLabel: 'Open Health',
    area: 'health',
    Content: TodayReadiness,
  },
  {
    key: 'body',
    title: 'Body snapshot',
    description: 'Your latest weight, body fat and waist.',
    Icon: MonitorWeightIcon,
    to: '/health',
    linkLabel: 'Open Health',
    area: 'health',
    Content: TodayBodySnapshot,
  },
  {
    key: 'gym',
    title: 'Your gym',
    description: 'Where you train and what is available there.',
    Icon: PlaceIcon,
    to: '/gyms',
    linkLabel: 'Open Gyms',
    area: 'gyms',
    Content: TodayGym,
  },
];

