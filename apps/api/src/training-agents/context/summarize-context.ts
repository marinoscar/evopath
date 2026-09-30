import type { ResearcherContext } from '../agents/researcher/researcher-context';
import { NEVER_SEND_LABELS } from './never-send';
import { PLANNER_CONTEXT_KEYS, type PlannerContext, type PlannerContextKey } from './planner-context.contract';

// =============================================================================
// The "what will be sent" summary, rendered from THE SAME OBJECT that is sent
// =============================================================================
//
// `summarizePlannerContext` walks every key of `PLANNER_CONTEXT_KEYS` (a test
// asserts the list equals the keys the builder can produce), so the panel
// cannot drift from what the planner receives: a section with no data says
// "None used". `dropped` names the sections the context budget left out;
// `excluded` is `never-send.ts`. No ids, no storage keys: the items quote the
// user's own intake text and name the kinds of data, nothing else.
// =============================================================================

export interface SentDataSection {
  /** The context key this section renders (`goal`, `history`, ...). */
  key: string;
  title: string;
  items: string[];
  count?: number;
}

export interface SentDataSummary {
  sections: SentDataSection[];
  /** Titles of sections the context budget dropped. */
  dropped: string[];
  excluded: string[];
}

export const NONE_USED = 'None used';

const TITLES: Record<PlannerContextKey, string> = {
  request: 'Request',
  goal: 'Goal',
  experience: 'Experience',
  daysPerWeek: 'Days per week',
  preferredWeekdays: 'Preferred weekdays',
  minutesPerSession: 'Minutes per session',
  durationWeeks: 'Plan length',
  limitations: 'Limitations',
  avoidExerciseKeys: 'Exercises to avoid',
  preferences: 'Preferences',
  conservative: 'Conservative mode',
  profile: 'Profile',
  bodyMetrics: 'Body metrics',
  equipment: 'Equipment',
  candidateExercises: 'Candidate exercises',
  history: 'Training history (last 6 weeks)',
  readiness: 'Readiness (7-day averages)',
  bio: 'Bio',
  currentPlan: 'Current plan',
};

const WEEKDAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function itemsFor(key: PlannerContextKey, context: PlannerContext): { items: string[]; count?: number } {
  switch (key) {
    case 'request':
      return {
        items: [
          context.request.kind === 'revise' ? 'Revise an existing plan' : 'Create a new plan',
          ...(context.request.instruction ? [`Your instruction: "${context.request.instruction}"`] : []),
        ],
      };
    case 'goal':
      return {
        items: [`Type: ${context.goal.type}`, ...(context.goal.description ? [`Your goal: "${context.goal.description}"`] : [])],
      };
    case 'experience':
      return { items: [context.experience] };
    case 'daysPerWeek':
      return { items: [String(context.daysPerWeek)] };
    case 'preferredWeekdays':
      return { items: context.preferredWeekdays ? [context.preferredWeekdays.map((d) => WEEKDAYS[d]).join(', ')] : ['Any'] };
    case 'minutesPerSession':
      return { items: [`${context.minutesPerSession} minutes`] };
    case 'durationWeeks':
      return { items: [`${context.durationWeeks} weeks`] };
    case 'limitations':
      return {
        items: context.limitations.length
          ? context.limitations.map((l) => (l.description ? `${l.area}: "${l.description}"` : l.area))
          : [NONE_USED],
        count: context.limitations.length,
      };
    case 'avoidExerciseKeys':
      return { items: context.avoidExerciseKeys.length ? [...context.avoidExerciseKeys] : [NONE_USED], count: context.avoidExerciseKeys.length };
    case 'preferences':
      return { items: context.preferences ? [`"${context.preferences}"`] : [NONE_USED] };
    case 'conservative':
      return { items: [context.conservative ? 'On: lower intensity and volume caps apply' : 'Off'] };
    case 'profile':
      if (!context.profile) return { items: [NONE_USED] };
      return {
        items: [
          `Age: ${context.profile.ageYears ?? 'not set'} (whole years)`,
          `Sex at birth: ${context.profile.sexAtBirth ?? 'not set'}`,
          `Height: ${context.profile.heightCm === null ? 'not set' : `${context.profile.heightCm} cm`}`,
          `Units: ${context.profile.unitPreference}`,
        ],
      };
    case 'bodyMetrics':
      if (!context.bodyMetrics) return { items: [NONE_USED] };
      return {
        items: [
          `Latest weight: ${context.bodyMetrics.weightKg === null ? 'none' : `${context.bodyMetrics.weightKg} kg`}`,
          `Latest body fat: ${context.bodyMetrics.bodyFatPercent === null ? 'none' : `${context.bodyMetrics.bodyFatPercent} %`}`,
          context.bodyMetrics.weightTrend
            ? `8-week weight trend: ${context.bodyMetrics.weightTrend.kgPerWeek} kg/week over ${context.bodyMetrics.weightTrend.points} readings`
            : '8-week weight trend: none',
        ],
      };
    case 'equipment':
      return {
        items: [
          context.equipment.hasGym ? 'Your gym\'s capabilities (not its name or location)' : 'No gym: bodyweight only',
          `Equipment class: ${context.equipment.equipmentClass}`,
        ],
        count: context.equipment.capabilityKeys.length,
      };
    case 'candidateExercises':
      return {
        items: ['Exercises your equipment supports: name, muscles, movement pattern, tracking mode'],
        count: context.candidateExercises.length,
      };
    case 'history':
      if (!context.history) return { items: [NONE_USED] };
      return {
        items: [
          'Sessions per week',
          'Per exercise: last top set, sessions ago, best recent working load',
          `Exercises you flagged pain on (last 28 days): ${context.history.painFlagExerciseKeys.length}`,
        ],
        count: context.history.exercises.length,
      };
    case 'readiness':
      if (!context.readiness) return { items: [NONE_USED] };
      return { items: ['Energy, sleep quality, soreness and stress scores only (no notes)'], count: context.readiness.days };
    case 'bio':
      return { items: context.bio ? [`"${context.bio}"`] : [NONE_USED] };
    case 'currentPlan':
      if (!context.currentPlan) return { items: [NONE_USED] };
      return { items: ['The plan being revised (exercises by key, sets, reps, loads)'], count: context.currentPlan.weeks.length };
  }
}

/** The planner's context as the panel shows it: one section per context key, in order. */
export function summarizePlannerContext(context: PlannerContext, dropped: readonly string[] = []): SentDataSummary {
  return {
    sections: PLANNER_CONTEXT_KEYS.map((key) => ({ key, title: TITLES[key], ...itemsFor(key, context) })),
    dropped: dropped.map((key) => TITLES[key as PlannerContextKey] ?? key),
    excluded: [...NEVER_SEND_LABELS],
  };
}

/** The researcher's context as the panel shows it (one section per key of `ResearcherContext`). */
export function summarizeResearcherContext(context: ResearcherContext): SentDataSummary {
  const sections: SentDataSection[] = [
    { key: 'goal', title: 'Goal', items: [`Type: ${context.goal.type}`, ...(context.goal.description ? [`"${context.goal.description}"`] : [])] },
    { key: 'experience', title: 'Experience', items: [context.experience] },
    { key: 'daysPerWeek', title: 'Days per week', items: [String(context.daysPerWeek)] },
    { key: 'minutesPerSession', title: 'Minutes per session', items: [`${context.minutesPerSession} minutes`] },
    { key: 'equipmentClass', title: 'Equipment class', items: [context.equipmentClass] },
    {
      key: 'limitations',
      title: 'Limitations',
      items: context.limitations.length ? context.limitations.map((l) => (l.description ? `${l.area}: "${l.description}"` : l.area)) : [NONE_USED],
      count: context.limitations.length,
    },
    { key: 'preferences', title: 'Preferences', items: context.preferences ? [`"${context.preferences}"`] : [NONE_USED] },
    {
      key: 'demographics',
      title: 'Age band and sex',
      items: context.demographics
        ? [`Age band: ${context.demographics.ageBand ?? 'not set'}`, `Sex at birth: ${context.demographics.sexAtBirth ?? 'not set'}`]
        : ['Not sent (tailoring is off)'],
    },
  ];

  return { sections, dropped: [], excluded: [...NEVER_SEND_LABELS] };
}

/** The person facts the critic receives (`agents/critic/critic.agent.ts` `buildCriticReview().person`), in order. */
export const CRITIC_PERSON_KEYS = [
  'goal',
  'experience',
  'daysPerWeek',
  'preferredWeekdays',
  'minutesPerSession',
  'durationWeeks',
  'limitations',
  'avoidExerciseKeys',
  'conservative',
  'painFlagExerciseKeys',
  'readiness',
  'equipment',
  'revisionRequest',
] as const;

/**
 * The critic's input as the panel shows it: the plan and the server's
 * checks (produced during the run), the person facts it gets (a subset of the
 * planner's, rendered the same way) and the evidence claims.
 */
export function summarizeCriticContext(context: PlannerContext, painFlagExerciseKeys: readonly string[]): SentDataSummary {
  const person: SentDataSection[] = CRITIC_PERSON_KEYS.flatMap((key): SentDataSection[] => {
    switch (key) {
      case 'painFlagExerciseKeys':
        return [
          {
            key,
            title: 'Exercises you flagged pain on',
            items: painFlagExerciseKeys.length ? [...painFlagExerciseKeys] : [NONE_USED],
            count: painFlagExerciseKeys.length,
          },
        ];
      case 'revisionRequest':
        return context.request.kind === 'revise' ? [{ key, title: 'Your instruction', items: [`"${context.request.instruction ?? ''}"`] }] : [];
      case 'equipment':
        return [{ key, title: TITLES.equipment, items: [context.equipment.hasGym ? `Equipment class: ${context.equipment.equipmentClass}` : 'No gym: bodyweight only'] }];
      default:
        return [{ key, title: TITLES[key], ...itemsFor(key, context) }];
    }
  });

  return {
    sections: [
      { key: 'plan', title: 'The plan draft', items: ['Exercises by key, sets, reps, RPE, rest and loads; rationales'] },
      { key: 'tables', title: 'Server checks', items: ['Weekly sets per muscle, minutes per workout, exercises per movement pattern'] },
      { key: 'report', title: 'Guardrail findings', items: ['What the server repaired or flagged in the draft'] },
      ...person,
      { key: 'evidence', title: 'Evidence', items: ['Claims from the research step, with source ids (no web pages)'] },
    ],
    dropped: [],
    excluded: [...NEVER_SEND_LABELS],
  };
}
