import { HARD_WEIGHT, SOFT_WEIGHT, personaPasses, summarize, weightOf, type ScoredProperty } from './score';

const prop = (property: ScoredProperty['property'], kind: 'hard' | 'soft', score: number, pass = score === 1): ScoredProperty => ({ property, kind, score, pass, details: [] });

describe('the scorer', () => {
  it('weighs hard properties 3 and soft ones 1', () => {
    expect(HARD_WEIGHT).toBe(3);
    expect(SOFT_WEIGHT).toBe(1);
    expect(weightOf('equipment_feasible')).toBe(3);
    expect(weightOf('goal_fit')).toBe(1);
  });

  it('scores the weighted mean', () => {
    // hard 1.0 (weight 3) + soft 0.5 (weight 1) = 3.5 / 4
    const layer = summarize('shipped', [prop('equipment_feasible', 'hard', 1), prop('goal_fit', 'soft', 0.5)]);
    expect(layer.score).toBe(0.875);
    expect(layer.hardFailures).toEqual([]);
  });

  it('weighs a hard failure more than a soft one', () => {
    const hardMiss = summarize('shipped', [prop('equipment_feasible', 'hard', 0), prop('goal_fit', 'soft', 1)]);
    const softMiss = summarize('shipped', [prop('equipment_feasible', 'hard', 1), prop('goal_fit', 'soft', 0)]);
    expect(hardMiss.score).toBeLessThan(softMiss.score);
  });

  it('fails the persona on a hard failure of the shipped artifact whatever the score', () => {
    const layer = summarize('shipped', [
      prop('equipment_feasible', 'hard', 0.99, false),
      prop('goal_fit', 'soft', 1),
      prop('progression_present', 'soft', 1),
      prop('variety_and_balance', 'soft', 1),
    ]);
    expect(layer.score).toBeGreaterThan(0.95);
    expect(layer.hardFailures).toEqual(['equipment_feasible']);
    expect(personaPasses(layer)).toBe(false);
  });

  it('a soft miss never fails the persona, and nothing shipped passes', () => {
    expect(personaPasses(summarize('shipped', [prop('goal_fit', 'soft', 0, false)]))).toBe(true);
    expect(personaPasses(null)).toBe(true);
  });

  it('scores an empty property list as 0 rather than dividing by zero', () => {
    expect(summarize('raw', []).score).toBe(0);
  });
});
