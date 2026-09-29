import { describe, it, expect } from 'vitest';
import { TODAY_CARDS } from '../../config/todayCards';
import { resolveActiveDestination } from '../../config/destinations';
import { ROADMAP } from '../../config/roadmap';

describe('TODAY_CARDS', () => {
  it('keeps the append-only order', () => {
    expect(TODAY_CARDS.map((c) => c.key)).toEqual(['workout', 'readiness', 'body', 'gym']);
  });

  it('has unique keys', () => {
    const keys = TODAY_CARDS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(TODAY_CARDS.map((c) => [c.key, c.to] as const))(
    'links %s to a route owned by a destination (%s)',
    (_key, to) => {
      expect(resolveActiveDestination(to)).not.toBeNull();
    }
  );

  it('uses a roadmap area that exists', () => {
    for (const card of TODAY_CARDS) {
      expect(Object.keys(ROADMAP)).toContain(card.area);
    }
  });

  it('gives body (#53) and readiness (#56) their Content; workout and gym stay placeholders', () => {
    const byKey = Object.fromEntries(TODAY_CARDS.map((c) => [c.key, c]));
    expect(byKey.body.Content).toBeDefined();
    expect(byKey.readiness.Content).toBeDefined();
    expect(byKey.workout.Content).toBeUndefined();
    expect(byKey.gym.Content).toBeUndefined();
  });
});
