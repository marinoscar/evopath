import { COACH_ANGLES, type CoachAngle } from '../nudges/angle-picker';
import { LEARNING_CONSTANTS } from './learning.constants';
import {
  daysSinceLastByAngle,
  eligibleAnglesFor,
  noveltyPenalty,
  personaAngleBias,
  pickAngle,
  recoveringDifference,
  scoreAngles,
  seededRng,
  type AngleHistory,
  type AngleRewards,
} from './pick-angle';

// E7.11 (#251), spec §2.8: the recovering-difference softmax.

const NOW = new Date('2026-10-01T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY_MS);

function draw(
  n: number,
  seed: number,
  history: AngleHistory[],
  eligible: CoachAngle[],
  params: Partial<Parameters<typeof pickAngle>[3]> = {},
): Map<CoachAngle, number> {
  const rng = seededRng(seed);
  const counts = new Map<CoachAngle, number>();
  for (let i = 0; i < n; i += 1) {
    const a = pickAngle(history, eligible, rng, { now: NOW, ...params })!;
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  return counts;
}

/** Strong evidence that `angle` converts better when sent (0.40) than when passed over (0.20). */
const strong = (angle: CoachAngle, others: CoachAngle[]): AngleRewards => {
  const rewards: AngleRewards = { [angle]: { sent: 1000, sentConverted: 400, notSent: 1000, notSentConverted: 200 } };
  for (const o of others) rewards[o] = { sent: 1000, sentConverted: 200, notSent: 1000, notSentConverted: 200 };
  return rewards;
};

describe('pickAngle (spec §2.8)', () => {
  const ALL = [...COACH_ANGLES];

  it('AC1: identical inputs and seed give the same angle; a different seed gives a different sequence', () => {
    const run = (seed: number) => {
      const rng = seededRng(seed);
      return Array.from({ length: 50 }, () => pickAngle([], ALL, rng, { now: NOW }));
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(7));
  });

  it('AC1: the distribution over 10,000 draws is stable across seeds within tolerance', () => {
    const a = draw(10_000, 1, [], ALL);
    const b = draw(10_000, 2, [], ALL);
    for (const angle of ALL) {
      expect(Math.abs((a.get(angle) ?? 0) - (b.get(angle) ?? 0)) / 10_000).toBeLessThan(0.03);
    }
  });

  it('AC2: exact novelty penalty γ·0.5^(d/h) for known d, h and γ', () => {
    const c = { noveltyPenaltyWeight: 0.04, noveltyHalfLifeDays: 10 };
    expect(noveltyPenalty(0, c)).toBe(0.04);
    expect(noveltyPenalty(10, c)).toBeCloseTo(0.02, 12);
    expect(noveltyPenalty(30, c)).toBeCloseTo(0.005, 12);
    expect(noveltyPenalty(null, c)).toBe(0);
    // The production constants.
    expect(noveltyPenalty(0)).toBe(LEARNING_CONSTANTS.noveltyPenaltyWeight);
    expect(noveltyPenalty(LEARNING_CONSTANTS.noveltyHalfLifeDays)).toBeCloseTo(LEARNING_CONSTANTS.noveltyPenaltyWeight / 2, 12);
  });

  it('AC2: an angle used today pays more and is chosen less often than one used 30 days ago', () => {
    const history: AngleHistory[] = [
      { angle: 'identity', at: daysAgo(0) },
      { angle: 'data', at: daysAgo(30) },
    ];
    const scored = scoreAngles(history, ['identity', 'data'], { now: NOW });
    const identity = scored.find((s) => s.angle === 'identity')!;
    const data = scored.find((s) => s.angle === 'data')!;
    expect(identity.penalty).toBe(LEARNING_CONSTANTS.noveltyPenaltyWeight * Math.pow(0.5, 0 / LEARNING_CONSTANTS.noveltyHalfLifeDays));
    expect(data.penalty).toBeCloseTo(LEARNING_CONSTANTS.noveltyPenaltyWeight * Math.pow(0.5, 30 / LEARNING_CONSTANTS.noveltyHalfLifeDays), 12);
    expect(identity.probability).toBeLessThan(data.probability);

    const counts = draw(5_000, 3, history, ['identity', 'data']);
    expect(counts.get('identity')!).toBeLessThan(counts.get('data')!);
  });

  it('uses the most recent send of an angle for d', () => {
    const since = daysSinceLastByAngle(
      [
        { angle: 'humor', at: daysAgo(20) },
        { angle: 'humor', at: daysAgo(2) },
      ],
      NOW,
    );
    expect(since.get('humor')).toBeCloseTo(2, 9);
  });

  it('AC3: a much higher r(a) wins most often at low τ; high τ flattens toward uniform', () => {
    const rewards = strong('challenge', ['identity', 'data', 'humor']);
    const eligible: CoachAngle[] = ['identity', 'data', 'humor', 'challenge'];

    const greedy = draw(4_000, 11, [], eligible, { rewards, constants: { temperature: 0.01, explorationFloor: 0 } });
    expect(greedy.get('challenge')! / 4_000).toBeGreaterThan(0.95);

    const flat = scoreAngles([], eligible, { now: NOW, rewards, constants: { temperature: 100, explorationFloor: 0 } });
    for (const s of flat) expect(s.probability).toBeCloseTo(0.25, 3);
  });

  it('AC3: p(a) = softmax(s/τ) with s = r − penalty (ε = 0)', () => {
    const tau = 0.05;
    const history: AngleHistory[] = [{ angle: 'data', at: daysAgo(5) }];
    const rewards = strong('identity', ['data']);
    const scored = scoreAngles(history, ['identity', 'data'], { now: NOW, rewards, constants: { temperature: tau, explorationFloor: 0 } });
    const s = scored.map((r) => r.reward - r.penalty);
    const z = s.map((x) => Math.exp(x / tau));
    expect(scored[0].probability).toBeCloseTo(z[0] / (z[0] + z[1]), 12);
    expect(scored[0].score).toBeCloseTo(s[0], 12);
  });

  it('a higher μ⁺ than μ⁻ is chosen more often over N seeded draws with the production constants', () => {
    const rewards = strong('loss_aversion', ['identity', 'humor']);
    const counts = draw(10_000, 5, [], ['identity', 'humor', 'loss_aversion'], { rewards });
    expect(counts.get('loss_aversion')!).toBeGreaterThan(counts.get('identity')!);
    expect(counts.get('loss_aversion')!).toBeGreaterThan(counts.get('humor')!);
  });

  it('the exploration floor keeps every eligible angle above ε/n', () => {
    const rewards = strong('challenge', ['identity']);
    const scored = scoreAngles([], ['identity', 'challenge'], { now: NOW, rewards, constants: { temperature: 0.0001, explorationFloor: 0.1 } });
    expect(scored.find((s) => s.angle === 'identity')!.probability).toBeCloseTo(0.05, 9);
  });

  it('AC4: one eligible angle is returned without calling the rng', () => {
    const rng = jest.fn(() => 0.5);
    expect(pickAngle([], ['identity'], rng, { now: NOW })).toBe('identity');
    expect(rng).not.toHaveBeenCalled();
  });

  it('calls the rng exactly once for several eligible angles', () => {
    const rng = jest.fn(() => 0.999999);
    expect(pickAngle([], ['identity', 'data'], rng, { now: NOW })).toBe('data');
    expect(rng).toHaveBeenCalledTimes(1);
  });

  it('AC5: an empty eligible list answers null', () => {
    expect(pickAngle([], [], seededRng(1), { now: NOW })).toBeNull();
  });

  it('AC6: no history and no rewards: uniform over the eligible angles', () => {
    const scored = scoreAngles([], ALL, { now: NOW });
    for (const s of scored) expect(s.probability).toBeCloseTo(1 / ALL.length, 12);
  });

  it('AC6: below the sample floor r(a) is 0 (cold start), so the choice stays uniform', () => {
    const few: AngleRewards = {
      challenge: { sent: LEARNING_CONSTANTS.minSamples - 1, sentConverted: 25, notSent: 500, notSentConverted: 10 },
    };
    expect(recoveringDifference(few.challenge)).toBe(0);
    const scored = scoreAngles([], ['identity', 'challenge'], { now: NOW, rewards: few });
    expect(scored[0].probability).toBeCloseTo(0.5, 12);
  });

  it('AC7: r(a) is μ⁺ − μ⁻ (with no prior it is the raw difference)', () => {
    const stats = { sent: 100, sentConverted: 30, notSent: 200, notSentConverted: 40 };
    expect(recoveringDifference(stats, { priorStrength: 0, minSamples: 1 })).toBeCloseTo(0.3 - 0.2, 12);
    // The prior shrinks both rates toward the pooled rate: same sign, smaller magnitude.
    const shrunk = recoveringDifference(stats, { minSamples: 1 });
    expect(shrunk).toBeGreaterThan(0);
    expect(shrunk).toBeLessThan(0.1);
  });

  describe('AC8: eligibility (before scoring)', () => {
    it('the supportive register allows only identity and future_self', () => {
      expect(eligibleAnglesFor({ personaId: 'drill_sergeant', supportive: true, hasWhy: true })).toEqual([
        'identity',
        'future_self',
      ]);
      expect(eligibleAnglesFor({ personaId: 'coach', supportive: true, hasWhy: false })).toEqual(['identity']);
    });

    it('future_self needs a why', () => {
      expect(eligibleAnglesFor({ personaId: 'coach', supportive: false, hasWhy: false })).not.toContain('future_self');
      expect(eligibleAnglesFor({ personaId: 'coach', supportive: false, hasWhy: true })).toEqual([...COACH_ANGLES]);
    });

    it('a supportive pick is always a supportive angle, whatever the rewards', () => {
      const eligible = eligibleAnglesFor({ personaId: 'coach', supportive: true, hasWhy: true });
      const counts = draw(1_000, 9, [], eligible, { rewards: strong('challenge', ['identity']) });
      expect([...counts.keys()].sort()).toEqual(['future_self', 'identity']);
    });

    it('the Analyst favours data', () => {
      expect(personaAngleBias('analyst').data).toBeGreaterThan(0);
      const counts = draw(10_000, 13, [], ['identity', 'data'], { bias: personaAngleBias('analyst') });
      expect(counts.get('data')!).toBeGreaterThan(counts.get('identity')!);
    });
  });
});
