// =============================================================================
// What `GET /api/admin/doctor` answers with (issue #634)
// =============================================================================
//
// ALWAYS A 200 FOR AN AUTHORIZED CALLER. A failing check is a row with
// `status: 'fail'`, never an error status: the report is read precisely when
// something is wrong, and a 500 or a 503 would withhold the list of what.
//
// Every nullable field is present on every row (`null` rather than absent), so
// a client renders one shape without optional-chaining through it.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const doctorStatusSchema = z
  .enum(['pass', 'warn', 'fail', 'skip'])
  .describe(
    '`pass` — verified healthy. `warn` — works, but needs attention. `fail` — broken. ' +
      '`skip` — not evaluated: a check it depends on did not pass, or the capability is ' +
      'intentionally switched off.',
  );

export const doctorCheckReportSchema = z.object({
  /** Stable dotted id, e.g. `storage.bucket`. */
  id: z.string(),
  /** `core`, `auth`, `storage`, ... — a fork may add its own. */
  category: z.string(),
  label: z.string(),
  /** The web route that fixes this check, when there is one. */
  settingsPath: z.string().nullable(),
  status: doctorStatusSchema,
  /** One line: what was found. */
  detail: z.string(),
  /** What to do about a `warn` or `fail`. Always set on those two. */
  remedy: z.string().nullable(),
  /** The underlying error message, when a probe failed. */
  error: z.string().nullable(),
  /** Small scalar facts: counts, versions, latencies. Never secret material. */
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable(),
  /** How long this check took; 0 when it was skipped without running. */
  durationMs: z.number().int(),
});

export const doctorReportSchema = z.object({
  /** The worst status in `checks` (pass < skip < warn < fail); `skip` when none ran. */
  verdict: doctorStatusSchema,
  /** When this report was produced. A cached report keeps its original time. */
  generatedAt: z.iso.datetime(),
  /** Wall time of the whole run. */
  durationMs: z.number().int(),
  /** Sorted by category (shipped order first), then registration order. */
  checks: z.array(doctorCheckReportSchema),
});

export class DoctorReportDto extends createZodDto(doctorReportSchema) {}

export type DoctorCheckReport = z.infer<typeof doctorCheckReportSchema>;
export type DoctorReport = z.infer<typeof doctorReportSchema>;
