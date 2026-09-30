// =============================================================================
// Safety keyword lists (guardrail G0): A FAIL-SAFE NET, NOT A DIAGNOSIS
// =============================================================================
//
// These lists decide nothing medical. They catch free text that SHOULD NOT
// start a training plan (urgent symptoms) or that should make a plan
// conservative (pain, injury, recovery, pregnancy). They are deliberately
// over-inclusive: a false stop costs the user a re-phrase, a missed one could
// cost far more. Negations are NOT special-cased ("no chest pain" still
// stops). The prompts separately instruct conservative behaviour; this file
// is the server's own net underneath them.
//
// Matching (`safety-screen.ts`): text is lower-cased, diacritics removed and
// punctuation turned into spaces; a phrase matches on word boundaries.
// Patterns may use `\w*` for a stem and `(?:\w+ ){0,3}` for "a few words in
// between". Bump `SAFETY_KEYWORDS_VERSION` whenever a list changes.
// =============================================================================

export const SAFETY_KEYWORDS_VERSION = '2026-09-1';

export interface UrgentSymptomRule {
  /** Stable code, recorded as `urgent:<code>` (never the user's words). */
  code: string;
  /** Regex sources over normalised text (lower case, no diacritics, single spaces). */
  patterns: string[];
}

const FEW = '(?:\\w+ ){0,3}';

/** Red-flag symptoms that stop a run before any provider call (VISION 74). */
export const URGENT_SYMPTOM_RULES: readonly UrgentSymptomRule[] = [
  {
    code: 'chest_pain',
    patterns: [
      'chest ?pains?',
      'chest pian',
      'chset pain',
      'chest pressure',
      'chest tightness',
      'tight(?:ness)? (?:in )?(?:my |the )?chest',
      `pain ${FEW}chest`,
      `pressure ${FEW}chest`,
      'chest (?:hurts|hurting|aches?)',
      'heart attack',
      'dolor (?:de|en el) pecho',
      'opresion (?:de|en el) pecho',
    ],
  },
  {
    code: 'breathing_at_rest',
    patterns: [
      'trouble breath\\w*',
      'difficulty breath\\w*',
      'hard to breath\\w*',
      'struggl\\w* to breath\\w*',
      "can ?t breath\\w*",
      'cannot breath\\w*',
      'can not breath\\w*',
      'unable to breath\\w*',
      `short(?:ness)? of breath ${FEW}rest`,
      `breathless ${FEW}rest`,
      'falta de aire',
    ],
  },
  {
    code: 'fainting',
    patterns: ['faint\\w*', 'fanted', 'passed out', 'pass(?:ing)? out', 'blacked out', 'black(?:ing)? out', 'syncope', 'desmay\\w*'],
  },
  {
    code: 'dizziness',
    patterns: ['dizz\\w*', 'dizy', 'dizey', 'diziness', 'vertigo', 'room spinning', 'mareo\\w*'],
  },
  {
    code: 'numbness_arm_face',
    patterns: [
      `numb\\w* ${FEW}(?:arm|arms|face|jaw)`,
      `(?:arm|arms|face|jaw) ${FEW}numb\\w*`,
      `tingl\\w* ${FEW}(?:arm|arms|face|jaw)`,
      `(?:arm|arms|face|jaw) ${FEW}tingl\\w*`,
      'face droop\\w*',
      'drooping face',
      'slurred speech',
    ],
  },
  {
    code: 'sudden_severe_headache',
    patterns: [
      'sudden (?:severe )?head ?aches?',
      'severe head ?aches?',
      'worst head ?aches?',
      'thunderclap',
    ],
  },
  {
    code: 'coughing_blood',
    patterns: ['cough\\w* (?:up )?blood', 'blood (?:when|while) cough\\w*', 'ha?emoptysis'],
  },
  {
    code: 'fracture_dislocation',
    patterns: [
      'fractur\\w*',
      'broken bones?',
      'broke (?:my |a )?(?:arm|leg|wrist|ankle|foot|hand|rib|ribs|collarbone|finger|toe)',
      'broken (?:arm|leg|wrist|ankle|foot|hand|rib|ribs|collarbone|finger|toe)',
      'dislocat\\w*',
      'disloacted',
    ],
  },
  {
    code: 'cannot_move',
    patterns: ["can ?t move", 'cannot move', 'can not move', 'unable to move', 'no puedo mover\\w*'],
  },
];

export interface ConservativeStemRule {
  code: string;
  /** Regex sources over normalised text, matched on word boundaries. */
  patterns: string[];
}

/** Words that switch a run to conservative mode (VISION 75). */
export const CONSERVATIVE_STEM_RULES: readonly ConservativeStemRule[] = [
  { code: 'pain', patterns: ['pain\\w*', 'ache\\w*', 'aching', 'hurts?', 'hurting', 'sore(?:ness)?', 'dolor\\w*'] },
  { code: 'injury', patterns: ['injur\\w*', 'lesion\\w*'] },
  { code: 'strain', patterns: ['strain\\w*'] },
  { code: 'sprain', patterns: ['sprain\\w*'] },
  { code: 'tendon', patterns: ['tendon\\w*', 'tendin\\w*', 'tendon'] },
  { code: 'joint', patterns: ['joints?', 'arthritis', 'articulac\\w*'] },
  { code: 'recovering', patterns: ['recovering', 'recover(?:ing|y)? from', 'rehab\\w*', 'surgery', 'post ?op\\w*'] },
  { code: 'pregnant', patterns: ['pregnan\\w*', 'postpartum', 'embarazad\\w*'] },
];

/** Check-in 7-day averages (1..5 scales) that switch a run to conservative mode. */
export const READINESS_CONSERVATIVE_THRESHOLDS = {
  /** At or below. */
  energy: 2,
  /** At or below. */
  sleepQuality: 2,
  /** At or above. */
  soreness: 4,
  /** At or above. */
  stress: 4,
} as const;

/**
 * Shown when the screen stops a run. A fixed constant: it never echoes what
 * the user typed and it diagnoses nothing.
 */
export const SAFETY_STOP_GUIDANCE =
  'Some of what you wrote can be a sign of a medical problem that needs attention before any training plan. ' +
  'Please stop exercising for now. If your symptoms are severe, sudden or ongoing, seek urgent medical care ' +
  '(call your local emergency number). This app cannot assess symptoms or give a diagnosis; once a qualified ' +
  'professional has cleared you to train, you can start a new plan.';
