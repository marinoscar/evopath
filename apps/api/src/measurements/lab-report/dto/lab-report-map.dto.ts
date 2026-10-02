import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { draftItemViewSchema } from '../../../intake/dto/intake.dto';
import { isLabMetric } from '../../metric-registry';
import { LAB_UNIT_MAX } from '../lab-report.value';

// =============================================================================
// POST /api/measurements/lab-reports/:intakeId/map — body and response (#307)
// =============================================================================

export const mapLabResultSchema = z
  .object({
    itemId: z.uuid().meta({ description: 'The draft result the user corrected (a `result` item of this intake).' }),
    analyteKey: z
      .string()
      .min(1)
      .max(64)
      .refine(isLabMetric, { message: 'analyteKey must be a lab analyte key from GET /api/measurements/metrics' })
      .optional()
      .meta({ description: 'The lab catalog key (category `lab`) to map the result, and every same-named result, to.' }),
    unit: z
      .string()
      .trim()
      .min(1)
      .max(LAB_UNIT_MAX)
      .optional()
      .meta({
        description:
          'The unit the result, and every same-named result of the same analyte printed with the same unit, is ' +
          're-read in: each printed number is kept and reinterpreted in this unit, then converted to canonical.',
      }),
  })
  .strict()
  .refine((body) => body.analyteKey !== undefined || body.unit !== undefined, {
    message: 'At least one of analyteKey or unit is required',
  })
  .meta({ description: 'The correction to propagate: an analyte, a unit, or both (the analyte first).' });

export class MapLabResultDto extends createZodDto(mapLabResultSchema) {}
export type MapLabResultInput = z.output<typeof mapLabResultSchema>;

export const labResultMapSkipSchema = z.object({
  itemId: z.uuid().meta({ description: 'A same-named result that was left unchanged.' }),
  message: z.string().meta({
    description:
      'Why: the rule the edit would break for that result (a unit the analyte does not allow, a value outside its ' +
      'bounds), as `PATCH /api/intakes/:id/items/:itemId` would word it. Never echoes the value.',
  }),
});

export const labResultMapSchema = z
  .object({
    items: z.array(draftItemViewSchema).meta({
      description: 'Every result that was mapped, the clicked one included, in review order, as they now stand.',
    }),
    skipped: z.array(labResultMapSkipSchema).meta({
      description: 'Same-named results the mapping could not apply to; each is left exactly as it was.',
    }),
  })
  .meta({
    description:
      'The outcome of mapping a lab result to an analyte: the results now mapped, and the same-named results left alone.',
  });

/** Named `LabResultMapView` because the class name is the OpenAPI schema name. */
export class LabResultMapView extends createZodDto(labResultMapSchema) {}
export type LabResultMap = z.infer<typeof labResultMapSchema>;
