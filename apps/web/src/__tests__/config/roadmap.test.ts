import { describe, it, expect } from 'vitest';
import { ROADMAP, comingInLabel } from '../../config/roadmap';

describe('roadmap', () => {
  it.each([
    ['health', 'Coming in E2'],
    ['gyms', 'Coming in E3'],
    ['workouts', 'Coming in E4'],
    ['programs', 'Coming in E5'],
  ] as const)('comingInLabel(%s) is "%s"', (area, label) => {
    expect(comingInLabel(area)).toBe(label);
  });

  it('every ROADMAP value is an epic id', () => {
    for (const epic of Object.values(ROADMAP)) {
      expect(epic).toMatch(/^E\d+$/);
    }
  });
});
