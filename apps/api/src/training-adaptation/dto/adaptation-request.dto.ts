import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { MUSCLES } from '../../common/constants/training.constants';
import { ADAPTATION_REQUEST_LIMITS as L } from '../adaptation.constants';

// =============================================================================
// What the user can ask for: "I have 30 minutes", "I'm sore", "only dumbbells"
// =============================================================================
//
// The body of `POST /api/ai/training/adaptations` and of its
// `/context-preview`. At least one real change is required: `minutes`,
// `soreness`, `lowEnergy: true`, an `equipment` mode other than `gym`, a
// `gymId` or `freeText` (the service also refuses a `gymId` that is the
// planned workout's own gym when nothing else changes). `baseWorkout`
// defaults to `planned` and is forced to `none` when today has no planned
// workout (a rest day, no active plan): an ad-hoc session.
// =============================================================================

export const NOTHING_TO_CHANGE_MESSAGE = 'Tell us what to change';

export const SORENESS_LEVELS = ['mild', 'moderate'] as const;
export type SorenessLevel = (typeof SORENESS_LEVELS)[number];

export const EQUIPMENT_MODES = ['gym', 'only', 'bodyweight'] as const;
export type EquipmentMode = (typeof EQUIPMENT_MODES)[number];

export const BASE_WORKOUT_CHOICES = ['planned', 'none'] as const;

const equipmentSchema = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('gym') }).strict().meta({ description: 'The gym as it is (the default).' }),
    z
      .object({
        mode: z.literal('only'),
        equipmentTypeIds: z
          .array(z.uuid())
          .min(L.onlyEquipment.min)
          .max(L.onlyEquipment.max)
          .transform((ids) => [...new Set(ids)])
          .meta({ description: `1..${L.onlyEquipment.max} equipment types of the chosen gym ("only dumbbells").` }),
      })
      .strict(),
    z.object({ mode: z.literal('bodyweight') }).strict().meta({ description: 'Bodyweight only.' }),
  ])
  .meta({ description: 'Which equipment the adapted workout may use.' });

export const adaptationRequestSchema = z
  .object({
    minutes: z
      .number()
      .int()
      .min(L.minutes.min)
      .max(L.minutes.max)
      .optional()
      .meta({ description: `"I have 30 minutes": ${L.minutes.min}..${L.minutes.max}.` }),
    soreness: z
      .object({
        muscles: z
          .array(z.enum(MUSCLES))
          .min(L.soreMuscles.min)
          .max(L.soreMuscles.max)
          .transform((muscles) => [...new Set(muscles)]),
        level: z.enum(SORENESS_LEVELS),
      })
      .strict()
      .optional()
      .meta({ description: '"I\'m sore": the sore muscles (the exercise muscle vocabulary) and how sore.' }),
    lowEnergy: z.boolean().optional().meta({ description: '"I\'m wiped": lower intensity everywhere.' }),
    equipment: equipmentSchema.optional(),
    gymId: z
      .uuid()
      .optional()
      .meta({ description: "One of your gyms (a temporary one is allowed). Default: the plan's gym, else your default gym." }),
    freeText: z
      .string()
      .trim()
      .max(L.freeTextChars, { message: `freeText must be at most ${L.freeTextChars} characters` })
      .optional()
      .transform((text) => (text ? text : undefined))
      .meta({ description: `Anything else, at most ${L.freeTextChars} characters. Sent to the model as data.` }),
    useReadiness: z.boolean().default(true).meta({ description: "Include today's check-in scores (never its note)." }),
    baseWorkout: z
      .enum(BASE_WORKOUT_CHOICES)
      .default('planned')
      .meta({ description: "`planned` adapts today's planned workout (forced to `none` when there is none); `none` builds a fresh session." }),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (!requestsAChange(body)) {
      ctx.addIssue({ code: 'custom', path: [], message: NOTHING_TO_CHANGE_MESSAGE });
    }
  });

export type AdaptationRequest = z.output<typeof adaptationRequestSchema>;
export type AdaptationRequestInput = z.input<typeof adaptationRequestSchema>;

/** The schema's at-least-one rule (the gym-equals-planned-gym case is the service's). */
export function requestsAChange(body: Partial<Pick<AdaptationRequest, 'minutes' | 'soreness' | 'lowEnergy' | 'equipment' | 'gymId' | 'freeText'>>): boolean {
  return (
    body.minutes !== undefined ||
    body.soreness !== undefined ||
    body.lowEnergy === true ||
    (body.equipment !== undefined && body.equipment.mode !== 'gym') ||
    body.gymId !== undefined ||
    (body.freeText !== undefined && body.freeText.length > 0)
  );
}

/** Whether the only change is `gymId` (the service refuses it when it is the planned gym). */
export function onlyGymChanges(body: AdaptationRequest): boolean {
  return (
    body.gymId !== undefined &&
    body.minutes === undefined &&
    body.soreness === undefined &&
    body.lowEnergy !== true &&
    (body.equipment === undefined || body.equipment.mode === 'gym') &&
    !body.freeText
  );
}

export class AdaptationRequestDto extends createZodDto(adaptationRequestSchema) {}

export const adaptationIdParamSchema = z.object({
  id: z.uuid().meta({ description: 'The adaptation id returned by `POST /api/ai/training/adaptations`.' }),
});

export class AdaptationIdParamDto extends createZodDto(adaptationIdParamSchema) {}
