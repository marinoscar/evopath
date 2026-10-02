import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { LAB_APPLY_ISSUE_CODES } from '../lab-report-issues';

// =============================================================================
// GET /api/measurements/lab-reports/:intakeId/issues — response (#317)
// =============================================================================

export const labReportIssueSchema = z.object({
  code: z.enum(LAB_APPLY_ISSUE_CODES).meta({
    description:
      'Why apply would refuse the result: `UNMATCHED` (no catalog analyte), `UNIT_NOT_ALLOWED`, `NO_VALUE`, ' +
      '`OUT_OF_RANGE` (outside the hard bounds), `REFERENCE_ORDER` (referenceLow above referenceHigh), ' +
      '`DUPLICATE_ON_DATE` (the same analyte more than once on one effective date; listed on each), `DATE_CAP` ' +
      '(more results on one date than one entry holds; listed on each result of that date) or `INVALID_RESULT`.',
  }),
  field: z
    .string()
    .nullable()
    .meta({ description: 'The value field concerned (`analyteKey`, `unit`, `value`, `referenceLow`), or null.' }),
  message: z.string().meta({ description: 'What to do, as apply words it. Never carries a value.' }),
});

export const labReportItemIssuesSchema = z.object({
  itemId: z.uuid().meta({ description: 'The draft result.' }),
  issues: z.array(labReportIssueSchema).min(1),
});

export const labReportIssuesSchema = z
  .object({
    items: z.array(labReportItemIssuesSchema).meta({
      description: 'Only the results with at least one issue, in review order. Empty when apply would refuse nothing.',
    }),
  })
  .meta({
    description:
      'What `POST /api/intakes/:id/apply` would refuse for each result that is not rejected (pending or accepted), ' +
      'checked as if every one of them were accepted. Apply and this route share one check.',
  });

/** Named `LabReportIssuesView` because the class name is the OpenAPI schema name. */
export class LabReportIssuesView extends createZodDto(labReportIssuesSchema) {}
export type LabReportIssues = z.infer<typeof labReportIssuesSchema>;
export type LabReportIssue = z.infer<typeof labReportIssueSchema>;
