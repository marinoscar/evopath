import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  COACH_PHOTO_CADENCES,
  coachSettingsPatchSchema,
} from '../../common/schemas/user-settings-namespaces.schema';
import { COACH_REGISTER_REASONS } from '../personas/resolve-register';

// =============================================================================
// /api/coach/settings (E7.2, #242; docs/specs/ai-coach.md §3.1, §3.6)
// =============================================================================

/**
 * PUT body: the `coach` namespace's PATCH form (an omitted field keeps the
 * stored value, `null` returns it to the default), without
 * `adultConfirmedAt`, which the client never writes: `confirmAdult: true`
 * asks the server to stamp it (the 18+ dialog of spec §2.4). STRICT: an
 * unknown key is a 400.
 */
export const putCoachSettingsSchema = coachSettingsPatchSchema
  .omit({ adultConfirmedAt: true })
  .extend({
    /** The user confirmed they are 18 or older; the server stamps `adultConfirmedAt = now`. */
    confirmAdult: z.literal(true).optional(),
  })
  .strict();

export type PutCoachSettingsValue = z.infer<typeof putCoachSettingsSchema>;
export class PutCoachSettingsDto extends createZodDto(putCoachSettingsSchema) {}

const registerSchema = z.object({
  /** Profanity is allowed for the next message (all four unlock conditions hold). */
  profane: z.boolean(),
  /** The failed unlock condition; null exactly when `profane`. */
  reason: z.enum(COACH_REGISTER_REASONS).nullable(),
});

export const coachSettingsViewSchema = z.object({
  /** The stored `coach` namespace with every default applied. */
  settings: z.object({
    enabled: z.boolean(),
    personaId: z.string(),
    intensity: z.number().int(),
    profanity: z.boolean(),
    adultConfirmedAt: z.string().nullable(),
    audio: z.object({
      enabled: z.boolean(),
      /** Null: the persona's default voice. */
      voice: z.string().nullable(),
      speed: z.number(),
    }),
    quietHours: z.object({ start: z.string(), end: z.string() }),
    maxNudgesPerDay: z.number().int(),
    lockScreenSafe: z.boolean(),
    photoCadence: z.enum(COACH_PHOTO_CADENCES),
    why: z.string().nullable(),
    preferredTime: z.string().nullable(),
  }),
  /** What the coach will actually do with these settings now. */
  effective: z.object({
    /** `maxNudgesPerDay` clamped to the system ceiling. */
    maxNudgesPerDay: z.number().int(),
    register: registerSchema,
    /** The intensity rendered: a locked Sarge L3 renders as L2. */
    intensity: z.number().int(),
    /** The voice spoken messages use: the chosen one, else the persona's default at the rendered level. */
    voice: z.string(),
  }),
  /** The deployment's coach policy, as far as it shapes this page. */
  policy: z.object({
    enabled: z.boolean(),
    allowProfanePersonas: z.boolean(),
    allowAudio: z.boolean(),
    maxNudgesPerDayCeiling: z.number().int(),
  }),
});

export type CoachSettingsViewData = z.infer<typeof coachSettingsViewSchema>;
export class CoachSettingsView extends createZodDto(coachSettingsViewSchema) {}
