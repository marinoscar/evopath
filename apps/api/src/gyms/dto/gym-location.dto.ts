import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { GYM_LOCATION_ACCURACY_MAX_METERS } from '../gyms.constants';
import { gymDetailSchema } from './gym.dto';

// =============================================================================
// /api/gyms/{id}/location — set or clear a gym's GPS position (E3.5)
// =============================================================================
//
// Coordinates are personal data: they are stored (rounded to 5 decimals, about
// 1 m) and returned to their owner, and never logged, put in a span attribute
// or sent to an AI provider. `accuracyMeters` is validated and echoed in the
// response only; it is never stored or logged.
// =============================================================================

export const setGymLocationSchema = z
  .object({
    latitude: z
      .number()
      .min(-90, { message: 'Must be between -90 and 90' })
      .max(90, { message: 'Must be between -90 and 90' })
      .meta({ description: 'Degrees, -90..90. Stored rounded to 5 decimals.' }),
    longitude: z
      .number()
      .min(-180, { message: 'Must be between -180 and 180' })
      .max(180, { message: 'Must be between -180 and 180' })
      .meta({ description: 'Degrees, -180..180. Stored rounded to 5 decimals.' }),
    accuracyMeters: z
      .number()
      .min(0, { message: `Must be between 0 and ${GYM_LOCATION_ACCURACY_MAX_METERS}` })
      .max(GYM_LOCATION_ACCURACY_MAX_METERS, { message: `Must be between 0 and ${GYM_LOCATION_ACCURACY_MAX_METERS}` })
      .optional()
      .meta({
        description:
          'The position\'s accuracy radius as the device reported it. Not stored; echoed in the response only.',
      }),
  })
  .strict();

export class SetGymLocationDto extends createZodDto(setGymLocationSchema) {}
export type SetGymLocationInput = z.output<typeof setGymLocationSchema>;

export const gymLocationResultSchema = gymDetailSchema.extend({
  accuracyMeters: z
    .number()
    .nullable()
    .meta({ description: 'The `accuracyMeters` sent with this request, or null. Never stored.' }),
});
export class GymLocationResult extends createZodDto(gymLocationResultSchema) {}
export type GymLocationResultData = z.infer<typeof gymLocationResultSchema>;
