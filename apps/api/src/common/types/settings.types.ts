import type {
  DataTablesValue,
  NavigationValue,
  NotificationsValue,
} from '../schemas/user-settings-namespaces.schema';
import {
  DEFAULT_MAINTENANCE_MESSAGE,
  type UserProfileSettingsValue,
  type SystemNotificationsValue,
  type SystemJobsValue,
  type SystemNodesValue,
  type SystemDatabaseBackupValue,
  type SystemMaintenanceValue,
  type SystemStorageValue,
  type SystemAiValue,
  type SystemTelemetryValue,
  type UserAiSettingsValue,
} from '../schemas/settings.schema';

// =============================================================================
// Settings Type Definitions
// =============================================================================

/**
 * User settings schema - stored in user_settings.value JSONB
 */
export interface UserSettingsValue {
  theme: 'light' | 'dark' | 'system';
  /**
   * Profile preferences (#367). `imageSource` chooses which picture represents
   * the user: none, the OAuth provider's picture, or one they uploaded.
   * `imageObjectId` is the uploaded avatar's `storage_objects` id and is kept
   * when the source is switched away from `upload`, so switching back does not
   * need a second upload. Derived from the zod schema so the two cannot drift.
   *
   * Rows written before #367 carry `useProviderImage`/`customImageUrl` instead;
   * they are normalised on read by `normalizeProfileSettings`
   * (common/profile-image/profile-image.ts), never migrated.
   */
  profile: UserProfileSettingsValue;
  /**
   * Per-table view preferences, keyed by table id.
   *
   * Optional on purpose, and derived from the zod schema so the two can never
   * drift. Absent means "the user has expressed no table preferences yet" —
   * NOT "empty preferences". See user-settings-namespaces.schema.ts.
   */
  dataTables?: DataTablesValue;
  /**
   * Navigation chrome preferences. Absent means "use built-in defaults".
   */
  navigation?: NavigationValue;
  /**
   * Per-channel, per-event notification preferences (#126), channel-outer:
   * `{ email: { 'user.welcome': false } }`.
   *
   * SPARSE AND OPTIONAL AT EVERY LEVEL. Absent namespace, absent channel and
   * absent event key all mean the same thing — "use the event's
   * `defaultEnabled` from the registry" — which is what lets this feature ship
   * with no migration and no backfill, and is why an untouched account is not
   * muted. The dispatcher resolves it; see
   * notifications/notification-preferences.ts.
   */
  notifications?: NotificationsValue;
  /**
   * AI preferences (#423, epic #419, umbrella #418): which (provider, model)
   * an AI surface should pre-select. Absent means "no default model chosen"
   * — the same sparse-optional contract every namespace above follows, so an
   * untouched account is not materialised with a preference nobody set.
   *
   * NON-SECRET ONLY: a user's own provider key is `UserAiKey.secret`, in its
   * own table, never here. See `userAiSettingsSchema` for the full argument.
   */
  ai?: UserAiSettingsValue;
}

/**
 * System settings schema - stored in system_settings.value JSONB
 */
export interface SystemSettingsValue {
  /**
   * Deployment-wide browser-notification policy (#225, epic #215).
   *
   * REQUIRED, not optional, and modelled rather than an untyped flag — see
   * `systemNotificationsSchema` in schemas/settings.schema.ts for the full
   * argument. Required is what makes a PUT that omits the block a loud 400
   * instead of a silent reset: the value being reset would be an operator's
   * decision to turn a delivery channel OFF, and silently turning it back on is
   * the one failure mode a security-adjacent gate must not have.
   *
   * Derived from the zod schema so the two cannot drift, exactly as the user
   * settings namespaces above are.
   */
  notifications: SystemNotificationsValue;
  /**
   * Operations namespaces (#256, epic #254): the job queue, the worker fleet,
   * database backup/restore and the maintenance window.
   *
   * REQUIRED, exactly like `notifications` above and for the same reason: this
   * type describes the value this code works with, and every read of the column
   * goes through `readKnownSettings`, which fills each block from
   * `DEFAULT_SYSTEM_SETTINGS` when storage has nothing. A consumer therefore
   * never has to ask whether a block is there, which is the whole point of
   * declaring them before the consumers exist — an optional field would push a
   * `?? DEFAULT` into every future call site, and one of those would be
   * forgotten.
   *
   * A row written before this issue genuinely lacks these keys on disk. That is
   * not a contradiction: `readKnownSettings` is the boundary where "what is on
   * disk" becomes "what this type promises", and the first write after this
   * ships materialises the blocks with their defaults.
   *
   * Derived from the zod schemas so the two cannot drift, as everything else
   * here is.
   */
  jobs: SystemJobsValue;
  nodes: SystemNodesValue;
  databaseBackup: SystemDatabaseBackupValue;
  maintenance: SystemMaintenanceValue;
  /**
   * Object-storage provider configuration (#373, epic #372): which provider,
   * which bucket, and the non-secret half of the credential.
   *
   * REQUIRED, like every namespace above it and for the same reason —
   * `readKnownSettings` completes it from `DEFAULT_SYSTEM_SETTINGS` on every
   * read, so no consumer has to write `?? DEFAULT` and none of them can forget
   * to. "Not configured" is expressed by empty strings INSIDE the block, never
   * by the block being absent; see `systemStorageSchema`.
   *
   * THE SECRET ACCESS KEY IS NOT PART OF THIS TYPE and must not be added to it:
   * it lives in the encrypted credential store at
   * `(purpose 'storage', name 'default')`. `accessKeyId` is here because it is
   * an identifier, not a credential. Both points are argued in full, and proved
   * at compile time, in `schemas/settings.schema.ts`.
   *
   * Derived from the zod schema so the two cannot drift, as everything else
   * here is.
   */
  storage: SystemStorageValue;
  /**
   * Deployment-wide AI platform policy (#423, epic #419, umbrella #418):
   * whether AI is enabled at all, how a call sources its API key, per-provider
   * configuration, and the deployment-wide defaults a call cannot exceed.
   *
   * REQUIRED, like every namespace above it and for the same reason —
   * `readKnownSettings` completes it from `DEFAULT_SYSTEM_SETTINGS` on every
   * read, so no consumer has to write `?? DEFAULT` and none of them can forget
   * to.
   *
   * THIS ISSUE OWNS SCHEMA ONLY: nothing in this build reads `ai.enabled` to
   * gate a route, and no controller lets a caller run a model yet (#427,
   * #428, #431, #432).
   *
   * NO API KEY IS PART OF THIS TYPE and none must be added to it: a user's own
   * key is `UserAiKey.secret`, ciphertext in its own table; an org-wide
   * fallback key belongs in the encrypted credential store. Both points are
   * argued in full, and proved at compile time, in `schemas/settings.schema.ts`.
   *
   * Derived from the zod schema so the two cannot drift, as everything else
   * here is.
   */
  ai: SystemAiValue;
  /**
   * Telemetry policy (epic #528, story #533): whether telemetry is collected
   * at all, how long it is retained, the bounds an ad-hoc query is held to,
   * and the AI assistant that may be pointed at it.
   *
   * REQUIRED, like every namespace above it and for the same reason —
   * `readKnownSettings` completes it from `DEFAULT_SYSTEM_SETTINGS` on every
   * read, so no consumer has to write `?? DEFAULT` and none of them can forget
   * to.
   *
   * NO CREDENTIAL IS PART OF THIS TYPE and none must be added to it: the
   * assistant's provider key is resolved through `AiKeyResolver`, exactly as
   * every other AI call resolves one. Proved at compile time in
   * `schemas/settings.schema.ts`.
   *
   * Derived from the zod schema so the two cannot drift, as everything else
   * here is.
   */
  telemetry: SystemTelemetryValue;
}

/**
 * Default user settings
 */
// NOTE: `dataTables`, `navigation` and `notifications` are intentionally NOT
// listed here.
// Seeding them would turn "absent" into "explicitly empty", which is exactly
// the failure mode the namespaces are designed to avoid (a frozen column set
// that silently hides every column added later, or a notification preference
// map that freezes a user at the defaults of the day they first saved).
export const DEFAULT_USER_SETTINGS: UserSettingsValue = {
  theme: 'system',
  profile: {
    imageSource: 'provider',
    imageObjectId: null,
  },
};

/**
 * Default system settings
 */
export const DEFAULT_SYSTEM_SETTINGS: SystemSettingsValue = {
  // ON by default, suppressing nothing. The opposite default would mean a fresh
  // deployment ships with a delivery channel silently off and no indication
  // anywhere that it was ever available — an operator opts OUT of browser
  // notifications, never into them.
  notifications: {
    browserEnabled: true,
    disabledEvents: [],
  },
  // ---------------------------------------------------------------------------
  // Operations namespaces (#256, epic #254)
  // ---------------------------------------------------------------------------
  //
  // THE ONE PLACE THESE NUMBERS LIVE. None of the schemas carries a
  // `.default()`, deliberately: a default in zod is applied by whichever
  // `parse` runs first, which makes "what does a fresh deployment do?" a
  // question you answer by reading parse call sites. Here it is a question you
  // answer by reading this object.
  //
  // Every value below is also chosen to be INERT. `jobs.history.purgeEnabled`
  // is the only one that is on, and it only bounds a table nothing writes to
  // yet; backups ship disabled, and so does the maintenance window. A default
  // that started doing something on upgrade would be a behaviour change smuggled
  // in by a schema-only issue.
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
    // ⚠ OFF, AND THE DEFAULT IS THE POINT (#349, epic #345). A fresh
    // deployment does not hand its worker fleet credentials to its own
    // database because somebody registered a node; an administrator turns
    // this on deliberately, having decided that those machines are inside the
    // trust boundary. Fail-closed also means a settings row that cannot be
    // read degrades to "no credentials for anyone", which is the safe
    // direction — unlike the fleet's other three values, where degrading to
    // the shipped policy is the safe direction.
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
    // EMPTY MEANS "WHATEVER PROVIDER IS ACTIVE", and that is the only honest
    // default (#373, epic #372). This field is a PIN: a non-empty value must
    // equal `storage.provider` or every backup is a loud 400
    // (`db-backup/db-backup-storage.ts`), which is exactly what should happen
    // to a value an operator typed and then contradicted. It is exactly what
    // should NOT happen to a value they never typed — and shipping the literal
    // `'s3'` here did precisely that: once `storage.provider` became a live
    // setting, every deployment that selected R2 inherited a pin on `s3` and
    // failed EVERY backup, from `queueBackup`, `startBackup`, `runQueuedBackup`
    // and `PUT config` alike, on nobody's decision. Empty is inert in the same
    // sense as the rest of this block: it defers, it does not choose.
    storageProvider: '',
    runStaleMinutes: 120,
    compressionLevel: 6,
    restoreRollbackMode: 'retain_database',
    oldDatabaseRetentionHours: 48,
    // OFF, like `nodes.jobSecretBrokerEnabled` and for a related-but-distinct
    // reason (#352, epic #345): a fresh deployment does not ship its entire
    // database off the API server because somebody registered a worker node.
    // Both switches must be on, and the credential broker must report itself
    // usable, before `db.backup.run` is offered to a node at all.
    nodeOffloadEnabled: false,
  },
  maintenance: {
    enabled: false,
    // Shared with the schema so the banner's copy and its validation cannot
    // disagree, and so a fork renaming its product finds no product name here
    // to rename.
    message: DEFAULT_MAINTENANCE_MESSAGE,
    allowAdmins: true,
    startedAt: null,
    startedById: null,
  },
  // ---------------------------------------------------------------------------
  // Storage provider configuration (#373, epic #372)
  // ---------------------------------------------------------------------------
  //
  // UNCONFIGURED: `provider: 's3'` names the shape the empty fields would be
  // filled in for, and every field that would actually make a request go
  // somewhere is empty. These are now the ONLY source of a storage
  // configuration — `STORAGE_PROVIDER`/`S3_*` were removed in #377 — so a fresh
  // deployment refuses storage operations with a 503 naming the empty fields
  // until an administrator fills them in at /admin/settings/storage.
  //
  // `'s3'` rather than `null` because `provider` is a closed enum with no "none"
  // member: "no storage configured" is `bucket === ''`, one question with one
  // answer, instead of a second way to spell the same state that every consumer
  // would then have to check for separately.
  storage: {
    provider: 's3',
    bucket: '',
    // Empty, not 'us-east-1'. Inheriting a region nobody chose is how a
    // deployment gets "the bucket you are attempting to access must be
    // addressed using the specified endpoint" from a settings page that looks
    // filled in. R2 wants the literal 'auto' here.
    region: '',
    // Empty means "derive it, or let the SDK use its own host".
    endpoint: '',
    // R2 only; the account-scoped endpoint is derived from it.
    accountId: '',
    // The IDENTIFIER half of the credential. Its secret half is never here —
    // it goes to the credential store at `(purpose 'storage', name 'default')`.
    accessKeyId: '',
    // `null`, NOT `false` — "use this vendor's convention" (path style for
    // `s3compatible`, virtual-host style for `s3` and `r2`). A default of
    // `false` is an operator's answer nobody gave, and it reached the driver
    // as one: it suppressed the per-vendor default and broke MinIO. Same rule
    // as the empty strings above, spelled the way a boolean has to spell it.
    forcePathStyle: null,
  },
  // ---------------------------------------------------------------------------
  // AI platform policy (#423, epic #419, umbrella #418)
  // ---------------------------------------------------------------------------
  //
  // OFF, and INERT: `enabled: false` is the point, matching every other
  // feature namespace that ships ahead of its own UI (`databaseBackup
  // .enabled`, `nodes.jobSecretBrokerEnabled`) — a fresh deployment does not
  // gain an AI capability nobody asked for by this namespace merely existing.
  // `byok` is the default key policy: every call uses its caller's own
  // saved key, with no deployment-wide fallback key to reason about or
  // secure. `allowBackgroundRuns: true` mirrors `jobs.history.purgeEnabled`
  // being the one "on" value in the operations block above — the queue is
  // this application's normal way of doing anything that takes a while, and
  // a deployment that has not thought about AI at all should not have
  // quietly disabled that path. `logPromptContent: false` is a deliberate,
  // named privacy default: prompt text may carry a user's own sensitive
  // input, and it must not land in a log line nobody scoped for that.
  ai: {
    enabled: false,
    keyPolicy: 'byok',
    providers: {
      openai: {
        enabled: false,
      },
      // #446 — off, like every provider slot: enabling one is an
      // administrator's decision, made alongside its key.
      anthropic: {
        enabled: false,
      },
      // #447 — off, like every provider slot.
      gemini: {
        enabled: false,
      },
      // #448 — off, and with no endpoint: each needs a `baseUrl` before it can
      // be enabled. Every other field is optional and absent means its default.
      'azure-openai': {
        enabled: false,
      },
      'openai-compatible': {
        enabled: false,
      },
    },
    defaults: {
      allowBackgroundRuns: true,
      // #449: realtime voice sessions OFF — minting one hands the browser an
      // ephemeral provider secret and the server stops seeing the call.
      allowRealtime: false,
    },
    logPromptContent: false,
    // #443: `ai_usage_events` kept 180 days — twice the longest usage report
    // window, so a 90-day report never reads a half-purged range.
    usageRetentionDays: 180,
    // #442: every provider-hosted tool OFF — each reaches outside the
    // deployment and bills per use, so it is an administrator's decision.
    hostedTools: {
      web_search: false,
      file_search: false,
      code_interpreter: false,
      image_generation: false,
      mcp: false,
      mcpAllowedHosts: [],
    },
    // #450: no limits — every field of `ai.limits` is optional and absent
    // means unlimited, so an upgrade never starts refusing calls by itself.
    limits: {},
  },
  // ---------------------------------------------------------------------------
  // Telemetry policy (epic #528, story #533)
  // ---------------------------------------------------------------------------
  //
  // OFF, and INERT, matching every namespace above it that ships ahead of its
  // own consumers (`databaseBackup.enabled`, `ai.enabled`): a fresh
  // deployment does not start collecting or retaining observability data
  // nobody asked for merely because this namespace exists.
  telemetry: {
    enabled: false,
    retentionDays: 30,
    // #565: `null` means "follow `APP_SLUG`" — resolved at the point of use
    // (`resolveTelemetryInstanceId`), so a renamed fork follows its new name
    // until an administrator overrides it. Storing the slug literally here
    // would freeze it at the first write. A row written before this field
    // existed lacks it, fails the field's own parse in `readNamespace`, and
    // reads back as this `null` — no migration.
    instanceId: null,
    query: {
      maxRows: 10000,
      timeoutSeconds: 30,
    },
    assistant: {
      // OFF, on top of `enabled` above being off — see `systemTelemetrySchema`
      // for why this is a second, narrower switch rather than folded into it.
      enabled: false,
      provider: null,
      modelId: null,
      // ON by default: an assistant that cannot see the rows it queried
      // cannot explain them, and an administrator who wants the narrower
      // behavior turns it off deliberately.
      shareResults: true,
      maxResultRowsToModel: 100,
      maxSteps: 15,
    },
  },
};
