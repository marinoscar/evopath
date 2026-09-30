import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `GET /api/admin/doctor` query.
 *
 * `refresh` is `z.enum(['true','false']).transform(...)` and NOT
 * `z.coerce.boolean()`, for the reason `jobs/dto/job-list-query.dto.ts` gives:
 * every query parameter is a string and `Boolean('false')` is `true`.
 */
export const doctorQuerySchema = z.object({
  /** Only the checks in this category (plus, unreported, whatever they depend on). */
  category: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'category must be a lowercase identifier')
    .optional(),
  /** `true` bypasses the 15-second report cache. */
  refresh: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export class DoctorQueryDto extends createZodDto(doctorQuerySchema) {}

export type DoctorQuery = z.output<typeof doctorQuerySchema>;
