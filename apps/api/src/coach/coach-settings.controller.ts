import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AiEnabledGuard } from '../ai/config/ai-enabled.guard';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../common/dto/error.dto';
import { CoachSettingsService } from './coach-settings.service';
import { CoachPersonaCard, type CoachPersonaCardData } from './dto/coach-personas.dto';
import { CoachSettingsView, PutCoachSettingsDto, type CoachSettingsViewData } from './dto/coach-settings.dto';

// =============================================================================
// /api/coach — personas and the caller's coach settings (E7.2, #242)
// =============================================================================
//
//   GET /api/coach/personas   ai:use   the persona gallery (static sample lines)
//   GET /api/coach/settings   ai:use   the caller's settings, effective register
//   PUT /api/coach/settings   ai:use   update with the unlock rules applied
//
// `AiEnabledGuard` at class level, like every consumer route under
// `/api/ai/*` (docs/specs/ai-coach.md §3.6): while AI is off the coach does
// nothing, so its consumer routes answer 403 `AI_DISABLED`. Owner-scoped by
// construction: every route acts on the caller only. No provider call.
// =============================================================================

const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const FORBIDDEN = {
  status: 403,
  description: '`AI_DISABLED` (`details.reason`), or missing `ai:use`',
  type: ErrorDto,
} as const;

@ApiTags('AI Coach')
@Controller('coach')
@UseGuards(AiEnabledGuard)
export class CoachSettingsController {
  constructor(private readonly coach: CoachSettingsService) {}

  @Get('personas')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'List coach personas',
    description:
      'Every coach persona: name, tagline, icon key, style, the label and default voice of each intensity ' +
      '(1 to 3), and a static sample line for every moment at every intensity. Served as-is: no model call. ' +
      'Sarge at intensity 3 is adult language: its uncensored lines are returned only when the caller\'s ' +
      'register is profane (all four unlock conditions of `GET /api/coach/settings` `effective.register`); ' +
      'otherwise the intensity-2 lines stand in and `censored` is true.',
  })
  @ApiDataResponse(CoachPersonaCard, { isArray: true, description: 'The persona gallery, in display order' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  personas(@CurrentUser('id') userId: string): Promise<CoachPersonaCardData[]> {
    return this.coach.personas(userId);
  }

  @Get('settings')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'Get my coach settings',
    description:
      'The caller\'s `coach` settings with defaults applied, what is in effect now (`maxNudgesPerDay` clamped ' +
      'to the deployment ceiling; the register, `profane` plus the failed unlock condition in `reason`; the ' +
      'rendered intensity and voice), and the deployment policy that shapes them. The register is ' +
      're-evaluated on every read: turning the deployment\'s profane personas off silences profanity without ' +
      'changing the stored settings.',
  })
  @ApiDataResponse(CoachSettingsView, { description: 'Settings, effective values and policy' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  view(@CurrentUser('id') userId: string): Promise<CoachSettingsViewData> {
    return this.coach.view(userId);
  }

  @Put('settings')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'Update my coach settings',
    description:
      'Updates the caller\'s `coach` settings. An omitted field keeps its value; `null` returns it to the ' +
      'default. `confirmAdult: true` records that the caller confirmed they are 18 or older ' +
      '(`adultConfirmedAt` is stamped by the server; it cannot be sent). Refusals store nothing: ' +
      '400 `COACH_PERSONA_UNKNOWN` for a `personaId` not in `GET /api/coach/personas`; 403 `COACH_DISABLED` ' +
      'to enable the coach while the deployment has it off; 403 `COACH_AUDIO_DISABLED` to enable audio while ' +
      'the deployment disallows it; 403 `COACH_PROFANITY_LOCKED` to set `profanity: true` while an unlock ' +
      'condition fails, with `details.reason` naming it (`system_disabled`, `underage`, `age_unverified`, ' +
      '`persona_or_intensity`). The coach code is in `details.code`. A date of birth in the health profile ' +
      'under 18 refuses profanity whatever the confirmation says.',
  })
  @ApiDataResponse(CoachSettingsView, { description: 'The updated settings, effective values and policy' })
  @ApiResponse({ status: 400, description: 'Validation error, or `COACH_PERSONA_UNKNOWN`', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse({
    status: 403,
    description:
      '`AI_DISABLED`, missing `ai:use`, `COACH_DISABLED`, `COACH_AUDIO_DISABLED` or `COACH_PROFANITY_LOCKED`',
    type: ErrorDto,
  })
  update(@CurrentUser('id') userId: string, @Body() dto: PutCoachSettingsDto): Promise<CoachSettingsViewData> {
    return this.coach.update(userId, dto);
  }
}
