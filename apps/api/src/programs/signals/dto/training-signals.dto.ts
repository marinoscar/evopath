import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { isRealDate } from '../../../check-ins/local-date';
import { daysFrom } from '../../today/resolve-today';
import {
  SIGNALS_AS_OF_WINDOW_DAYS,
  SIGNALS_DEFAULT_WEEKS,
  SIGNALS_MAX_WEEKS,
  planSignalsSchema,
} from '../plan-signals.contract';

// =============================================================================
// GET /api/training/signals (E5.9): query and response schemas
// =============================================================================

const day = (description: string) =>
  z.iso
    .date()
    .refine(isRealDate, { message: 'Must be a real calendar date in YYYY-MM-DD format' })
    .optional()
    .meta({ description });

export const trainingSignalsQuerySchema = z
  .object({
    programId: z
      .uuid()
      .optional()
      .meta({ description: 'One of the caller\'s programs. Default: the active program (none: empty signals).' }),
    from: day(`First day of the range. Default: the Monday ${SIGNALS_DEFAULT_WEEKS - 1} weeks before \`to\`'s week.`),
    to: day('Last day of the range. Default: `asOf`.'),
    asOf: day(
      'The client\'s local day the signals are computed for. Default: the server\'s today in the Health Profile time ' +
        `zone (UTC when unset); must be within ${SIGNALS_AS_OF_WINDOW_DAYS} days of it.`,
    ),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (!query.from || !query.to || !isRealDate(query.from) || !isRealDate(query.to)) return;
    if (query.from > query.to) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: '`from` must not be after `to`' });
    } else if (daysFrom(query.from, query.to) + 1 > SIGNALS_MAX_WEEKS * 7) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: `The range must be at most ${SIGNALS_MAX_WEEKS} weeks` });
    }
  });

export class TrainingSignalsQueryDto extends createZodDto(trainingSignalsQuerySchema) {}
export type TrainingSignalsQuery = z.output<typeof trainingSignalsQuerySchema>;

export class PlanSignalsView extends createZodDto(planSignalsSchema) {}
