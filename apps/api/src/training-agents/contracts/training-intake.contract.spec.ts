import { randomUUID } from 'node:crypto';

import { intakeFixture } from '../testing/intake-fixtures';
import { freeTextOf, trainingIntakeSchema, trainingRunRequestSchema } from './training-intake.contract';

describe('training intake contract', () => {
  it('applies the defaults: 8 weeks, no gym, no limitations, bio and tailoring off, autonomous', () => {
    const intake = trainingIntakeSchema.parse({
      goal: { type: 'strength' },
      experience: 'beginner',
      daysPerWeek: 3,
      minutesPerSession: 45,
    });

    expect(intake).toEqual({
      goal: { type: 'strength', description: '' },
      experience: 'beginner',
      daysPerWeek: 3,
      preferredWeekdays: null,
      minutesPerSession: 45,
      durationWeeks: 8,
      gymId: null,
      limitations: [],
      avoidExerciseKeys: [],
      preferences: '',
      includeBio: false,
      tailorResearch: false,
      autonomy: 'autonomous',
    });
  });

  it.each([
    ['days per week 0', { daysPerWeek: 0 }],
    ['days per week 8', { daysPerWeek: 8 }],
    ['19 minutes', { minutesPerSession: 19 }],
    ['181 minutes', { minutesPerSession: 181 }],
    ['3 weeks', { durationWeeks: 3 }],
    ['25 weeks', { durationWeeks: 25 }],
    ['a goal sentence over 300 characters', { goal: { type: 'general', description: 'x'.repeat(301) } }],
    ['seven limitations', { limitations: Array.from({ length: 7 }, () => ({ area: 'knee', description: '' })) }],
    ['a limitation over 200 characters', { limitations: [{ area: 'knee', description: 'x'.repeat(201) }] }],
    ['an unknown limitation area', { limitations: [{ area: 'toe', description: '' }] }],
    ['21 avoid keys', { avoidExerciseKeys: Array.from({ length: 21 }, (_v, i) => `ex_${i}`) }],
    ['an avoid key that is not a slug', { avoidExerciseKeys: ['Bench Press!'] }],
    ['preferences over 300 characters', { preferences: 'x'.repeat(301) }],
    ['a gym id that is not a uuid', { gymId: 'gym-1' }],
    ['duplicate preferred weekdays', { daysPerWeek: 2, preferredWeekdays: [1, 1, 3] }],
    ['fewer preferred weekdays than days', { daysPerWeek: 3, preferredWeekdays: [1, 3] }],
    ['weekday 8', { daysPerWeek: 1, preferredWeekdays: [8] }],
    ['an unknown field', { weightKg: 80 }],
    ['cardio days per week 0', { cardio: { include: true, activity: 'walk', daysPerWeek: 0 } }],
    ['cardio days per week 8', { cardio: { include: true, activity: 'walk', daysPerWeek: 8 } }],
    ['9 cardio minutes', { cardio: { include: true, activity: 'walk', minutesPerSession: 9 } }],
    ['121 cardio minutes', { cardio: { include: true, activity: 'run', minutesPerSession: 121 } }],
    ['an unknown cardio activity', { cardio: { include: true, activity: 'swim' } }],
    ['cardio without an activity', { cardio: { include: true } }],
    ['an unknown cardio field', { cardio: { include: true, activity: 'walk', pace: 6 } }],
  ])('refuses %s', (_label, over) => {
    const base = { ...intakeFixture() } as Record<string, unknown>;
    expect(trainingIntakeSchema.safeParse({ ...base, ...over }).success).toBe(false);
  });

  it('accepts an optional cardio request (#265), and leaves it out when absent', () => {
    const parsed = trainingIntakeSchema.parse({
      ...intakeFixture(),
      cardio: { include: true, activity: 'walk', daysPerWeek: 4, minutesPerSession: 30 },
    });
    expect(parsed.cardio).toEqual({ include: true, activity: 'walk', daysPerWeek: 4, minutesPerSession: 30 });
    expect(trainingIntakeSchema.parse({ ...intakeFixture(), cardio: { include: false, activity: 'any' } }).cardio).toEqual({
      include: false,
      activity: 'any',
    });
    expect('cardio' in intakeFixture()).toBe(false);
  });

  it('accepts preferred weekdays covering the days per week', () => {
    expect(trainingIntakeSchema.safeParse({ ...intakeFixture(), daysPerWeek: 3, preferredWeekdays: [1, 3, 5, 6] }).success).toBe(true);
  });

  it('the run request is create (intake) or revise (program, version, instruction <= 500)', () => {
    const programId = randomUUID();
    expect(trainingRunRequestSchema.safeParse({ kind: 'create', intake: intakeFixture() }).success).toBe(true);
    expect(trainingRunRequestSchema.safeParse({ kind: 'revise', programId, basedOnVersion: 2, instruction: 'Less running' }).success).toBe(true);
    expect(trainingRunRequestSchema.safeParse({ kind: 'revise', programId, basedOnVersion: 0, instruction: 'x' }).success).toBe(false);
    expect(trainingRunRequestSchema.safeParse({ kind: 'revise', programId, basedOnVersion: 1, instruction: ' ' }).success).toBe(false);
    expect(trainingRunRequestSchema.safeParse({ kind: 'revise', programId, basedOnVersion: 1, instruction: 'x'.repeat(501) }).success).toBe(false);
  });

  it('freeTextOf lists the goal sentence, limitation descriptions, preferences and instruction, nothing else', () => {
    const intake = intakeFixture({
      goal: { type: 'general', description: 'GOAL' },
      limitations: [
        { area: 'knee', description: 'LIM1' },
        { area: 'back', description: '' },
      ],
      preferences: 'PREF',
      avoidExerciseKeys: ['barbell_back_squat'],
    });

    expect(freeTextOf({ kind: 'create', intake })).toEqual(['GOAL', 'LIM1', 'PREF']);
    expect(freeTextOf({ kind: 'revise', instruction: 'INSTR' })).toEqual(['INSTR']);
    expect(freeTextOf(null)).toEqual([]);
  });
});
