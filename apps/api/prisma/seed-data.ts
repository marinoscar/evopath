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

  // Health data (E2.1, #47) — separate from `user_settings:*` so a deployment
  // can withhold health data from a role without blocking theme changes.
  { name: 'health_data:read', description: 'Read own health data' },
  { name: 'health_data:write', description: 'Modify own health data' },

  // Photo intake (E3.1)
  { name: 'intakes:read', description: 'Read own photo intakes and their draft items' },
  { name: 'intakes:write', description: 'Create, edit, analyze and apply own photo intakes' },

  // Gyms and equipment (E3.2): the caller's own gyms, self-service.
  { name: 'gyms:read', description: 'Read own gyms and their equipment' },
  { name: 'gyms:write', description: 'Create, edit and delete own gyms and equipment' },

  // Exercise library (E4.1): read the library plus own custom exercises;
  // write only own custom exercises.
  { name: 'exercises:read', description: 'Read the exercise library and own custom exercises' },
  { name: 'exercises:write', description: 'Create, edit and delete own custom exercises' },
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
    // E2.1, #47 — `health_data:*` is separate from `user_settings:*` (health
    // data is a different class of data than UI preferences, so a deployment
    // can withhold it from a role). All three roles hold both: it is the
    // user's own data, self-service like `user_settings:*`.
    'health_data:read',
    'health_data:write',
    // E3.1 — own photo intakes, self-service; all three roles. Analyze also
    // needs `ai:use` (Viewer lacks it).
    'intakes:read',
    'intakes:write',
    // E3.2 — own gyms and equipment, self-service; all three roles.
    'gyms:read',
    'gyms:write',
    // E4.1 — exercise library; all three roles (custom exercises are own-only).
    'exercises:read',
    'exercises:write',
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
    // E2.1, #47 — `health_data:*` is separate from `user_settings:*` (health
    // data is a different class of data than UI preferences, so a deployment
    // can withhold it from a role). All three roles hold both: it is the
    // user's own data, self-service like `user_settings:*`.
    'health_data:read',
    'health_data:write',
    // E3.1 — own photo intakes, self-service; all three roles. Analyze also
    // needs `ai:use` (Viewer lacks it).
    'intakes:read',
    'intakes:write',
    // E3.2 — own gyms and equipment, self-service; all three roles.
    'gyms:read',
    'gyms:write',
    // E4.1 — exercise library; all three roles (custom exercises are own-only).
    'exercises:read',
    'exercises:write',
  ],
  viewer: [
    'user_settings:read',
    'user_settings:write',
    'storage:read',
    // E2.1, #47 — `health_data:*` is separate from `user_settings:*` (health
    // data is a different class of data than UI preferences, so a deployment
    // can withhold it from a role). All three roles hold both: it is the
    // user's own data, self-service like `user_settings:*`.
    'health_data:read',
    'health_data:write',
    // E3.1 — own photo intakes, self-service; all three roles. Analyze also
    // needs `ai:use` (Viewer lacks it).
    'intakes:read',
    'intakes:write',
    // E3.2 — own gyms and equipment, self-service; all three roles.
    'gyms:read',
    'gyms:write',
    // E4.1 — exercise library; all three roles (custom exercises are own-only).
    'exercises:read',
    'exercises:write',
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

// =============================================================================
// Gyms, equipment catalog and capabilities (E3.2)
// =============================================================================
//
// Slugs are PERMANENT once seeded: the seed upserts by slug, `EquipmentType`
// rows are referenced by `gym_equipment`, and a fork that renames a row keeps
// its slug. Never delete or repurpose a slug. Custom (user-owned) equipment
// types are not part of this catalog and the seed never touches them.

// MOVEMENT_PATTERNS, MUSCLES and EXERCISE_TRACKING_MODES are a deliberate copy
// of `src/common/constants/training.constants.ts` (the API's one home for them):
// this file runs under ts-node where `src/` may not exist (the production image
// ships `prisma/` only). `test/prisma/seed-data.spec.ts` asserts they are equal.
export const MOVEMENT_PATTERNS = [
  'squat', 'hinge', 'horizontal_push', 'vertical_push', 'horizontal_pull',
  'vertical_pull', 'lunge', 'carry', 'core', 'isolation', 'cardio',
] as const;
export type MovementPattern = (typeof MOVEMENT_PATTERNS)[number];

export const MUSCLES = [
  'chest', 'upper_back', 'lats', 'traps', 'shoulders', 'rear_delts', 'biceps',
  'triceps', 'forearms', 'abs', 'obliques', 'lower_back', 'glutes', 'quads',
  'hamstrings', 'calves', 'hip_flexors', 'adductors', 'abductors', 'full_body',
] as const;
export type Muscle = (typeof MUSCLES)[number];

export const EQUIPMENT_CATEGORIES = [
  'free_weights', 'benches_racks', 'plate_loaded', 'selectorized', 'cable',
  'cardio', 'bodyweight', 'accessories',
] as const;
export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

export interface CapabilitySeed {
  slug: string;
  name: string;
  movementPattern: MovementPattern;
  primaryMuscles: Muscle[];
  description?: string;
  sortOrder: number;
}

export interface EquipmentSeed {
  slug: string;
  name: string;
  category: EquipmentCategory;
  aliases: string[];
  description?: string;
  sortOrder: number;
  /** Capability slugs; an unknown slug makes the seed throw. */
  capabilities: string[];
}

export const CAPABILITY_CATALOG: CapabilitySeed[] = [
  { slug: 'back_squat', name: 'Back squat', movementPattern: 'squat', primaryMuscles: ['quads', 'glutes'], sortOrder: 10 },
  { slug: 'front_squat', name: 'Front squat', movementPattern: 'squat', primaryMuscles: ['quads'], sortOrder: 20 },
  { slug: 'smith_squat', name: 'Smith squat', movementPattern: 'squat', primaryMuscles: ['quads', 'glutes'], sortOrder: 30 },
  { slug: 'leg_press', name: 'Leg press', movementPattern: 'squat', primaryMuscles: ['quads', 'glutes'], sortOrder: 40 },
  { slug: 'hack_squat', name: 'Hack squat', movementPattern: 'squat', primaryMuscles: ['quads'], sortOrder: 50 },
  { slug: 'goblet_squat', name: 'Goblet squat', movementPattern: 'squat', primaryMuscles: ['quads', 'glutes'], sortOrder: 60 },
  { slug: 'lunge_loaded', name: 'Loaded lunge', movementPattern: 'lunge', primaryMuscles: ['quads', 'glutes'], sortOrder: 70 },
  { slug: 'step_up', name: 'Step up', movementPattern: 'lunge', primaryMuscles: ['quads', 'glutes'], sortOrder: 80 },
  { slug: 'hip_hinge_loaded', name: 'Loaded hip hinge', movementPattern: 'hinge', primaryMuscles: ['hamstrings', 'glutes', 'lower_back'], sortOrder: 90 },
  { slug: 'hip_thrust', name: 'Hip thrust', movementPattern: 'hinge', primaryMuscles: ['glutes'], sortOrder: 100 },
  { slug: 'back_extension', name: 'Back extension', movementPattern: 'hinge', primaryMuscles: ['lower_back', 'glutes'], sortOrder: 110 },
  { slug: 'barbell_bench_press', name: 'Barbell bench press', movementPattern: 'horizontal_push', primaryMuscles: ['chest', 'triceps'], sortOrder: 120 },
  { slug: 'dumbbell_bench_press', name: 'Dumbbell bench press', movementPattern: 'horizontal_push', primaryMuscles: ['chest', 'triceps'], sortOrder: 130 },
  { slug: 'incline_press', name: 'Incline press', movementPattern: 'horizontal_push', primaryMuscles: ['chest', 'shoulders'], sortOrder: 140 },
  { slug: 'shoulder_press', name: 'Shoulder press', movementPattern: 'vertical_push', primaryMuscles: ['shoulders', 'triceps'], sortOrder: 150 },
  { slug: 'chest_fly', name: 'Chest fly', movementPattern: 'isolation', primaryMuscles: ['chest'], sortOrder: 160 },
  { slug: 'pec_deck', name: 'Pec deck', movementPattern: 'isolation', primaryMuscles: ['chest'], sortOrder: 170 },
  { slug: 'chest_press', name: 'Chest press', movementPattern: 'horizontal_push', primaryMuscles: ['chest', 'triceps'], sortOrder: 180 },
  { slug: 'machine_shoulder_press', name: 'Machine shoulder press', movementPattern: 'vertical_push', primaryMuscles: ['shoulders', 'triceps'], sortOrder: 190 },
  { slug: 'reverse_pec_deck', name: 'Reverse pec deck', movementPattern: 'isolation', primaryMuscles: ['rear_delts'], sortOrder: 200 },
  { slug: 'cable_fly', name: 'Cable fly', movementPattern: 'isolation', primaryMuscles: ['chest'], sortOrder: 210 },
  { slug: 'push_up', name: 'Push-up', movementPattern: 'horizontal_push', primaryMuscles: ['chest', 'triceps'], sortOrder: 220 },
  { slug: 'dip', name: 'Dip', movementPattern: 'vertical_push', primaryMuscles: ['chest', 'triceps'], sortOrder: 230 },
  { slug: 'pull_up', name: 'Pull-up', movementPattern: 'vertical_pull', primaryMuscles: ['lats', 'biceps'], sortOrder: 240 },
  { slug: 'assisted_pull_up', name: 'Assisted pull-up', movementPattern: 'vertical_pull', primaryMuscles: ['lats', 'biceps'], sortOrder: 250 },
  { slug: 'lat_pulldown', name: 'Lat pulldown', movementPattern: 'vertical_pull', primaryMuscles: ['lats', 'biceps'], sortOrder: 260 },
  { slug: 'seated_row', name: 'Seated row', movementPattern: 'horizontal_pull', primaryMuscles: ['upper_back', 'lats'], sortOrder: 270 },
  { slug: 'cable_row', name: 'Cable row', movementPattern: 'horizontal_pull', primaryMuscles: ['upper_back', 'lats'], sortOrder: 280 },
  { slug: 'barbell_row', name: 'Barbell row', movementPattern: 'horizontal_pull', primaryMuscles: ['upper_back', 'lats'], sortOrder: 290 },
  { slug: 'dumbbell_row', name: 'Dumbbell row', movementPattern: 'horizontal_pull', primaryMuscles: ['upper_back', 'lats'], sortOrder: 300 },
  { slug: 'face_pull', name: 'Face pull', movementPattern: 'horizontal_pull', primaryMuscles: ['rear_delts', 'upper_back'], sortOrder: 310 },
  { slug: 'lateral_raise', name: 'Lateral raise', movementPattern: 'isolation', primaryMuscles: ['shoulders'], sortOrder: 320 },
  { slug: 'rear_delt_raise', name: 'Rear delt raise', movementPattern: 'isolation', primaryMuscles: ['rear_delts'], sortOrder: 330 },
  { slug: 'biceps_curl', name: 'Biceps curl', movementPattern: 'isolation', primaryMuscles: ['biceps'], sortOrder: 340 },
  { slug: 'triceps_extension', name: 'Triceps extension', movementPattern: 'isolation', primaryMuscles: ['triceps'], sortOrder: 350 },
  { slug: 'triceps_pushdown', name: 'Triceps pushdown', movementPattern: 'isolation', primaryMuscles: ['triceps'], sortOrder: 360 },
  { slug: 'leg_extension', name: 'Leg extension', movementPattern: 'isolation', primaryMuscles: ['quads'], sortOrder: 370 },
  { slug: 'leg_curl', name: 'Leg curl', movementPattern: 'isolation', primaryMuscles: ['hamstrings'], sortOrder: 380 },
  { slug: 'calf_raise', name: 'Calf raise', movementPattern: 'isolation', primaryMuscles: ['calves'], sortOrder: 390 },
  { slug: 'hip_abduction', name: 'Hip abduction', movementPattern: 'isolation', primaryMuscles: ['abductors', 'glutes'], sortOrder: 400 },
  { slug: 'hip_adduction', name: 'Hip adduction', movementPattern: 'isolation', primaryMuscles: ['adductors'], sortOrder: 410 },
  { slug: 'shrug', name: 'Shrug', movementPattern: 'isolation', primaryMuscles: ['traps'], sortOrder: 420 },
  { slug: 'kettlebell_swing', name: 'Kettlebell swing', movementPattern: 'hinge', primaryMuscles: ['glutes', 'hamstrings'], sortOrder: 430 },
  { slug: 'hanging_leg_raise', name: 'Hanging leg raise', movementPattern: 'core', primaryMuscles: ['abs', 'hip_flexors'], sortOrder: 440 },
  { slug: 'ab_crunch', name: 'Ab crunch', movementPattern: 'core', primaryMuscles: ['abs'], sortOrder: 450 },
  { slug: 'farmer_carry', name: 'Farmer carry', movementPattern: 'carry', primaryMuscles: ['forearms', 'traps', 'abs'], sortOrder: 460 },
  { slug: 'band_resistance', name: 'Band resistance', movementPattern: 'isolation', primaryMuscles: ['full_body'], sortOrder: 470 },
  { slug: 'steady_state_cardio', name: 'Steady-state cardio', movementPattern: 'cardio', primaryMuscles: ['full_body'], sortOrder: 480 },
  { slug: 'interval_cardio', name: 'Interval cardio', movementPattern: 'cardio', primaryMuscles: ['full_body'], sortOrder: 490 },
  { slug: 'low_impact_cardio', name: 'Low-impact cardio', movementPattern: 'cardio', primaryMuscles: ['full_body'], sortOrder: 500 },
];

export const EQUIPMENT_CATALOG: EquipmentSeed[] = [
  {
    slug: 'dumbbells',
    name: 'Dumbbells',
    category: 'free_weights',
    aliases: ['fixed dumbbells', 'hand weights', 'free weights'],
    sortOrder: 10,
    capabilities: ['dumbbell_bench_press', 'dumbbell_row', 'incline_press', 'shoulder_press', 'biceps_curl', 'lateral_raise', 'rear_delt_raise', 'goblet_squat', 'lunge_loaded', 'hip_hinge_loaded', 'shrug', 'step_up', 'farmer_carry', 'triceps_extension', 'chest_fly'],
  },
  {
    slug: 'adjustable_dumbbells',
    name: 'Adjustable dumbbells',
    category: 'free_weights',
    aliases: ['powerblock', 'selectorized dumbbells', 'dial dumbbells'],
    sortOrder: 20,
    capabilities: ['dumbbell_bench_press', 'dumbbell_row', 'incline_press', 'shoulder_press', 'biceps_curl', 'lateral_raise', 'rear_delt_raise', 'goblet_squat', 'lunge_loaded', 'hip_hinge_loaded', 'shrug', 'step_up', 'farmer_carry', 'triceps_extension', 'chest_fly'],
  },
  {
    slug: 'barbell',
    name: 'Barbell',
    category: 'free_weights',
    aliases: ['olympic bar', 'straight bar', 'bar'],
    sortOrder: 30,
    capabilities: ['back_squat', 'front_squat', 'hip_hinge_loaded', 'barbell_row', 'barbell_bench_press', 'shoulder_press', 'hip_thrust', 'lunge_loaded', 'shrug', 'biceps_curl'],
  },
  {
    slug: 'ez_bar',
    name: 'EZ curl bar',
    category: 'free_weights',
    aliases: ['curl bar', 'ez bar', 'easy bar'],
    sortOrder: 40,
    capabilities: ['biceps_curl', 'triceps_extension'],
  },
  {
    slug: 'weight_plates',
    name: 'Weight plates',
    category: 'free_weights',
    aliases: ['plates', 'bumper plates', 'iron plates'],
    sortOrder: 50,
    capabilities: [],
  },
  {
    slug: 'kettlebells',
    name: 'Kettlebells',
    category: 'free_weights',
    aliases: ['kettlebell', 'girya', 'cast iron bell'],
    sortOrder: 60,
    capabilities: ['kettlebell_swing', 'goblet_squat', 'hip_hinge_loaded', 'farmer_carry'],
  },
  {
    slug: 'adjustable_bench',
    name: 'Adjustable bench',
    category: 'benches_racks',
    aliases: ['incline bench', 'utility bench', 'multi-position bench'],
    sortOrder: 70,
    capabilities: ['dumbbell_bench_press', 'incline_press', 'dumbbell_row', 'step_up'],
  },
  {
    slug: 'flat_bench',
    name: 'Flat bench',
    category: 'benches_racks',
    aliases: ['weight bench', 'bench', 'flat weight bench'],
    sortOrder: 80,
    capabilities: ['dumbbell_bench_press', 'barbell_bench_press', 'step_up'],
  },
  {
    slug: 'squat_rack',
    name: 'Squat rack',
    category: 'benches_racks',
    aliases: ['squat stand', 'half rack', 'squat stands'],
    sortOrder: 90,
    capabilities: ['back_squat', 'front_squat', 'barbell_bench_press', 'shoulder_press'],
  },
  {
    slug: 'power_rack',
    name: 'Power rack',
    category: 'benches_racks',
    aliases: ['power cage', 'full rack', 'squat cage'],
    sortOrder: 100,
    capabilities: ['back_squat', 'front_squat', 'barbell_bench_press', 'shoulder_press', 'pull_up'],
  },
  {
    slug: 'smith_machine',
    name: 'Smith machine',
    category: 'plate_loaded',
    aliases: ['smith rack', 'guided barbell', 'smith press'],
    sortOrder: 110,
    capabilities: ['smith_squat', 'barbell_bench_press', 'incline_press', 'shoulder_press', 'lunge_loaded', 'hip_thrust', 'shrug', 'calf_raise'],
  },
  {
    slug: 'leg_press',
    name: 'Leg press',
    category: 'plate_loaded',
    aliases: ['45 degree leg press', 'sled leg press', 'seated leg press'],
    sortOrder: 120,
    capabilities: ['leg_press', 'calf_raise'],
  },
  {
    slug: 'hack_squat_machine',
    name: 'Hack squat machine',
    category: 'plate_loaded',
    aliases: ['hack squat', 'hack sled', 'reverse hack squat'],
    sortOrder: 130,
    capabilities: ['hack_squat'],
  },
  {
    slug: 'landmine',
    name: 'Landmine attachment',
    category: 'plate_loaded',
    aliases: ['landmine', 'landmine post', 'barbell pivot'],
    sortOrder: 140,
    capabilities: ['shoulder_press', 'barbell_row'],
  },
  {
    slug: 'cable_machine',
    name: 'Cable machine',
    category: 'cable',
    aliases: ['cable station', 'cable tower', 'pulley machine'],
    sortOrder: 150,
    capabilities: ['cable_fly', 'cable_row', 'lat_pulldown', 'triceps_pushdown', 'triceps_extension', 'biceps_curl', 'face_pull', 'lateral_raise', 'rear_delt_raise'],
  },
  {
    slug: 'functional_trainer',
    name: 'Functional trainer',
    category: 'cable',
    aliases: ['dual cable machine', 'cable crossover', 'dual adjustable pulley'],
    sortOrder: 160,
    capabilities: ['cable_row', 'cable_fly', 'lat_pulldown', 'triceps_pushdown', 'triceps_extension', 'biceps_curl', 'lateral_raise', 'face_pull', 'rear_delt_raise'],
  },
  {
    slug: 'lat_pulldown',
    name: 'Lat pulldown machine',
    category: 'selectorized',
    aliases: ['pulldown machine', 'lat pull machine', 'lat machine'],
    sortOrder: 170,
    capabilities: ['lat_pulldown'],
  },
  {
    slug: 'seated_row_machine',
    name: 'Seated row machine',
    category: 'selectorized',
    aliases: ['row machine', 'low row machine', 'seated cable row'],
    sortOrder: 180,
    capabilities: ['seated_row'],
  },
  {
    slug: 'chest_press_machine',
    name: 'Chest press machine',
    category: 'selectorized',
    aliases: ['machine chest press', 'seated chest press', 'bench press machine'],
    sortOrder: 190,
    capabilities: ['chest_press'],
  },
  {
    slug: 'shoulder_press_machine',
    name: 'Shoulder press machine',
    category: 'selectorized',
    aliases: ['machine shoulder press', 'seated shoulder press', 'overhead press machine'],
    sortOrder: 200,
    capabilities: ['machine_shoulder_press'],
  },
  {
    slug: 'pec_deck_machine',
    name: 'Pec deck / rear delt machine',
    category: 'selectorized',
    aliases: ['pec deck', 'butterfly machine', 'rear delt fly machine', 'chest fly machine'],
    sortOrder: 210,
    capabilities: ['pec_deck', 'reverse_pec_deck'],
  },
  {
    slug: 'leg_extension_machine',
    name: 'Leg extension machine',
    category: 'selectorized',
    aliases: ['leg extension', 'quad extension', 'quad machine'],
    sortOrder: 220,
    capabilities: ['leg_extension'],
  },
  {
    slug: 'leg_curl_machine',
    name: 'Leg curl machine',
    category: 'selectorized',
    aliases: ['hamstring curl machine', 'seated leg curl', 'lying leg curl'],
    sortOrder: 230,
    capabilities: ['leg_curl'],
  },
  {
    slug: 'hip_abductor_machine',
    name: 'Hip abductor/adductor machine',
    category: 'selectorized',
    aliases: ['hip abduction machine', 'inner outer thigh machine', 'adductor machine'],
    sortOrder: 240,
    capabilities: ['hip_abduction', 'hip_adduction'],
  },
  {
    slug: 'calf_raise_machine',
    name: 'Calf raise machine',
    category: 'selectorized',
    aliases: ['standing calf raise', 'seated calf raise', 'calf machine'],
    sortOrder: 250,
    capabilities: ['calf_raise'],
  },
  {
    slug: 'assisted_pullup_machine',
    name: 'Assisted pull-up / dip machine',
    category: 'selectorized',
    aliases: ['assisted pull up machine', 'gravitron', 'assisted dip machine'],
    sortOrder: 260,
    capabilities: ['assisted_pull_up'],
  },
  {
    slug: 'back_extension_bench',
    name: 'Back extension bench',
    category: 'benches_racks',
    aliases: ['hyperextension bench', 'roman chair', 'back extension'],
    sortOrder: 270,
    capabilities: ['back_extension'],
  },
  {
    slug: 'treadmill',
    name: 'Treadmill',
    category: 'cardio',
    aliases: ['running machine', 'walking machine', 'jogging machine'],
    sortOrder: 280,
    capabilities: ['steady_state_cardio', 'interval_cardio'],
  },
  {
    slug: 'stationary_bike',
    name: 'Stationary bike',
    category: 'cardio',
    aliases: ['exercise bike', 'spin bike', 'upright bike', 'recumbent bike'],
    sortOrder: 290,
    capabilities: ['steady_state_cardio', 'interval_cardio', 'low_impact_cardio'],
  },
  {
    slug: 'elliptical',
    name: 'Elliptical',
    category: 'cardio',
    aliases: ['elliptical trainer', 'cross trainer', 'elliptical machine'],
    sortOrder: 300,
    capabilities: ['steady_state_cardio', 'interval_cardio', 'low_impact_cardio'],
  },
  {
    slug: 'rowing_machine',
    name: 'Rowing machine',
    category: 'cardio',
    aliases: ['rower', 'ergometer', 'erg'],
    sortOrder: 310,
    capabilities: ['steady_state_cardio', 'interval_cardio', 'low_impact_cardio'],
  },
  {
    slug: 'stair_climber',
    name: 'Stair climber',
    category: 'cardio',
    aliases: ['stair stepper', 'stairmaster', 'step mill'],
    sortOrder: 320,
    capabilities: ['steady_state_cardio', 'interval_cardio'],
  },
  {
    slug: 'pull_up_bar',
    name: 'Pull-up bar',
    category: 'bodyweight',
    aliases: ['chin-up bar', 'doorway pull-up bar', 'pull up station'],
    sortOrder: 330,
    capabilities: ['pull_up'],
  },
  {
    slug: 'dip_station',
    name: 'Dip station',
    category: 'bodyweight',
    aliases: ['parallel bars', 'dip bars', 'dip stand'],
    sortOrder: 340,
    capabilities: ['dip', 'hanging_leg_raise'],
  },
  {
    slug: 'captains_chair',
    name: "Captain's chair",
    category: 'bodyweight',
    aliases: ['vertical knee raise', 'leg raise station', 'knee raise tower'],
    sortOrder: 350,
    capabilities: ['hanging_leg_raise'],
  },
  {
    slug: 'plyo_box',
    name: 'Plyo box / step',
    category: 'accessories',
    aliases: ['plyometric box', 'jump box', 'aerobic step'],
    sortOrder: 360,
    capabilities: ['step_up'],
  },
  {
    slug: 'resistance_bands',
    name: 'Resistance bands',
    category: 'accessories',
    aliases: ['exercise bands', 'loop bands', 'tube bands'],
    sortOrder: 370,
    capabilities: ['band_resistance'],
  },
  {
    slug: 'suspension_trainer',
    name: 'Suspension trainer (TRX)',
    category: 'accessories',
    aliases: ['trx', 'suspension straps', 'gymnastic rings'],
    sortOrder: 380,
    capabilities: ['push_up', 'seated_row'],
  },
  {
    slug: 'ab_wheel',
    name: 'Ab wheel',
    category: 'accessories',
    aliases: ['ab roller', 'roller wheel', 'core wheel'],
    sortOrder: 390,
    capabilities: ['ab_crunch'],
  },
  {
    slug: 'medicine_ball',
    name: 'Medicine ball',
    category: 'accessories',
    aliases: ['med ball', 'slam ball', 'weighted ball'],
    sortOrder: 400,
    capabilities: [],
  },
  {
    slug: 'yoga_mat',
    name: 'Mat',
    category: 'accessories',
    aliases: ['yoga mat', 'exercise mat', 'floor mat'],
    sortOrder: 410,
    capabilities: ['ab_crunch', 'push_up'],
  },
];

// =============================================================================
// Exercise library (E4.1)
// =============================================================================
//
// Slugs are PERMANENT once seeded: the seed upserts by slug and workouts will
// reference the rows. Custom (user-owned) exercises are not part of this
// catalog and the seed never touches them.
//
// Notation, one exercise per line:
//   slug | Name | primary; secondary | pattern | requirements | flags
// Requirements: `E:a|b` is a group of equipment types (any one satisfies it),
// `C:x|y` a group of capabilities (any one satisfies it); groups are joined by
// ` + ` (every group must be satisfied); `-` means no requirement. Flags (comma
// separated, optional): BW bodyweight, U unilateral, T time tracking, D
// distance+time tracking. Tracking mode: none -> weight_reps; BW alone ->
// bodyweight_reps; T -> time; D -> distance_time.

export const EXERCISE_TRACKING_MODES = [
  'weight_reps', 'bodyweight_reps', 'time', 'distance_time',
] as const;
export type ExerciseTrackingMode = (typeof EXERCISE_TRACKING_MODES)[number];

export interface ExerciseRequirementGroupSeed {
  kind: 'equipment' | 'capability';
  /** Equipment type slugs or capability slugs (OR within the group). */
  slugs: string[];
}

export interface ExerciseSeed {
  slug: string;
  name: string;
  primaryMuscles: Muscle[];
  secondaryMuscles: Muscle[];
  movementPattern: MovementPattern;
  trackingMode: ExerciseTrackingMode;
  isUnilateral: boolean;
  isBodyweight: boolean;
  /** AND of groups; index in this array is the row's `groupIndex`. */
  requirements: ExerciseRequirementGroupSeed[];
}

const EXERCISE_LINES: string[] = [
  'barbell_bench_press | Barbell bench press | chest; triceps,shoulders | horizontal_push | E:barbell + E:flat_bench|adjustable_bench',
  'dumbbell_bench_press | Dumbbell bench press | chest; triceps,shoulders | horizontal_push | E:dumbbells|adjustable_dumbbells + E:flat_bench|adjustable_bench',
  'incline_dumbbell_press | Incline dumbbell press | chest; shoulders,triceps | horizontal_push | E:dumbbells|adjustable_dumbbells + E:adjustable_bench',
  'incline_barbell_press | Incline barbell press | chest; shoulders,triceps | horizontal_push | E:barbell + E:adjustable_bench',
  'machine_chest_press | Machine chest press | chest; triceps | horizontal_push | C:chest_press',
  'dumbbell_fly | Dumbbell fly | chest; shoulders | isolation | E:dumbbells|adjustable_dumbbells + E:flat_bench|adjustable_bench',
  'cable_fly | Cable fly | chest; shoulders | isolation | C:cable_fly',
  'pec_deck | Pec deck | chest | isolation | C:pec_deck',
  'push_up | Push-up | chest; triceps,shoulders | horizontal_push | - | BW',
  'diamond_push_up | Diamond push-up | triceps; chest | horizontal_push | - | BW',
  'dip | Dip | triceps; chest,shoulders | vertical_push | C:dip | BW',
  'bench_dip | Bench dip | triceps; chest | vertical_push | E:flat_bench|adjustable_bench|plyo_box | BW',
  'barbell_overhead_press | Barbell overhead press | shoulders; triceps | vertical_push | E:barbell',
  'dumbbell_shoulder_press | Dumbbell shoulder press | shoulders; triceps | vertical_push | E:dumbbells|adjustable_dumbbells',
  'arnold_press | Arnold press | shoulders; triceps | vertical_push | E:dumbbells|adjustable_dumbbells',
  'machine_shoulder_press | Machine shoulder press | shoulders; triceps | vertical_push | C:machine_shoulder_press',
  'landmine_press | Landmine press | shoulders; chest,triceps | vertical_push | E:landmine | U',
  'dumbbell_lateral_raise | Dumbbell lateral raise | shoulders | isolation | E:dumbbells|adjustable_dumbbells',
  'cable_lateral_raise | Cable lateral raise | shoulders | isolation | E:cable_machine|functional_trainer | U',
  'dumbbell_rear_delt_raise | Dumbbell rear delt raise | rear_delts; upper_back | isolation | E:dumbbells|adjustable_dumbbells',
  'reverse_pec_deck | Reverse pec deck | rear_delts; upper_back | isolation | C:reverse_pec_deck',
  'face_pull | Face pull | rear_delts; upper_back,shoulders | horizontal_pull | C:face_pull',
  'pike_push_up | Pike push-up | shoulders; triceps | vertical_push | - | BW',
  'pull_up | Pull-up | lats; biceps,upper_back | vertical_pull | C:pull_up | BW',
  'chin_up | Chin-up | lats,biceps; upper_back | vertical_pull | C:pull_up | BW',
  'assisted_pull_up | Assisted pull-up | lats; biceps | vertical_pull | C:assisted_pull_up',
  'lat_pulldown | Lat pulldown | lats; biceps,upper_back | vertical_pull | C:lat_pulldown',
  'seated_cable_row | Seated row | upper_back,lats; biceps | horizontal_pull | C:seated_row|cable_row',
  'barbell_row | Barbell row | upper_back,lats; biceps,lower_back | horizontal_pull | E:barbell',
  'dumbbell_row | One-arm dumbbell row | lats,upper_back; biceps | horizontal_pull | E:dumbbells|adjustable_dumbbells | U',
  't_bar_row | T-bar row | upper_back,lats; biceps | horizontal_pull | E:landmine',
  'inverted_row | Inverted row | upper_back; biceps,lats | horizontal_pull | E:smith_machine|power_rack|squat_rack|suspension_trainer | BW',
  'back_extension | Back extension | lower_back; glutes,hamstrings | hinge | C:back_extension | BW',
  'dumbbell_shrug | Dumbbell shrug | traps | isolation | E:dumbbells|adjustable_dumbbells',
  'barbell_shrug | Barbell shrug | traps | isolation | E:barbell',
  'dumbbell_pullover | Dumbbell pullover | lats; chest | isolation | E:dumbbells|adjustable_dumbbells + E:flat_bench|adjustable_bench',
  'barbell_back_squat | Barbell back squat | quads,glutes; hamstrings,lower_back | squat | E:barbell + E:squat_rack|power_rack',
  'front_squat | Front squat | quads; glutes,abs | squat | E:barbell + E:squat_rack|power_rack',
  'smith_machine_squat | Smith machine squat | quads,glutes | squat | E:smith_machine',
  'goblet_squat | Goblet squat | quads,glutes; abs | squat | C:goblet_squat',
  'leg_press | Leg press | quads,glutes; hamstrings | squat | C:leg_press',
  'hack_squat | Hack squat | quads; glutes | squat | C:hack_squat',
  'bodyweight_squat | Bodyweight squat | quads,glutes | squat | - | BW',
  'bulgarian_split_squat | Bulgarian split squat | quads,glutes; hamstrings | lunge | E:flat_bench|adjustable_bench|plyo_box | BW,U',
  'walking_lunge | Walking lunge | quads,glutes; hamstrings | lunge | - | BW,U',
  'reverse_lunge | Reverse lunge | quads,glutes | lunge | - | BW,U',
  'dumbbell_lunge | Dumbbell lunge | quads,glutes; hamstrings | lunge | E:dumbbells|adjustable_dumbbells | U',
  'step_up | Step-up | quads,glutes | lunge | C:step_up | BW,U',
  'conventional_deadlift | Conventional deadlift | hamstrings,glutes,lower_back; upper_back,quads,forearms | hinge | E:barbell',
  'romanian_deadlift | Romanian deadlift | hamstrings,glutes; lower_back | hinge | E:barbell',
  'dumbbell_romanian_deadlift | Dumbbell Romanian deadlift | hamstrings,glutes; lower_back | hinge | E:dumbbells|adjustable_dumbbells',
  'good_morning | Good morning | hamstrings,lower_back; glutes | hinge | E:barbell',
  'kettlebell_swing | Kettlebell swing | glutes,hamstrings; lower_back,shoulders | hinge | C:kettlebell_swing',
  'hip_thrust | Hip thrust | glutes; hamstrings | hinge | C:hip_thrust + E:flat_bench|adjustable_bench|plyo_box',
  'glute_bridge | Glute bridge | glutes; hamstrings | hinge | - | BW',
  'leg_extension | Leg extension | quads | isolation | C:leg_extension',
  'leg_curl | Leg curl | hamstrings; calves | isolation | C:leg_curl',
  'calf_raise | Calf raise | calves | isolation | C:calf_raise',
  'bodyweight_calf_raise | Bodyweight calf raise | calves | isolation | - | BW',
  'hip_abduction_machine | Hip abduction | abductors,glutes | isolation | C:hip_abduction',
  'hip_adduction_machine | Hip adduction | adductors | isolation | C:hip_adduction',
  'wall_sit | Wall sit | quads; glutes | squat | - | BW,T',
  'barbell_curl | Barbell curl | biceps; forearms | isolation | E:barbell|ez_bar',
  'ez_bar_curl | EZ-bar curl | biceps; forearms | isolation | E:ez_bar',
  'dumbbell_curl | Dumbbell curl | biceps; forearms | isolation | E:dumbbells|adjustable_dumbbells',
  'hammer_curl | Hammer curl | biceps,forearms | isolation | E:dumbbells|adjustable_dumbbells',
  'cable_curl | Cable curl | biceps | isolation | E:cable_machine|functional_trainer',
  'triceps_pushdown | Triceps pushdown | triceps | isolation | C:triceps_pushdown',
  'dumbbell_overhead_triceps_extension | Dumbbell overhead triceps extension | triceps | isolation | E:dumbbells|adjustable_dumbbells',
  'skull_crusher | Skull crusher | triceps | isolation | E:ez_bar|barbell + E:flat_bench|adjustable_bench',
  'close_grip_bench_press | Close-grip bench press | triceps; chest,shoulders | horizontal_push | E:barbell + E:flat_bench|adjustable_bench',
  'wrist_curl | Wrist curl | forearms | isolation | E:dumbbells|adjustable_dumbbells|barbell',
  'plank | Plank | abs; obliques,shoulders | core | - | BW,T',
  'side_plank | Side plank | obliques; abs | core | - | BW,T,U',
  'crunch | Crunch | abs | core | - | BW',
  'bicycle_crunch | Bicycle crunch | abs,obliques | core | - | BW',
  'russian_twist | Russian twist | obliques; abs | core | - | BW',
  'dead_bug | Dead bug | abs; hip_flexors | core | - | BW',
  'hanging_leg_raise | Hanging leg raise | abs; hip_flexors | core | C:hanging_leg_raise | BW',
  'cable_crunch | Cable crunch | abs | core | E:cable_machine|functional_trainer',
  'ab_wheel_rollout | Ab wheel rollout | abs; shoulders | core | E:ab_wheel | BW',
  'pallof_press | Pallof press | obliques; abs | core | E:cable_machine|functional_trainer | U',
  'farmers_carry | Farmer\'s carry | forearms,traps; abs | carry | C:farmer_carry | D',
  'mountain_climber | Mountain climber | abs; full_body | core | - | BW,T',
  'treadmill_run | Treadmill run | full_body | cardio | E:treadmill | D',
  'treadmill_incline_walk | Treadmill incline walk | full_body | cardio | E:treadmill | D',
  'stationary_bike_ride | Stationary bike | full_body | cardio | E:stationary_bike | D',
  'elliptical_session | Elliptical | full_body | cardio | E:elliptical | D',
  'rowing_machine_session | Rowing machine | full_body | cardio | E:rowing_machine | D',
  'stair_climber_session | Stair climber | full_body | cardio | E:stair_climber | D',
  'outdoor_run | Outdoor run | full_body | cardio | - | D',
  'jump_rope | Jump rope | full_body | cardio | - | BW,T',
  'burpee | Burpee | full_body | cardio | - | BW',
  'band_pull_apart | Band pull-apart | rear_delts; upper_back | horizontal_pull | E:resistance_bands',
];

function parseExerciseLine(line: string): ExerciseSeed {
  const parts = line.split(' | ').map((p) => p.trim());
  if (parts.length < 5 || parts.length > 6) {
    throw new Error(`Malformed exercise line: ${line}`);
  }
  const [slug, name, muscles, pattern, reqs, flagsRaw = ''] = parts;
  const [primary, secondary = ''] = muscles.split(';').map((m) => m.trim());
  const list = (s: string) => (s ? s.split(',').map((x) => x.trim()) : []);
  const flags = new Set(list(flagsRaw));
  for (const f of flags) {
    if (!['BW', 'U', 'T', 'D'].includes(f)) {
      throw new Error(`Exercise "${slug}" has unknown flag "${f}"`);
    }
  }
  const trackingMode: ExerciseTrackingMode = flags.has('T')
    ? 'time'
    : flags.has('D')
      ? 'distance_time'
      : flags.has('BW')
        ? 'bodyweight_reps'
        : 'weight_reps';
  const requirements: ExerciseRequirementGroupSeed[] =
    reqs === '-'
      ? []
      : reqs.split(' + ').map((g) => {
          const [prefix, rest] = [g.slice(0, 2), g.slice(2)];
          if (prefix !== 'E:' && prefix !== 'C:') {
            throw new Error(`Exercise "${slug}" has malformed group "${g}"`);
          }
          return {
            kind: prefix === 'E:' ? 'equipment' : 'capability',
            slugs: rest.split('|').map((s) => s.trim()),
          };
        });
  return {
    slug,
    name,
    primaryMuscles: list(primary) as Muscle[],
    secondaryMuscles: list(secondary) as Muscle[],
    movementPattern: pattern as MovementPattern,
    trackingMode,
    isUnilateral: flags.has('U'),
    isBodyweight: flags.has('BW'),
    requirements,
  };
}

export const EXERCISE_CATALOG: ExerciseSeed[] = EXERCISE_LINES.map(parseExerciseLine);
