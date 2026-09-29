// =============================================================================
// Exercises (E4.1) — shared limits and refusal reasons
// =============================================================================
//
// One home for every bound the DTOs, the services and the tests agree on.
// Machine-readable refusal reasons go in `details.reason` (the error filter
// derives the top-level `code` from the status), as in the gyms module.
// =============================================================================

export const EXERCISE_NAME_MAX = 80;
export const EXERCISE_NOTES_MAX = 1000;
export const EXERCISE_PRIMARY_MUSCLES_MIN = 1;
export const EXERCISE_PRIMARY_MUSCLES_MAX = 4;
export const EXERCISE_SECONDARY_MUSCLES_MAX = 6;
/** Requirement groups are ANDed; the options inside one group are ORed. */
export const EXERCISE_REQUIREMENT_GROUPS_MAX = 4;
export const EXERCISE_REQUIREMENT_OPTIONS_MAX = 6;

/** Custom exercises (user- and AI-created, any status) one user may own. */
export const MAX_CUSTOM_EXERCISES_PER_USER = 200;

export const EXERCISE_LIST_LIMIT_DEFAULT = 100;
export const EXERCISE_LIST_LIMIT_MAX = 200;
export const EXERCISE_QUERY_MAX = 80;

/** `details.reason` values this module answers with. */
export const EXERCISE_REFUSALS = {
  LIBRARY_EXERCISE_READ_ONLY: 'LIBRARY_EXERCISE_READ_ONLY',
  EXERCISE_IN_USE: 'EXERCISE_IN_USE',
  EXERCISE_LIMIT: 'EXERCISE_LIMIT',
  UNKNOWN_EQUIPMENT_TYPE: 'UNKNOWN_EQUIPMENT_TYPE',
  UNKNOWN_CAPABILITY: 'UNKNOWN_CAPABILITY',
} as const;
