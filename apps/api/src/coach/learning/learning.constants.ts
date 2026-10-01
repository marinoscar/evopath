import type { CoachPersonaId } from '../personas';
import type { CoachAngle } from '../nudges/angle-picker';

// =============================================================================
// Learning-loop constants (E7.11, #251; docs/specs/ai-coach.md §2.8)
// =============================================================================
//
// CODE CONSTANTS, never settings or environment variables. Changing one is a
// reviewed code change, so every deployment learns the same way.
//
// Scale. `r(a)` is an ABSOLUTE difference of two conversion rates (spec §2.8:
// "the rate when sent minus the rate when eligible but not sent"), so realistic
// rewards are a few hundredths. `γ` and `τ` are sized against that:
//
//   - a just-repeated angle pays `γ = 0.03`, i.e. `γ/τ = 1.5` nats, about a
//     4.5x lower odds than a fresh angle with the same reward;
//   - a reward lead of 0.05 is `0.05/τ = 2.5` nats, about 12x the odds.
//
// Yancey and Settles (KDD 2020) used a RELATIVE difference with
// `γ = 0.017, h = 15 days, τ = 0.0025`; we keep their half-life and rescale
// the other two to the absolute difference the spec defines.
// =============================================================================

export interface LearningConstants {
  /** `γ`: the novelty penalty an angle pays when the user got it today. */
  noveltyPenaltyWeight: number;
  /** `h`: the penalty's half-life, in days. */
  noveltyHalfLifeDays: number;
  /** `τ`: the softmax temperature. Lower is greedier. */
  temperature: number;
  /** Minimum sends AND minimum eligible-but-not-sent messages before `r(a)` is non-zero (cold start). */
  minSamples: number;
  /**
   * Beta-prior strength for each rate, centred on the pooled conversion rate:
   * `(converted + α·p₀) / (n + α)`. Keeps one lucky week from dominating.
   */
  priorStrength: number;
  /** `ε`: the share of probability spread uniformly, so no eligible angle ever starves. */
  explorationFloor: number;
}

export const LEARNING_CONSTANTS: Readonly<LearningConstants> = Object.freeze({
  noveltyPenaltyWeight: 0.03,
  noveltyHalfLifeDays: 15,
  temperature: 0.02,
  minSamples: 30,
  priorStrength: 20,
  explorationFloor: 0.05,
});

/** Global rewards are computed over this many days of delivered messages (spec §2.8). */
export const ANGLE_REWARD_WINDOW_DAYS = 90;

/**
 * A message younger than this has not finished its conversion window (the
 * longest is the photo prompt's 48 h), so it is left out of the reward: it
 * would otherwise count as an unconverted send.
 */
export const ANGLE_REWARD_MATURITY_HOURS = 48;

/** The user's own angle history (the novelty penalty) looks back this far. */
export const ANGLE_USER_HISTORY_DAYS = 60;
/** At most this many of the user's recent messages are read for the penalty. */
export const ANGLE_USER_HISTORY_LIMIT = 200;

/** The global reward aggregate is cached in memory this long (one per API process). */
export const ANGLE_REWARD_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Angles a persona cannot voice: removed BEFORE scoring (spec §2.8, "filtered
 * by persona"). Empty today: every registry persona can write every angle.
 * A persona that cannot voice one is listed here, never special-cased.
 */
export const PERSONA_ANGLE_EXCLUSIONS: Readonly<Partial<Record<CoachPersonaId, readonly CoachAngle[]>>> = Object.freeze({});

/**
 * Angles a persona FAVOURS: a score bonus, in the same unit as `r(a)`. The
 * Analyst favours `data` (spec §2.8); the bonus equals a 0.02 reward lead.
 */
export const PERSONA_ANGLE_BONUS: Readonly<Partial<Record<CoachPersonaId, Partial<Record<CoachAngle, number>>>>> =
  Object.freeze({
    analyst: { data: 0.02 },
  });
