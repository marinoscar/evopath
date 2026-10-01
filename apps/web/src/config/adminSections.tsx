/**
 * The admin (Console) settings information architecture — ONE declaration,
 * three consumers.
 *
 * Issue #91, epic #90. The admin surface used to be two tab-strip pages
 * (`SystemSettingsPage` with three tabs, `UserManagementPage` with two) plus a
 * separate list of rail destinations in `config/destinations.ts`. That is the
 * same shape of mistake issue #55 already fixed once for library navigation:
 * when the page, the menu, and the rail each keep their own list of what
 * exists and who may see it, three gates give three answers, and a user ends
 * up with a reachable page, a menu entry pointing at it, and no rail row.
 *
 * So the IA is declared here exactly once and read by:
 *
 *   1. `SettingsHubPage`            — the card grid, and the phone drill-down
 *   2. `NavigationRail` Console mode — the rail's contents on any `/admin/*`
 *   3. `AppBar`                      — resolving an admin route to its title
 *
 * "Console mode invents no new admin IA" is enforced structurally rather than
 * by convention: there is one array, so a card added here appears in all three
 * surfaces, and none of them can drift from the others.
 *
 * `Icon` is declared as a COMPONENT, never as a rendered element — exactly as
 * `config/destinations.ts` does, and for the same reason. The hub draws it at
 * 40px and the rail at ~20px, so the size cannot be baked in at declaration
 * time. Storing `<AdminIcon />` here would freeze it at the default size and
 * make every consumer clone the element to resize it.
 *
 * Why `.tsx` when the file holds no JSX: the icon values are React component
 * types, and keeping the extension consistent with the rest of the config
 * surface means adding a rendered fallback later is not a file rename.
 */

import type { SettingsSectionDef } from './settingsRegistry';
import EmailOutlinedIcon from '@mui/icons-material/EmailOutlined';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';
import BuildCircleOutlinedIcon from '@mui/icons-material/BuildCircleOutlined';
import VpnKeyOutlinedIcon from '@mui/icons-material/VpnKeyOutlined';
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined';
import PeopleIcon from '@mui/icons-material/People';
// Operations (#266, epic #254). One icon per card, including the two cards
// whose pages land in later issues — the card is declared now, so its icon is
// declared now; see the `Operations` section's own header.
import WorkHistoryOutlinedIcon from '@mui/icons-material/WorkHistoryOutlined';
import QueryStatsIcon from '@mui/icons-material/QueryStats';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import BackupOutlinedIcon from '@mui/icons-material/BackupOutlined';
// Broadcasts (#325, epic #319) — the one Operations card that is not a view
// onto machinery, but an action taken through it.
import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
// About (#401, epic #397) — the running system's own identity: which commit,
// which version, installed when.
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import ModelTrainingOutlinedIcon from '@mui/icons-material/ModelTrainingOutlined';
import DataUsageOutlinedIcon from '@mui/icons-material/DataUsageOutlined';
import AltRouteOutlinedIcon from '@mui/icons-material/AltRouteOutlined';
// AI Coach (E7.3, #243).
import SportsOutlinedIcon from '@mui/icons-material/SportsOutlined';
// Observability (#537, epic #528) — the telemetry policy page and the explorer.
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
// Telemetry Dashboard (#578, epic #576).
import MonitorHeartOutlinedIcon from '@mui/icons-material/MonitorHeartOutlined';
// Doctor (#634).
import HealthAndSafetyOutlinedIcon from '@mui/icons-material/HealthAndSafetyOutlined';
// Factory reset (#211) — the one destructive card, alone in its own group.
import DeleteForeverOutlinedIcon from '@mui/icons-material/DeleteForeverOutlined';
import ChecklistOutlinedIcon from '@mui/icons-material/ChecklistOutlined';
// Android app (#283, epic #276).
import PhoneAndroidOutlinedIcon from '@mui/icons-material/PhoneAndroidOutlined';

// The types and the pure registry functions live in `settingsRegistry.ts`
// (issue #222) so the visual harness can reuse them without this file's data.
// Re-exported here so every existing import keeps working unchanged.
export * from './settingsRegistry';

/**
 * The admin sections, in hub order.
 *
 * GATING IS BY PERMISSION, NOT BY ROLE — a role check here is what produced
 * the split-brain described in `destinations.ts`'s header. The strings are the
 * ones the API enforces:
 *
 *   - `system_settings:read`  → `system-settings.controller.ts` (GET)
 *   - `system_settings:write` → `system-settings.controller.ts` (PUT/PATCH)
 *   - `users:read`            → `users.controller.ts`
 *   - `jobs:read`             → `jobs/job-admin.controller.ts`
 *   - `nodes:read`            → the worker-node controller (#267)
 *   - `db_backup:read`        → the database-backup controller (#268)
 *   - `push:read`             → the push-config controller (#355)
 *   - `storage_config:read`   → the storage-config controller (#375)
 *
 * `Users & Allowlist` gates on `users:read` alone even though it hosts data
 * from two controllers (Users → `users:read`, Allowlist → `allowlist:read`).
 * That mirrors the existing destination gate: the CARD gate is about
 * reachability, and the page is worth reaching for its Users half alone; the
 * Allowlist half gates itself on `allowlist:read` inside the page.
 */
export const ADMIN_SECTIONS: SettingsSectionDef[] = [
  {
    label: 'General',
    cards: [
      {
        // Issue #124, epic #109. `system_settings:read` is the string
        // `email-settings.controller.ts` enforces on its GET, exactly as the
        // `Notifications` card below mirrors `system-settings.controller.ts` —
        // the registry never invents a permission. Saving and test-sending need
        // `system_settings:write`, which the PAGE gates internally: the card
        // gate is about REACHABILITY, and a read-only admin diagnosing "why is
        // mail broken" is worth letting in to look.
        title: 'Email',
        description:
          'Choose how the application sends email, and send a test message to prove it works.',
        Icon: EmailOutlinedIcon,
        path: '/admin/settings/email',
        permission: 'system_settings:read',
      },
      {
        // Issue #225, epic #215. `system_settings:read` is the string
        // `system-settings.controller.ts` enforces on its GET, because this
        // setting lives in the system settings document. Saving needs
        // `system_settings:write`, which the PAGE gates internally: the card gate is about REACHABILITY, and "are
        // browser notifications on for this deployment, and which events are
        // suppressed" is worth reading for anyone answering "why did nobody get
        // notified".
        title: 'Notifications',
        description:
          'Turn browser notifications on or off for everyone, and suppress individual events.',
        Icon: NotificationsActiveOutlinedIcon,
        path: '/admin/settings/notifications',
        permission: 'system_settings:read',
      },
      {
        // Issue #355. `push:read` / `push:write` is a permission pair OF ITS
        // OWN, not a reuse of `system_settings:*`: generating/rotating key
        // material has a real, described blast radius (every existing
        // subscriber goes dark until it re-subscribes) that should not ride
        // along with routine settings edits, mirroring why `broadcasts:*` and
        // `nodes:*` were split out rather than folded into
        // `system_settings:*`/`jobs:*`. `push:read` is the string
        // `push-config.controller.ts` enforces on its GET — the registry
        // never invents a permission, it mirrors one. Generating, rotating,
        // enabling/disabling and removing all need `push:write`, which the
        // PAGE gates internally: the card gate is about REACHABILITY, and "is
        // web push configured, and by whom" is worth reading for anyone
        // diagnosing why push notifications are not arriving.
        title: 'Web Push',
        description:
          'Generate a VAPID key pair, enable or rotate it, and control whether this deployment can send browser push notifications.',
        Icon: VpnKeyOutlinedIcon,
        path: '/admin/settings/push',
        permission: 'push:read',
      },
      {
        // Issue #376, epic #372. `storage_config:read` / `storage_config:write`
        // is a permission pair OF ITS OWN, and it is neither of the two pairs
        // that already look like they would do.
        //
        // NOT `system_settings:*`: a wrong bucket, a wrong endpoint or a
        // rotated-out secret does not degrade one feature, it breaks every
        // upload, avatar, job artifact and database backup in the deployment at
        // once — the same "distinct blast radius" argument `nodes:*`,
        // `db_backup:*`, `broadcasts:*` and `push:*` each made before it.
        //
        // NOT `storage:*`, which is the closer-looking mistake: THAT pair gates
        // OBJECT ACCESS and is seeded to Viewer and Contributor, so every
        // ordinary user of this application holds `storage:read`. Mirroring it
        // here would put the deployment's credential-bearing configuration
        // screen in front of the entire user base.
        //
        // `storage_config:read` is the string `storage/config/storage-config
        // .controller.ts` enforces on its GET — the registry never invents a
        // permission, it mirrors one. Saving, testing the connection and
        // creating the bucket all need `storage_config:write`, which the PAGE
        // gates internally by disabling its controls: the card gate is about
        // REACHABILITY, and "which bucket is this deployment writing to, and
        // does it think it is configured" is worth reading for anyone answering
        // "why did that upload fail".
        //
        // GENERAL, NOT OPERATIONS: this is configuration an administrator SETS
        // and which then sits there, exactly like Email and Web Push beside it.
        // Operations is the running system — work in flight, the machines
        // executing it, the copies of the data taken while it ran.
        title: 'Storage',
        description:
          'Point this deployment at an object store, prove the credentials work, and create the bucket if it is not there yet.',
        Icon: CloudOutlinedIcon,
        path: '/admin/settings/storage',
        permission: 'storage_config:read',
      },
      {
        // Issue #258, epic #254. `system_settings:read` is the string
        // `common/maintenance/maintenance.controller.ts` enforces on its GET —
        // the registry never invents a permission, it mirrors one. That
        // controller deliberately adds NO permission of its own: a maintenance
        // window IS a system setting, stored in the `maintenance` namespace of
        // that row and nowhere else, so `system_settings:read` / `:write`
        // already mean exactly what this page needs them to mean.
        //
        // Opening and closing a window needs `system_settings:write`, which the
        // PAGE gates internally by disabling its controls: the card gate is
        // about REACHABILITY, and "is this deployment deliberately out of
        // service, and which layer is deciding that" is worth reading for
        // anyone answering "why is nothing working".
        title: 'Maintenance',
        description:
          'Take the application out of service for planned work, with a message for anyone who tries to use it.',
        Icon: BuildCircleOutlinedIcon,
        path: '/admin/settings/maintenance',
        permission: 'system_settings:read',
      },
      // Issue #203. APPENDED to General (not inserted): the first-run setup
      // guide is about configuration an administrator sets, and every step
      // links into a sibling General card. `system_settings:read` is the
      // permission under which `GET /api/onboarding` returns its `admin`
      // block; no `feature`, because it is how AI gets switched on.
      {
        title: 'Setup guide',
        description:
          'See what must be configured before people can use the app, check each step against the live configuration, and jump to where it is done.',
        Icon: ChecklistOutlinedIcon,
        path: '/admin/settings/setup',
        permission: 'system_settings:read',
      },
      {
        // Issue #283, epic #276. APPENDED to General after Setup guide: which
        // Android app builds the deployment trusts is configuration an
        // administrator sets once. `system_settings:read` is the exact string
        // `GET /api/admin/android-app` enforces; changing the trusted apps
        // needs `system_settings:write`, gated inside the page. No `feature`.
        title: 'Android app',
        description:
          'Trust the Android app’s signing certificate so it opens full screen, and preview the Digital Asset Links file.',
        Icon: PhoneAndroidOutlinedIcon,
        path: '/admin/settings/android',
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
  /**
   * Operations — the deployment's moving parts (issue #266, epic #254).
   *
   * A THIRD GROUP rather than more cards under `General`, because the question
   * it answers is a different one. `General` is configuration: values an
   * administrator SETS, which then sit there. These four are the running
   * system: work in flight, machines executing it, and the copy of the data
   * taken while it ran. An operator opens `General` to change something and
   * opens this group to find out what is happening — and putting the two under
   * one heading would make the twelve-card grid a single undifferentiated wall
   * exactly when someone is scanning it during an incident.
   *
   * ===========================================================================
   * ALL FOUR CARDS WERE DECLARED AT ONCE, BEFORE THEIR PAGES EXISTED
   * ===========================================================================
   *
   * `Worker Nodes` and `Database Backup` landed in later issues (#271 routed
   * the first; #287, the epic's last issue, routed the second). Both were
   * declared back in #266 anyway, `disabled: true` and with NO `path`, and the
   * reason is concrete rather than aesthetic:
   *
   * The settings hub is under visual-regression testing at
   * `maxDiffPixels: 4`. Any change to the card grid — a card added to a
   * section, a new section, a title long enough to wrap — reflows the layout
   * and requires the baselines to be regenerated inside a pinned Playwright
   * container. Adding these four cards one issue at a time means doing that
   * four times, with four chances to land a stale or mis-generated baseline,
   * and three of those regenerations would be for a grid nobody has shipped a
   * page behind yet. Declaring the whole group at once makes it ONE reflow and
   * ONE baseline regeneration for the epic.
   *
   * That reasoning is about ADDING a card, and it does not argue against
   * flipping one when its page ships: routing `Worker Nodes` (#271), and then
   * `Database Backup` (#287), changes what a card in the existing grid renders
   * — a "Coming soon" chip becomes a `CardActionArea`, and the rail gains the
   * row it was skipping — so the baselines move once more each time, for a card
   * somebody can now actually open. As of #287 no card in this group is inert,
   * which is the state the group was declared in advance to reach.
   *
   * `disabled: true` AND no `path` together, not either alone, for a card that
   * is still unbuilt. They are belt-and-braces on purpose, because the two
   * consumers treat them differently and both treatments must be right: `SettingsHub` renders an
   * inert card with a "Coming soon" chip and — importantly — no
   * `CardActionArea` at all, so the card is not a tab stop and does not ripple;
   * `NavigationRail` skips the row entirely rather than drawing a link to
   * nowhere. A card carrying a `path` to an unrouted page would instead send a
   * click to `App.tsx`'s `*` catch-all and land the operator on the home page
   * with no explanation.
   *
   * ===========================================================================
   * THE PERMISSIONS ARE THE CONTROLLERS' OWN STRINGS
   * ===========================================================================
   *
   * Per `CLAUDE.md` Settings UI Pattern rule 3, verified against the API rather
   * than assumed:
   *
   *   - `jobs:read`      → `jobs/job-admin.controller.ts` (`PERMISSIONS.JOBS_READ`),
   *                        which both Jobs cards mirror: the list, the stats
   *                        and the insights read all sit behind it. The five
   *                        writes need `jobs:write`, which each PAGE gates
   *                        internally by disabling its controls — the card gate
   *                        is about REACHABILITY, and "what is the queue doing"
   *                        is worth reading for anyone answering "why has
   *                        nothing happened".
   *   - `nodes:read`     → `nodes/nodes-admin.controller.ts`
   *                        (`PERMISSIONS.NODES_READ`), the string it enforces
   *                        on the fleet list, the node detail and the
   *                        credential list; also `node-credential.controller.ts`.
   *                        DELIBERATELY NOT `jobs:read`: `roles.constants.ts`
   *                        splits the two, so a Workers card gated on
   *                        `jobs:read` would advertise a permission that
   *                        controller never checks, and the hub would decide
   *                        reachability on evidence unrelated to whether the
   *                        request behind it will be authorized.
   *   - `db_backup:read` → the backup controller (#268). NOT
   *                        `system_settings:read`: `roles.constants.ts`
   *                        reserves a dedicated `db_backup:read/write/restore`
   *                        triple for this surface precisely so backup access
   *                        can be granted without handing over the settings
   *                        document, and mirroring the settings permission here
   *                        would quietly undo that.
   *
   * All five strings are seeded to ADMIN ONLY (`prisma/seed-data.ts`), so in
   * practice this whole group is invisible to Contributor and Viewer today. The
   * cards still gate per permission and not on the admin ROLE, because a later
   * issue widening one read to an operations role must not have to touch this
   * file — and because a role check here is the split-brain `destinations.ts`'s
   * header exists to describe.
   *
   * The `/admin/settings` route gate is deliberately NOT widened to include
   * `jobs:read`. It mirrors `console`'s `anyPermission` in
   * `config/destinations.ts` byte for byte (asserted in
   * `destinations.test.ts`), and every holder of these permissions is an admin
   * who also holds `system_settings:read`, so nothing is unreachable. Widening
   * one side without the other is exactly the disagreement that test exists to
   * catch.
   */
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
        // Nested UNDER the Jobs route, which `settingsPageTitle`'s
        // longest-prefix rule resolves correctly: a bare `startsWith` would let
        // `Jobs` claim this path and title the page "Jobs" in the compact
        // AppBar. That is the case the rule was written for, and it is asserted
        // in `settingsRegistry.test.ts` rather than left to the comment.
        title: 'Job Insights',
        description:
          'See how long the queue takes, how fast it is moving, and when the outstanding work will be done.',
        Icon: QueryStatsIcon,
        path: '/admin/settings/jobs/insights',
        permission: 'jobs:read',
      },
      {
        // Declared inert by #266 alongside the whole group; ROUTED by #271,
        // which ships the page. Flipping a card is exactly the two-field edit
        // the section header describes — a `path` appears and `disabled`
        // disappears — and both consumers pick it up from that alone: the hub
        // swaps its "Coming soon" chip for a real `CardActionArea`, and the
        // Console rail, which skipped the row entirely, starts drawing it.
        //
        // `permission` is UNCHANGED and was already right: `nodes:read` is the
        // literal string `nodes-admin.controller.ts` enforces on its fleet
        // list, its detail read and its credential list
        // (`PERMISSIONS.NODES_READ`). Creating and revoking credentials, and
        // deleting a node, need `nodes:write`, which the PAGE gates internally
        // by omitting the row actions and the create button — the card gate is
        // about REACHABILITY, and "which machines are attached and are they
        // alive" is worth reading for anyone answering "why is nothing being
        // processed".
        title: 'Worker Nodes',
        description:
          'See which machines are attached to this deployment, what they are running, and whether they are healthy.',
        Icon: DnsOutlinedIcon,
        path: '/admin/settings/workers',
        permission: 'nodes:read',
      },
      {
        // Declared inert by #266 alongside the whole group; ROUTED by #287,
        // the last issue of the epic, which ships the page. Flipping a card is
        // the two-field edit the section header describes — a `path` appears
        // and `disabled` disappears — and both consumers pick it up from that
        // alone: the hub swaps its "Coming soon" chip for a real
        // `CardActionArea`, and the Console rail, which skipped the row
        // entirely, starts drawing it. Both of those move pixels, so the
        // visual baselines were regenerated with this change.
        //
        // `permission` is UNCHANGED and was already right: `db_backup:read` is
        // the literal string `db-backup/db-backup.controller.ts` enforces on
        // its config read, its run list and its run detail
        // (`PERMISSIONS.DB_BACKUP_READ`). NOT `system_settings:read`:
        // `roles.constants.ts` reserves a dedicated
        // `db_backup:read/write/restore` triple for this surface precisely so
        // backup access can be granted without handing over the settings
        // document, and mirroring the settings permission here would quietly
        // undo that.
        //
        // Scheduling, cancelling and deleting need `db_backup:write`, and
        // restoring or rolling back need `db_backup:restore` — a THIRD
        // permission, kept separate by the API so it can be withheld from
        // someone who may schedule backups but must not be able to replace the
        // database. The PAGE gates both internally by disabling its controls;
        // the card gate is about REACHABILITY, and "is this deployment being
        // backed up, and what have we got" is worth reading for anyone
        // answering "can we recover from this".
        title: 'Database Backup',
        description:
          'Schedule backups, review what has been taken, and restore the database from one.',
        Icon: BackupOutlinedIcon,
        path: '/admin/settings/db-backup',
        permission: 'db_backup:read',
      },
      {
        // Issue #325, epic #319. `broadcasts:read` is the literal string
        // `notifications/broadcasts/broadcasts.controller.ts` enforces on its
        // audience count, its list and its detail read
        // (`PERMISSIONS.BROADCASTS_READ`) — the registry never invents a
        // permission, it mirrors one. Composing, scheduling, cancelling,
        // deleting and test-sending need `broadcasts:write`, which the PAGE
        // gates internally by disabling its controls: the card gate is about
        // REACHABILITY, and "what has been announced, and is anything queued to
        // go out" is worth reading for anyone answering "did everyone get told".
        //
        // OPERATIONS, NOT GENERAL, per this section's own header. General holds
        // values an administrator SETS, which then sit there; a broadcast is
        // work you dispatch and then watch — it has a status, a progress
        // counter and a cancel — and it belongs one card away from Jobs, where
        // its fan-out becomes visible.
        //
        // ⚠ NOT THE SAME PAGE AS General → Notifications, and the descriptions
        // are written to keep them apart. That card is the deployment-wide KILL
        // SWITCH: it decides whether browser notifications may be raised at all
        // and which events are suppressed. This one composes and sends a single
        // announcement to every user. Confusing the two during an incident is
        // the difference between silencing every notification in the product
        // and telling everybody what is happening.
        title: 'Broadcasts',
        description:
          'Write an announcement and send it to every active user now or at a scheduled time, then watch it go out.',
        Icon: CampaignOutlinedIcon,
        path: '/admin/settings/broadcasts',
        permission: 'broadcasts:read',
      },
      {
        // Issue #401, epic #397. `system_settings:read` is the literal string
        // `about/about.controller.ts` enforces on its single GET
        // (`PERMISSIONS.SYSTEM_SETTINGS_READ`) — the registry never invents a
        // permission, it mirrors one. That controller deliberately adds NO
        // permission of its own, and argues the point in its own header: the
        // cases that justify a SPLIT pair elsewhere in this file (`push:*`,
        // `broadcasts:*`, `nodes:*`, `storage_config:*`) all turn on a distinct
        // blast radius — key material, a send to every user, a fleet, a
        // credential-bearing screen. A read-only report of what is deployed has
        // none of that, and its blast radius is exactly the deployment
        // configuration `system_settings:read` already describes.
        //
        // THERE IS NO WRITE SIDE AT ALL. Every other card in this file notes
        // which actions its page gates internally; this one has none — the
        // endpoint is a single GET and the page renders it. So the card gate is
        // the only gate, and it is still about REACHABILITY: "what commit is
        // this box running, and did the deploy that put it there finish" is the
        // question an operator opens first during an incident.
        //
        // OPERATIONS, NOT GENERAL, per this section's own header. General holds
        // values an administrator SETS, which then sit there. Nothing on this
        // page is settable: it is a read-only view of the running system, the
        // same kind of question Jobs (what work is in flight), Worker Nodes
        // (which machines are executing it) and Database Backup (which copies
        // were taken while it ran) each answer on their own axis. This one
        // answers the most basic of them — what IS the running system.
        //
        // APPENDED rather than inserted, the same rule `Broadcasts` followed:
        // the hub, the rail and the drill-down list all render this array in
        // declaration order, so an insertion would move five existing cards for
        // a reader who has learnt where they are — and would reflow the grid
        // further than the one added card requires. See §4 of this file's
        // Operations header on why every grid change costs a baseline
        // regeneration.
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
    // Issue #425, epic #419. A FOURTH group, APPENDED — the same append-only
    // rule `Broadcasts` and `About` followed inside Operations, one level up:
    // the hub, the rail and the drill-down list render this array in
    // declaration order, and appending keeps every existing card where it was
    // (the pixel baselines in `tests/visual` hold at `maxDiffPixels: 4`).
    //
    // Both cards gate on `ai_config:read`, the literal string the admin AI
    // controller enforces on its reads (`PERMISSIONS.AI_CONFIG_READ`, #423 /
    // #428). Saving, storing a key, probing a provider and editing a model all
    // need `ai_config:write`, which each PAGE gates internally — the card gate
    // is about REACHABILITY.
    label: 'AI',
    cards: [
      {
        // NO `feature`, deliberately: this is the page an administrator
        // switches AI ON from. Gating it on AI being on would make the switch
        // unreachable in exactly the state it exists to change.
        title: 'AI',
        description:
          'Switch AI on for this deployment, choose whose keys pay for calls, and configure each provider.',
        Icon: AutoAwesomeOutlinedIcon,
        path: '/admin/settings/ai',
        permission: 'ai_config:read',
      },
      {
        // Nested UNDER the AI route, so `settingsPageTitle`'s longest-prefix
        // rule titles it "AI Models" rather than "AI" — the Job Insights
        // precedent. Feature-gated: a model catalogue for a switched-off
        // feature is a page about nothing.
        title: 'AI Models',
        description:
          'Review the models each provider offers, classify what they can do, and choose which ones users may call.',
        Icon: ModelTrainingOutlinedIcon,
        path: '/admin/settings/ai/models',
        permission: 'ai_config:read',
        feature: 'ai',
      },
      {
        // Issue #444, epic #420. APPENDED to the AI group (append-only, as
        // above). `ai_config:read` is the literal string the admin AI usage
        // route (`GET /api/admin/ai/usage`, #443) enforces — the same read
        // permission as the rest of `/api/admin/ai/*`. Read-only: the page has
        // no write side. Nested under the AI route (longest prefix titles it
        // "AI Usage") and feature-gated like AI Models.
        title: 'AI Usage',
        description:
          "See who is calling AI, which models they use, and how much of it the organization's key pays for.",
        Icon: DataUsageOutlinedIcon,
        path: '/admin/settings/ai/usage',
        permission: 'ai_config:read',
        feature: 'ai',
      },
      {
        // Issue #173. APPENDED to the AI group (append-only, as above). Every
        // AI model choice is an administrator's: the organization default and
        // a model per feature. `ai_config:read` is the literal string
        // `ai-assignments-admin.controller.ts` enforces on its GET; saving
        // needs `ai_config:write`, which the page gates internally. Nested
        // under the AI route (longest prefix titles it) and feature-gated like
        // AI Models (CLAUDE.md AI Platform Rule 5).
        title: 'AI Model Assignments',
        description:
          'Choose the AI model the organization uses by default and for each feature. Users do not choose models.',
        Icon: AltRouteOutlinedIcon,
        path: '/admin/settings/ai/assignments',
        permission: 'ai_config:read',
        feature: 'ai',
      },
      {
        // E7.3 (#243). APPENDED to the AI group (append-only, as above).
        // `ai_config:read` is the literal string
        // `coach/admin/coach-admin-settings.controller.ts` enforces on its GET;
        // saving needs `ai_config:write`, gated inside the page. Feature-gated
        // like the other AI cards (CLAUDE.md AI Platform Rule 5). The coach's
        // MODELS are chosen on AI Model Assignments (its Coach section).
        title: 'Coach',
        description:
          'Switch the AI Coach on or off, allow adult language and spoken messages, and cap daily nudges.',
        Icon: SportsOutlinedIcon,
        path: '/admin/settings/coach',
        permission: 'ai_config:read',
        feature: 'ai',
      },
    ],
  },
  {
    // Issue #537, epic #528. A FIFTH group, APPENDED after AI — the same
    // append-only rule every earlier group followed: the hub, the rail and the
    // drill-down list render this array in declaration order, so appending
    // keeps every existing card where it was. (It still reflows the hub grid
    // below the AI group, so the `tests/visual` hub baselines move once.)
    //
    // OBSERVABILITY, NOT OPERATIONS: Operations is the running system's work
    // (jobs, nodes, backups); this group is the system's own traces, logs and
    // metrics, and the tools for asking questions of them.
    //
    // The permissions are the literal strings the telemetry controllers
    // enforce (`PERMISSIONS.TELEMETRY_*` in `roles.constants.ts`):
    //   - `telemetry:read`  → `telemetry/telemetry-admin.controller.ts` (#534),
    //                         on GET config and GET status. Saving needs
    //                         `telemetry:write`, which the PAGE gates.
    //   - `telemetry:query` → the explorer controller (#535), on query, schema
    //                         and export — and, with `ai:use`, the assistant
    //                         stream (#536).
    label: 'Observability',
    cards: [
      {
        // NO `feature`, deliberately — the `AI` card's precedent: this is the
        // page telemetry is switched on from.
        title: 'Telemetry',
        description:
          'Turn telemetry collection on, choose how long it is kept, set query limits and configure the AI assistant.',
        Icon: InsightsOutlinedIcon,
        path: '/admin/settings/telemetry',
        permission: 'telemetry:read',
      },
      {
        // Nested UNDER the Telemetry route, so `settingsPageTitle`'s
        // longest-prefix rule titles it "Telemetry Explorer". Feature-gated:
        // an explorer over a store that is absent or switched off is a page
        // about nothing. `telemetry:query`, NOT `telemetry:read`: running
        // arbitrary read-only SQL over telemetry is a separate grant.
        title: 'Telemetry Explorer',
        description:
          'Query traces, logs and metrics with SQL, export the results, and ask the AI assistant for help.',
        Icon: TerminalOutlinedIcon,
        path: '/admin/settings/telemetry/explorer',
        permission: 'telemetry:query',
        feature: 'telemetry',
      },
      {
        // Issue #578, epic #576. APPENDED after the Explorer. Nested under the
        // Telemetry route like the Explorer, so the longest-prefix rule titles
        // it "Telemetry Dashboard". `telemetry:query`, the exact permission
        // `telemetry/dashboard/telemetry-dashboard.controller.ts` enforces on
        // every route (#577): the dashboard reads telemetry DATA, the same
        // grant as the explorer. Feature-gated on `telemetry` for the same
        // reason: a dashboard over a store that is absent or switched off is
        // a page about nothing.
        title: 'Telemetry Dashboard',
        description:
          'See at a glance whether anything is wrong: error rate, latency, error logs and the top failing routes.',
        Icon: MonitorHeartOutlinedIcon,
        path: '/admin/settings/telemetry/dashboard',
        permission: 'telemetry:query',
        feature: 'telemetry',
      },
      {
        // Issue #634. APPENDED as the last Observability card (append-only).
        // `system_settings:read`, the exact permission
        // `doctor/doctor.controller.ts` enforces on `GET /api/admin/doctor`.
        // NO `feature`, deliberately: the Doctor reports on AI and telemetry
        // while they are switched off (as `skip`), which is exactly when an
        // administrator asks why a capability is missing. No `alwaysShow`.
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
    // Issue #211. A SIXTH group, APPENDED after Observability — the same
    // append-only rule every earlier group followed, so every existing card
    // stays where it was. (It still adds a row below Observability, so the
    // `tests/visual` hub baselines move once.)
    //
    // Its OWN group, last, and never folded into Operations: a factory reset
    // erases every user and all application data, and the admin should find
    // it at the bottom of the Console under a label that says so — the admin
    // twin of the per-user `Danger Zone` group (#202).
    //
    // `system:factory_reset` is the literal string the factory-reset
    // controller enforces on its summary, start and status routes
    // (`PERMISSIONS.SYSTEM_FACTORY_RESET` in `roles.constants.ts`), seeded to
    // the Admin role ONLY. NO `feature`, NO `alwaysShow`: the card is
    // unreachable for anyone else, including a `system_settings:write` holder.
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

/**
 * The Console hub itself — the one admin route that owns no card, and so the
 * title `settingsPageTitle` falls back to.
 */
export const ADMIN_HUB_PATH = '/admin/settings';
export const ADMIN_HUB_TITLE = 'Settings';
