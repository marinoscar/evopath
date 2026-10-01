import { createZodDto } from 'nestjs-zod';

import { systemCoachPatchSchema, systemCoachSchema } from '../../common/schemas/settings.schema';

// =============================================================================
// /api/admin/coach/settings (E7.2, #242; docs/specs/ai-coach.md §3.2)
// =============================================================================

/** The system `coach` setting as stored (every field present). */
export class SystemCoachSettingsView extends createZodDto(systemCoachSchema) {}

/** PUT body: any subset of the fields; an omitted field keeps its value. STRICT. */
export const putSystemCoachSettingsSchema = systemCoachPatchSchema.strict();
export class PutSystemCoachSettingsDto extends createZodDto(putSystemCoachSettingsSchema) {}
