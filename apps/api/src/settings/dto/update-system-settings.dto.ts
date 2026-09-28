import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { notificationEventKeySchema } from '../../common/schemas/user-settings-namespaces.schema';
import {
  MAX_DISABLED_NOTIFICATION_EVENTS,
  BACKUP_TIME_OF_DAY_PATTERN,
  STORAGE_PROVIDER_KINDS,
  AI_KEY_POLICIES,
  AI_USAGE_RETENTION_MAX_DAYS,
  AI_MCP_ALLOWED_HOST_PATTERN,
  AI_MCP_ALLOWED_HOSTS_MAX,
  AI_LIMIT_MODEL_KEY_MAX,
  AI_LIMIT_MODEL_KEY_PATTERN,
  AI_LIMITS_PER_MODEL_MAX,
  AI_LIMIT_VALUE_MAX,
  AI_AZURE_API_VERSION_PATTERN,
  AI_AZURE_ENDPOINT_SCHEMES,
  AI_COMPATIBLE_ENDPOINT_SCHEMES,
  AI_OPENAI_API_STYLES,
  aiAzureDeploymentsSchema,
  aiEndpointUrlSchema,
  TELEMETRY_INSTANCE_ID_PATTERN,
} from '../../common/schemas/settings.schema';

// The request-body schemas deliberately RESTATE `common/schemas/settings.schema.ts`
// rather than importing it: these are the OpenAPI-visible DTOs (`createZodDto`
// reads them to build the documented request schema) and the service validates
// against the shared schema again on the way in. Both copies must move together
// — `notifications` (#225) is the block that most recently did.

/**
 * Deployment-wide browser-notification policy (#225, epic #215).
 *
 * A MODELLED block: a framework-level, security-adjacent gate needs a real
 * type, a real default and somewhere to document its semantics. Nothing enforces it yet — the browser
 * channel reading these values is issue #226 — so it is stored and editable and
 * no delivery path consults it. See `systemNotificationsSchema`.
 */
const notificationsSettingsSchema = z.object({
  browserEnabled: z.boolean(),
  disabledEvents: z
    .array(notificationEventKeySchema)
    .max(MAX_DISABLED_NOTIFICATION_EVENTS),
});

// =============================================================================
// Operations namespaces on the wire (#256, epic #254)
// =============================================================================
//
// THIS FILE IS THE TRAP THE PARITY GUARD EXISTS FOR. A namespace that reaches
// `systemSettingsSchema` but not the two schemas below is not a validation
// error — it is a SILENT one. The global `ZodValidationPipe` parses the body
// against these schemas first and strips every key they do not declare, so the
// service is handed a body with the caller's change already deleted and
// cheerfully writes the unchanged value back. `common/schemas/settings-parity.spec.ts`
// fails the build when that happens; read its header before editing anything
// here.
//
// WHY THESE FOUR ARE OPTIONAL IN THE PUT BODY WHILE `notifications` IS REQUIRED.
// The rule `notifications` (#225) established is right and unchanged: a PUT
// that omits a modelled block must not silently reset it. The two cases differ
// in who is sending the body. `notifications` shipped together with the admin
// UI that sends it, so requiring it broke nothing and caught real omissions.
// These four ship AHEAD of every consumer, so requiring them would 400 every
// PUT from every client that exists today — including this repo's own settings
// page — the moment this issue merges. That is exactly the "changes behaviour
// for a deployment that has never saved these keys" outcome the issue rules
// out.
//
// SO WHAT STOPS THE SILENT RESET? `replaceSettings` carries an omitted block
// forward from the stored value instead of letting it fall back to the
// defaults — the same rule that file already applies to keys it does not model
// at all, and it is derived from THIS schema (the keys that accept
// `undefined`), not from a second hand-written list. A PUT can therefore change
// these namespaces, but cannot erase them by not mentioning them. When a UI for
// one of them lands and every client is sending it, promoting that block to
// required here is a one-line change with a test that already covers it.

const jobsSettingsSchema = z.object({
  history: z.object({
    retentionDays: z.number().int().min(1).max(3650),
    purgeEnabled: z.boolean(),
  }),
  stuckThresholdMinutes: z.number().int().min(1).max(10080),
});

const nodesSettingsSchema = z.object({
  staleHeartbeatSeconds: z.number().int().min(5).max(86400),
  offlineStaleMultiplier: z.number().int().min(1).max(100),
  offlineRetentionDays: z.number().int().min(1).max(3650),
  jobSecretBrokerEnabled: z.boolean(),
});

const databaseBackupSettingsSchema = z.object({
  enabled: z.boolean(),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  dayOfWeek: z.number().int().min(0).max(6),
  dayOfMonth: z.number().int().min(1).max(28),
  timeOfDay: z
    .string()
    .regex(BACKUP_TIME_OF_DAY_PATTERN, 'Expected a 24-hour HH:MM time'),
  timezone: z.string().min(1).max(64),
  retentionCount: z.number().int().min(1).max(365),
  // No `.min(1)`: `""` is the one spelling of "unset" and is the SHIPPED
  // DEFAULT — it means "whatever provider `storage.provider` names right now".
  // A non-empty value must equal the active provider or the write is a loud
  // 400 (`DatabaseBackupRunnerService.assertStorageProviderUsable`); that check
  // is unchanged. Only the default moved, because a provider id the operator
  // never chose must not be able to redirect or block their backups. See
  // `common/schemas/settings.schema.ts` for the full argument.
  storageProvider: z.string().max(64),
  runStaleMinutes: z.number().int().min(1).max(10080),
  compressionLevel: z.number().int().min(0).max(9),
  restoreRollbackMode: z.enum(['retain_database', 'drop_database']),
  oldDatabaseRetentionHours: z.number().int().min(1).max(8760),
  nodeOffloadEnabled: z.boolean(),
});

const maintenanceSettingsSchema = z.object({
  enabled: z.boolean(),
  message: z.string().min(1).max(1000),
  allowAdmins: z.boolean(),
  startedAt: z.iso.datetime().nullable(),
  startedById: z.string().uuid().nullable(),
});

// =============================================================================
// Storage provider configuration on the wire (#373, epic #372)
// =============================================================================
//
// Restated here rather than imported, for the reason at the top of this file:
// these are the OpenAPI-visible request schemas. Optional in the PUT body like
// the operations namespaces above, and for the identical reason — this block
// ships ahead of every client that knows it exists, so requiring it would 400
// every PUT from this repo's own settings page the moment it merges.
//
// NO `secretAccessKey` FIELD, ON EITHER SCHEMA, EVER. The secret access key is
// written through the credential store (#115, epic #108) at
// `(purpose 'storage', name 'default')`, not through this document. Accepting it
// here would put it in the request body of an endpoint whose audit rows record
// the full merged value, and in the response of the GET that follows. See
// `common/schemas/settings.schema.ts`, which carries the argument and a
// compile-time proof of the absence. `accessKeyId` is fine: it is an identifier
// that rides in the clear in every SigV4 `Authorization` header, the counterpart
// of `smtpUsername`.
//
// Bounds mirror `systemStorageSchema` exactly. No `.min(1)` on the strings:
// empty means "not configured", which is a legal state and the one a fresh
// deployment is in.

const storageSettingsSchema = z.object({
  provider: z.enum(STORAGE_PROVIDER_KINDS),
  bucket: z.string().trim().max(255),
  region: z.string().trim().max(255),
  endpoint: z.string().trim().max(512),
  accountId: z.string().trim().max(255),
  accessKeyId: z.string().trim().max(255),
  // Tri-state, mirroring `systemStorageSchema`: `null` is "use this vendor's
  // convention" and is what a fresh deployment holds.
  forcePathStyle: z.boolean().nullable(),
});

// =============================================================================
// AI platform policy on the wire (#423, epic #419, umbrella #418)
// =============================================================================
//
// Restated here rather than imported, for the reason at the top of this file.
// Optional in the PUT body like the operations namespaces and `storage`
// above, and for the identical reason: this block ships ahead of every
// client that knows it exists.
//
// NO API KEY FIELD, ON EITHER SCHEMA, EVER. A user's own key is
// `UserAiKey.secret`, written through its own dedicated endpoint (#428), not
// through this document; an org-wide fallback key belongs in the encrypted
// credential store. See `common/schemas/settings.schema.ts`, which carries
// the argument and a compile-time proof of the absence.
//
// Bounds mirror `systemAiSchema` exactly.

// `ai.limits` (#450). Every field optional — absent means unlimited. Used by
// the PUT body and (whole, since a PATCH replaces it wholesale) the PATCH body.
const aiLimitValueSchema = z.number().int().positive().max(AI_LIMIT_VALUE_MAX);
const aiLimitsSettingsSchema = z.object({
  perUser: z
    .object({
      requestsPerMinute: aiLimitValueSchema.optional(),
      requestsPerDay: aiLimitValueSchema.optional(),
    })
    .optional(),
  orgKey: z
    .object({
      requestsPerDayPerUser: aiLimitValueSchema.optional(),
      tokensPerDayPerUser: aiLimitValueSchema.optional(),
    })
    .optional(),
  perModel: z
    .record(
      z.string().max(AI_LIMIT_MODEL_KEY_MAX).regex(AI_LIMIT_MODEL_KEY_PATTERN),
      z.object({
        maxOutputTokens: aiLimitValueSchema.optional(),
        requestsPerMinutePerUser: aiLimitValueSchema.optional(),
      }),
    )
    .refine((value) => Object.keys(value).length <= AI_LIMITS_PER_MODEL_MAX, {
      message: `At most ${AI_LIMITS_PER_MODEL_MAX} per-model limits`,
    })
    .optional(),
});

const aiSettingsSchema = z.object({
  enabled: z.boolean(),
  keyPolicy: z.enum(AI_KEY_POLICIES),
  providers: z.object({
    openai: z.object({
      enabled: z.boolean(),
      baseUrl: z.string().url().optional(),
    }),
    anthropic: z.object({
      enabled: z.boolean(),
      baseUrl: z.string().url().optional(),
    }),
    gemini: z.object({
      enabled: z.boolean(),
      baseUrl: z.string().url().optional(),
    }),
    // #448 — see `systemAiAzureProviderSchema` / `systemAiCompatibleProviderSchema`.
    'azure-openai': z.object({
      enabled: z.boolean(),
      baseUrl: aiEndpointUrlSchema(AI_AZURE_ENDPOINT_SCHEMES).optional(),
      apiVersion: z.string().regex(AI_AZURE_API_VERSION_PATTERN).optional(),
      apiStyle: z.enum(AI_OPENAI_API_STYLES).optional(),
      deployments: aiAzureDeploymentsSchema.optional(),
    }),
    'openai-compatible': z.object({
      enabled: z.boolean(),
      baseUrl: aiEndpointUrlSchema(AI_COMPATIBLE_ENDPOINT_SCHEMES).optional(),
      apiStyle: z.enum(AI_OPENAI_API_STYLES).optional(),
      requiresKey: z.boolean().optional(),
    }),
  }),
  defaults: z.object({
    maxOutputTokensCap: z.number().int().positive().optional(),
    allowBackgroundRuns: z.boolean(),
    allowRealtime: z.boolean(),
  }),
  logPromptContent: z.boolean(),
  usageRetentionDays: z.number().int().min(1).max(AI_USAGE_RETENTION_MAX_DAYS),
  hostedTools: z.object({
    web_search: z.boolean(),
    file_search: z.boolean(),
    code_interpreter: z.boolean(),
    image_generation: z.boolean(),
    mcp: z.boolean(),
    mcpAllowedHosts: z
      .array(z.string().max(253).regex(AI_MCP_ALLOWED_HOST_PATTERN))
      .max(AI_MCP_ALLOWED_HOSTS_MAX),
  }),
  limits: aiLimitsSettingsSchema,
});

// =============================================================================
// Telemetry policy on the wire (epic #528, story #533)
// =============================================================================
//
// Restated here rather than imported, for the reason at the top of this file.
// Optional in the PUT body like every other namespace that ships ahead of its
// own client, and for the identical reason.
//
// NO CREDENTIAL FIELD, ON EITHER SCHEMA, EVER. The AI assistant's provider key
// is resolved the same way every other AI call resolves one — through
// `AiKeyResolver` — never through this document. See
// `common/schemas/settings.schema.ts`, which carries the argument and a
// compile-time proof of the absence.
//
// Bounds mirror `systemTelemetrySchema` exactly.

const telemetryInstanceIdSchema = z.string().regex(TELEMETRY_INSTANCE_ID_PATTERN);

const telemetrySettingsSchema = z.object({
  enabled: z.boolean(),
  retentionDays: z.number().int().min(1).max(3650),
  // #565 — `null` follows `APP_SLUG`; see `systemTelemetrySchema`.
  instanceId: telemetryInstanceIdSchema.nullable(),
  query: z.object({
    maxRows: z.number().int().min(1).max(100000),
    timeoutSeconds: z.number().int().min(1).max(120),
  }),
  assistant: z.object({
    enabled: z.boolean(),
    provider: z.string().nullable(),
    modelId: z.string().nullable(),
    shareResults: z.boolean(),
    maxResultRowsToModel: z.number().int().min(1).max(100),
    maxSteps: z.number().int().min(1).max(20),
  }),
});

// Full replacement (PUT)
export const updateSystemSettingsSchema = z.object({
  // REQUIRED. A PUT that omits it is a 400 and
  // not a silent reset to the defaults: the value it would reset is an
  // operator's decision to turn a delivery channel off for everyone.
  notifications: notificationsSettingsSchema,
  // OPTIONAL — see the section header above. Omitting one means "leave it as
  // stored", never "reset it to the defaults"; `SystemSettingsService
  // .replaceSettings` is what makes that true.
  jobs: jobsSettingsSchema.optional(),
  nodes: nodesSettingsSchema.optional(),
  databaseBackup: databaseBackupSettingsSchema.optional(),
  maintenance: maintenanceSettingsSchema.optional(),
  // #373, epic #372 — optional for the same reason, and carried forward from
  // storage when omitted by the same `OMITTABLE_ON_PUT` machinery, which derives
  // itself from this shape rather than from a second list.
  storage: storageSettingsSchema.optional(),
  // #423, epic #419 — optional for the same reason, carried forward the same
  // way.
  ai: aiSettingsSchema.optional(),
  // Epic #528, story #533 — optional for the same reason, carried forward the
  // same way.
  telemetry: telemetrySettingsSchema.optional(),
});

export class UpdateSystemSettingsDto extends createZodDto(
  updateSystemSettingsSchema,
) {}

// Partial update (PATCH)
export const patchSystemSettingsSchema = z.object({
  // `disabledEvents` REPLACES rather than merges — RFC 7396's rule for arrays,
  // and the only workable one here: a merging list could never express
  // "re-enable this event", so unchecking a box on the admin page would be a
  // no-op.
  notifications: z
    .object({
      browserEnabled: z.boolean().optional(),
      disabledEvents: z
        .array(notificationEventKeySchema)
        .max(MAX_DISABLED_NOTIFICATION_EVENTS)
        .optional(),
    })
    .optional(),
  // Optional at the namespace level and field by field inside, so that
  // `{ "databaseBackup": { "enabled": true } }` is a legal body. If this line
  // is missing, that body parses to `{}` and the PATCH is a no-op that returns
  // 200 — the defect `settings-parity.spec.ts` and
  // `test/settings/system-settings.integration.spec.ts` both pin.
  jobs: z
    .object({
      history: z
        .object({
          retentionDays: z.number().int().min(1).max(3650).optional(),
          purgeEnabled: z.boolean().optional(),
        })
        .optional(),
      stuckThresholdMinutes: z.number().int().min(1).max(10080).optional(),
    })
    .optional(),
  nodes: z
    .object({
      staleHeartbeatSeconds: z.number().int().min(5).max(86400).optional(),
      offlineStaleMultiplier: z.number().int().min(1).max(100).optional(),
      offlineRetentionDays: z.number().int().min(1).max(3650).optional(),
      jobSecretBrokerEnabled: z.boolean().optional(),
    })
    .optional(),
  databaseBackup: z
    .object({
      enabled: z.boolean().optional(),
      frequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
      dayOfWeek: z.number().int().min(0).max(6).optional(),
      dayOfMonth: z.number().int().min(1).max(28).optional(),
      timeOfDay: z
        .string()
        .regex(BACKUP_TIME_OF_DAY_PATTERN, 'Expected a 24-hour HH:MM time')
        .optional(),
      timezone: z.string().min(1).max(64).optional(),
      retentionCount: z.number().int().min(1).max(365).optional(),
      // No `.min(1)`, matching the PUT schema above: `""` CLEARS the pin back
      // to "whatever provider is active", absent leaves it alone. Rejecting
      // `""` would make the shipped default unreachable by the endpoint that
      // edits it.
      storageProvider: z.string().max(64).optional(),
      runStaleMinutes: z.number().int().min(1).max(10080).optional(),
      compressionLevel: z.number().int().min(0).max(9).optional(),
      restoreRollbackMode: z
        .enum(['retain_database', 'drop_database'])
        .optional(),
      oldDatabaseRetentionHours: z.number().int().min(1).max(8760).optional(),
      nodeOffloadEnabled: z.boolean().optional(),
    })
    .optional(),
  // `startedAt` and `startedById` are `.nullable().optional()`: `null` clears
  // the window's provenance, absent leaves it alone. The service's merge
  // distinguishes the two with `!== undefined` rather than `??`, which would
  // collapse them and make "clear it" impossible to express.
  maintenance: z
    .object({
      enabled: z.boolean().optional(),
      message: z.string().min(1).max(1000).optional(),
      allowAdmins: z.boolean().optional(),
      startedAt: z.iso.datetime().nullable().optional(),
      startedById: z.string().uuid().nullable().optional(),
    })
    .optional(),
  // #373, epic #372. THE LINE THAT MAKES A STORAGE PATCH DO ANYTHING AT ALL.
  // Without it `PATCH { "storage": { "bucket": "my-bucket" } }` parses to `{}`
  // in the global ZodValidationPipe, the service merges nothing, the row is
  // rewritten unchanged and the endpoint answers 200 with a body that looks
  // right — no error, no log line, no audit entry. `common/schemas/settings-parity.spec.ts`
  // is what fails the build if this is ever dropped.
  //
  // An empty string here CLEARS a string field (`''` is how a string says
  // "un-configure this"); absent leaves the stored value alone. The one
  // nullable field, `forcePathStyle`, says the same thing with an explicit
  // `null` — see `systemStorageSchema` for why a boolean needs a third state.
  storage: z
    .object({
      provider: z.enum(STORAGE_PROVIDER_KINDS).optional(),
      bucket: z.string().trim().max(255).optional(),
      region: z.string().trim().max(255).optional(),
      endpoint: z.string().trim().max(512).optional(),
      accountId: z.string().trim().max(255).optional(),
      // Identifier, never the secret half — see the section header above.
      accessKeyId: z.string().trim().max(255).optional(),
      // Absent leaves it alone; explicit `null` restores the vendor default.
      forcePathStyle: z.boolean().nullable().optional(),
    })
    .optional(),
  // #423, epic #419. Optional at the namespace level and field by field
  // inside, one level into each `providers.<id>` and `defaults`, matching
  // `storage` above — `{ "ai": { "enabled": true } }` must be a legal body,
  // or the admin page has to send the whole namespace to flip one switch.
  // NO API KEY FIELD — see the section header above.
  ai: z
    .object({
      enabled: z.boolean().optional(),
      keyPolicy: z.enum(AI_KEY_POLICIES).optional(),
      providers: z
        .object({
          openai: z
            .object({
              enabled: z.boolean().optional(),
              // Absent leaves it alone; explicit `null` removes the override.
              baseUrl: z.string().url().nullable().optional(),
            })
            .optional(),
          anthropic: z
            .object({
              enabled: z.boolean().optional(),
              baseUrl: z.string().url().nullable().optional(),
            })
            .optional(),
          gemini: z
            .object({
              enabled: z.boolean().optional(),
              baseUrl: z.string().url().nullable().optional(),
            })
            .optional(),
          // #448. `null` removes an optional field (back to its default);
          // `deployments` replaces wholesale when present.
          'azure-openai': z
            .object({
              enabled: z.boolean().optional(),
              baseUrl: aiEndpointUrlSchema(AI_AZURE_ENDPOINT_SCHEMES).nullable().optional(),
              apiVersion: z.string().regex(AI_AZURE_API_VERSION_PATTERN).nullable().optional(),
              apiStyle: z.enum(AI_OPENAI_API_STYLES).nullable().optional(),
              deployments: aiAzureDeploymentsSchema.nullable().optional(),
            })
            .optional(),
          'openai-compatible': z
            .object({
              enabled: z.boolean().optional(),
              baseUrl: aiEndpointUrlSchema(AI_COMPATIBLE_ENDPOINT_SCHEMES).nullable().optional(),
              apiStyle: z.enum(AI_OPENAI_API_STYLES).nullable().optional(),
              requiresKey: z.boolean().nullable().optional(),
            })
            .optional(),
        })
        .optional(),
      defaults: z
        .object({
          // Absent leaves it alone; explicit `null` removes the cap.
          maxOutputTokensCap: z.number().int().positive().nullable().optional(),
          allowBackgroundRuns: z.boolean().optional(),
          allowRealtime: z.boolean().optional(),
        })
        .optional(),
      logPromptContent: z.boolean().optional(),
      usageRetentionDays: z.number().int().min(1).max(AI_USAGE_RETENTION_MAX_DAYS).optional(),
      // #442. Booleans field by field; `mcpAllowedHosts` replaces wholesale.
      hostedTools: z
        .object({
          web_search: z.boolean().optional(),
          file_search: z.boolean().optional(),
          code_interpreter: z.boolean().optional(),
          image_generation: z.boolean().optional(),
          mcp: z.boolean().optional(),
          mcpAllowedHosts: z
            .array(z.string().max(253).regex(AI_MCP_ALLOWED_HOST_PATTERN))
            .max(AI_MCP_ALLOWED_HOSTS_MAX)
            .optional(),
        })
        .optional(),
      // #450. Replaces wholesale when present — see `systemAiPatchSchema`.
      limits: aiLimitsSettingsSchema.optional(),
    })
    .optional(),
  // Epic #528, story #533. Optional at the namespace level and field by field
  // inside, one level into `query` and `assistant`, matching `ai` above —
  // `{ "telemetry": { "enabled": true } }` must be a legal body. Absent
  // leaves `assistant.provider`/`assistant.modelId` alone; explicit `null`
  // clears either back to "not configured" — see `systemTelemetryPatchSchema`.
  telemetry: z
    .object({
      enabled: z.boolean().optional(),
      retentionDays: z.number().int().min(1).max(3650).optional(),
      // #565 — absent leaves it alone, `null` returns to the `APP_SLUG` default.
      instanceId: telemetryInstanceIdSchema.nullable().optional(),
      query: z
        .object({
          maxRows: z.number().int().min(1).max(100000).optional(),
          timeoutSeconds: z.number().int().min(1).max(120).optional(),
        })
        .optional(),
      assistant: z
        .object({
          enabled: z.boolean().optional(),
          provider: z.string().nullable().optional(),
          modelId: z.string().nullable().optional(),
          shareResults: z.boolean().optional(),
          maxResultRowsToModel: z.number().int().min(1).max(100).optional(),
          maxSteps: z.number().int().min(1).max(20).optional(),
        })
        .optional(),
    })
    .optional(),
});

export class PatchSystemSettingsDto extends createZodDto(
  patchSystemSettingsSchema,
) {}
