import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/measurements/lab-reports/:intakeId/duplicates — response (H4, #188)
// =============================================================================

export const labReportDuplicateMatchSchema = z.object({
  measurementId: z.uuid(),
  entryId: z.uuid(),
  measuredAt: z.iso.datetime(),
  origin: z.string(),
  healthDocumentId: z.uuid().nullable().meta({ description: 'The document the saved result was read from, if any.' }),
  intakeId: z.uuid().nullable().meta({ description: 'The intake it was applied from, if any.' }),
});

export const labReportDuplicateSchema = z.object({
  itemId: z.uuid().meta({ description: 'The draft item that would save a duplicate.' }),
  analyteKey: z.string(),
  value: z.number().meta({ description: 'The canonical value both carry.' }),
  unit: z.string(),
  matches: z.array(labReportDuplicateMatchSchema).min(1),
});

export const labReportDuplicatesSchema = z
  .object({
    intakeId: z.uuid(),
    checkedDate: z
      .string()
      .meta({ description: "The day compared (UTC), `YYYY-MM-DD`: the intake's `collectionDate`, else today." }),
    collectionDate: z.string().nullable(),
    duplicates: z.array(labReportDuplicateSchema),
  })
  .meta({
    description:
      'Draft results (pending or accepted, matched, with a number) that equal an active saved lab result of the caller: ' +
      'same analyte, same day, same canonical value. A warning only: apply never de-duplicates.',
  });

export class LabReportDuplicatesDto extends createZodDto(labReportDuplicatesSchema) {}
export type LabReportDuplicates = z.infer<typeof labReportDuplicatesSchema>;
