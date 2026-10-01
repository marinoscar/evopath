import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { COACH_MOMENTS } from '../personas/persona.types';

// =============================================================================
// GET /api/coach/personas (E7.2, #242; docs/specs/ai-coach.md §2.3)
// =============================================================================

const intensityLinesSchema = z.object({ 1: z.string(), 2: z.string(), 3: z.string() });

const sampleLinesSchema = z.object(
  Object.fromEntries(COACH_MOMENTS.map((m) => [m, intensityLinesSchema])) as Record<
    (typeof COACH_MOMENTS)[number],
    typeof intensityLinesSchema
  >,
);

export const coachPersonaCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  tagline: z.string(),
  vibe: z.string(),
  /** Icon key. */
  avatar: z.string(),
  /** The style card's summary. */
  style: z.string(),
  intensities: z.array(
    z.object({
      level: z.number().int(),
      label: z.string(),
      /** Default voice at this level. */
      voice: z.string(),
      /** This level is adult language (Sarge L3 only), behind the unlock of spec §2.4. */
      profane: z.boolean(),
    }),
  ),
  /**
   * Static sample lines, every moment at every intensity. Placeholders:
   * `{n}`, `{streak}`, `{lift}`, `{time}`. A profane level is served only to
   * a caller whose register is profane; otherwise the clean level below
   * stands in and `censored` is true.
   */
  sampleLines: sampleLinesSchema,
  censored: z.boolean(),
});

export type CoachPersonaCardData = z.infer<typeof coachPersonaCardSchema>;
export class CoachPersonaCard extends createZodDto(coachPersonaCardSchema) {}
