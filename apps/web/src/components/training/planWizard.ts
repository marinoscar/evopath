/**
 * The intake wizard's form, its per-step validation, its mapping to the
 * API's `TrainingIntake`, and the mapping of a server `400` back to a field
 * and a step. Pure, so it is tested without rendering.
 *
 * The bounds come from `services/trainingAgents.ts` (a contract test keeps
 * them equal to the API's); the API decides.
 */
import {
  TRAINING_INTAKE_LIMITS as L,
  type TrainingAutonomy,
  type TrainingExperience,
  type TrainingGoalType,
  type TrainingIntake,
  type TrainingLimitationArea,
} from '../../services/trainingAgents';

export const WIZARD_STEPS = ['Goal', 'Schedule and gym', 'Limits and preferences', 'Review and start'] as const;

/** `gymId` value for "No equipment". */
export const NO_GYM = 'none';

export const MINUTE_PRESETS = [30, 45, 60, 90] as const;

export interface WizardForm {
  goalType: TrainingGoalType;
  goalDescription: string;
  experience: TrainingExperience | '';
  daysPerWeek: number;
  preferredWeekdays: number[];
  minutesPerSession: number;
  durationWeeks: number;
  /** A gym id, `NO_GYM`, or '' before a choice. */
  gymId: string;
  limitations: Array<{ area: TrainingLimitationArea; description: string }>;
  avoid: Array<{ slug: string; name: string }>;
  preferences: string;
  includeBio: boolean;
  tailorResearch: boolean;
  autonomy: TrainingAutonomy;
}

/** The goal the wizard starts on when the user has not told us one (#203). */
export const DEFAULT_GOAL_TYPE: TrainingGoalType = 'hypertrophy';

/**
 * A fresh form. `goalType` seeds the goal (the welcome dialog's
 * `settings.onboarding.goal`, #203); absent or null keeps the default.
 */
export function initialWizardForm(goalType?: TrainingGoalType | null): WizardForm {
  return {
    goalType: goalType ?? DEFAULT_GOAL_TYPE,
    goalDescription: '',
    experience: '',
    daysPerWeek: 3,
    preferredWeekdays: [],
    minutesPerSession: 45,
    durationWeeks: L.durationWeeks.default,
    gymId: '',
    limitations: [],
    avoid: [],
    preferences: '',
    includeBio: false,
    tailorResearch: false,
    autonomy: 'autonomous',
  };
}

export type WizardErrors = Record<string, string>;

const inRange = (value: number, range: { min: number; max: number }) =>
  Number.isInteger(value) && value >= range.min && value <= range.max;

/** Errors for one step (0..2); `gymIds` are the caller's gyms, for "gym removed". */
export function validateStep(step: number, form: WizardForm, gymIds: string[] | null = null): WizardErrors {
  const errors: WizardErrors = {};
  if (step === 0) {
    if (form.goalDescription.trim().length > L.goalChars) {
      errors['goal.description'] = `At most ${L.goalChars} characters.`;
    }
    if (!form.experience) errors.experience = 'Choose your experience level.';
  }
  if (step === 1) {
    if (!inRange(form.daysPerWeek, L.daysPerWeek)) {
      errors.daysPerWeek = `Choose ${L.daysPerWeek.min} to ${L.daysPerWeek.max} days.`;
    }
    if (form.preferredWeekdays.length > 0 && new Set(form.preferredWeekdays).size < form.daysPerWeek) {
      errors.preferredWeekdays = `Choose at least ${form.daysPerWeek} weekdays, or none.`;
    }
    if (!inRange(form.minutesPerSession, L.minutesPerSession)) {
      errors.minutesPerSession = `Choose ${L.minutesPerSession.min} to ${L.minutesPerSession.max} minutes.`;
    }
    if (!inRange(form.durationWeeks, L.durationWeeks)) {
      errors.durationWeeks = `Choose ${L.durationWeeks.min} to ${L.durationWeeks.max} weeks.`;
    }
    if (!form.gymId) errors.gymId = 'Choose a gym, or No equipment.';
    else if (form.gymId !== NO_GYM && gymIds !== null && !gymIds.includes(form.gymId)) {
      errors.gymId = 'This gym no longer exists. Choose another.';
    }
  }
  if (step === 2) {
    if (form.limitations.length > L.maxLimitations) errors.limitations = `At most ${L.maxLimitations} limitations.`;
    form.limitations.forEach((limitation, index) => {
      if (limitation.description.trim().length > L.limitationChars) {
        errors[`limitations.${index}.description`] = `At most ${L.limitationChars} characters.`;
      }
    });
    if (form.avoid.length > L.maxAvoidKeys) errors.avoidExerciseKeys = `At most ${L.maxAvoidKeys} exercises.`;
    if (form.preferences.trim().length > L.preferencesChars) errors.preferences = `At most ${L.preferencesChars} characters.`;
  }
  return errors;
}

/** Every step's errors, keyed by field. */
export function validateAll(form: WizardForm, gymIds: string[] | null = null): WizardErrors {
  return { ...validateStep(0, form, gymIds), ...validateStep(1, form, gymIds), ...validateStep(2, form, gymIds) };
}

/** Which step owns a field (an intake path without the `intake.` prefix). */
export function stepOfField(field: string): number {
  const head = field.replace(/^intake\./, '').split('.')[0];
  if (head === 'goal' || head === 'experience') return 0;
  if (['daysPerWeek', 'preferredWeekdays', 'minutesPerSession', 'durationWeeks', 'gymId'].includes(head)) return 1;
  if (['limitations', 'avoidExerciseKeys', 'preferences'].includes(head)) return 2;
  return 3;
}

/** The first step with an error, or null. */
export function firstErrorStep(errors: WizardErrors): number | null {
  const steps = Object.keys(errors).map(stepOfField);
  return steps.length > 0 ? Math.min(...steps) : null;
}

/** A server `400`'s `details.issues` as wizard errors. */
export function errorsFromIssues(details: unknown): WizardErrors {
  const issues = (details as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) return {};
  const errors: WizardErrors = {};
  for (const issue of issues) {
    const path = typeof issue?.path === 'string' ? issue.path.replace(/^intake\./, '') : '';
    if (!path) continue;
    errors[path] = typeof issue.message === 'string' ? issue.message : 'Invalid value.';
  }
  return errors;
}

/** The form as the API's intake. */
export function toIntake(form: WizardForm): TrainingIntake {
  return {
    goal: { type: form.goalType, description: form.goalDescription.trim() },
    experience: (form.experience || 'beginner') as TrainingExperience,
    daysPerWeek: form.daysPerWeek,
    preferredWeekdays: form.preferredWeekdays.length > 0 ? [...new Set(form.preferredWeekdays)].sort((a, b) => a - b) : null,
    minutesPerSession: form.minutesPerSession,
    durationWeeks: form.durationWeeks,
    gymId: form.gymId && form.gymId !== NO_GYM ? form.gymId : null,
    limitations: form.limitations.map((l) => ({ area: l.area, description: l.description.trim() })),
    avoidExerciseKeys: form.avoid.map((a) => a.slug),
    preferences: form.preferences.trim(),
    includeBio: form.includeBio,
    tailorResearch: form.tailorResearch,
    autonomy: form.autonomy,
  };
}

/** The free text a safety stop was about, to refuse resubmitting it unchanged. */
export function freeTextOf(form: WizardForm): string {
  return JSON.stringify([form.goalDescription.trim(), form.limitations.map((l) => l.description.trim()), form.preferences.trim()]);
}

// -----------------------------------------------------------------------------
// Survive a reload of the tab (sessionStorage; never required)
// -----------------------------------------------------------------------------

export const WIZARD_STORAGE_KEY = 'plan-wizard.v1';

export function loadWizardDraft(): { step: number; form: WizardForm } | null {
  try {
    const raw = window.sessionStorage.getItem(WIZARD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { step?: unknown; form?: unknown };
    if (!parsed || typeof parsed !== 'object' || !parsed.form || typeof parsed.form !== 'object') return null;
    const step = typeof parsed.step === 'number' && parsed.step >= 0 && parsed.step <= 3 ? parsed.step : 0;
    return { step, form: { ...initialWizardForm(), ...(parsed.form as Partial<WizardForm>) } };
  } catch {
    return null;
  }
}

export function saveWizardDraft(step: number, form: WizardForm): void {
  try {
    window.sessionStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify({ step, form }));
  } catch {
    // Storage blocked or full: the wizard works without it.
  }
}

export function clearWizardDraft(): void {
  try {
    window.sessionStorage.removeItem(WIZARD_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
