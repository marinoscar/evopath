/**
 * The health profile API (`/api/health-profile`), as the web app sees it.
 *
 * Issue #47 (E2.1). One row per user, read with `health_data:read` and fully
 * replaced with `health_data:write`. `services/api.ts` stays the transport (the
 * bearer token, the refresh dance, the `{ data }` envelope); this module holds
 * the two calls next to the types they produce.
 *
 * The browser presents and collects only. Every rule that matters (a real
 * calendar date, not in the future, height 500 to 2500 mm, an IANA time zone,
 * the 1000-character bio) is enforced by the API's Zod schema; the form's own
 * checks exist to explain a problem before the round trip, never to decide it.
 */

import { api, ApiError } from './api';

/** Mirrors the API's `sexAtBirth` enum. `null` means "not set". */
export const SEX_AT_BIRTH_VALUES = ['female', 'male', 'prefer_not_to_say'] as const;
export type SexAtBirth = (typeof SEX_AT_BIRTH_VALUES)[number];

export const UNIT_SYSTEMS = ['metric', 'imperial'] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];

/** The bounds the API enforces on `heightMm` (integer millimetres). */
export const HEIGHT_MM_MIN = 500;
export const HEIGHT_MM_MAX = 2500;

/** The API's limit on `bio`, counted after trimming. */
export const BIO_MAX_LENGTH = 1000;

/** How far back a date of birth may go, in years. */
export const DOB_MAX_AGE_YEARS = 120;

/** What `GET` and `PUT /api/health-profile` return. */
export interface HealthProfile {
  /** `YYYY-MM-DD`, a date-only value; never parse it through local time. */
  dateOfBirth: string | null;
  sexAtBirth: SexAtBirth | null;
  /** Integer millimetres, the only stored unit (5 ft 10 in is exactly 1778). */
  heightMm: number | null;
  unitSystem: UnitSystem;
  /** IANA name, e.g. `Europe/Madrid` or `UTC`. */
  timeZone: string | null;
  bio: string | null;
  /** `0` when no row exists yet. Pass back as `If-Match` on the next `PUT`. */
  version: number;
  updatedAt: string | null;
}

/**
 * The body of `PUT`: a FULL replace. A nullable field sent as `null` clears
 * it, and the API's schema is strict, so nothing but these six keys is sent.
 */
export type HealthProfileInput = Omit<HealthProfile, 'version' | 'updatedAt'>;

/** `GET /api/health-profile` (`health_data:read`). */
export function getHealthProfile(): Promise<HealthProfile> {
  return api.get<HealthProfile>('/health-profile');
}

/**
 * `PUT /api/health-profile` (`health_data:write`).
 *
 * `expectedVersion` becomes `If-Match`. The check is `=== undefined`, never a
 * truthiness test, so the first save of a user with no row still sends
 * `If-Match: 0` and asserts "nothing is stored yet". A mismatch is a `409`.
 */
export function saveHealthProfile(
  input: HealthProfileInput,
  expectedVersion?: number,
): Promise<HealthProfile> {
  const body: HealthProfileInput = {
    dateOfBirth: input.dateOfBirth,
    sexAtBirth: input.sexAtBirth,
    heightMm: input.heightMm,
    unitSystem: input.unitSystem,
    timeZone: input.timeZone,
    bio: input.bio,
  };
  return api.put<HealthProfile>('/health-profile', body, {
    headers:
      expectedVersion === undefined ? undefined : { 'If-Match': String(expectedVersion) },
  });
}

/** True when a save was refused because the profile changed elsewhere. */
export function isHealthProfileConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}
