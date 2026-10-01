import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { LAB_UNIT_SYSTEMS, type LabUnits } from '../../measurements/metric-registry';
import { checkDateOfBirth, isValidTimeZone } from '../health-profile.validation';

// =============================================================================
// /api/health-profile — the caller's health profile (E2.1, #47)
// =============================================================================
//
//   GET /api/health-profile                         -> HealthProfile
//   PUT /api/health-profile   HealthProfileInput    -> HealthProfile
//                             (optional If-Match: <version>)
//
// PUT is a FULL REPLACE: an omitted nullable field is stored as null. Only
// `unitSystem` is required. `labUnits` (#234) is the one exception: it is not
// nullable, and omitting it KEEPS the stored preference (a client that does
// not know the field must not silently reset it). `.strict()` refuses unknown properties, so a typo
// is a 400 rather than a silently dropped field.
//
// Never echo a submitted value in a validation message: the messages below
// name the rule, not the input (the bio in particular is free text).
// =============================================================================

export const SEX_AT_BIRTH_VALUES = ['female', 'male', 'prefer_not_to_say'] as const;
export const UNIT_SYSTEM_VALUES = ['metric', 'imperial'] as const;

export const HEALTH_PROFILE_HEIGHT_MM_MIN = 500;
export const HEALTH_PROFILE_HEIGHT_MM_MAX = 2500;
export const HEALTH_PROFILE_BIO_MAX = 1000;

export type SexAtBirth = (typeof SEX_AT_BIRTH_VALUES)[number];
export type UnitSystem = (typeof UNIT_SYSTEM_VALUES)[number];
export { LAB_UNIT_SYSTEMS, type LabUnits };

const labUnitsSchema = z.enum(LAB_UNIT_SYSTEMS).meta({
  description:
    'How lab results are shown: `conventional` (US conventional units, e.g. mg/dL; the default) or `si` ' +
    '(SI units, e.g. mmol/L). Display and export only: stored values stay in the canonical unit.',
});

const DOB_MESSAGES = {
  invalid: 'dateOfBirth must be a real calendar date in YYYY-MM-DD form',
  future: 'dateOfBirth must not be in the future',
  too_old: 'dateOfBirth must not be more than 120 years ago',
} as const;

const dateOfBirthSchema = z
  .string()
  .superRefine((value, ctx) => {
    const problem = checkDateOfBirth(value);

    if (problem) {
      ctx.addIssue({ code: 'custom', message: DOB_MESSAGES[problem] });
    }
  })
  .meta({ format: 'date', description: 'Date of birth, `YYYY-MM-DD`. Null clears it.' });

const timeZoneSchema = z
  .string()
  .trim()
  .refine(isValidTimeZone, { message: 'timeZone must be an IANA time zone name' })
  .meta({ description: 'IANA time zone name, e.g. `Europe/Madrid` or `UTC`. Null clears it.' });

const bioSchema = z
  .string()
  .trim()
  .max(HEALTH_PROFILE_BIO_MAX, {
    message: `bio must be at most ${HEALTH_PROFILE_BIO_MAX} characters`,
  })
  .meta({
    description: `Free-text context, at most ${HEALTH_PROFILE_BIO_MAX} characters after trimming. An empty string is stored as null.`,
  });

/** `undefined` (omitted) and `null` both mean "not set" under full-replace semantics. */
const toNull = <T>(value: T | null | undefined): T | null => value ?? null;

export const healthProfileInputSchema = z
  .object({
    dateOfBirth: dateOfBirthSchema.nullish().transform(toNull),
    sexAtBirth: z.enum(SEX_AT_BIRTH_VALUES).nullish().transform(toNull),
    heightMm: z
      .number()
      .int({ message: 'heightMm must be a whole number of millimetres' })
      .min(HEALTH_PROFILE_HEIGHT_MM_MIN)
      .max(HEALTH_PROFILE_HEIGHT_MM_MAX)
      .nullish()
      .transform(toNull)
      .meta({ description: 'Height in whole millimetres (500 to 2500). Null clears it.' }),
    unitSystem: z.enum(UNIT_SYSTEM_VALUES),
    timeZone: timeZoneSchema.nullish().transform(toNull),
    bio: bioSchema.nullish().transform((value) => (value ? value : null)),
    labUnits: labUnitsSchema.optional().meta({
      description:
        'Lab unit preference: `conventional` or `si`. Omitted = keep the stored preference (`conventional` for a new profile).',
    }),
  })
  .strict()
  .meta({
    description:
      'Full replacement of the caller\'s health profile. Every nullable field that is omitted is stored as null; only `unitSystem` is required; an omitted `labUnits` keeps the stored preference.',
  });

export class HealthProfileInputDto extends createZodDto(healthProfileInputSchema) {}

/** The validated, normalised input the service stores. */
export type HealthProfileInput = z.output<typeof healthProfileInputSchema>;

export const healthProfileSchema = z.object({
  dateOfBirth: z.iso.date().nullable(),
  sexAtBirth: z.enum(SEX_AT_BIRTH_VALUES).nullable(),
  heightMm: z.number().int().nullable(),
  unitSystem: z.enum(UNIT_SYSTEM_VALUES),
  timeZone: z.string().nullable(),
  bio: z.string().nullable(),
  labUnits: labUnitsSchema,
  /** 0 when no profile has been saved yet; send it back as `If-Match`. */
  version: z.number().int(),
  /** Null when no profile has been saved yet. */
  updatedAt: z.iso.datetime().nullable(),
});

export class HealthProfileDto extends createZodDto(healthProfileSchema) {}
export type HealthProfile = z.infer<typeof healthProfileSchema>;

/** The stored fields a save can change — what the audit row may name. */
export const HEALTH_PROFILE_FIELDS = [
  'dateOfBirth',
  'sexAtBirth',
  'heightMm',
  'unitSystem',
  'timeZone',
  'bio',
  'labUnits',
] as const satisfies ReadonlyArray<keyof HealthProfileInput>;

export type HealthProfileField = (typeof HEALTH_PROFILE_FIELDS)[number];
