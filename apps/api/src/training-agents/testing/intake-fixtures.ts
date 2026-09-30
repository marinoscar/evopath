import type { TrainingIntake, TrainingIntakeInput } from '../contracts/training-intake.contract';
import { trainingIntakeSchema } from '../contracts/training-intake.contract';

/** A valid intake (three days, 60 minutes, 8 weeks, no gym) with `overrides` over it. */
export function intakeFixture(overrides: Partial<TrainingIntakeInput> = {}): TrainingIntake {
  return trainingIntakeSchema.parse({
    goal: { type: 'hypertrophy', description: 'Build muscle and get stronger' },
    experience: 'intermediate',
    daysPerWeek: 3,
    preferredWeekdays: null,
    minutesPerSession: 60,
    durationWeeks: 8,
    gymId: null,
    limitations: [],
    avoidExerciseKeys: [],
    preferences: '',
    includeBio: false,
    tailorResearch: false,
    autonomy: 'autonomous',
    ...overrides,
  });
}

/** A `create` run body with a valid intake. */
export function createRunBody(overrides: Partial<TrainingIntakeInput> = {}) {
  return { kind: 'create' as const, intake: intakeFixture(overrides) };
}
