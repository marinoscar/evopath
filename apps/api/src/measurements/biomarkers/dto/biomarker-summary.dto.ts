import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { MEASUREMENT_FLAGS } from '../../dto/measurement.dto';
import { LAB_PANELS } from '../../metric-registry';

// =============================================================================
// GET /api/health/biomarkers/summary — schemas (H5, #189)
// =============================================================================

/** The flags that make a latest result "out of range" for the `outOfRange` filter. */
export const OUT_OF_RANGE_FLAGS = ['low', 'high', 'critical'] as const;

/**
 * `'true'`/`'false'` → boolean. NOT `z.coerce.boolean()`, which turns the
 * string `'false'` into `true`.
 */
const queryBoolean = z.enum(['true', 'false']).transform((value) => value === 'true');

export const biomarkerSummaryQuerySchema = z
  .object({
    panel: z
      .enum(LAB_PANELS)
      .optional()
      .meta({ description: 'Only analytes of this panel.' }),
    outOfRange: queryBoolean
      .default(false)
      .meta({
        description: `\`true\` = only analytes whose latest result is flagged ${OUT_OF_RANGE_FLAGS.map((flag) => `\`${flag}\``).join(', ')}.`,
      }),
  })
  .strict();

export class BiomarkerSummaryQueryDto extends createZodDto(biomarkerSummaryQuerySchema) {}
export type BiomarkerSummaryQuery = z.output<typeof biomarkerSummaryQuerySchema>;

export const biomarkerResultSchema = z.object({
  measurementId: z.uuid().meta({ description: 'The active measurement row (`GET /api/measurements` item id).' }),
  value: z.number().meta({ description: 'In the analyte\'s canonical unit.' }),
  measuredAt: z.iso.datetime(),
  flag: z.enum(MEASUREMENT_FLAGS).nullable(),
  referenceLow: z.number().nullable().meta({ description: 'Canonical unit; null when the lab gave none.' }),
  referenceHigh: z.number().nullable().meta({ description: 'Canonical unit; null when the lab gave none.' }),
  referenceText: z.string().nullable(),
});

export type BiomarkerResult = z.infer<typeof biomarkerResultSchema>;

export const biomarkerSummarySchema = z.object({
  items: z.array(
    z.object({
      analyteKey: z.string().meta({ description: 'The lab metric key (`metricKey`).' }),
      label: z.string(),
      panel: z.enum(LAB_PANELS),
      unit: z.string().meta({ description: 'The canonical unit every value and limit is in.' }),
      latest: biomarkerResultSchema,
      previous: biomarkerResultSchema.nullable().meta({ description: 'The result before `latest`; null with one result.' }),
      delta: z
        .number()
        .nullable()
        .meta({ description: '`latest.value - previous.value`, rounded to 4 decimals; null without `previous`.' }),
      count: z.number().int().min(1).meta({ description: 'Active results of this analyte.' }),
    }),
  ),
});

export class BiomarkerSummaryDto extends createZodDto(biomarkerSummarySchema) {}
export type BiomarkerSummary = z.infer<typeof biomarkerSummarySchema>;
