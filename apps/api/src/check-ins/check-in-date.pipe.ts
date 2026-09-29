import { Injectable, type PipeTransform } from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';

import { checkInDateParamSchema } from './dto/check-in.dto';

/**
 * Validates the `:date` route parameter (`YYYY-MM-DD`, a real calendar day)
 * before the handler runs, so a malformed date never reaches a query. Failures
 * go through the same `ZodValidationException` path as bodies and queries, so
 * the 400 names `date` under `details.issues`.
 */
@Injectable()
export class CheckInDatePipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const result = checkInDateParamSchema.safeParse({ date: value });

    if (!result.success) {
      throw new ZodValidationException(result.error);
    }

    return result.data.date;
  }
}
