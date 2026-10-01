// =============================================================================
// AI Coach persona types (E7.2, #242; docs/specs/ai-coach.md §2.3)
// =============================================================================
//
// A persona is DATA: one `*.persona.ts` file per persona, collected into
// `COACH_PERSONAS` by `./index.ts`. The registry is the only place persona text
// lives; the web reads it through `GET /api/coach/personas` and the prompt
// builder reads it directly.
//
// Pure module: no Nest, no Prisma.
// =============================================================================

/**
 * Every moment the coach can speak at (spec §2.5 Moments, plus the auto-silence
 * back-off message, the program kickoff of §2.13, the weekly review lane and the
 * activity-goal moments `goal_at_risk` and `goal_hit`).
 * Every persona carries a sample line for every moment at every intensity; the
 * registry completeness test fails until it does (spec §4.2).
 */
export const COACH_MOMENTS = [
  'missed_twice',
  'streak_at_risk',
  'comeback',
  'pr',
  'weekly_target_hit',
  'missed_session',
  'fresh_start',
  'photo_prompt',
  'win_back',
  'back_off',
  'kickoff',
  'weekly_review',
  // Activity goals (F9, #269): appended, the order above is unchanged.
  'goal_at_risk',
  'goal_hit',
] as const;

export type CoachMoment = (typeof COACH_MOMENTS)[number];

export const COACH_INTENSITIES = [1, 2, 3] as const;

export type Intensity = (typeof COACH_INTENSITIES)[number];

/** The registry ids, in gallery order. `coach` is the default persona. */
export const COACH_PERSONA_IDS = [
  'coach',
  'drill_sergeant',
  'stoic',
  'analyst',
  'butler',
  'hype',
  'nana',
] as const;

export type CoachPersonaId = (typeof COACH_PERSONA_IDS)[number];

/**
 * The OpenAI speech voices a persona may default to. Mirrors
 * `OPENAI_SPEECH_VOICES` (`ai/providers/openai/openai-model-catalog.ts`); the
 * coach may not import a provider module, so the registry spec pins the two
 * lists together instead.
 */
export const COACH_PERSONA_VOICES = [
  'alloy',
  'ash',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'ballad',
  'verse',
  'marin',
  'cedar',
] as const;

export type CoachPersonaVoice = (typeof COACH_PERSONA_VOICES)[number];

/** One line per intensity level. */
export type IntensityLines = Readonly<Record<Intensity, string>>;

/** Sample lines: every moment, every intensity. Placeholders: `{n}`, `{streak}`, `{lift}`, `{time}`. */
export type PersonaSampleLines = Readonly<Record<CoachMoment, IntensityLines>>;

/** What one intensity level means for this persona (the prompt's rubric). */
export interface PersonaRubricLevel {
  /** Short label shown in the gallery ("Gentle", "Brutal"). */
  label: string;
  /** How the model should write at this level. */
  guidance: string;
}

export interface PersonaStyleCard {
  /** One-paragraph description of the voice. */
  summary: string;
  /** Words and phrases that belong to this persona. */
  lexicon: readonly string[];
  do: readonly string[];
  dont: readonly string[];
}

export interface PersonaVoice {
  /** Default voice per intensity (a level-3 voice can differ, as Sarge's does). */
  byIntensity: Readonly<Record<Intensity, CoachPersonaVoice>>;
  /** TTS delivery instructions for every level. */
  instructions: string;
  /** Extra instructions appended at a given level (Sarge L3). */
  extraInstructions?: Readonly<Partial<Record<Intensity, string>>>;
}

export interface Persona {
  id: CoachPersonaId;
  name: string;
  tagline: string;
  /** Icon key the web maps to an icon. */
  avatar: string;
  /** One-line vibe from the spec's persona table. */
  vibe: string;
  styleCard: PersonaStyleCard;
  rubric: Readonly<Record<Intensity, PersonaRubricLevel>>;
  voice: PersonaVoice;
  /**
   * Intensity levels whose sample lines and rubric are PROFANE. Only Sarge L3
   * (`[3]`); every other persona has none. Rendering one of these levels needs
   * `resolveRegister(...).profane`; otherwise the level below stands in.
   */
  profaneIntensities: readonly Intensity[];
  /**
   * Figures the persona's own lexicon uses ("your mind quits at 40 percent"),
   * which are style, not data. The content guard's numbers rule admits them
   * besides the context's figures.
   */
  lexiconNumbers: readonly number[];
  sampleLines: PersonaSampleLines;
}

/** The same line at every intensity: the persona's level changes the rubric, not the static sample. */
export function atEveryLevel(line: string): IntensityLines {
  return { 1: line, 2: line, 3: line };
}
