// =============================================================================
// Seed Data Definitions
// =============================================================================
//
// The declarative half of `seed.ts`, in a module of its own so it can be
// asserted by a test (#256, epic #254). `seed.ts` instantiates a PrismaClient
// and calls `main()` at import time — it is a script, not a module — so nothing
// in a Jest run can import it to check that the roles it seeds actually name
// permissions it declares, or that the system-settings blob it writes still
// matches the API's `DEFAULT_SYSTEM_SETTINGS`. Splitting the data out costs one
// import and buys `test/prisma/seed-data.spec.ts`.
//
// This file stays framework-free and dependency-free on purpose: it is compiled
// by `prisma/tsconfig.json` under ts-node when `npm run prisma:seed` runs, with
// no Nest build anywhere in sight.
//
// IDEMPOTENCE IS A PROPERTY OF `seed.ts`, NOT OF THIS FILE — every write there
// is an `upsert` keyed on a natural unique (`role.name`, `permission.name`,
// `rolePermission.roleId_permissionId`, `systemSettings.key`), so a second run
// updates the same rows instead of inserting duplicates. What this file
// contributes is that the data itself contains no duplicates to insert, which
// the spec checks.

export const ROLES = [
  {
    name: 'admin',
    description: 'Full system access - manage users, roles, and all settings',
  },
  {
    name: 'contributor',
    description: 'Standard user - can manage own settings and future features',
  },
  {
    name: 'viewer',
    description: 'Read-only access - can view content and manage own settings',
  },
] as const;

export const PERMISSIONS = [
  // System settings
  { name: 'system_settings:read', description: 'Read system settings' },
  { name: 'system_settings:write', description: 'Modify system settings' },

  // User settings
  { name: 'user_settings:read', description: 'Read own user settings' },
  { name: 'user_settings:write', description: 'Modify own user settings' },

  // Users management
  { name: 'users:read', description: 'View user list and details' },
  { name: 'users:write', description: 'Modify user accounts' },

  // RBAC management
  { name: 'rbac:manage', description: 'Manage roles and permissions' },

  // Allowlist management
  { name: 'allowlist:read', description: 'View allowlisted emails' },
  { name: 'allowlist:write', description: 'Manage allowlisted emails' },

  // Storage management
  { name: 'storage:read', description: 'Read object metadata, get download URLs' },
  { name: 'storage:write', description: 'Upload, update metadata' },
  { name: 'storage:delete_any', description: 'Admin: delete any object' },

  // Jobs — the background queue (#256, epic #254)
  { name: 'jobs:read', description: 'View queued, running and completed jobs' },
  { name: 'jobs:write', description: 'Enqueue, retry and cancel jobs' },

  // Worker nodes — the fleet that executes those jobs (#256, epic #254).
  //
  // A SEPARATE PAIR FROM `jobs:*` on purpose. A settings card's `permission`
  // must be the exact string its controller enforces (CLAUDE.md, Settings UI
  // Pattern rule 3), so a Workers card gated on `jobs:read` would mirror a
  // permission the nodes controller never checks — the hub would decide
  // reachability on evidence unrelated to whether the request will be
  // authorized. They are also different questions: what work is queued, versus
  // which machines are attached to this deployment.
  { name: 'nodes:read', description: 'View worker nodes and their health' },
  { name: 'nodes:write', description: 'Register, drain and remove worker nodes' },

  // Database backup (#256, epic #254).
  //
  // `db_backup:restore` is a THIRD permission rather than part of `:write`
  // because the two acts are not comparable. Writing is routine scheduling and
  // is undone by writing again; restoring renames the live database and
  // restarts the process, interrupting every session. Folding restore into
  // write would mean anyone trusted to move a backup window is also trusted to
  // roll production back over the top of itself.
  { name: 'db_backup:read', description: 'View backup schedule, history and status' },
  { name: 'db_backup:write', description: 'Configure the backup schedule and run a backup' },
  { name: 'db_backup:restore', description: 'Restore the database from a backup' },

  // Notification broadcasts — admin messages fanned out to every user
  // (#320, epic #319). A separate pair from `system_settings:*`: broadcasting
  // is not editing the settings document, it's a one-way message to every
  // account in the deployment, so it gets its own controller-enforced
  // permission rather than mirroring one nothing in that controller checks.
  // Plural, matching `jobs:*`/`nodes:*`/`users:*` for a collection resource.
  {
    name: 'broadcasts:read',
    description: 'View notification broadcasts and their delivery history',
  },
  {
    name: 'broadcasts:write',
    description: 'Compose, schedule, cancel and send notification broadcasts',
  },

  // Web Push (VAPID) configuration (#355). A separate pair from
  // `system_settings:*`: generating or rotating the VAPID key pair knocks
  // every existing push subscriber offline until they resubscribe, which is
  // a materially different act from an ordinary settings edit and gets its
  // own controller-enforced permission rather than mirroring one nothing in
  // that controller checks.
  { name: 'push:read', description: 'View Web Push (VAPID) configuration' },
  {
    name: 'push:write',
    description: 'Generate, rotate, enable/disable and remove Web Push VAPID keys',
  },

  // Object-storage configuration (#375, epic #372). A separate pair from
  // BOTH `system_settings:*` and `storage:*`: the first understates the blast
  // radius (a wrong bucket or a rotated-out key breaks every upload, avatar,
  // job artifact and backup at once, with no restart in between), and the
  // second is held by every Viewer in the deployment because it gates ordinary
  // object access. See `src/common/constants/roles.constants.ts`.
  {
    name: 'storage_config:read',
    description:
      'View the object-storage configuration and the masked status of its stored secret key',
  },
  {
    name: 'storage_config:write',
    description:
      'Change the object-storage provider, bucket, endpoint and credential, test a configuration, and provision a bucket',
  },

  // AI platform (#423, epic #419, umbrella #418). THREE permissions, not two
  // — see `src/common/constants/roles.constants.ts` for the full argument.
  // `ai_config:*` gates the DEPLOYMENT-WIDE policy (whether AI is on, the key
  // policy, per-provider config) and reaches every user at once, the same
  // "distinct blast radius" reasoning `storage_config:*`/`push:*`/
  // `broadcasts:*`/`nodes:*` above each make. `ai:use` is the opposite axis —
  // may THIS caller invoke AI at all, with THEIR OWN saved key — and changes
  // nothing about anyone else's access or the deployment's configuration.
  {
    name: 'ai_config:read',
    description: 'View the deployment-wide AI platform policy',
  },
  {
    name: 'ai_config:write',
    description:
      'Change whether AI is enabled, the key policy, per-provider configuration and the deployment-wide defaults',
  },
  {
    name: 'ai:use',
    description: 'Call AI models using a saved key',
  },

  // Telemetry (epic #528, story #533). THREE permissions, mirroring the shape
  // of `ai_config:*`/`ai:use` and `db_backup:*`: `telemetry:read` and
  // `telemetry:write` gate the DEPLOYMENT-WIDE policy (whether telemetry is
  // collected, how long it is retained, the query and assistant bounds) and
  // are seeded Admin-only, same "narrow, operational surface" posture as
  // `storage_config:*`/`push:*`/`broadcasts:*`/`nodes:*`/`ai_config:*` above.
  // `telemetry:query` is the separate, comparably sensitive act of actually
  // running SQL, exporting results or invoking the AI assistant against
  // telemetry data — closer to `db_backup:restore` than to a settings edit —
  // and is seeded Admin-only as well, since nobody but an administrator has a
  // vetted need to run ad-hoc queries against this deployment's observability
  // data yet.
  {
    name: 'telemetry:read',
    description: 'View telemetry settings and status',
  },
  {
    name: 'telemetry:write',
    description: 'Change telemetry settings',
  },
  {
    name: 'telemetry:query',
    description: 'Run SQL, export and use the AI assistant against telemetry',
  },
] as const;

// Role to permissions mapping
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [
    'system_settings:read',
    'system_settings:write',
    'user_settings:read',
    'user_settings:write',
    'users:read',
    'users:write',
    'rbac:manage',
    'allowlist:read',
    'allowlist:write',
    'storage:read',
    'storage:write',
    'storage:delete_any',
    // #256, epic #254 — ADMIN ONLY, including the read halves. Contributor and
    // Viewer are deliberately left off: the queue, the fleet and the backup
    // history are operational surfaces, and a read there exposes job payload
    // metadata, host names and the shape of the deployment's schedule. A later
    // issue can widen a specific read to Contributor with an argument for that
    // one surface; starting narrow is the direction that can be relaxed
    // without a migration, since these are rows.
    'jobs:read',
    'jobs:write',
    'nodes:read',
    'nodes:write',
    'db_backup:read',
    'db_backup:write',
    'db_backup:restore',
    // #320, epic #319 — ADMIN ONLY, same reasoning as the jobs/nodes/backup
    // trio just above: broadcasting reaches every user in the deployment, so
    // it starts as narrow as the other operational surfaces here and can be
    // widened later without a migration, since these are rows.
    'broadcasts:read',
    'broadcasts:write',
    // #355 — ADMIN ONLY, same reasoning: rotating VAPID keys knocks every
    // push subscriber offline, so it starts as narrow as the surfaces above
    // and can be widened later without a migration, since these are rows.
    'push:read',
    'push:write',
    // #375, epic #372 — ADMIN ONLY, same reasoning: this pair decides which
    // object store the whole deployment writes to and under whose key, so it
    // starts as narrow as the surfaces above and can be widened later without
    // a migration, since these are rows. Note that Contributor and Viewer keep
    // `storage:*` (object ACCESS) below and gain nothing here — that split is
    // the entire point of a separate pair.
    'storage_config:read',
    'storage_config:write',
    // #423, epic #419 — ADMIN gets all three AI permissions: the two
    // deployment-wide config ones (same "narrow, operational surface" posture
    // as `storage_config:*`/`push:*`/`broadcasts:*`/`nodes:*` above) AND
    // `ai:use`, since an administrator should not need a second grant to use
    // a capability they can also configure.
    'ai_config:read',
    'ai_config:write',
    'ai:use',
    // Epic #528, story #533 — ADMIN ONLY, same reasoning as the operational
    // surfaces above: telemetry settings and ad-hoc queries against
    // observability data start as narrow as `db_backup:*`/`ai_config:*` and
    // can be widened later without a migration, since these are rows.
    'telemetry:read',
    'telemetry:write',
    'telemetry:query',
  ],
  contributor: [
    'user_settings:read',
    'user_settings:write',
    'storage:read',
    'storage:write',
    // #423, epic #419 — `ai:use` only, never `ai_config:*`: a Contributor may
    // call AI with their own saved key, and has no say over whether AI is
    // enabled for anyone else or under which policy.
    'ai:use',
  ],
  viewer: [
    'user_settings:read',
    'user_settings:write',
    'storage:read',
    // #499 — deliberately NO `ai:use` here, unlike Contributor above. Viewer
    // is the DEFAULT role every new user lands in (see `ROLES` above and
    // `AuthService`'s allowlist-driven bootstrap), so seeding `ai:use` onto
    // it meant every fresh signup could call AI with no explicit grant. That
    // is fine under `byok` (no key, no calls succeed) but wrong under
    // `byok_with_org_fallback`: a brand-new Viewer would silently spend the
    // deployment's own org key the first time they touched an AI surface,
    // with no administrator having decided that person should be able to.
    // An administrator who wants a specific Viewer (or all of them) to use
    // AI grants it back explicitly — a `role_permissions` row for
    // `('viewer', 'ai:use')` — or promotes the account to Contributor, which
    // already carries the grant.
  ],
};

// Default system settings
// Must stay in step with `DEFAULT_SYSTEM_SETTINGS` in
// `src/common/types/settings.types.ts` — the seed cannot import it (this script
// runs outside the Nest build), so the two are a deliberate duplicate. A seeded
// row missing a modelled block is not fatal (`readKnownSettings` degrades it to
// the same defaults), but it does mean the first PATCH is what materialises it.
export const DEFAULT_SYSTEM_SETTINGS = {
  // #225, epic #215. Browser notifications on, nothing suppressed: an operator
  // opts OUT of the channel, never into it.
  notifications: {
    browserEnabled: true,
    disabledEvents: [] as string[],
  },
  // #256, epic #254. Inert defaults: backups and the maintenance window ship
  // off, and the only switch that is on bounds a history table nothing writes
  // to yet. `test/prisma/seed-data.spec.ts` asserts this object still equals
  // the API's `DEFAULT_SYSTEM_SETTINGS` key for key and value for value, which
  // is the only thing standing between the deliberate duplication above and a
  // seeded row that disagrees with the code reading it.
  jobs: {
    history: {
      retentionDays: 30,
      purgeEnabled: true,
    },
    stuckThresholdMinutes: 30,
  },
  nodes: {
    staleHeartbeatSeconds: 90,
    offlineStaleMultiplier: 4,
    offlineRetentionDays: 30,
    // OFF, and the default is the point (#349, epic #345): a fresh deployment
    // does not hand its worker fleet credentials to its own database because
    // somebody registered a node. An administrator opens that trust boundary
    // deliberately.
    jobSecretBrokerEnabled: false,
  },
  databaseBackup: {
    enabled: false,
    frequency: 'daily',
    dayOfWeek: 0,
    dayOfMonth: 1,
    timeOfDay: '02:00',
    timezone: 'UTC',
    retentionCount: 7,
    // EMPTY, meaning "whatever provider `storage.provider` names" (#373, epic
    // #372) — and it must stay byte-identical to the API's
    // `DEFAULT_SYSTEM_SETTINGS`, which `test/prisma/seed-data.spec.ts` pins.
    // This field is a pin an operator sets deliberately; seeding a literal
    // provider id would pin every fresh deployment to a provider nobody chose,
    // and a deployment that then selected R2 would fail every backup with a
    // 400. Empty defers instead of choosing.
    storageProvider: '',
    runStaleMinutes: 120,
    compressionLevel: 6,
    restoreRollbackMode: 'retain_database',
    oldDatabaseRetentionHours: 48,
    // OFF (#352, epic #345). Node offload needs TWO deliberate decisions —
    // this one and `nodes.jobSecretBrokerEnabled` above — because "these
    // machines may hold a short-lived credential" and "the whole database may
    // be dumped somewhere other than the API server" are different questions.
    nodeOffloadEnabled: false,
  },
  maintenance: {
    enabled: false,
    // Names no product and no repository — this is a template repo, and the
    // API-side copy of this string (`DEFAULT_MAINTENANCE_MESSAGE`) does not
    // either. A fork that wants its name here reads `APP_NAME` from
    // `@app/shared` at render time rather than baking it into a seeded row.
    message:
      'This service is temporarily unavailable for scheduled maintenance. Please try again shortly.',
    allowAdmins: true,
    startedAt: null as string | null,
    startedById: null as string | null,
  },
  // #373, epic #372. UNCONFIGURED, but — unlike the namespaces above it — NO
  // LONGER INERT: parts 2 and 3 landed the consumers. `StorageConfigService`
  // resolves this namespace (plus the encrypted secret) on every storage call,
  // `ResolvingStorageProvider` builds its S3 client from the result, and
  // `ObjectsService`, `ProfileImageService` and `DatabaseBackupRunnerService`
  // record `provider` onto the rows that say where bytes went.
  //
  // Seeding it still changes no behaviour, and for a different reason than
  // before: every value here is the UNCONFIGURED state. An empty `bucket` is
  // what `resolveStorageConfig` reads as "not configured", so a fresh install
  // answers storage calls with a 503 naming the missing fields whether this
  // block was seeded or not. What seeding buys is that the first admin who
  // opens the storage settings page finds the keys already there instead of
  // materialising them.
  //
  // `provider: 's3'` names the shape the empty fields would be filled in for;
  // "no storage configured" is `bucket === ''`, not a separate provider value.
  //
  // NO SECRET ACCESS KEY IS SEEDED HERE, and none can be: the secret half of
  // the storage credential lives in the encrypted `credentials` table at
  // `(purpose 'storage', name 'default')`, which is written through
  // `CredentialsService` at runtime and is not part of this document at all.
  storage: {
    provider: 's3',
    bucket: '',
    // Empty, not 'us-east-1' — a region nobody chose is how a deployment ends
    // up with a settings page that looks filled in and requests that fail.
    region: '',
    endpoint: '',
    accountId: '',
    // The IDENTIFIER half of the credential only.
    accessKeyId: '',
    // `null` means "use this vendor's convention" and must stay byte-identical
    // to `DEFAULT_SYSTEM_SETTINGS` (test/prisma/seed-data.spec.ts guards it).
    forcePathStyle: null,
  },
  // #423, epic #419, umbrella #418. OFF, and INERT, matching every namespace
  // above it that ships ahead of its own consumers: `enabled: false` means a
  // fresh deployment gains no AI capability nobody asked for merely because
  // this namespace exists. `byok` is the default key policy — every call
  // uses its caller's own saved key, with no deployment-wide fallback to
  // secure. `allowBackgroundRuns: true` mirrors `jobs.history.purgeEnabled`
  // being the one "on" value above: the queue is this application's normal
  // way of doing anything that takes a while. `logPromptContent: false` is a
  // deliberate privacy default — prompt text may carry a user's own
  // sensitive input.
  //
  // Must stay byte-identical to the API's `DEFAULT_SYSTEM_SETTINGS`, which
  // `test/prisma/seed-data.spec.ts` pins. NO API KEY IS SEEDED HERE, and none
  // can be: a user's own key is `UserAiKey.secret`, in its own table; an
  // org-wide fallback key belongs in the encrypted credential store.
  ai: {
    enabled: false,
    keyPolicy: 'byok',
    providers: {
      openai: {
        enabled: false,
      },
      anthropic: {
        enabled: false,
      },
      gemini: {
        enabled: false,
      },
      'azure-openai': {
        enabled: false,
      },
      'openai-compatible': {
        enabled: false,
      },
    },
    defaults: {
      allowBackgroundRuns: true,
      allowRealtime: false,
    },
    logPromptContent: false,
    usageRetentionDays: 180,
    hostedTools: {
      web_search: false,
      file_search: false,
      code_interpreter: false,
      image_generation: false,
      mcp: false,
      mcpAllowedHosts: [],
    },
    limits: {},
  },
  // Epic #528, story #533. OFF, and INERT, matching every namespace above it
  // that ships ahead of its own consumers: a fresh deployment does not start
  // collecting or retaining observability data nobody asked for merely
  // because this namespace exists. Must stay byte-identical to the API's
  // `DEFAULT_SYSTEM_SETTINGS`, which `test/prisma/seed-data.spec.ts` pins.
  telemetry: {
    enabled: false,
    retentionDays: 30,
    // #565: null = follow `APP_SLUG` — never the slug literally, which would
    // freeze a renamed fork's telemetry identity at seed time.
    instanceId: null,
    query: {
      maxRows: 10000,
      timeoutSeconds: 30,
    },
    assistant: {
      enabled: false,
      provider: null as string | null,
      modelId: null as string | null,
      shareResults: true,
      maxResultRowsToModel: 100,
      maxSteps: 15,
    },
  },
};
