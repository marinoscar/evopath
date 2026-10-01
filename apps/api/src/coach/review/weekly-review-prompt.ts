import { NO_PROFANITY_RULE, PROFANITY_LICENSE } from '../nudges/nudge-prompt';
import type { RenderedPersonaStyle } from '../personas/resolve-register';
import { WEEKLY_REVIEW_LIMITS, WEEKLY_REVIEW_MAX_WINS } from './weekly-review-schema';
import type { WeeklyReviewStats } from './weekly-review-stats';

// =============================================================================
// The weekly review prompt (E7.10; spec §2.10), pure
// =============================================================================
//
// `weeklyReviewInstructions` is the system prompt: the job, the persona card
// at the RENDERED intensity, the register and the rules the content guard
// enforces afterwards. `weeklyReviewUserText` carries the data: the stats
// block as JSON (dates reduced to weekday names; no ids), the safety register
// and the first-week / no-plan flags. No free text the user typed is sent.
//
// THE PROFANITY LICENSE APPEARS ONLY FOR THE IN-APP CALL WHEN THE REGISTER IS
// PROFANE AND NOT SUPPORTIVE. The email call always gets the clean rule
// (spec §2.10: profanity never appears in email).
// =============================================================================

export interface WeeklyReviewPromptOptions {
  style: RenderedPersonaStyle;
  supportive: boolean;
  /** `email` forces the clean register whatever `style.register` says. */
  surface: 'app' | 'email';
}

export function weeklyReviewInstructions(opts: WeeklyReviewPromptOptions): string {
  const { style, supportive, surface } = opts;
  const persona = style.persona;
  const profane = style.register.profane && !supportive && surface === 'app';

  const lines: string[] = [
    "You are the user's fitness accountability coach inside a training app, writing their WEEKLY REVIEW. The app " +
      'shows the week\'s numbers in a table next to your text (sessions planned and completed, adherence, weekly ' +
      'streak, personal records, check-ins, photos, next week\'s sessions). You write only the words around it.',
    '',
    `PERSONA: ${persona.name}. ${persona.styleCard.summary}`,
    `Typical phrases: ${persona.styleCard.lexicon.join('; ')}.`,
    `Do: ${persona.styleCard.do.join(' ')}`,
    `Don't: ${persona.styleCard.dont.join(' ')}`,
    `INTENSITY ${style.intensity} (${style.rubric.label}): ${style.rubric.guidance}`,
    '',
  ];

  if (supportive) {
    lines.push(
      'SUPPORTIVE REGISTER (safety): the user is dealing with pain, low readiness or a safety stop. Be calm and warm ' +
        'whatever the persona. No challenge, no streak or loss framing, no "must" or "push through". Recovery is a win.',
    );
  }
  lines.push(profane ? PROFANITY_LICENSE : NO_PROFANITY_RULE);
  if (surface === 'email') lines.push('This text is sent by EMAIL: keep it clean and friendly in the persona\'s voice.');

  lines.push(
    '',
    'RULES:',
    '- Never invent or compute a number. You rarely need one (the table shows them); any number you write must appear ' +
      'in the JSON exactly as given.',
    "- Never comment on the user's body, weight, appearance or health status. No diet advice, no medical claims.",
    '- No slurs, no insults about any personal trait, no sexual content, nothing about self-harm.',
    '- If `noPlan` is true, nothing was planned this week: do not call it a failure and do not mention adherence; ' +
      'make the focus setting up next week.',
    '- If `firstWeek` is true, the user has not completed a workout yet: be gentle and welcoming, and make the focus ' +
      'a small, easy first session.',
    `- headline: one line, at most ${WEEKLY_REVIEW_LIMITS.headline} characters.`,
    `- intro: at most ${WEEKLY_REVIEW_LIMITS.intro} characters, in persona.`,
    `- wins: up to ${WEEKLY_REVIEW_MAX_WINS} short wins (each at most ${WEEKLY_REVIEW_LIMITS.win} characters); an empty ` +
      'list is fine when there were none.',
    `- focus: the ONE thing to work on next week (at most ${WEEKLY_REVIEW_LIMITS.focus} characters).`,
    '- nextWeekPlanPrompt: a short first-person message the USER could send you to plan next week, e.g. "Help me ' +
      `plan next week around my schedule." (at most ${WEEKLY_REVIEW_LIMITS.nextWeekPlanPrompt} characters).`,
  );

  return lines.join('\n');
}

/** The data the model sees: the stats without ids or dates (weekday names instead). */
export interface WeeklyReviewPromptData {
  week: string;
  planned: number;
  completed: number;
  missed: number;
  adherencePct: number | null;
  weeklyStreak: number;
  streakPassesLeft: number;
  streakChange: WeeklyReviewStats['streakChange'];
  personalRecords: Array<{ exercise: string; value: number; unit: string; reps: number | null }>;
  checkIns: number;
  photosAdded: number;
  nextWeekSessions: number;
  nextWeek: Array<{ weekday: string; name: string }>;
  noPlan: boolean;
  firstWeek: boolean;
  supportive: boolean;
}

export function weeklyReviewPromptData(stats: WeeklyReviewStats, supportive: boolean): WeeklyReviewPromptData {
  return {
    week: stats.isoWeek,
    planned: stats.planned,
    completed: stats.completed,
    missed: stats.missed,
    adherencePct: stats.adherencePct,
    weeklyStreak: stats.weeklyStreak,
    streakPassesLeft: stats.streakPassesLeft,
    streakChange: stats.streakChange,
    personalRecords: stats.prs.map((pr) => ({ exercise: pr.exercise, value: pr.value, unit: pr.unit, reps: pr.reps })),
    checkIns: stats.checkIns,
    photosAdded: stats.photosAdded,
    nextWeekSessions: stats.nextWeekSessions,
    nextWeek: stats.nextWeek.map((s) => ({ weekday: s.weekday, name: s.name })),
    noPlan: stats.noPlan,
    firstWeek: stats.firstWeek,
    supportive,
  };
}

export function weeklyReviewUserText(data: WeeklyReviewPromptData): string {
  return ['WEEKLY REVIEW DATA (JSON):', JSON.stringify(data)].join('\n');
}
