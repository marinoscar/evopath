import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { draftItemViewSchema } from '../../../intake/dto/intake.dto';

// =============================================================================
// POST /api/measurements/lab-reports/:intakeId/reject-unmatched — response (#311)
// =============================================================================

export const labReportRejectUnmatchedSchema = z
  .object({
    items: z.array(draftItemViewSchema).meta({
      description:
        'The results this call rejected, in review order, as they now stand (`status: rejected`). Empty when ' +
        'every unmatched result was already rejected, or there was none.',
    }),
  })
  .meta({
    description:
      'The unmatched lab results (no catalog analyte, `analyteKey: null`) the call rejected. Each can be restored ' +
      'with `PATCH /api/intakes/:id/items/:itemId` `{ status: "pending" }`, like any rejected result.',
  });

/** Named `LabReportRejectUnmatchedView` because the class name is the OpenAPI schema name. */
export class LabReportRejectUnmatchedView extends createZodDto(labReportRejectUnmatchedSchema) {}
export type LabReportRejectUnmatched = z.infer<typeof labReportRejectUnmatchedSchema>;
