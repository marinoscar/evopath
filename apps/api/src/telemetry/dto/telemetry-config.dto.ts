import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { systemTelemetrySchema } from '../../common/schemas/settings.schema';

// =============================================================================
// /api/admin/telemetry/config and /api/telemetry/config — wire shapes
// (issue #534, epic #528)
// =============================================================================
//
// The PUT body IS the stored `telemetry` namespace (`systemTelemetrySchema`),
// so a form can send back exactly what it loaded (minus the provenance fields
// the response adds). Full replace: `assistant.provider` / `assistant.modelId`
// sent as `null` clear a stored value.
//
// ONE EXCEPTION TO "FULL": `instanceId` (#565) is OPTIONAL in the PUT body.
// Absent keeps the stored value, `null` returns to the `APP_SLUG` default, a
// string overrides it. It arrived after the form did, and a client written
// before it existed must not get a 400 — nor silently reset an identity an
// administrator set — merely by saving the page. The response always carries
// it, plus `instanceIdDefault` / `instanceIdEffective` so a form can show what
// `null` currently means.
//
// No credential is part of any of these shapes and none may be added — the
// namespace carries a compile-time proof of that (`settings.schema.ts`). The
// GreptimeDB connection is its own resource (`/api/admin/telemetry/connection`,
// #558), with its passwords in the encrypted credential store.
// =============================================================================

export const updateTelemetryConfigSchema = systemTelemetrySchema.extend({
  instanceId: systemTelemetrySchema.shape.instanceId.optional(),
});

export class UpdateTelemetryConfigDto extends createZodDto(updateTelemetryConfigSchema) {}
export type UpdateTelemetryConfigInput = z.infer<typeof updateTelemetryConfigSchema>;

export const telemetryConfigResponseSchema = systemTelemetrySchema.extend({
  /**
   * Whether a telemetry store is configured (admin UI or deployment default):
   * a host and the reader login with its password. While false, `enabled` is
   * stored but nothing is exported or queryable.
   */
  available: z.boolean(),
  /**
   * Whether the GreptimeDB admin login is configured (admin UI or deployment
   * default), which retention needs. While false, `retentionDays` is stored
   * but not applied.
   */
  retentionApplicable: z.boolean(),
  /**
   * What a `null` `instanceId` resolves to: the application slug (`APP_SLUG`,
   * derived from the product name). Read-only.
   */
  instanceIdDefault: z.string(),
  /**
   * The identifier currently stamped as the `app.instance.id` resource
   * attribute on exported telemetry: `instanceId` when set, else
   * `instanceIdDefault`. Read-only.
   */
  instanceIdEffective: z.string(),
  /** The system-settings row version — send it back as `If-Match` on `PUT`. `0` when nothing is stored yet. */
  version: z.number().int(),
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.object({ id: z.string(), email: z.string() }).nullable(),
});

export class TelemetryConfigResponseDto extends createZodDto(telemetryConfigResponseSchema) {}
export type TelemetryConfigResponse = z.infer<typeof telemetryConfigResponseSchema>;

/** `GET /api/telemetry/config` — the feature flag every signed-in client reads. */
export const telemetryPublicConfigSchema = z.object({
  /** A telemetry store is configured (admin UI or deployment default). False hides every telemetry surface. */
  available: z.boolean(),
  /** `telemetry.enabled` — whether this deployment is currently collecting telemetry. */
  enabled: z.boolean(),
  /**
   * `telemetry.assistant.enabled` — whether the telemetry AI assistant is
   * switched on. Whether the AI platform itself is on is `GET /api/ai/config`.
   */
  assistantEnabled: z.boolean(),
});

export class TelemetryPublicConfigDto extends createZodDto(telemetryPublicConfigSchema) {}
export type TelemetryPublicConfig = z.infer<typeof telemetryPublicConfigSchema>;
