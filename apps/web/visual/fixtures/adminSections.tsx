/**
 * FROZEN admin settings registry for the visual regression harness — issue #222.
 *
 * DO NOT SYNC THIS FILE WITH `src/config/adminSections.tsx`. THAT IS THE POINT.
 *
 * `apps/web/visual/vite.config.ts` swaps every import of the live
 * `config/adminSections.tsx` for this module, so the hub, the Console rail and
 * the compact AppBar title resolver all draw THIS registry in the harness. The
 * pixel baselines under `tests/visual/specs/` then measure layout, theme and
 * breakpoints, and appending a card to the live `ADMIN_SECTIONS` moves none of
 * them. Before #222 every new card reflowed six baselines for a reason that had
 * nothing to do with what they test.
 *
 * Content is a snapshot of the live registry as of #222, kept whole so the
 * baselines did not move when the seam went in. It exercises what the specs
 * need: the six groups, a card whose permission the harness lacks (`Web Push`,
 * `Broadcasts`), feature-gated cards (`ai`, `telemetry`), a nested route
 * (`Job Insights` under `Jobs`, for the longest-prefix title rule), the
 * `Maintenance` card `hub-search` filters to, and `Users & Allowlist`, the only
 * card a `users:read`-only user keeps (`hub-permissions`, `drilldown-appbar`).
 *
 * Change this file only when a spec needs a different shape, and regenerate the
 * baselines that move in the same change. Never import `ADMIN_SECTIONS` (or any
 * value) from the live module here: `src/__tests__/visual/registryFixtures.test.ts`
 * fails if you do.
 */

import EmailOutlinedIcon from '@mui/icons-material/EmailOutlined';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';
import BuildCircleOutlinedIcon from '@mui/icons-material/BuildCircleOutlined';
import VpnKeyOutlinedIcon from '@mui/icons-material/VpnKeyOutlined';
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined';
import PeopleIcon from '@mui/icons-material/People';
import WorkHistoryOutlinedIcon from '@mui/icons-material/WorkHistoryOutlined';
import QueryStatsIcon from '@mui/icons-material/QueryStats';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import BackupOutlinedIcon from '@mui/icons-material/BackupOutlined';
import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import ModelTrainingOutlinedIcon from '@mui/icons-material/ModelTrainingOutlined';
import DataUsageOutlinedIcon from '@mui/icons-material/DataUsageOutlined';
import AltRouteOutlinedIcon from '@mui/icons-material/AltRouteOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import MonitorHeartOutlinedIcon from '@mui/icons-material/MonitorHeartOutlined';
import HealthAndSafetyOutlinedIcon from '@mui/icons-material/HealthAndSafetyOutlined';
import DeleteForeverOutlinedIcon from '@mui/icons-material/DeleteForeverOutlined';
import ChecklistOutlinedIcon from '@mui/icons-material/ChecklistOutlined';
import type { SettingsSectionDef } from '../../src/config/settingsRegistry';

// The REAL types and pure functions (`visibleSettingsSections`,
// `settingsPageTitle`, `isFeatureEnabled`): the harness fixes the data, never
// the logic that filters and titles it.
export * from '../../src/config/settingsRegistry';

export const ADMIN_SECTIONS: SettingsSectionDef[] = [
  {
    label: 'General',
    cards: [
      {
        title: 'Email',
        description:
          'Choose how the application sends email, and send a test message to prove it works.',
        Icon: EmailOutlinedIcon,
        path: '/admin/settings/email',
        permission: 'system_settings:read',
      },
      {
        title: 'Notifications',
        description:
          'Turn browser notifications on or off for everyone, and suppress individual events.',
        Icon: NotificationsActiveOutlinedIcon,
        path: '/admin/settings/notifications',
        permission: 'system_settings:read',
      },
      {
        title: 'Web Push',
        description:
          'Generate a VAPID key pair, enable or rotate it, and control whether this deployment can send browser push notifications.',
        Icon: VpnKeyOutlinedIcon,
        path: '/admin/settings/push',
        permission: 'push:read',
      },
      {
        title: 'Storage',
        description:
          'Point this deployment at an object store, prove the credentials work, and create the bucket if it is not there yet.',
        Icon: CloudOutlinedIcon,
        path: '/admin/settings/storage',
        permission: 'storage_config:read',
      },
      {
        title: 'Maintenance',
        description:
          'Take the application out of service for planned work, with a message for anyone who tries to use it.',
        Icon: BuildCircleOutlinedIcon,
        path: '/admin/settings/maintenance',
        permission: 'system_settings:read',
      },
      {
        title: 'Setup guide',
        description:
          'See what must be configured before people can use the app, check each step against the live configuration, and jump to where it is done.',
        Icon: ChecklistOutlinedIcon,
        path: '/admin/settings/setup',
        permission: 'system_settings:read',
      },
    ],
  },
  {
    label: 'Access',
    cards: [
      {
        title: 'Users & Allowlist',
        description: 'Manage user accounts and roles, and control who may sign in at all.',
        Icon: PeopleIcon,
        path: '/admin/settings/users',
        permission: 'users:read',
      },
    ],
  },
  {
    label: 'Operations',
    cards: [
      {
        title: 'Jobs',
        description:
          'Inspect the background queue, retry or remove individual jobs, and recover work that stalled.',
        Icon: WorkHistoryOutlinedIcon,
        path: '/admin/settings/jobs',
        permission: 'jobs:read',
      },
      {
        title: 'Job Insights',
        description:
          'See how long the queue takes, how fast it is moving, and when the outstanding work will be done.',
        Icon: QueryStatsIcon,
        path: '/admin/settings/jobs/insights',
        permission: 'jobs:read',
      },
      {
        title: 'Worker Nodes',
        description:
          'See which machines are attached to this deployment, what they are running, and whether they are healthy.',
        Icon: DnsOutlinedIcon,
        path: '/admin/settings/workers',
        permission: 'nodes:read',
      },
      {
        title: 'Database Backup',
        description:
          'Schedule backups, review what has been taken, and restore the database from one.',
        Icon: BackupOutlinedIcon,
        path: '/admin/settings/db-backup',
        permission: 'db_backup:read',
      },
      {
        title: 'Broadcasts',
        description:
          'Write an announcement and send it to every active user now or at a scheduled time, then watch it go out.',
        Icon: CampaignOutlinedIcon,
        path: '/admin/settings/broadcasts',
        permission: 'broadcasts:read',
      },
      {
        title: 'About',
        description:
          'See exactly what is deployed here: the version running, the commit it was built from, and when it was installed.',
        Icon: InfoOutlinedIcon,
        path: '/admin/settings/about',
        permission: 'system_settings:read',
      },
    ],
  },
  {
    label: 'AI',
    cards: [
      {
        title: 'AI',
        description:
          'Switch AI on for this deployment, choose whose keys pay for calls, and configure each provider.',
        Icon: AutoAwesomeOutlinedIcon,
        path: '/admin/settings/ai',
        permission: 'ai_config:read',
      },
      {
        title: 'AI Models',
        description:
          'Review the models each provider offers, classify what they can do, and choose which ones users may call.',
        Icon: ModelTrainingOutlinedIcon,
        path: '/admin/settings/ai/models',
        permission: 'ai_config:read',
        feature: 'ai',
      },
      {
        title: 'AI Usage',
        description:
          "See who is calling AI, which models they use, and how much of it the organization's key pays for.",
        Icon: DataUsageOutlinedIcon,
        path: '/admin/settings/ai/usage',
        permission: 'ai_config:read',
        feature: 'ai',
      },
      {
        title: 'AI Model Assignments',
        description:
          'Choose the AI model the organization uses by default and for each feature. Users do not choose models.',
        Icon: AltRouteOutlinedIcon,
        path: '/admin/settings/ai/assignments',
        permission: 'ai_config:read',
        feature: 'ai',
      },
    ],
  },
  {
    label: 'Observability',
    cards: [
      {
        title: 'Telemetry',
        description:
          'Turn telemetry collection on, choose how long it is kept, set query limits and configure the AI assistant.',
        Icon: InsightsOutlinedIcon,
        path: '/admin/settings/telemetry',
        permission: 'telemetry:read',
      },
      {
        title: 'Telemetry Explorer',
        description:
          'Query traces, logs and metrics with SQL, export the results, and ask the AI assistant for help.',
        Icon: TerminalOutlinedIcon,
        path: '/admin/settings/telemetry/explorer',
        permission: 'telemetry:query',
        feature: 'telemetry',
      },
      {
        title: 'Telemetry Dashboard',
        description:
          'See at a glance whether anything is wrong: error rate, latency, error logs and the top failing routes.',
        Icon: MonitorHeartOutlinedIcon,
        path: '/admin/settings/telemetry/dashboard',
        permission: 'telemetry:query',
        feature: 'telemetry',
      },
      {
        title: 'Doctor',
        description:
          'Check the configuration, connectivity and health of every capability, including telemetry capture.',
        Icon: HealthAndSafetyOutlinedIcon,
        path: '/admin/settings/doctor',
        permission: 'system_settings:read',
      },
    ],
  },
  {
    label: 'Danger Zone',
    cards: [
      {
        title: 'Factory reset',
        description:
          'Erase every user and all application data, returning this deployment to a fresh install.',
        Icon: DeleteForeverOutlinedIcon,
        path: '/admin/settings/factory-reset',
        permission: 'system:factory_reset',
      },
    ],
  },
];

export const ADMIN_HUB_PATH = '/admin/settings';
export const ADMIN_HUB_TITLE = 'Settings';
