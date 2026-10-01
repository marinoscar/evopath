import { z } from 'zod';
import { NOTIFICATION_CHANNELS } from '../../notifications/notification-events';
import type { NotificationPreferences } from '../../notifications/notification-preferences';
import type { ProgramGoal } from '../../programs/programs.constants';

// =============================================================================
// User Settings Namespaces: `dataTables`, `navigation`, `notifications`,
// `onboarding`, `coach`
// =============================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// The user-settings shape is currently hand-maintained in five separate zod
// declarations (common/schemas/settings.schema.ts x2,
// settings/dto/update-user-settings.dto.ts x2, and
// settings/dto/user-settings-response.dto.ts) plus one plain TS interface in
// common/types/settings.types.ts. Adding a namespace to only some of them means
// the payload is silently stripped by `userSettingsSchema.parse()` and never
// round-trips through a subsequent GET.
//
// These namespaces are therefore declared ONCE, here, and imported by every
// copy. Deduplicating the pre-existing `theme` / `profile` declarations is
// deliberately out of scope (no behaviour change in this pass), but any NEW
// namespace should be added here rather than copy-pasted five times.
//
// SECURITY: THE BOUNDS BELOW ARE A CONTROL, NOT ERGONOMICS
// --------------------------------------------------------
// `user_settings.value` is a JSONB blob that the user themselves writes via
// PUT/PATCH /api/user-settings. An unbounded user-controlled record is a
// storage-exhaustion vector: without a cap on the number of table entries, the
// number of column ids per entry, and the length of each id, an authenticated
// user can inflate a single row without limit. Every limit below exists to
// close that, and must not be relaxed for convenience.
//
// CRITICAL: NO `.default()` ANYWHERE IN THIS FILE
// ------------------------------------------------
// Absent MUST mean "use the application's built-in defaults", computed at read
// time by the consumer. This is load-bearing, not style.
//
// Concretely: if `visibleColumns` defaulted to `[]` (or to today's column list),
// then the first time a user merely opened a density menu — touching a totally
// unrelated preference — the persisted entry would materialise a frozen column
// set. Every column added to that table afterwards would be silently invisible
// to that user forever, with no error and no signal that anything was wrong,
// and the only remedy would be a manual settings reset. The same argument
// applies to `density`, `pageSize`, `sort`, and `railCollapsed`. Persist only
// what the user actually chose.
//
// =============================================================================

/**
 * Maximum number of per-table entries a single user may persist.
 *
 * NOTE: this cap CANNOT be expressed in `z.record()` — zod has no "max number
 * of keys" refinement that survives the record type. It is enforced in
 * UserSettingsService after the merge instead. See that service for why
 * enforcing it here would produce a 500 rather than a 400.
 */
export const DATA_TABLE_MAX_TABLES = 40;

/** Allowed shape of a table identifier (lowercase slug). */
export const DATA_TABLE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Maximum length of a table identifier and of a column identifier. */
export const DATA_TABLE_MAX_ID_LENGTH = 64;

/** Maximum number of column ids that may be persisted for a single table. */
export const DATA_TABLE_MAX_VISIBLE_COLUMNS = 60;

/** Maximum persisted page size for a single table. */
export const DATA_TABLE_MAX_PAGE_SIZE = 500;

/** Row density options exposed by the data table component. */
export const dataTableDensitySchema = z.enum([
  'compact',
  'standard',
  'comfortable',
]);

/** Sort direction options. */
export const dataTableSortDirectionSchema = z.enum(['asc', 'desc']);

/** Persisted sort state for a single table. */
export const dataTableSortSchema = z
  .object({
    field: z.string().min(1).max(DATA_TABLE_MAX_ID_LENGTH),
    direction: dataTableSortDirectionSchema,
  })
  .strict();

/**
 * Persisted preferences for a single data table.
 *
 * Every key is optional and NONE has a `.default()` — see the file header.
 */
export const dataTableEntrySchema = z
  .object({
    visibleColumns: z
      .array(z.string().min(1).max(DATA_TABLE_MAX_ID_LENGTH))
      .max(DATA_TABLE_MAX_VISIBLE_COLUMNS)
      .optional(),
    density: dataTableDensitySchema.optional(),
    sort: dataTableSortSchema.optional(),
    pageSize: z.number().int().min(1).max(DATA_TABLE_MAX_PAGE_SIZE).optional(),
  })
  .strict();

/** Table identifier key schema, shared by the full and patch record schemas. */
export const dataTableIdSchema = z
  .string()
  .min(1)
  .max(DATA_TABLE_MAX_ID_LENGTH)
  .regex(DATA_TABLE_ID_PATTERN);

/**
 * Full `dataTables` namespace: a map of table id -> preferences.
 *
 * zod v4 requires BOTH a key and a value schema for `z.record`.
 */
export const dataTablesSchema = z.record(
  dataTableIdSchema,
  dataTableEntrySchema,
);

/**
 * PATCH form of the `dataTables` namespace.
 *
 * The value is nullable because JSON Merge Patch uses `null` to mean "delete":
 * `{ dataTables: { jobs: null } }` removes the `jobs` entry. A non-null entry
 * REPLACES the stored entry for that table wholesale (it is not deep-merged) —
 * see UserSettingsService.mergeDataTables.
 */
export const dataTablesPatchSchema = z.record(
  dataTableIdSchema,
  dataTableEntrySchema.nullable(),
);

/**
 * Full `navigation` namespace.
 *
 * `railCollapsed` absent means "use the built-in default" — deliberately NOT
 * `.default(false)`, so that a future change to the default rail state reaches
 * users who never expressed a preference.
 */
export const navigationSchema = z
  .object({
    railCollapsed: z.boolean().optional(),
  })
  .strict();

/**
 * PATCH form of the `navigation` namespace: each field may additionally be
 * `null`, meaning "delete this field and fall back to the built-in default".
 */
export const navigationPatchSchema = z
  .object({
    railCollapsed: z.boolean().nullable().optional(),
  })
  .strict();

// =============================================================================
// Inferred types — derived from the schemas above so they can never drift.
// =============================================================================

export type DataTableDensity = z.infer<typeof dataTableDensitySchema>;
export type DataTableSort = z.infer<typeof dataTableSortSchema>;
export type DataTableEntry = z.infer<typeof dataTableEntrySchema>;
export type DataTablesValue = z.infer<typeof dataTablesSchema>;
export type DataTablesPatchValue = z.infer<typeof dataTablesPatchSchema>;
export type NavigationValue = z.infer<typeof navigationSchema>;
export type NavigationPatchValue = z.infer<typeof navigationPatchSchema>;

// =============================================================================
// User Settings Namespace: `notifications` (issue #126, epic #109)
// =============================================================================
//
// The WRITE side of the preference contract whose READ side is
// notifications/notification-preferences.ts (#125). That file is the
// authority on the stored shape; everything here exists to make sure nothing
// can be written that it would not read back the same way.
//
//     user_settings.value.notifications = {
//       email:   { 'user.welcome': false },
//       browser: { 'security.role_changed': true },
//     }
//
// CHANNEL-OUTER, EVENT-INNER — not a choice made here. It is the shape
// `readNotificationPreferences` already parses and `isChannelEnabled` already
// resolves; a write schema that accepted event-outer would produce rows the
// dispatcher silently ignores, i.e. mutes that never take effect.
//
// SPARSE, LIKE ITS NEIGHBOURS ABOVE. No `.default()`, no materialised blob.
// Absent at any of the three levels (namespace / channel / event) means "use
// the registry's `defaultEnabled`", resolved at read time. This is why
// `mergeNotifications` collapses an emptied channel, and an emptied namespace,
// back to ABSENT rather than storing `{}` — see that method. Storing `{}`
// would be a second representation of "no opinion" for the read path and the
// UI to disagree about, and `readNotificationPreferences` deliberately drops
// empty maps for exactly the same reason.
//
// -----------------------------------------------------------------------------
// WHY CHANNEL KEYS ARE CLOSED AND EVENT KEYS ARE NOT
// -----------------------------------------------------------------------------
//
// The outer level is validated against `NOTIFICATION_CHANNELS`: an unknown
// channel is a 400. The inner level accepts ANY syntactically valid event key,
// and is deliberately NOT checked against `NOTIFICATION_EVENTS`. That
// asymmetry is not an oversight — it mirrors what the read path does with each
// level, and the rule is: THE WRITE PATH MUST ACCEPT EVERYTHING THE READ PATH
// CAN EMIT.
//
//   * `readNotificationPreferences` DROPS unknown channels. A channel the
//     registry does not declare can never be delivered, so nothing is lost by
//     refusing it on write either, and a GET can never hand a client a channel
//     that a subsequent PUT would then reject.
//
//   * `readNotificationPreferences` KEEPS unknown event keys, and says why:
//     during a rolling deploy an older pod legitimately reads a preference for
//     an event only the newer build declares. Rejecting unknown event keys on
//     write would break that in three concrete ways:
//
//       1. ROLLING DEPLOY. The preferences page renders from
//          `GET /api/notifications/events` (#124). Behind a load balancer that
//          list can come from a new pod while the resulting PATCH lands on an
//          old one, so the user's toggle 400s on a key that is perfectly real.
//
//       2. READ-MODIFY-WRITE. `PUT /api/user-settings` states the settings in
//          full, so a client GETs and PUTs back keys the server just served
//          it. Once an event is retired from the registry, that round trip
//          starts failing on the server's own data.
//
//       3. THE CLEANUP PATH WOULD BE UNREACHABLE. Deleting a stale preference
//          is `{ notifications: { email: { 'old.event': null } } }` — a
//          request that NAMES the unknown key. Validating keys against the
//          registry rejects the very request that would remove them, so a
//          retired event's preference could never be cleaned up at all.
//
// The cost of accepting them is that a typo'd key from a hand-written PATCH is
// stored and quietly does nothing. That is tolerable because it is inert:
// `isChannelEnabled` is only ever asked about REGISTERED events, so a
// preference for a key no event has cannot affect a delivery decision. The
// real risk of an open map is unbounded growth, and that is closed below by
// key format, key length, and a per-channel entry cap — the same
// storage-exhaustion control the header of this file describes for
// `dataTables`, and for the same reason: this blob is user-written.
//
// -----------------------------------------------------------------------------
// `mandatory` IS NOT ENFORCED HERE, DELIBERATELY
// -----------------------------------------------------------------------------
//
// A stored `{ 'security.role_changed': false }` is accepted by this schema and
// is harmless: `isChannelEnabled` tests `event.mandatory` BEFORE it looks at
// stored preferences, so the value is never consulted. That single gate, in
// the resolver, is the security boundary (#125) precisely because it catches
// every path — including rows written before an event became mandatory, and
// crafted requests that never went near the UI. Adding a second gate here
// would not make the system safer; it would create two enforcement points that
// can disagree, and the one that matters is the one the dispatcher reads.
// =============================================================================

/**
 * Maximum number of event preferences a single user may persist PER CHANNEL.
 *
 * As with DATA_TABLE_MAX_TABLES this cannot be expressed in `z.record()` and
 * must be checked against the MERGED result, so it is enforced in
 * UserSettingsService. See `assertNotificationLimit` there.
 *
 * Generous against a registry of a handful of events — this is a bound on
 * abuse, not a product limit — but finite, because the event level is an open
 * map that the user writes.
 */
export const NOTIFICATION_MAX_EVENTS_PER_CHANNEL = 100;

/** Maximum length of a persisted event key. */
export const NOTIFICATION_MAX_EVENT_KEY_LENGTH = 64;

/**
 * Allowed shape of an event key: the `<area>.<event>` convention
 * `NOTIFICATION_EVENTS` documents, as a syntactic bound.
 *
 * THIS IS A BOUND, NOT A REGISTRY CHECK (see the header). It must therefore
 * stay at least as permissive as the registry's own key convention: if a
 * future event key adopts a character this pattern rejects, preferences for
 * that event become unwritable — a toggle that 400s with no registry change in
 * sight. Widen this deliberately if that convention ever changes.
 */
export const NOTIFICATION_EVENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/;

/** Event key schema, shared by the full and patch record schemas. */
export const notificationEventKeySchema = z
  .string()
  .min(1)
  .max(NOTIFICATION_MAX_EVENT_KEY_LENGTH)
  .regex(NOTIFICATION_EVENT_KEY_PATTERN);

/**
 * One channel's preferences: event key -> the user's explicit choice.
 *
 * `boolean` only. `readNotificationPreferences` discards any other value, so
 * accepting one here would persist a preference that can never take effect.
 */
export const notificationChannelPreferencesSchema = z.record(
  notificationEventKeySchema,
  z.boolean(),
);

/**
 * Full `notifications` namespace: channel -> that channel's preferences.
 *
 * `partialRecord` (not `record`) over the channel enum: every channel is
 * OPTIONAL. A plain `z.record` with an enum key requires the full key set,
 * which would force a client that only ever touched email to also state a
 * `browser` object — the materialised blob this whole namespace avoids.
 *
 * The key set is derived from `NOTIFICATION_CHANNELS`, so adding `'push'`
 * there widens this schema in the same edit and there is no second list to
 * forget.
 */
export const notificationsSchema = z.partialRecord(
  z.enum(NOTIFICATION_CHANNELS),
  notificationChannelPreferencesSchema,
);

/**
 * PATCH form of one channel's preferences.
 *
 * The value is nullable because JSON Merge Patch uses `null` to mean "delete":
 * `{ email: { 'user.welcome': null } }` removes that one event key, restoring
 * the ABSENT (= registry default) state. That is the operation #126 sends when
 * a control returns to its default — writing the default value explicitly
 * would pin the user to today's default forever, which is the staleness the
 * sparse contract exists to prevent.
 */
export const notificationChannelPreferencesPatchSchema = z.record(
  notificationEventKeySchema,
  z.boolean().nullable(),
);

/**
 * PATCH form of the `notifications` namespace.
 *
 * Three levels of delete, each meaning something different:
 *   `{ notifications: null }`                       -> clear the namespace
 *   `{ notifications: { email: null } }`            -> clear the email channel
 *   `{ notifications: { email: { 'k': null } } }`   -> delete one event key
 *
 * Unlike `dataTablesPatchSchema`, a non-null channel object is DEEP-merged
 * per event rather than replacing the channel wholesale — see
 * UserSettingsService.mergeNotifications for why.
 */
export const notificationsPatchSchema = z.partialRecord(
  z.enum(NOTIFICATION_CHANNELS),
  notificationChannelPreferencesPatchSchema.nullable(),
);

export type NotificationChannelPreferencesValue = z.infer<
  typeof notificationChannelPreferencesSchema
>;
export type NotificationsValue = z.infer<typeof notificationsSchema>;
export type NotificationsPatchValue = z.infer<typeof notificationsPatchSchema>;

/**
 * Compile-time guard: what this schema accepts must remain assignable to the
 * shape the dispatcher reads (`NotificationPreferences`, #125).
 *
 * Exported only so it is not an unused local — nothing should reference it.
 * If it ever resolves to `false`, the write path and the read path have drifted
 * apart and stored preferences would stop resolving; fix the schema rather than
 * this alias.
 */
export type NotificationsValueMatchesDispatcherShape = [
  NotificationsValue,
] extends [NotificationPreferences]
  ? true
  : false;

// =============================================================================
// `onboarding` (#203): first-run welcome and getting-started checklist state
// =============================================================================
//
// UI state only: when the welcome dialog was seen, when the checklist was
// dismissed, and the goal the user picked on the welcome dialog (it seeds the
// plan wizard's goal and orders the checklist). Whether a checklist STEP is
// done is never stored here; `GET /api/onboarding` derives it from the data.
//
// Sparse like every namespace in this file: absent means "never seen, never
// dismissed, no goal". No `.default()`.

/**
 * The goals the welcome dialog offers: `programs.goal` minus `custom`, which
 * needs a free-text description the dialog does not collect.
 */
export const ONBOARDING_GOALS = [
  'strength',
  'hypertrophy',
  'fat_loss',
  'endurance',
  'general',
] as const satisfies readonly Exclude<ProgramGoal, 'custom'>[];

export const onboardingGoalSchema = z.enum(ONBOARDING_GOALS);

/**
 * Stored and PUT form. Each field is nullable because `null` is a meaningful
 * value in the contract ("not yet" / "no goal"); the PATCH merge deletes a
 * field sent as `null`, so a stored row normally carries only set values.
 */
export const onboardingSettingsSchema = z
  .object({
    welcomeSeenAt: z.iso.datetime().nullable().optional(),
    checklistDismissedAt: z.iso.datetime().nullable().optional(),
    goal: onboardingGoalSchema.nullable().optional(),
  })
  .strict();

/**
 * PATCH form: shallow merge of the provided keys; an explicit `null` clears
 * that key (the web's "Getting started" menu item resets both timestamps).
 */
export const onboardingPatchSchema = onboardingSettingsSchema;

export type OnboardingGoal = z.infer<typeof onboardingGoalSchema>;
export type OnboardingValue = z.infer<typeof onboardingSettingsSchema>;
export type OnboardingPatchValue = z.infer<typeof onboardingPatchSchema>;

// =============================================================================
// `coach` (E7.1, #241): the AI Coach's per-user preferences
// =============================================================================
//
// docs/specs/ai-coach.md §3.1. Sparse like every namespace in this file: no
// `.default()`. Absent (namespace, field, or nested `audio`/`quietHours`
// field) means "use `COACH_USER_DEFAULTS`", applied at read time by
// `resolveCoachUserSettings`, so a default changed in a later release reaches
// every user who never chose otherwise.
//
// THE SCHEMA BOUNDS SHAPE, NOT POLICY. The unlock rules (`profanity` needs the
// system `allowProfanePersonas` switch and an 18+ confirmation; `audio.enabled`
// needs the system `allowAudio`; `maxNudgesPerDay` is clamped to the system
// ceiling; `personaId` must name a registry persona) are applied by the coach
// settings route, which can read the system settings and the persona registry.
// This schema only refuses values that are never valid.
//
// `why` is free text the user writes and the model later reads: bounded to
// 200 characters here, like every other user-written field in this blob.

/** `HH:mm`, 24-hour, zero-padded. Same grammar as `BACKUP_TIME_OF_DAY_PATTERN`. */
export const COACH_TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A registry id: lowercase slug. Whether it names a persona is the route's check. */
export const COACH_PERSONA_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const COACH_PERSONA_ID_MAX_LENGTH = 64;
export const COACH_VOICE_MAX_LENGTH = 64;
export const COACH_WHY_MAX_LENGTH = 200;
export const COACH_INTENSITY_MIN = 1;
export const COACH_INTENSITY_MAX = 3;
export const COACH_AUDIO_SPEED_MIN = 0.75;
export const COACH_AUDIO_SPEED_MAX = 1.5;
export const COACH_MAX_NUDGES_PER_DAY_MIN = 1;
export const COACH_MAX_NUDGES_PER_DAY_MAX = 4;

export const COACH_PHOTO_CADENCES = ['off', 'weekly', 'biweekly', 'monthly'] as const;

export const coachPhotoCadenceSchema = z.enum(COACH_PHOTO_CADENCES);

const coachTimeOfDaySchema = z
  .string()
  .regex(COACH_TIME_OF_DAY_PATTERN, 'must be HH:mm (24-hour)');

const coachPersonaIdSchema = z
  .string()
  .min(1)
  .max(COACH_PERSONA_ID_MAX_LENGTH)
  .regex(COACH_PERSONA_ID_PATTERN);

const coachIntensitySchema = z
  .number()
  .int()
  .min(COACH_INTENSITY_MIN)
  .max(COACH_INTENSITY_MAX);

const coachAudioSpeedSchema = z
  .number()
  .min(COACH_AUDIO_SPEED_MIN)
  .max(COACH_AUDIO_SPEED_MAX);

const coachMaxNudgesPerDaySchema = z
  .number()
  .int()
  .min(COACH_MAX_NUDGES_PER_DAY_MIN)
  .max(COACH_MAX_NUDGES_PER_DAY_MAX);

const coachVoiceSchema = z.string().min(1).max(COACH_VOICE_MAX_LENGTH);

const coachWhySchema = z.string().max(COACH_WHY_MAX_LENGTH);

/** `coach.audio`, stored and PUT form. Absent `voice` = the persona's default voice. */
export const coachAudioSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    voice: coachVoiceSchema.optional(),
    speed: coachAudioSpeedSchema.optional(),
  })
  .strict();

/** `coach.quietHours`, stored and PUT form. The window may wrap midnight. */
export const coachQuietHoursSchema = z
  .object({
    start: coachTimeOfDaySchema.optional(),
    end: coachTimeOfDaySchema.optional(),
  })
  .strict();

/**
 * Stored and PUT form of the `coach` namespace. STRICT: an unknown key is a
 * 400. `adultConfirmedAt`, `why` and `preferredTime` are nullable because
 * `null` is a value in the contract ("not confirmed", "no reason given", "no
 * anchor").
 */
export const coachSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    personaId: coachPersonaIdSchema.optional(),
    intensity: coachIntensitySchema.optional(),
    profanity: z.boolean().optional(),
    adultConfirmedAt: z.iso.datetime().nullable().optional(),
    audio: coachAudioSettingsSchema.optional(),
    quietHours: coachQuietHoursSchema.optional(),
    maxNudgesPerDay: coachMaxNudgesPerDaySchema.optional(),
    lockScreenSafe: z.boolean().optional(),
    photoCadence: coachPhotoCadenceSchema.optional(),
    why: coachWhySchema.nullable().optional(),
    preferredTime: coachTimeOfDaySchema.nullable().optional(),
  })
  .strict();

/**
 * PATCH form, merged by `UserSettingsService.mergeCoach`: an omitted field
 * keeps the stored value, a value replaces it, `null` deletes it (back to the
 * built-in default). `audio` and `quietHours` merge one level deeper the same
 * way, so `{ coach: { audio: { speed: 1.25 } } }` keeps the stored voice.
 */
export const coachSettingsPatchSchema = z
  .object({
    enabled: z.boolean().nullable().optional(),
    personaId: coachPersonaIdSchema.nullable().optional(),
    intensity: coachIntensitySchema.nullable().optional(),
    profanity: z.boolean().nullable().optional(),
    adultConfirmedAt: z.iso.datetime().nullable().optional(),
    audio: z
      .object({
        enabled: z.boolean().nullable().optional(),
        voice: coachVoiceSchema.nullable().optional(),
        speed: coachAudioSpeedSchema.nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    quietHours: z
      .object({
        start: coachTimeOfDaySchema.nullable().optional(),
        end: coachTimeOfDaySchema.nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    maxNudgesPerDay: coachMaxNudgesPerDaySchema.nullable().optional(),
    lockScreenSafe: z.boolean().nullable().optional(),
    photoCadence: coachPhotoCadenceSchema.nullable().optional(),
    why: coachWhySchema.nullable().optional(),
    preferredTime: coachTimeOfDaySchema.nullable().optional(),
  })
  .strict();

export type CoachPhotoCadence = z.infer<typeof coachPhotoCadenceSchema>;
export type CoachAudioSettingsValue = z.infer<typeof coachAudioSettingsSchema>;
export type CoachQuietHoursValue = z.infer<typeof coachQuietHoursSchema>;
export type CoachSettingsValue = z.infer<typeof coachSettingsSchema>;
export type CoachSettingsPatchValue = z.infer<typeof coachSettingsPatchSchema>;

/** Every `coach` field resolved: what a consumer reads after applying defaults. */
export interface ResolvedCoachUserSettings {
  enabled: boolean;
  personaId: string;
  intensity: number;
  profanity: boolean;
  adultConfirmedAt: string | null;
  audio: {
    enabled: boolean;
    /** `null` = the persona's default voice. */
    voice: string | null;
    speed: number;
  };
  quietHours: { start: string; end: string };
  maxNudgesPerDay: number;
  lockScreenSafe: boolean;
  photoCadence: CoachPhotoCadence;
  why: string | null;
  preferredTime: string | null;
}

/**
 * The built-in defaults (spec §3.1). The ONE place they live; never written
 * into a user's row. Off until the user picks a persona.
 */
export const COACH_USER_DEFAULTS: Readonly<ResolvedCoachUserSettings> = Object.freeze({
  enabled: false,
  personaId: 'coach',
  intensity: 2,
  profanity: false,
  adultConfirmedAt: null,
  audio: Object.freeze({ enabled: false, voice: null, speed: 1.0 }),
  quietHours: Object.freeze({ start: '21:30', end: '07:30' }),
  maxNudgesPerDay: 2,
  lockScreenSafe: true,
  photoCadence: 'biweekly',
  why: null,
  preferredTime: null,
});

/** A stored (sparse, possibly absent) `coach` namespace with every default applied. */
export function resolveCoachUserSettings(
  stored: CoachSettingsValue | undefined,
): ResolvedCoachUserSettings {
  const d = COACH_USER_DEFAULTS;
  return {
    enabled: stored?.enabled ?? d.enabled,
    personaId: stored?.personaId ?? d.personaId,
    intensity: stored?.intensity ?? d.intensity,
    profanity: stored?.profanity ?? d.profanity,
    adultConfirmedAt: stored?.adultConfirmedAt ?? d.adultConfirmedAt,
    audio: {
      enabled: stored?.audio?.enabled ?? d.audio.enabled,
      voice: stored?.audio?.voice ?? d.audio.voice,
      speed: stored?.audio?.speed ?? d.audio.speed,
    },
    quietHours: {
      start: stored?.quietHours?.start ?? d.quietHours.start,
      end: stored?.quietHours?.end ?? d.quietHours.end,
    },
    maxNudgesPerDay: stored?.maxNudgesPerDay ?? d.maxNudgesPerDay,
    lockScreenSafe: stored?.lockScreenSafe ?? d.lockScreenSafe,
    photoCadence: stored?.photoCadence ?? d.photoCadence,
    why: stored?.why ?? d.why,
    preferredTime: stored?.preferredTime ?? d.preferredTime,
  };
}
