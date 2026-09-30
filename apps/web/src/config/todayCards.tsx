import type { ComponentType } from 'react';
import type { SvgIconComponent } from '@mui/icons-material';
import FitnessCenterIcon from '@mui/icons-material/FitnessCenter';
import BatteryChargingFullIcon from '@mui/icons-material/BatteryChargingFull';
import MonitorWeightIcon from '@mui/icons-material/MonitorWeight';
import PlaceIcon from '@mui/icons-material/Place';
import type { RoadmapArea } from './roadmap';
import { TodayBodySnapshot } from '../components/today/TodayBodySnapshot';
import { TodayReadiness } from '../components/today/TodayReadiness';
import { TodayGym } from '../components/today/TodayGym';
import { TodayWorkout } from '../components/today/TodayWorkout';

/**
 * Cards on the Today page. Append-only order: workout, readiness, body, gym.
 * The epic that builds a card sets its `Content`; the page itself never changes.
 */
export interface TodayCardDef {
  key: 'workout' | 'readiness' | 'body' | 'gym';
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
}

export const TODAY_CARDS: readonly TodayCardDef[] = [
  {
    key: 'workout',
    title: "Today's workout",
    description: 'Your planned session, ready to start.',
    Icon: FitnessCenterIcon,
    to: '/train',
    linkLabel: 'Open Train',
    area: 'programs',
    // E4.6: Start or Resume a workout, the last workout and this week's count.
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
];
