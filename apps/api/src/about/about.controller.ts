// =============================================================================
// /api/admin/about — what is actually deployed here (issue #401, epic #397)
// =============================================================================
//
// ONE ROUTE, ONE STATUS CODE. `GET /api/admin/about` answers 200 for every
// reachable-and-authorized caller, always. A missing deploy document, a
// malformed one and an unreachable database are all FIELDS in the body. The
// full argument for that lives in `dto/about-response.dto.ts`; the short version
// is that an operator opens this page precisely when something is wrong, and a
// 404 or a 503 would withhold the facts they came for.
//
// -----------------------------------------------------------------------------
// ⚠ IT GATES ON THE EXISTING `system_settings:read`, AND INVENTS NOTHING
// -----------------------------------------------------------------------------
//
// The permission is `PERMISSIONS.SYSTEM_SETTINGS_READ` — the literal string
// `system_settings:read`, already seeded Admin-only and already enforced by
// `settings/system-settings/system-settings.controller.ts`.
//
// There is deliberately NO permission of its own. A new one would have to be
// seeded, granted and explained, and it would buy nothing: this endpoint reports
// the deployment's configuration, which is exactly the blast radius
// `system_settings:read` already describes. The cases that argue for a SPLIT
// permission elsewhere in this codebase (`push:*`, `broadcasts:*`, `nodes:*`,
// `storage_config:*`) all turn on a DISTINCT blast radius — key material, sends
// to every user, a fleet, a credential-bearing config screen. A read-only report
// has none of that.
//
// ⚠ THE STRING HERE IS HALF OF A CROSS-APP CONTRACT. The web settings card that
// reaches this route (a later issue in this epic) must declare the exact same
// permission, and `apps/web/src/__tests__/config/settingsRegistry.test.ts` reads
// THIS FILE'S SOURCE to prove the two agree byte for byte. Both spellings — the
// `PERMISSIONS.SYSTEM_SETTINGS_READ` reference below and the literal
// `system_settings:read` — therefore appear in this file on purpose. Do not
// "tidy" either of them away.
//
// -----------------------------------------------------------------------------
// ⚠ THE DECORATOR IS `@Auth({ permissions: [...] })`, AND THE PERMISSION IS NOT
// OPTIONAL
// -----------------------------------------------------------------------------
//
// This follows `storage/config/storage-config.controller.ts` exactly — the
// nearest neighbour on an `admin/` prefix — and not a hand-rolled
// `@UseGuards(JwtAuthGuard)`. A route declared as merely AUTHENTICATED, with no
// permission decorator, is the trap this epic has already been bitten by: the
// resolved user is not necessarily attached to the request, `permissions` reads
// as `undefined`, and an empty set silently filters permissioned content out of
// a perfectly cheerful 200. Declaring the permission is what makes
// `PermissionsGuard` run at all, and `test/about/about.integration.spec.ts`
// drives this route through the REAL guard stack — a holder in, a non-holder
// refused — because a unit test that hands the controller a user it built itself
// cannot see that failure.
//
// Mounted at `admin/about` rather than `about` for the reason
// `NodesAdminController` and `DatabaseBackupController` both give about their
// prefixes: `JwtAuthGuard` treats path prefixes as part of what a non-session
// credential may reach, and an administrative surface belongs outside the `nod_`
// allowlist by construction rather than by a check somebody has to remember.
// =============================================================================

import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { AllowDuringMaintenance } from '../common/maintenance/allow-during-maintenance.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { AboutService } from './about.service';
import { AboutResponseDto } from './dto/about-response.dto';

@ApiTags('About')
// ⚠ READABLE DURING A MAINTENANCE WINDOW, deliberately.
//
// Every other admin surface is blocked while a window is open, and that is
// right: they CHANGE things. This one only reports, and the moment an operator
// most needs it is precisely the moment a window is open -- a deploy failed
// partway, somebody opened the window to stop traffic, and the question they
// now have is "what is actually on this box?". Answering 503 to that question
// withholds the one page that could answer it, from the one person entitled to
// ask.
//
// It is safe to exempt on the same grounds the health probes are: it performs
// no network I/O, writes nothing, and already reports an unreachable database
// as a field rather than an error -- which is the state a window is often
// covering for. It remains gated on `system_settings:read`, so the exemption
// widens no surface to anyone who could not already read it.
@AllowDuringMaintenance()
@Controller('admin/about')
export class AboutController {
  constructor(private readonly about: AboutService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Report what is deployed here (Admin only)',
    description:
      'Reports this deployment: the API version the process resolved for itself, the deploy ' +
      'document `appctl deploy` left on disk, and a database liveness fact.\n\n' +
      '**Always answers `200`.** A missing document is `deployInfoStatus: "absent"`, an ' +
      'unreadable or malformed one is `"invalid"`, and a database that does not answer is ' +
      '`database: null` with a `databaseError` string. None of the three is an error status: ' +
      'this endpoint is read when something has gone wrong, so every failure it can have is a ' +
      'field rather than a status code.\n\n' +
      '**Three deploy states, not two.** Beyond `ok` and `absent`, a document can be complete ' +
      'AND describe a run that failed — `deployInfoStatus: "ok"` with `run.outcome: "failure"` ' +
      'and `run.failedStep` naming where it stopped. That run still deployed something, so ' +
      'every fact it recorded is reported.\n\n' +
      '**Never performs network I/O.** `remote` is copied from the document as-is; this route ' +
      'does not contact the deploy remote, run git, or refresh anything. The document is read ' +
      'from disk on every request, so rewriting it needs no restart.\n\n' +
      '`deployInfoPath` is the exact path that was read, and on an `absent` answer it is the ' +
      'actionable fact — the file may simply be at a different path, on an unattached bind ' +
      'mount, or from a run that stopped before writing it.\n\n' +
      '**Deployment details (issue #392).** `lastCommand`, `bindPort`, `proxy`, `host` and ' +
      '`history` (successful runs, newest first, at most 20) are also read from the document, ' +
      'leniently: an invalid sub-field is `null` and an invalid history entry is dropped. `host` ' +
      'and `proxy.certificateExpiresAt` are as the CLI observed them when it wrote the file, not ' +
      'live. `runtime` (`processStartedAt`, `nodeVersion`, `environment`) is the one live object, ' +
      'describing this API process.\n\n' +
      'Requires `system_settings:read`.',
  })
  @ApiResponse({
    status: 200,
    description:
      'The deployment report. Returned for every authorized caller, whatever the state of ' +
      'the deploy document or the database.',
    type: AboutResponseDto,
  })
  async getAbout(): Promise<AboutResponseDto> {
    return this.about.describe();
  }
}
