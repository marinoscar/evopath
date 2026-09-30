// =============================================================================
// /api/admin/doctor — is every capability configured and healthy? (issue #634)
// =============================================================================
//
// ⚠ IT GATES ON THE EXISTING `system_settings:read`, exactly like
// `about/about.controller.ts` and for the same reason: the report describes the
// deployment's configuration, which is precisely the blast radius
// `system_settings:read` already covers, and every check is read-only (see
// `doctor-check.interface.ts`), so there is no new capability to grant. No
// `doctor:read` is invented.
//
// ⚠ THE STRING IS HALF OF A CROSS-APP CONTRACT (CLAUDE.md, Settings UI Pattern
// rule 3): a web settings card reaching this route must declare the literal
// `system_settings:read`, which is why both spellings appear in this file.
//
// Mounted under `admin/` for the reason `AboutController` gives: an
// administrative surface belongs outside the `nod_` allowlist by construction.
//
// Not `@AllowDuringMaintenance()`: unlike About, the doctor performs network
// I/O (object storage, GreptimeDB, the stack agent). An administrator still
// reaches it during a window whenever the window allows admins (the default).
// =============================================================================

import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { DOCTOR_CATEGORIES } from './doctor-check.interface';
import { DOCTOR_CACHE_TTL_MS, DOCTOR_DEFAULT_TIMEOUT_MS, DoctorService } from './doctor.service';
import { DoctorQueryDto } from './dto/doctor-query.dto';
import { DoctorReport, DoctorReportDto } from './dto/doctor-report.dto';

@ApiTags('Doctor')
@Controller('admin/doctor')
export class DoctorController {
  constructor(private readonly doctor: DoctorService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Run the configuration and health checks (Admin only)',
    description:
      'Runs a read-only check of every capability this deployment has — database, ' +
      'authentication, maintenance mode, object storage, email, Web Push, AI, the job queue, ' +
      'worker nodes, database backups and telemetry — and returns one row per check with a ' +
      '`status` (`pass`, `warn`, `fail`, `skip`), a one-line `detail`, and on `warn`/`fail` a ' +
      '`remedy` plus the `settingsPath` of the page that fixes it.\n\n' +
      '**Always answers `200`.** A failing check is a row, not an error status.\n\n' +
      '**Read-only.** No check writes an object, a row or an audit event, sends mail or a ' +
      'push, or calls a model; the explicit "Test" buttons on each settings page remain the ' +
      'way to exercise a capability end to end.\n\n' +
      `**Bounded.** Checks run in parallel; each is cut off after ${DOCTOR_DEFAULT_TIMEOUT_MS} ms ` +
      'unless it declares otherwise, and a check whose dependency failed or was skipped is ' +
      'reported as `skip` without running.\n\n' +
      `**Cached** for ${DOCTOR_CACHE_TTL_MS / 1000} s per \`category\`; pass \`refresh=true\` to run ` +
      'again now. `generatedAt` says when the report was produced.\n\n' +
      '`verdict` is the worst status present, ordered `pass` < `skip` < `warn` < `fail`.\n\n' +
      'Requires `system_settings:read`.',
  })
  @ApiQuery({
    name: 'category',
    required: false,
    type: String,
    description:
      `Only the checks in this category. Shipped categories: ${DOCTOR_CATEGORIES.join(', ')}. ` +
      'An unknown category returns an empty report.',
  })
  @ApiQuery({
    name: 'refresh',
    required: false,
    enum: ['true', 'false'],
    description: '`true` bypasses the report cache.',
  })
  @ApiResponse({ status: 200, description: 'The doctor report.', type: DoctorReportDto })
  @ApiResponse({ status: 400, description: 'Invalid query parameter' })
  async getReport(@Query() query: DoctorQueryDto): Promise<DoctorReport> {
    const { category, refresh } = query as { category?: string; refresh?: boolean };

    return this.doctor.run({ category, refresh: refresh === true });
  }
}
