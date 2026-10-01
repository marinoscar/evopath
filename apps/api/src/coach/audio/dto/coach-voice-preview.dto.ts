import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  COACH_AUDIO_SPEED_MAX,
  COACH_AUDIO_SPEED_MIN,
  COACH_PERSONA_ID_MAX_LENGTH,
  COACH_VOICE_MAX_LENGTH,
} from '../../../common/schemas/user-settings-namespaces.schema';
import { COACH_INTENSITIES, COACH_MOMENTS } from '../../personas';

// =============================================================================
// POST /api/coach/voice-preview (E7.6, #246; docs/specs/ai-coach.md §3.6)
// =============================================================================

/** The moment whose sample line a preview speaks when none is named. */
export const COACH_PREVIEW_DEFAULT_MOMENT = 'streak_at_risk' as const;

export const coachVoicePreviewRequestSchema = z
  .object({
    personaId: z
      .string()
      .min(1)
      .max(COACH_PERSONA_ID_MAX_LENGTH)
      .meta({ description: 'A persona id from `GET /api/coach/personas`.' }),
    intensity: z
      .number()
      .int()
      .min(COACH_INTENSITIES[0])
      .max(COACH_INTENSITIES[COACH_INTENSITIES.length - 1])
      .optional()
      .meta({ description: 'Intensity 1 to 3. Omitted: your saved intensity.' }),
    voice: z
      .string()
      .min(1)
      .max(COACH_VOICE_MAX_LENGTH)
      .optional()
      .meta({ description: 'A voice the `coach.voice` model speaks. Omitted: the persona\'s default for the level.' }),
    speed: z
      .number()
      .min(COACH_AUDIO_SPEED_MIN)
      .max(COACH_AUDIO_SPEED_MAX)
      .optional()
      .meta({ description: `${COACH_AUDIO_SPEED_MIN} to ${COACH_AUDIO_SPEED_MAX}. Omitted: your saved speed.` }),
    moment: z
      .enum(COACH_MOMENTS)
      .optional()
      .meta({ description: `Whose sample line is spoken. Omitted: \`${COACH_PREVIEW_DEFAULT_MOMENT}\`.` }),
  })
  .strict();

export type CoachVoicePreviewRequest = z.infer<typeof coachVoicePreviewRequestSchema>;
export class CoachVoicePreviewRequestDto extends createZodDto(coachVoicePreviewRequestSchema) {}

export const coachVoicePreviewStartedSchema = z.object({
  runId: z.uuid().meta({ description: 'Poll `GET /api/ai/runs/{runId}`; once `succeeded`, `output` is the audio.' }),
  jobId: z.uuid(),
  personaId: z.string(),
  intensity: z.number().int().meta({ description: 'The level spoken (a locked Sarge L3 speaks L2).' }),
  moment: z.enum(COACH_MOMENTS),
  voice: z.string(),
  censored: z.boolean().meta({ description: 'True when the clean line stood in for a locked adult-language level.' }),
});

export type CoachVoicePreviewStarted = z.infer<typeof coachVoicePreviewStartedSchema>;
export class CoachVoicePreviewStartedDto extends createZodDto(coachVoicePreviewStartedSchema) {}
