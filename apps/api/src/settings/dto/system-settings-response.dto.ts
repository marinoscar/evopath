import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const systemSettingsResponseSchema = z.object({
  security: z.object({
    jwtAccessTtlMinutes: z.number(),
    refreshTtlDays: z.number(),
  }),
  // #225, epic #215. Part of the represented resource, which is what makes a
  // PUT that omits it meaningful (and rejected) rather than a client simply not
  // knowing the field exists. Nothing enforces these values yet — that is #226.
  notifications: z.object({
    browserEnabled: z.boolean(),
    disabledEvents: z.array(z.string()),
  }),
  // #256, epic #254 — the operations namespaces. Published from the day they
  // exist rather than the day something reads them: a block the response omits
  // is a block no client can echo back in a PUT, which would leave
  // `replaceSettings` carrying it forward blind forever. Restated here rather
  // than imported for the same reason the request bodies are — this is the
  // OpenAPI-visible contract — and kept in step by
  // `common/schemas/settings-parity.spec.ts`.
  jobs: z.object({
    history: z.object({
      retentionDays: z.number(),
      purgeEnabled: z.boolean(),
    }),
    stuckThresholdMinutes: z.number(),
  }),
  nodes: z.object({
    staleHeartbeatSeconds: z.number(),
    offlineStaleMultiplier: z.number(),
    offlineRetentionDays: z.number(),
    jobSecretBrokerEnabled: z.boolean(),
  }),
  databaseBackup: z.object({
    enabled: z.boolean(),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    dayOfWeek: z.number(),
    dayOfMonth: z.number(),
    timeOfDay: z.string(),
    timezone: z.string(),
    retentionCount: z.number(),
    storageProvider: z.string(),
    runStaleMinutes: z.number(),
    compressionLevel: z.number(),
    restoreRollbackMode: z.enum(['retain_database', 'drop_database']),
    oldDatabaseRetentionHours: z.number(),
    nodeOffloadEnabled: z.boolean(),
  }),
  maintenance: z.object({
    enabled: z.boolean(),
    message: z.string(),
    allowAdmins: z.boolean(),
    startedAt: z.string().nullable(),
    startedById: z.string().nullable(),
  }),
  // #373, epic #372 — the storage provider configuration, published for the
  // same reason the operations namespaces above are: a block this response
  // omits is a block no client can echo back in a PUT.
  //
  // THERE IS NO `secretAccessKey` FIELD AND THERE MUST NEVER BE ONE. The
  // secret half of the storage credential lives in the encrypted credential
  // store at `(purpose 'storage', name 'default')` and is returned by nothing.
  // `accessKeyId` is published deliberately: it is an identifier that travels
  // in the clear in every SigV4 request, and an administrator who cannot see
  // which key id is configured cannot tell a rotated key from a mistyped one.
  // See `common/schemas/settings.schema.ts` for the full argument and its
  // compile-time proof.
  storage: z.object({
    provider: z.enum(['s3', 'r2', 's3compatible']),
    bucket: z.string(),
    region: z.string(),
    endpoint: z.string(),
    accountId: z.string(),
    accessKeyId: z.string(),
    // Tri-state, and `null` is published as `null` rather than coerced to
    // `false`: an administrator reading this must be able to tell "I have not
    // chosen" from "I chose virtual-host style". See `systemStorageSchema`.
    forcePathStyle: z.boolean().nullable(),
  }),
  // #423, epic #419, umbrella #418 — the AI platform policy, published for
  // the same reason the operations namespaces and `storage` above are: a
  // block this response omits is a block no client can echo back in a PUT.
  //
  // THERE IS NO API KEY FIELD AND THERE MUST NEVER BE ONE. A user's own key
  // is `UserAiKey.secret`, in its own table; an org-wide fallback key belongs
  // in the encrypted credential store. See
  // `common/schemas/settings.schema.ts` for the full argument and its
  // compile-time proof.
  ai: z.object({
    enabled: z.boolean(),
    keyPolicy: z.enum(['byok', 'byok_with_org_fallback']),
    providers: z.object({
      openai: z.object({
        enabled: z.boolean(),
        baseUrl: z.string().optional(),
      }),
      anthropic: z.object({
        enabled: z.boolean(),
        baseUrl: z.string().optional(),
      }),
      gemini: z.object({
        enabled: z.boolean(),
        baseUrl: z.string().optional(),
      }),
      'azure-openai': z.object({
        enabled: z.boolean(),
        baseUrl: z.string().optional(),
        apiVersion: z.string().optional(),
        apiStyle: z.enum(['responses', 'chat_completions']).optional(),
        deployments: z.record(z.string(), z.string()).optional(),
      }),
      'openai-compatible': z.object({
        enabled: z.boolean(),
        baseUrl: z.string().optional(),
        apiStyle: z.enum(['responses', 'chat_completions']).optional(),
        requiresKey: z.boolean().optional(),
      }),
    }),
    defaults: z.object({
      maxOutputTokensCap: z.number().optional(),
      allowBackgroundRuns: z.boolean(),
      allowRealtime: z.boolean(),
    }),
    logPromptContent: z.boolean(),
    usageRetentionDays: z.number().int(),
    hostedTools: z.object({
      web_search: z.boolean(),
      file_search: z.boolean(),
      code_interpreter: z.boolean(),
      image_generation: z.boolean(),
      mcp: z.boolean(),
      mcpAllowedHosts: z.array(z.string()),
    }),
    limits: z.object({
      perUser: z
        .object({ requestsPerMinute: z.number().int().optional(), requestsPerDay: z.number().int().optional() })
        .optional(),
      orgKey: z
        .object({
          requestsPerDayPerUser: z.number().int().optional(),
          tokensPerDayPerUser: z.number().int().optional(),
        })
        .optional(),
      perModel: z
        .record(
          z.string(),
          z.object({
            maxOutputTokens: z.number().int().optional(),
            requestsPerMinutePerUser: z.number().int().optional(),
          }),
        )
        .optional(),
    }),
  }),
  updatedAt: z.iso.datetime(),
  updatedBy: z
    .object({
      id: z.string().uuid(),
      email: z.string().email(),
    })
    .nullable(),
  version: z.number(),
});

export class SystemSettingsResponseDto extends createZodDto(
  systemSettingsResponseSchema,
) {}
