import { z } from 'zod';

// =============================================================================
// The researcher's input: the smallest object that lets it search well
// =============================================================================
//
// DATA MINIMISATION. The researcher forms its own web searches from this
// object, so anything in it may appear in a query sent to the search
// provider. `buildResearcherContext` copies ONLY the fields below, field by
// field, whatever else its source carries; `researcherContextSchema` is
// `.strict()` so nothing else can ride along.
//
// Included: goal type and the user's goal sentence (<= 300 chars), experience
// level, limitation areas with the user's short description (<= 200 chars
// each, at most 6), days per week, minutes per session, an equipment class
// (not the gym's name), free-text preferences (<= 300 chars). Only when the
// user ticked "Tailor research to my age and sex" (default off): an age band
// and sex at birth.
//
// NEVER sent: name, email, exact age or date of birth, weight or body
// measurements, labs, medications, bio, other gyms, gym name or location,
// check-ins, storage keys, photos. The web-search tool's `userLocation` is
// never set either.
//
// The context builder puts this object at `RunState.context.researcher`, and
// the "what will be sent" summary renders the same object.
// =============================================================================

export const RESEARCH_GOAL_TYPES = ['strength', 'hypertrophy', 'fat_loss', 'general', 'endurance', 'custom'] as const;
export const RESEARCH_EXPERIENCE_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export const RESEARCH_LIMITATION_AREAS = [
  'shoulder',
  'elbow',
  'wrist',
  'back',
  'hip',
  'knee',
  'ankle',
  'neck',
  'other',
] as const;
export const EQUIPMENT_CLASSES = ['full_gym', 'home_basic', 'minimal', 'bodyweight'] as const;
export const AGE_BANDS = ['18-29', '30-39', '40-49', '50-59', '60-69', '70+'] as const;
export const RESEARCH_SEX_AT_BIRTH = ['female', 'male'] as const;

export type EquipmentClass = (typeof EQUIPMENT_CLASSES)[number];
export type AgeBand = (typeof AGE_BANDS)[number];

export const RESEARCHER_CONTEXT_LIMITS = {
  goalChars: 300,
  limitationChars: 200,
  maxLimitations: 6,
  preferencesChars: 300,
} as const;

/** The disclosure shown next to the "what will be sent" panel. `{provider}` is replaced by the display name. */
export const RESEARCHER_DISCLOSURE =
  'The research agent forms its own web searches from this brief, so your goal and limitations may appear in search queries sent to {provider}.';

export const researcherContextSchema = z
  .object({
    goal: z
      .object({
        type: z.enum(RESEARCH_GOAL_TYPES),
        description: z.string().max(RESEARCHER_CONTEXT_LIMITS.goalChars),
      })
      .strict(),
    experience: z.enum(RESEARCH_EXPERIENCE_LEVELS),
    daysPerWeek: z.number().int().min(1).max(7),
    minutesPerSession: z.number().int().min(10).max(300),
    equipmentClass: z.enum(EQUIPMENT_CLASSES),
    limitations: z
      .array(
        z
          .object({
            area: z.enum(RESEARCH_LIMITATION_AREAS),
            description: z.string().max(RESEARCHER_CONTEXT_LIMITS.limitationChars),
          })
          .strict(),
      )
      .max(RESEARCHER_CONTEXT_LIMITS.maxLimitations),
    preferences: z.string().max(RESEARCHER_CONTEXT_LIMITS.preferencesChars),
    /** Present only when the user opted in to tailored research. */
    demographics: z
      .object({
        ageBand: z.enum(AGE_BANDS).nullable(),
        sexAtBirth: z.enum(RESEARCH_SEX_AT_BIRTH).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type ResearcherContext = z.infer<typeof researcherContextSchema>;

/** What the context builder hands in. Extra fields on it are ignored, never copied. */
export interface ResearcherContextSource {
  goal: { type: (typeof RESEARCH_GOAL_TYPES)[number]; description: string };
  experience: (typeof RESEARCH_EXPERIENCE_LEVELS)[number];
  daysPerWeek: number;
  minutesPerSession: number;
  equipmentClass: EquipmentClass;
  limitations: Array<{ area: (typeof RESEARCH_LIMITATION_AREAS)[number]; description: string }>;
  preferences: string;
  /** "Tailor research to my age and sex"; default off. */
  tailorResearch: boolean;
  /** Read only when `tailorResearch` is on. The exact age is never sent, only its band. */
  ageYears?: number | null;
  sexAtBirth?: string | null;
}

/** The band an age falls in, or `null` (under 18, unknown). */
export function ageBand(ageYears: number | null | undefined): AgeBand | null {
  if (typeof ageYears !== 'number' || !Number.isFinite(ageYears) || ageYears < 18) return null;
  if (ageYears >= 70) return '70+';
  if (ageYears < 30) return '18-29';
  const decade = Math.floor(ageYears / 10) * 10;
  return `${decade}-${decade + 9}` as AgeBand;
}

/** Builds the researcher's minimised input. Pure; copies an allow-list of fields only. */
export function buildResearcherContext(source: ResearcherContextSource): ResearcherContext {
  const sex = source.sexAtBirth === 'female' || source.sexAtBirth === 'male' ? source.sexAtBirth : null;

  return researcherContextSchema.parse({
    goal: { type: source.goal.type, description: clip(source.goal.description, RESEARCHER_CONTEXT_LIMITS.goalChars) },
    experience: source.experience,
    daysPerWeek: source.daysPerWeek,
    minutesPerSession: source.minutesPerSession,
    equipmentClass: source.equipmentClass,
    limitations: (source.limitations ?? []).slice(0, RESEARCHER_CONTEXT_LIMITS.maxLimitations).map((limitation) => ({
      area: limitation.area,
      description: clip(limitation.description, RESEARCHER_CONTEXT_LIMITS.limitationChars),
    })),
    preferences: clip(source.preferences, RESEARCHER_CONTEXT_LIMITS.preferencesChars),
    demographics: source.tailorResearch ? { ageBand: ageBand(source.ageYears), sexAtBirth: sex } : null,
  });
}

/** Trims, collapses whitespace and cuts to `max` characters. */
function clip(text: string | null | undefined, max: number): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, max).join('').trim();
}
