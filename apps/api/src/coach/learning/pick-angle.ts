import type { CoachPersonaId } from '../personas';
import { SUPPORTIVE_ANGLES } from '../guard/banned-terms';
import { COACH_ANGLES, type CoachAngle } from '../nudges/angle-picker';
import {
  LEARNING_CONSTANTS,
  PERSONA_ANGLE_BONUS,
  PERSONA_ANGLE_EXCLUSIONS,
  type LearningConstants,
} from './learning.constants';

// =============================================================================
// pickAngle: the recovering-difference softmax (E7.11, #251; spec §2.8)
// =============================================================================
//
// PURE. No clock, no I/O, no Math.random: `now` and `rng` are injected, so a
// seeded rng gives the same answer for the same inputs.
//
// After Yancey and Settles, "A Sleeping, Recovering Bandit Algorithm for
// Optimizing Recurring Notifications" (KDD 2020):
//
//   r(a)       = μ⁺(a) − μ⁻(a)        global conversion rate when `a` was sent,
//                                      minus the rate when `a` was ELIGIBLE but
//                                      another angle was sent (0 below the
//                                      sample floor: cold start)
//   penalty(a) = γ · 0.5^(d/h)         d = days since THIS user last got `a`;
//                                      0 when the user never got it
//   s(a)       = r(a) + bias(a) − penalty(a)
//   p(a)       = (1 − ε) · softmax(s/τ) + ε / n
//
// `bias` is the persona's favour (the Analyst favours `data`); `ε` is the
// exploration floor. Both are 0-safe: with no bias and `ε = 0` this is exactly
// the spec's `softmax(s/τ)`.
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

/** One message the user received, newest or oldest first (order does not matter). */
export interface AngleHistory {
  angle: CoachAngle;
  /** When the user got it (`deliveredAt`, else `createdAt`). */
  at: Date;
}

/** Global counts for one angle over the reward window. */
export interface AngleRewardStats {
  /** Messages SENT with this angle. */
  sent: number;
  /** ...of which converted. */
  sentConverted: number;
  /** Messages where this angle was ELIGIBLE but another angle was sent. */
  notSent: number;
  /** ...of which converted. */
  notSentConverted: number;
}

export type AngleRewards = Partial<Record<CoachAngle, AngleRewardStats>>;

export interface PickAngleParams {
  now: Date;
  /** Global per-angle counts; missing angles score `r(a) = 0`. */
  rewards?: AngleRewards;
  /** A per-angle score bonus (persona favour), in reward units. */
  bias?: Partial<Record<CoachAngle, number>>;
  /** Overrides for tests; production uses `LEARNING_CONSTANTS`. */
  constants?: Partial<LearningConstants>;
}

export interface AngleScore {
  angle: CoachAngle;
  reward: number;
  penalty: number;
  score: number;
  probability: number;
}

function constantsOf(params: Pick<PickAngleParams, 'constants'>): LearningConstants {
  return { ...LEARNING_CONSTANTS, ...params.constants };
}

/** `γ · 0.5^(d/h)`; 0 when the user never got the angle (`daysSince` null). */
export function noveltyPenalty(daysSince: number | null, constants: Partial<LearningConstants> = {}): number {
  if (daysSince === null) return 0;
  const { noveltyPenaltyWeight: gamma, noveltyHalfLifeDays: h } = constantsOf({ constants });
  return gamma * Math.pow(0.5, Math.max(0, daysSince) / h);
}

/**
 * `r(a) = μ⁺ − μ⁻`, each rate shrunk toward the pooled rate by a Beta prior.
 * Zero below the sample floor on either side (cold start).
 */
export function recoveringDifference(
  stats: AngleRewardStats | undefined,
  constants: Partial<LearningConstants> = {},
): number {
  if (!stats) return 0;
  const { minSamples, priorStrength } = constantsOf({ constants });
  if (stats.sent < minSamples || stats.notSent < minSamples) return 0;
  const pooled = (stats.sentConverted + stats.notSentConverted) / (stats.sent + stats.notSent);
  const muPlus = (stats.sentConverted + priorStrength * pooled) / (stats.sent + priorStrength);
  const muMinus = (stats.notSentConverted + priorStrength * pooled) / (stats.notSent + priorStrength);
  return muPlus - muMinus;
}

/** Days since the user last got each angle, from their history. */
export function daysSinceLastByAngle(history: readonly AngleHistory[], now: Date): Map<CoachAngle, number> {
  const latest = new Map<CoachAngle, number>();
  for (const entry of history) {
    const t = entry.at.getTime();
    const prev = latest.get(entry.angle);
    if (prev === undefined || t > prev) latest.set(entry.angle, t);
  }
  const out = new Map<CoachAngle, number>();
  for (const [angle, t] of latest) out.set(angle, Math.max(0, (now.getTime() - t) / DAY_MS));
  return out;
}

/** The scored distribution over `eligible` (in `eligible` order). Exposed for tests and diagnostics. */
export function scoreAngles(
  history: readonly AngleHistory[],
  eligible: readonly CoachAngle[],
  params: PickAngleParams,
): AngleScore[] {
  const constants = constantsOf(params);
  const since = daysSinceLastByAngle(history, params.now);
  const rows = eligible.map((angle) => {
    const reward = recoveringDifference(params.rewards?.[angle], constants) + (params.bias?.[angle] ?? 0);
    const penalty = noveltyPenalty(since.get(angle) ?? null, constants);
    return { angle, reward, penalty, score: reward - penalty, probability: 0 };
  });
  if (rows.length === 0) return rows;

  const tau = Math.max(constants.temperature, 1e-9);
  const max = Math.max(...rows.map((r) => r.score / tau));
  const weights = rows.map((r) => Math.exp(r.score / tau - max));
  const total = weights.reduce((a, b) => a + b, 0);
  const epsilon = Math.min(1, Math.max(0, constants.explorationFloor));
  rows.forEach((row, i) => {
    row.probability = (1 - epsilon) * (weights[i] / total) + epsilon / rows.length;
  });
  return rows;
}

/**
 * The angle for one nudge, or `null` when nothing is eligible (the caller
 * then falls back to its default). One eligible angle is returned WITHOUT
 * calling `rng`. Otherwise `rng` is called exactly once.
 */
export function pickAngle(
  history: readonly AngleHistory[],
  eligibleAngles: readonly CoachAngle[],
  rng: () => number,
  params: PickAngleParams,
): CoachAngle | null {
  const eligible = [...new Set(eligibleAngles)];
  if (eligible.length === 0) return null;
  if (eligible.length === 1) return eligible[0];

  const scored = scoreAngles(history, eligible, params);
  const u = rng();
  let cumulative = 0;
  for (const row of scored) {
    cumulative += row.probability;
    if (u < cumulative) return row.angle;
  }
  return scored[scored.length - 1].angle;
}

// -----------------------------------------------------------------------------
// Eligibility (applied BEFORE scoring)
// -----------------------------------------------------------------------------

export interface AngleEligibilityInput {
  personaId: CoachPersonaId;
  /** The safety register is in force: only `SUPPORTIVE_ANGLES`. */
  supportive: boolean;
  /** The user wrote a `why`; `future_self` is a message from it, so it needs one. */
  hasWhy: boolean;
}

/**
 * The angles this nudge may use, in `COACH_ANGLES` order: persona exclusions
 * first, then `future_self` only with a `why`, then the supportive register.
 * Never empty in practice (`identity` survives every filter), but a caller
 * must still handle `[]`.
 */
export function eligibleAnglesFor(input: AngleEligibilityInput): CoachAngle[] {
  const excluded = new Set<CoachAngle>(PERSONA_ANGLE_EXCLUSIONS[input.personaId] ?? []);
  return COACH_ANGLES.filter((angle) => {
    if (excluded.has(angle)) return false;
    if (angle === 'future_self' && !input.hasWhy) return false;
    if (input.supportive && !SUPPORTIVE_ANGLES.includes(angle)) return false;
    return true;
  });
}

/** The persona's score bonus (its favoured angles). */
export function personaAngleBias(personaId: CoachPersonaId): Partial<Record<CoachAngle, number>> {
  return PERSONA_ANGLE_BONUS[personaId] ?? {};
}

/** A small seeded PRNG (mulberry32) for deterministic tests and reproducible diagnostics. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
