import type { CoachMoment, CoachPersonaId } from '../personas';
import { SUPPORTIVE_ANGLES } from '../guard/banned-terms';

// =============================================================================
// The angle seam (E7.5, #245; spec §2.8)
// =============================================================================
//
// Each nudge is written from one ANGLE (the learning loop's bandit arm),
// recorded on `CoachMessage.angle`. E7.11 replaces the default picker with
// `pickAngle` (the recovering-difference softmax over conversion history);
// until then `DefaultAnglePicker` answers a fixed, deterministic angle.
//
// To swap it, provide another implementation under `COACH_ANGLE_PICKER` in
// `CoachNudgesModule`. The handler only depends on the interface.
// =============================================================================

export const COACH_ANGLES = [
  'loss_aversion',
  'identity',
  'humor',
  'challenge',
  'data',
  'future_self',
  'social_proof_self',
] as const;

export type CoachAngle = (typeof COACH_ANGLES)[number];

/** What a picker may base its choice on: ids and enums only. */
export interface AnglePickInput {
  userId: string;
  moment: CoachMoment;
  personaId: CoachPersonaId;
  /** The safety register is in force: only `SUPPORTIVE_ANGLES` may be chosen. */
  supportive: boolean;
  /** The user wrote a `why` (enables `future_self`). */
  hasWhy: boolean;
}

export interface AnglePicker {
  /** The angle for this nudge, or null for none. Must honour `supportive`. */
  pick(input: AnglePickInput): Promise<CoachAngle | null>;
}

/** DI token for the active `AnglePicker`. */
export const COACH_ANGLE_PICKER = Symbol('COACH_ANGLE_PICKER');

/**
 * The fixed default until E7.11: `future_self` when the user wrote a `why`,
 * `data` for the Analyst, else `identity`. Every answer is a supportive angle
 * or is replaced by one under the supportive register, so the guard's
 * `supportive_register` angle rule can never fire on it.
 */
export class DefaultAnglePicker implements AnglePicker {
  async pick(input: AnglePickInput): Promise<CoachAngle | null> {
    const angle: CoachAngle = input.hasWhy ? 'future_self' : input.personaId === 'analyst' ? 'data' : 'identity';
    if (input.supportive && !SUPPORTIVE_ANGLES.includes(angle)) return 'identity';
    return angle;
  }
}
