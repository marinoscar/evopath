import { describe, it, expect } from 'vitest';
import { TODAY_CARDS } from '../../config/todayCards';
import { resolveActiveDestination } from '../../config/destinations';
import { ROADMAP } from '../../config/roadmap';

describe('TODAY_CARDS', () => {
  it('keeps the append-only order', () => {
    // #203 put the two onboarding cards at the top; the original four keep their order.
    expect(TODAY_CARDS.map((c) => c.key)).toEqual([
      'adminSetup',
      'getStarted',
      'workout',
      'readiness',
      'body',
      'gym',
      'coach',
    ]);
  });

  it('appends the coach card last (E7.8), gated, linking to /coach', () => {
    const last = TODAY_CARDS[TODAY_CARDS.length - 1];
    expect(last.key).toBe('coach');
    expect(last.to).toBe('/coach');
    expect(last.Gate).toBeDefined();
    expect(last.Content).toBeDefined();
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

  it('gives workout (E4.6), body (#53), readiness (#56) and gym (E3.3) their Content', () => {
    const byKey = Object.fromEntries(TODAY_CARDS.map((c) => [c.key, c]));
    expect(byKey.workout.Content).toBeDefined();
    expect(byKey.body.Content).toBeDefined();
    expect(byKey.readiness.Content).toBeDefined();
    expect(byKey.gym.Content).toBeDefined();
  });
});
