import type { ComponentType, ReactNode } from 'react';
import type { SvgIconComponent } from '@mui/icons-material';
import FitnessCenterIcon from '@mui/icons-material/FitnessCenter';
import BatteryChargingFullIcon from '@mui/icons-material/BatteryChargingFull';
import MonitorWeightIcon from '@mui/icons-material/MonitorWeight';
import PlaceIcon from '@mui/icons-material/Place';
import ChecklistIcon from '@mui/icons-material/Checklist';
import RocketLaunchOutlinedIcon from '@mui/icons-material/RocketLaunchOutlined';
import SportsIcon from '@mui/icons-material/Sports';
import type { RoadmapArea } from './roadmap';
import { TodayBodySnapshot } from '../components/today/TodayBodySnapshot';
import { TodayReadiness } from '../components/today/TodayReadiness';
import { TodayGym } from '../components/today/TodayGym';
import { TodayWorkout } from '../components/today/TodayWorkout';
import {
  AdminSetupGate,
  GetStartedGate,
  TodayAdminSetup,
  TodayGetStarted,
} from '../components/today/TodayOnboarding';
import { CoachGate, TodayCoach } from '../components/today/TodayCoach';

/**
 * Cards on the Today page. Append-only order: workout, readiness, body, gym,
 * coach (E7.8, #248).
 * The epic that builds a card sets its `Content`; the page itself never changes.
 *
 * Issue #203 put the two onboarding cards (`adminSetup`, `getStarted`) at the
 * TOP, deliberately: they are the first thing a new account should see, and
 * they disappear for good once their steps are done or dismissed. Each carries
 * a `Gate` so it renders nothing (not even an empty grid cell) when it does
 * not apply.
 */
export interface TodayCardDef {
  key: 'adminSetup' | 'getStarted' | 'workout' | 'readiness' | 'body' | 'gym' | 'coach';
  title: string;
  description: string;
  Icon: SvgIconComponent;
  /** A route owned by a destination. */
  to: string;
  /** e.g. "Open Train". */
  linkLabel: string;
  area: RoadmapArea;
  /** Set by the epic that builds the card; replaces the placeholder body. */
  Content?: ComponentType;
  /**
   * Renders `children` (the whole card, grid cell included) only when the card
   * applies to this user right now, and nothing otherwise. Absent ⇒ always shown.
   */
  Gate?: ComponentType<{ children: ReactNode }>;
}

export const TODAY_CARDS: readonly TodayCardDef[] = [
  {
    key: 'adminSetup',
    title: 'Set up the app',
    description: 'What must be configured before people can use the app.',
    Icon: RocketLaunchOutlinedIcon,
    to: '/admin/settings/setup',
    linkLabel: 'Open setup guide',
    area: 'programs',
    // #203: shown to `system_settings:read` holders until every required step is done.
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
    // #203: the user checklist, until every step is done or it is dismissed.
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
    // E4.6: Start or Resume a workout, the last workout and this week's count.
    // E5.7: the active plan's session for today (TodayPlanCard) comes first.
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
    // E2.4 (#56): today's check-in scores, and the check-in dialog.
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
    // E2.3 (#53): the latest weight, body fat and waist, and quick entry.
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
    // E3.3: the default gym's name and equipment count, or "Add your gym".
    Content: TodayGym,
  },
  {
    // E7.8 (#248): appended. This week's target and the streak, shown only
    // while the coach is visible to the user (`ai:use` AND AI on).
    key: 'coach',
    title: 'Coach',
    description: 'Your accountability coach: nudges, cheers and a weekly review.',
    Icon: SportsIcon,
    to: '/coach',
    linkLabel: 'Open Coach',
    area: 'programs',
    Content: TodayCoach,
    Gate: CoachGate,
  },
];
