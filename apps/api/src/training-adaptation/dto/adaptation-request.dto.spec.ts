import { randomUUID } from 'node:crypto';

import { ADAPTATION_REQUEST_LIMITS as L } from '../adaptation.constants';
import {
  NOTHING_TO_CHANGE_MESSAGE,
  adaptationRequestSchema,
  onlyGymChanges,
  requestsAChange,
} from './adaptation-request.dto';

const parse = (body: unknown) => adaptationRequestSchema.safeParse(body);
const messages = (body: unknown) => {
  const result = parse(body);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe('adaptationRequestSchema', () => {
  describe('at least one change is required', () => {
    it.each([
      ['an empty body', {}],
      ['only the defaults spelled out', { useReadiness: true, baseWorkout: 'planned' }],
      ['lowEnergy: false', { lowEnergy: false }],
      ['the gym as it is', { equipment: { mode: 'gym' } }],
      ['blank free text', { freeText: '    ' }],
      ['a fresh session but nothing else', { baseWorkout: 'none' }],
    ])('%s is refused with "Tell us what to change"', (_label, body) => {
      expect(messages(body)).toContain(NOTHING_TO_CHANGE_MESSAGE);
      expect(NOTHING_TO_CHANGE_MESSAGE).toBe('Tell us what to change');
    });

    it.each([
      ['minutes', { minutes: 30 }],
      ['soreness', { soreness: { muscles: ['chest'], level: 'mild' } }],
      ['lowEnergy', { lowEnergy: true }],
      ['only equipment', { equipment: { mode: 'only', equipmentTypeIds: [randomUUID()] } }],
      ['bodyweight equipment', { equipment: { mode: 'bodyweight' } }],
      ['a gym', { gymId: randomUUID() }],
      ['free text', { freeText: 'my shoulder feels odd' }],
    ])('%s alone is enough', (_label, body) => {
      expect(parse(body).success).toBe(true);
    });
  });

  describe('bounds', () => {
    it.each([
      [L.minutes.min - 1, false],
      [L.minutes.min, true],
      [30, true],
      [L.minutes.max, true],
      [L.minutes.max + 1, false],
      [29.5, false],
      ['30', false],
    ])('minutes %p -> %p', (minutes, ok) => {
      expect(parse({ minutes }).success).toBe(ok);
    });

    it('soreness needs 1..8 muscles from the muscle vocabulary and a mild or moderate level', () => {
      const muscles = ['chest', 'triceps', 'shoulders', 'lats', 'biceps', 'quads', 'glutes', 'hamstrings', 'abs'];
      expect(parse({ soreness: { muscles: [], level: 'mild' } }).success).toBe(false);
      expect(parse({ soreness: { muscles: muscles.slice(0, 8), level: 'mild' } }).success).toBe(true);
      expect(parse({ soreness: { muscles, level: 'mild' } }).success).toBe(false);
      expect(parse({ soreness: { muscles: ['not_a_muscle'], level: 'mild' } }).success).toBe(false);
      expect(parse({ soreness: { muscles: ['chest'], level: 'severe' } }).success).toBe(false);
      expect(parse({ soreness: { muscles: ['chest'] } }).success).toBe(false);
    });

    it('soreness muscles are de-duplicated', () => {
      const result = parse({ soreness: { muscles: ['chest', 'chest'], level: 'mild' } });
      expect(result.success && result.data.soreness?.muscles).toEqual(['chest']);
    });

    it('only-equipment takes 1..12 uuids, de-duplicated', () => {
      const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
      expect(parse({ equipment: { mode: 'only', equipmentTypeIds: [] } }).success).toBe(false);
      expect(parse({ equipment: { mode: 'only', equipmentTypeIds: ids(L.onlyEquipment.max) } }).success).toBe(true);
      expect(parse({ equipment: { mode: 'only', equipmentTypeIds: ids(L.onlyEquipment.max + 1) } }).success).toBe(false);
      expect(parse({ equipment: { mode: 'only', equipmentTypeIds: ['not-a-uuid'] } }).success).toBe(false);

      const id = randomUUID();
      const result = parse({ equipment: { mode: 'only', equipmentTypeIds: [id, id] } });
      expect(result.success && result.data.equipment).toEqual({ mode: 'only', equipmentTypeIds: [id] });
    });

    it('equipment modes are a closed set and refuse foreign keys', () => {
      expect(parse({ equipment: { mode: 'everything' } }).success).toBe(false);
      expect(parse({ equipment: { mode: 'gym', equipmentTypeIds: [randomUUID()] } }).success).toBe(false);
      expect(parse({ equipment: { mode: 'bodyweight', equipmentTypeIds: [randomUUID()] } }).success).toBe(false);
    });

    it('gymId must be a uuid', () => {
      expect(parse({ gymId: 'home' }).success).toBe(false);
    });

    it(`free text is trimmed and at most ${L.freeTextChars} characters`, () => {
      const trimmed = parse({ minutes: 30, freeText: '  my knee is fine  ' });
      expect(trimmed.success && trimmed.data.freeText).toBe('my knee is fine');
      expect(parse({ freeText: 'x'.repeat(L.freeTextChars) }).success).toBe(true);
      expect(messages({ freeText: 'x'.repeat(L.freeTextChars + 1) }).join(' ')).toContain('at most 500');
    });

    it('blank free text with another change becomes undefined, not an empty string', () => {
      const result = parse({ minutes: 30, freeText: '   ' });
      expect(result.success && result.data.freeText).toBeUndefined();
    });

    it('rejects unknown keys (strict)', () => {
      expect(parse({ minutes: 30, model: 'gpt-5' }).success).toBe(false);
      expect(parse({ minutes: 30, loadKg: 100 }).success).toBe(false);
    });
  });

  describe('defaults', () => {
    it('useReadiness defaults to true and baseWorkout to planned', () => {
      const result = parse({ minutes: 30 });
      expect(result.success && result.data).toMatchObject({ minutes: 30, useReadiness: true, baseWorkout: 'planned' });
    });

    it('both can be turned off / changed', () => {
      const result = parse({ minutes: 30, useReadiness: false, baseWorkout: 'none' });
      expect(result.success && result.data).toMatchObject({ useReadiness: false, baseWorkout: 'none' });
      expect(parse({ minutes: 30, baseWorkout: 'sometimes' }).success).toBe(false);
    });
  });
});

describe('requestsAChange', () => {
  it('is false for the gym as it is, lowEnergy false and empty free text', () => {
    expect(requestsAChange({})).toBe(false);
    expect(requestsAChange({ equipment: { mode: 'gym' }, lowEnergy: false, freeText: '' })).toBe(false);
  });

  it('is true for each individual change', () => {
    expect(requestsAChange({ minutes: 10 })).toBe(true);
    expect(requestsAChange({ lowEnergy: true })).toBe(true);
    expect(requestsAChange({ equipment: { mode: 'bodyweight' } })).toBe(true);
    expect(requestsAChange({ gymId: randomUUID() })).toBe(true);
  });
});

describe('onlyGymChanges (the service decides whether that gym is the planned one)', () => {
  const request = (body: unknown) => {
    const parsed = adaptationRequestSchema.parse(body);
    return parsed;
  };

  it('is true when gymId is the only change', () => {
    expect(onlyGymChanges(request({ gymId: randomUUID() }))).toBe(true);
    expect(onlyGymChanges(request({ gymId: randomUUID(), equipment: { mode: 'gym' } }))).toBe(true);
  });

  it.each([
    ['minutes', { minutes: 30 }],
    ['soreness', { soreness: { muscles: ['chest'], level: 'mild' } }],
    ['lowEnergy', { lowEnergy: true }],
    ['bodyweight', { equipment: { mode: 'bodyweight' } }],
    ['free text', { freeText: 'hi' }],
  ])('is false when %s changes too', (_label, extra) => {
    expect(onlyGymChanges(request({ gymId: randomUUID(), ...extra }))).toBe(false);
  });
});
