/** planWizard: step validation, the intake mapping, 400 issue mapping and storage that may throw. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  NO_GYM,
  errorsFromIssues,
  firstErrorStep,
  initialWizardForm,
  loadWizardDraft,
  saveWizardDraft,
  stepOfField,
  toIntake,
  validateStep,
} from '../../../components/training/planWizard';

afterEach(() => vi.restoreAllMocks());

describe('planWizard', () => {
  it('validates each step against the contract bounds', () => {
    const form = { ...initialWizardForm(), gymId: NO_GYM };
    expect(validateStep(0, form)).toEqual({ experience: 'Choose your experience level.' });
    expect(validateStep(0, { ...form, experience: 'beginner', goalDescription: 'x'.repeat(301) })).toHaveProperty('goal.description');
    expect(validateStep(1, { ...form, minutesPerSession: 10, durationWeeks: 30, daysPerWeek: 8 })).toEqual({
      daysPerWeek: 'Choose 1 to 7 days.',
      minutesPerSession: 'Choose 20 to 180 minutes.',
      durationWeeks: 'Choose 4 to 24 weeks.',
    });
    expect(validateStep(1, { ...form, gymId: 'gone' }, ['other'])).toEqual({ gymId: 'This gym no longer exists. Choose another.' });
    expect(validateStep(1, { ...form, gymId: '' })).toEqual({ gymId: 'Choose a gym, or No equipment.' });
    expect(
      validateStep(2, { ...form, limitations: [{ area: 'knee', description: 'x'.repeat(201) }], preferences: 'y'.repeat(301) }),
    ).toEqual({ 'limitations.0.description': 'At most 200 characters.', preferences: 'At most 300 characters.' });
  });

  it('maps the form to the intake', () => {
    const intake = toIntake({
      ...initialWizardForm(),
      experience: 'advanced',
      goalDescription: '  strong  ',
      preferredWeekdays: [5, 1, 3],
      gymId: NO_GYM,
      avoid: [{ slug: 'back-squat', name: 'Back squat' }],
    });
    expect(intake).toMatchObject({
      goal: { type: 'hypertrophy', description: 'strong' },
      preferredWeekdays: [1, 3, 5],
      gymId: null,
      avoidExerciseKeys: ['back-squat'],
      includeBio: false,
      tailorResearch: false,
      autonomy: 'autonomous',
    });
    expect(toIntake({ ...initialWizardForm(), experience: 'beginner', gymId: 'g1' }).preferredWeekdays).toBeNull();
  });

  it('validates and maps the cardio request only when it is switched on (#265)', () => {
    const form = { ...initialWizardForm(), experience: 'beginner' as const, gymId: NO_GYM };
    expect(validateStep(1, { ...form, cardioDaysPerWeek: 0, cardioMinutesPerSession: 200 })).toEqual({});
    expect(validateStep(1, { ...form, cardioInclude: true, cardioDaysPerWeek: 0, cardioMinutesPerSession: 200 })).toEqual({
      'cardio.daysPerWeek': 'Choose 1 to 7 cardio days.',
      'cardio.minutesPerSession': 'Choose 10 to 120 minutes.',
    });
    expect(stepOfField('intake.cardio.daysPerWeek')).toBe(1);

    expect('cardio' in toIntake(form)).toBe(false);
    expect(toIntake({ ...form, cardioInclude: true, cardioActivity: 'run', cardioDaysPerWeek: 4, cardioMinutesPerSession: 30 }).cardio).toEqual({
      include: true,
      activity: 'run',
      daysPerWeek: 4,
      minutesPerSession: 30,
    });
  });

  it('maps server issues to fields and steps', () => {
    const errors = errorsFromIssues({ issues: [{ path: 'intake.preferredWeekdays', message: 'Too few' }, { path: 'intake.limitations.0.description', message: 'Long' }] });
    expect(errors).toEqual({ preferredWeekdays: 'Too few', 'limitations.0.description': 'Long' });
    expect(firstErrorStep(errors)).toBe(1);
    expect(stepOfField('goal.description')).toBe(0);
    expect(stepOfField('autonomy')).toBe(3);
    expect(errorsFromIssues(null)).toEqual({});
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadWizardDraft()).toBeNull();
    expect(() => saveWizardDraft(1, initialWizardForm())).not.toThrow();
  });
});
