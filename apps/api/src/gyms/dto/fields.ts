import { z } from 'zod';

// =============================================================================
// Field builders shared by the gyms DTOs (E3.3)
// =============================================================================

/**
 * Optional free text: trimmed, bounded, and a blank value is stored as `null`.
 * `null` clears the field on a PATCH; omitting it leaves the field unchanged.
 */
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, { message: `Must be at most ${max} characters` })
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();
}

/** A required display name: trimmed, 1..max characters. */
export function requiredName(max: number) {
  return z
    .string()
    .trim()
    .min(1, { message: 'Must not be empty' })
    .max(max, { message: `Must be at most ${max} characters` });
}

/** `'true'`/`'false'` → boolean (never `z.coerce.boolean()`, which reads `'false'` as true). */
export const queryBoolean = z.enum(['true', 'false']).transform((value) => value === 'true');

/** A list of distinct UUIDs, at most `max` long. */
export function uuidSet(max: number) {
  return z
    .array(z.uuid())
    .max(max, { message: `At most ${max} ids` })
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Ids must be distinct' });
}
