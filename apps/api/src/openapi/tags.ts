// =============================================================================
// OpenAPI tag taxonomy (issue #53)
// =============================================================================
//
// The single declaration of every `@ApiTags(...)` name used in this API, its
// human description, and which sidebar section it belongs to.
//
// The tag NAMES here were already consistent across the ten controllers, so
// unlike the rest of this pass nothing was renamed. What was missing is what
// this file adds: a description for each (an undescribed tag renders as a bare
// heading) and a grouping (an ungrouped tag renders outside every section).
//
// One rule this file exists to enforce: NO undeclared and NO orphaned tags. A
// tag used by a controller but not listed here would render with no description
// and land outside every group; a tag listed here but used by nobody would
// render an empty section. Both are failed assertions in
// `test/openapi/openapi-document.spec.ts` rather than something a reviewer has
// to notice.
//
// Ordering is deliberate: `TAG_GROUPS` is emitted as `x-tagGroups`, and the
// flattened tag order becomes the document's `tags` array, which is what a
// renderer falls back to when it has no group support.
// =============================================================================

export interface OpenApiTag {
  /** Must match the controller's `@ApiTags(...)` argument byte-for-byte. */
  name: string;
  /** One or two sentences. Rendered under the section heading in the sidebar. */
  description: string;
}

export interface OpenApiTagGroup {
  name: string;
  tags: OpenApiTag[];
}

/**
 * Sidebar sections, in render order.
 *
 * A group is a product area rather than a module boundary — `Allowlist` sits
 * with authentication because it gates sign-in, even though it is administered
 * from the same screen as `Users`.
 */
export const TAG_GROUPS: OpenApiTagGroup[] = [
  {
    name: 'Authentication & Access',
    tags: [
      {
        name: 'Authentication',
        description:
          'Google OAuth sign-in, access-token refresh, logout, and the current-user lookup. ' +
          'Start here: every other section assumes a bearer token obtained through one of these routes.',
      },
      {
        name: 'Device Authorization',
        description:
          'RFC 8628 device authorization grant — how a CLI or other browserless client obtains a ' +
          'token by showing the user a code to approve elsewhere, plus management of the resulting ' +
          'device sessions.',
      },
      {
        name: 'Personal Access Tokens',
        description:
          'Long-lived `pat_` bearer credentials for scripts and automation. A PAT carries the full ' +
          'permission set of the user that minted it and is accepted on every authenticated route.',
      },
      {
        name: 'Allowlist',
        description:
          'Pre-authorized email addresses. Access is allowlist-gated: an email absent from this list ' +
          'cannot complete OAuth sign-in at all. Admin only.',
      },
      {
        name: 'Test Authentication',
        description:
          'Token minting for automated tests. The module is registered only when ' +
          '`NODE_ENV !== "production"`, so these routes are absent from a production document entirely.',
      },
    ],
  },
  {
    name: 'Account & Settings',
    tags: [
      {
        name: 'Users',
        description:
          'User administration: listing, inspecting, activating and deactivating accounts, and ' +
          'assigning system roles. Admin only.',
      },
      {
        name: 'User Settings',
        description:
          'The calling user\'s own preferences, stored as a JSON document. Supports full replacement ' +
          '(`PUT`) and JSON Merge Patch (`PATCH`).',
      },
      {
        name: 'User Data',
        description:
          'The calling user\'s own data as a whole: counts of what they own and a "factory reset" ' +
          'that deletes all of it (a queued job) while keeping the account and its sign-in. ' +
          'Gated on `user_settings:write`; a reset job is visible only to its owner.',
      },
      {
        name: 'Onboarding',
        description:
          'The calling user\'s first-run checklist: onboarding UI state from the `onboarding` ' +
          'user-settings namespace plus steps derived from their data, and, for callers with ' +
          '`system_settings:read`, the deployment setup steps derived from the Doctor; plus, for ' +
          'administrators, aggregate new-user activation metrics. Read-only.',
      },
      {
        name: 'Health Profile',
        description:
          'The calling user\'s health profile: date of birth, sex at birth, height, unit system, ' +
          'time zone and a short bio, used to interpret their measurements. Full replacement ' +
          '(`PUT`) with an optional `If-Match` version. Gated on `health_data:read`/`:write`, ' +
          'separately from `user_settings:*`.',
      },
      {
        name: 'Measurements',
        description:
          'The calling user\'s health measurements (weight, body fat, waist, blood pressure, ' +
          'resting heart rate, average heart rate, HRV; device-synced readings carry `origin: device`): ' +
          'the metric catalog with unit conversion factors, entries of ' +
          'readings saved together, latest values, and chart series. Values are stored in each ' +
          'metric\'s canonical unit; edits create superseding revisions and deletes are soft. ' +
          'Gated on `health_data:read`/`:write`; owner-scoped (a foreign id is a 404).',
      },
      {
        name: 'Sleep',
        description:
          'The calling user\'s sleep sessions, synced from a phone (Health Connect): start, end, the day of ' +
          'waking, asleep minutes and stage minutes (awake, light, deep, REM). List by day range and delete. ' +
          'Gated on `health_data:read`/`:write`; owner-scoped.',
      },
      {
        name: 'Check-ins',
        description:
          'The calling user\'s daily readiness check-in: four optional self-reported scores from ' +
          '1 to 5 (energy, sleep quality, muscle soreness, stress) and a note, one per local ' +
          'calendar day in the profile time zone, editable for today and the 7 days before. ' +
          'Stored as wellness measurements; no combined readiness score is computed. Gated on ' +
          '`health_data:read`/`:write`; owner-scoped.',
      },
      {
        name: 'Health Export',
        description:
          'Export the calling user\'s health data (profile, body, vitals, labs, wellness check-ins ' +
          'and an index of kept documents) for a date range as JSON, CSV (zip), Excel or a PDF report ' +
          'for a doctor. An export is a queued job; poll it, then download the file through a ' +
          'short-lived signed URL. Files are kept 7 days. Gated on `health_data:read`; owner-scoped ' +
          '(a foreign id is a 404).',
      },
      {
        name: 'Health Documents',
        description:
          'The calling user\'s health documents: every file handed a health intake (scale photos, ' +
          'lab reports), kept or erased, with the count of values read from each. List, rename or ' +
          'date, get a short-lived download link, and delete (the file through the purge job, ' +
          'optionally its values too). Writes require `If-Match`; a stale one is a 412. Gated on ' +
          '`health_data:read`/`:write`; owner-scoped (a foreign id is a 404).',
      },
      {
        name: 'Progress Photos',
        description:
          'The calling user\'s private progress photos: list (newest first, keyset-paged, by pose), add an ' +
          'uploaded JPEG, PNG or WebP storage object (checked by its bytes), and delete (with its stored ' +
          'object). Images are read through the owner-checked signed storage download; never sent to an AI ' +
          'model or a notification. Gated on `health_data:read`/`:write`, not on AI; owner-scoped.',
      },
      {
        name: 'Intakes',
        description:
          'The calling user\'s photo intakes: share photos instead of typing, let a vision model ' +
          'draft structured items, review them (edit, accept, reject, add missing), then apply the ' +
          'accepted items to real data. Each flow is a registered intake kind. Provenance is kept: ' +
          'the AI\'s original value, confidence and a verified flag. Gated on `intakes:read`/`:write`; ' +
          'analyze also needs `ai:use` and AI switched on. Owner-scoped (a foreign id is a 404).',
      },
      {
        name: 'System Settings',
        description:
          'Deployment-wide configuration, stored as a JSON document. Readable by any signed-in user; ' +
          'writable only with `system_settings:write`.',
      },
      {
        name: 'Email Settings',
        description:
          'Mail transport configuration (SES or SMTP), the sender identity, and a test send that ' +
          'reports the provider\'s actual error so a misconfiguration can be diagnosed. Gated on ' +
          '`system_settings:read`/`:write`. The SMTP password is write-only: it is held in the ' +
          'encrypted credential store, is never returned, and submitting it empty preserves it.',
      },
      {
        name: 'Notifications',
        description:
          'The registry of events this application can raise, and which channels each supports. ' +
          'Readable by any signed-in user, because every user renders their own notification ' +
          'preferences against it.',
      },
      {
        name: 'Push Configuration',
        description:
          'Runtime-configurable Web Push (VAPID) keys: generate, rotate, enable/disable and ' +
          'remove, with no restart required. Gated on `push:read`/`push:write`, separately from ' +
          '`system_settings:*`, because rotating or removing the key pair knocks every existing ' +
          'push subscriber offline until they resubscribe — a materially different act from an ' +
          'ordinary settings edit. The VAPID private key is write-only: it is held in the ' +
          'encrypted credential store and is never returned by any endpoint.',
      },
    ],
  },
  {
    name: 'Gyms & Equipment',
    tags: [
      {
        name: 'Gyms',
        description:
          'The calling user\'s training locations: name, type, description, notes, temporary flag, ' +
          'the one default gym, the equipment in each (manual rows, and AI rows with their ' +
          'provenance) and photos attached from storage objects the caller uploaded. Gated on ' +
          '`gyms:read`/`gyms:write`; attaching or removing a photo also needs `storage:write`. ' +
          'Owner-scoped (a foreign id is a 404).',
      },
      {
        name: 'Equipment',
        description:
          'The equipment catalog (seeded, read-only) plus the caller\'s own custom equipment ' +
          'types, searchable by name and alias. Gated on `gyms:read`/`gyms:write`; a custom type ' +
          'is visible only to its owner.',
      },
      {
        name: 'Capabilities',
        description:
          'What equipment lets you train (e.g. back squat, lat pulldown), with movement pattern ' +
          'and primary muscles. Seeded and read-only; gated on `gyms:read`.',
      },
    ],
  },
  {
    name: 'Training',
    tags: [
      {
        name: 'Exercises',
        description:
          'The exercise library (seeded, read-only) plus the caller\'s custom exercises: muscles, ' +
          'movement pattern, tracking mode and the equipment or capability groups each needs, with ' +
          'per-gym availability. Gated on `exercises:read`/`exercises:write`; a custom exercise is ' +
          'visible only to its owner, and an AI-proposed one waits for the owner\'s approval.',
      },
      {
        name: 'Workouts',
        description:
          'Logged workouts: start (one in progress per user), exercises in order, sets with weight, reps, ' +
          'time, distance, RPE, RIR, rest and pain flags, then finish with a summary. Weights are ' +
          'kilograms and distances metres; clients convert for display. Gated on ' +
          '`workouts:read`/`workouts:write`; owner-scoped.',
      },
      {
        name: 'Programs',
        description:
          'Training plans: a tree of blocks, weeks, workouts and prescribed exercises, with immutable ' +
          'versions, a change log (who changed what and why) and revert. Content edits require ' +
          '`If-Match: <currentVersion>` and answer `409` with `details.reason: "TRAINING_STALE_PLAN"` ' +
          'when stale. At most one active program per user. Weights are kilograms. Gated on ' +
          '`programs:read`/`programs:write`; owner-scoped; works with AI switched off.',
      },
      {
        name: 'Goals',
        description:
          'Activity goals (walk, run, any cardio, any workout, custom) counted in sessions, minutes, steps ' +
          'or meters per Monday..Sunday week or per day, with templates, pause/resume/archive and progress: ' +
          'done, remaining, days left, on track, hit and streaks. PATCH requires `If-Match: <version>` ' +
          '(`428` missing, `412` stale). At most 10 active goals. Gated on `goals:read`/`goals:write`; owner-scoped.',
      },
      {
        name: 'Activity entries',
        description:
          'Check-ins toward goals ("I did it", minutes, steps) on a local day up to 7 days back, plus the ' +
          'entries the server derives from completed workouts (`source: workout`, read-only here). Per day ' +
          'the highest source counts: integration > workout > manual. Meters and seconds. Gated on ' +
          '`goals:read`/`goals:write`; owner-scoped.',
      },
      {
        name: 'Health sync',
        description:
          'Android Health Connect sync: paired phones (each linked to the access token it paired with), ' +
          'sync uploads that upsert activity entries (`source: integration`), measurements and sleep ' +
          'sessions per phone and reconcile deletions inside the sync window, run history and diagnostics ' +
          'reports. Gated on `goals:read`/`goals:write`; measurements and sleep also need ' +
          '`health_data:write`. Owner-scoped.',
      },
    ],
  },
  {
    name: 'Storage',
    tags: [
      {
        name: 'Storage',
        description:
          'File objects: simple upload, resumable multipart upload, signed download URLs, metadata, ' +
          'and deletion. A caller sees only the objects they uploaded.',
      },
      {
        name: 'Storage Configuration',
        description:
          'Which object store this deployment writes to, and with whose credential: provider, ' +
          'bucket, region, endpoint, plus a connection test and a bucket provisioner. Gated on ' +
          '`storage_config:read`/`storage_config:write`, separately from `storage:*` (which every ' +
          'signed-in user holds for object access) and from `system_settings:*` (a wrong value here ' +
          'breaks every upload, avatar, job artifact and backup at once). The secret access key is ' +
          'write-only: it is held in the encrypted credential store and is never returned by any ' +
          'endpoint.',
      },
    ],
  },
  {
    name: 'AI',
    tags: [
      {
        name: 'AI Administration',
        description:
          'The AI platform\'s deployment-wide configuration: the kill switch, the key policy, ' +
          'which providers are enabled, each provider\'s admin (org) key, a connection test, and ' +
          'the model catalog — which models are enabled, their capability overrides, and catalog ' +
          'refresh. Gated on `ai_config:read`/`ai_config:write` (Admin only) and reachable while ' +
          'AI is disabled, so it can always be turned back on. Admin keys are write-only: held ' +
          'in the encrypted credential store and never returned.',
      },
      {
        name: 'AI',
        description:
          'Using AI as a signed-in user: `GET /api/ai/config` (is AI on, which key policy, which ' +
          'providers — readable by anyone, even while AI is off), your own provider keys (bring ' +
          'your own key: verified before it is stored, encrypted at rest, write-only), and the ' +
          'models you can actually call. Everything except `GET /api/ai/config` requires ' +
          '`ai:use` and answers `403` with `details.reason: "AI_DISABLED"` while AI is disabled.',
      },
      {
        name: 'AI Training',
        description:
          'The training-plan agents (researcher, planner, critic, evaluator): which model and ' +
          'reasoning effort each role will use, or why it cannot run and where to fix it, and a ' +
          'pre-run token estimate against your per-run cap (tokens only, never a price). ' +
          'Requires `ai:use` and answers `403` with `details.reason: "AI_DISABLED"` while AI is disabled.',
      },
      {
        name: 'AI Coach',
        description:
          'The AI Coach as a signed-in user: the persona gallery with its static sample lines, and your ' +
          'coach settings with the profanity unlock and the other deployment rules applied server-side. ' +
          'Requires `ai:use` and answers `403` with `details.reason: "AI_DISABLED"` while AI is disabled. ' +
          'Coach refusals carry the coach code in `details.code`.',
      },
      {
        name: 'AI Memory',
        description:
          'The facts the coach and the plan agents remember about you: list, add, edit, pin, delete (with an undo ' +
          'window) and delete all. The coach adds memories when you ask it to remember something and, when you ' +
          'allow it, learns durable facts from your chat in the background. Turn memory, background learning and ' +
          'health-related memories on or off with `PATCH /api/user-settings` (`memory`). Requires `ai:use` and ' +
          'answers `403` with `details.reason: "AI_DISABLED"` while AI is disabled; owner-scoped (a foreign id is a 404).',
      },
      {
        name: 'AI Coach Administration',
        description:
          'The deployment-wide coach policy: the coach switch, the profane-persona unlock, spoken messages, ' +
          'the daily nudge ceiling, audio retention, auto-silence and the inactivity stop. Gated on ' +
          '`ai_config:read`/`ai_config:write` and reachable while AI is disabled.',
      },
    ],
  },
  {
    name: 'Operations',
    tags: [
      {
        name: 'Health',
        description:
          'Liveness and readiness probes for orchestrators and load balancers. Public — a probe that ' +
          'needed a token could not report that authentication is down.',
      },
      // ----------------------------------------------------------------------
      // Reserved ahead of their controllers (#256, epic #254)
      // ----------------------------------------------------------------------
      //
      // The four tags below are declared before any operation carries them, so
      // that the epic's later issues add a controller and not a taxonomy
      // argument. That is safe here and needs no exception in the tests:
      // `applyTagGroups` (openapi/document.ts) publishes only the tags an
      // operation actually uses, so an unused declaration is PRUNED from
      // `document.tags` and from `x-tagGroups` rather than rendering an empty
      // section. `test/openapi/openapi-document.spec.ts` asserts orphans
      // against the PUBLISHED tags for exactly that reason — the same mechanism
      // that already lets `Test Authentication` be declared here and absent
      // from a production document.
      //
      // The rule that has no slack is the other direction: a tag USED by a
      // controller and missing from this file is undeclared, undescribed and
      // ungrouped, and that assertion stays strict. So each issue below adds
      // its operations to a tag that is already described and already grouped.
      {
        name: 'Jobs',
        description:
          'The background job queue: what is queued, running, finished or failed, and the controls ' +
          'to retry or cancel a job. Gated on `jobs:read`/`jobs:write`.',
      },
      {
        name: 'Worker Nodes',
        description:
          'The worker fleet that executes queued jobs — registration, heartbeats, health, and ' +
          'draining a node before it is retired. Gated on `nodes:read`/`nodes:write`, separately ' +
          'from the queue itself.',
      },
      {
        name: 'Database Backup',
        description:
          'Scheduled database backups, their history, and restore. Reading and scheduling are ' +
          '`db_backup:read`/`db_backup:write`; restoring requires `db_backup:restore`, which is a ' +
          'permission of its own because it renames the live database and restarts the process.',
      },
      {
        name: 'Notification Broadcasts',
        description:
          'Announcements an administrator composes and sends to every active user, immediately ' +
          'or on a schedule, over the channels the deployment supports. Gated on ' +
          '`broadcasts:read`/`broadcasts:write`, separately from `Notifications` — that section ' +
          'is every signed-in user\'s own preferences and registry, this one sends to all of ' +
          'them. Grouped with Operations rather than with Account & Settings because a ' +
          'broadcast is an operational action (maintenance windows, incident updates, policy ' +
          'changes), not a per-account setting.',
      },
      {
        name: 'About',
        description:
          'What is actually deployed here: the API version this process resolved for itself, ' +
          'the deploy document `evopathcli deploy` leaves on disk, and a database liveness fact. ' +
          'Gated on `system_settings:read` — deliberately an existing permission rather than ' +
          'a new one, because a read-only report of the deployment has no blast radius of its ' +
          'own. Always answers 200: a missing or malformed document, and an unreachable ' +
          'database, are fields rather than status codes.',
      },
      {
        name: 'Doctor',
        description:
          'Read-only configuration and health checks for every capability of this deployment, ' +
          'each with a status, a one-line detail and — when something needs attention — a ' +
          'remedy and the settings page that fixes it. Gated on `system_settings:read`. ' +
          'Always answers 200: a failing check is a row, not a status code.',
      },
      {
        name: 'Android App',
        description:
          'Trust for the Android app\'s Trusted Web Activity: the (package, signing certificate ' +
          'fingerprint) pairs this deployment vouches for, gated on `system_settings:read`/`:write`, ' +
          'the pairs paired devices report, and the public Digital Asset Links document served at ' +
          '`/.well-known/assetlinks.json`.',
      },
      {
        name: 'Telemetry',
        description:
          'Observability: whether traces, logs and metrics are exported to the telemetry store ' +
          '(GreptimeDB), how long they are retained, and the store\'s status. The policy is ' +
          '`telemetry:read`/`telemetry:write`; running queries against the data is ' +
          '`telemetry:query`. `GET /api/telemetry/config` is readable by any signed-in user — ' +
          'it is how a client learns whether to show telemetry surfaces at all.',
      },
      {
        name: 'Factory Reset',
        description:
          'Reset the whole application to a clean slate: a deployment-wide count of what would be ' +
          'deleted, and a queued job that deletes every other user and all application data while ' +
          'keeping the calling administrator, roles, system settings, deployment credentials, worker ' +
          'nodes and database backups. Gated on `system:factory_reset` (Admin only); one factory ' +
          'reset can be in flight per deployment.',
      },
      {
        name: 'Maintenance',
        description:
          'The maintenance window: turning it on, the message callers see while it is open, and ' +
          'whether administrators keep access. Gated on `system_settings:write`.',
      },
    ],
  },
];

/** Flattened, in group order. Emitted as the document's `tags` array. */
export const OPENAPI_TAGS: OpenApiTag[] = TAG_GROUPS.flatMap((group) => group.tags);

/** Emitted as `x-tagGroups`, the extension Scalar and Redoc read. */
export const OPENAPI_TAG_GROUPS = TAG_GROUPS.map((group) => ({
  name: group.name,
  tags: group.tags.map((tag) => tag.name),
}));
