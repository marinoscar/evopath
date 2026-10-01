import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import type { CoachRegisterReason } from './personas/resolve-register';

// =============================================================================
// AI Coach error codes (E7.2, #242; docs/specs/ai-coach.md §3.7)
// =============================================================================
//
// The envelope's top-level `code` is always status-derived (`FORBIDDEN`,
// `BAD_REQUEST`; docs/API.md "Errors"), so the coach code travels in
// `details.code`. `details.reason` carries the same code, as every other
// refusal in this API does, EXCEPT for `COACH_PROFANITY_LOCKED`, whose
// `details.reason` names the failed unlock condition (spec §2.4:
// `system_disabled`, `age_unverified`, `underage`, `persona_or_intensity`).
// =============================================================================

export const COACH_ERRORS = {
  DISABLED: 'COACH_DISABLED',
  PROFANITY_LOCKED: 'COACH_PROFANITY_LOCKED',
  AUDIO_DISABLED: 'COACH_AUDIO_DISABLED',
  PERSONA_UNKNOWN: 'COACH_PERSONA_UNKNOWN',
  MESSAGE_NOT_FOUND: 'COACH_MESSAGE_NOT_FOUND',
} as const;

export function coachDisabledError(): ForbiddenException {
  return new ForbiddenException({
    message: 'The coach is switched off for this deployment.',
    details: { code: COACH_ERRORS.DISABLED, reason: COACH_ERRORS.DISABLED },
  });
}

export function coachProfanityLockedError(reason: CoachRegisterReason): ForbiddenException {
  return new ForbiddenException({
    message: 'Adult language cannot be turned on: an unlock condition is not met.',
    details: { code: COACH_ERRORS.PROFANITY_LOCKED, reason },
  });
}

export function coachAudioDisabledError(): ForbiddenException {
  return new ForbiddenException({
    message: 'Spoken coach messages are switched off for this deployment.',
    details: { code: COACH_ERRORS.AUDIO_DISABLED, reason: COACH_ERRORS.AUDIO_DISABLED },
  });
}

export function coachPersonaUnknownError(): BadRequestException {
  return new BadRequestException({
    message: 'Unknown coach persona.',
    details: {
      code: COACH_ERRORS.PERSONA_UNKNOWN,
      reason: COACH_ERRORS.PERSONA_UNKNOWN,
      issues: [{ path: 'personaId', message: 'must be a persona id from GET /api/coach/personas' }],
    },
  });
}

/** 404 for an unknown message id AND for another user's message (E7.5): existence is not disclosed. */
export function coachMessageNotFoundError(): NotFoundException {
  return new NotFoundException({
    message: 'Coach message not found.',
    details: { code: COACH_ERRORS.MESSAGE_NOT_FOUND, reason: COACH_ERRORS.MESSAGE_NOT_FOUND },
  });
}
