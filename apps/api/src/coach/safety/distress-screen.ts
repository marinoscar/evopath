import { normalizeForScreen } from '../../training-agents/guardrails/safety-screen';

// =============================================================================
// The coach's distress screen (E7.7, #247; docs/specs/ai-coach.md §2.9, §2.14)
// =============================================================================
//
// `screenFreeText` (training-agents/guardrails/safety-screen.ts) covers urgent
// PHYSICAL symptoms and pain stems; it has no self-harm, suicidal-ideation or
// disordered-eating rules. A coach chat message is screened by both: a hit
// here means NO model call, the persona is dropped, and the user gets the
// fixed, reviewed `COACH_DISTRESS_REPLY` (coach-chat-safety.ts).
//
// CONSERVATIVE BY DESIGN. Phrases, not single words: a false negative is
// worse than a false positive, but "this workout is killing me" or "I cut
// myself some slack" must not turn a training question into a crisis reply,
// so every pattern names the person themself or a clinical term. Matching
// runs over `normalizeForScreen` text (lower case, diacritics removed, every
// non-alphanumeric run a single space), so `don't` reads `don t` and word
// boundaries are spaces.
//
// `codes` are rule ids (`distress:suicidal_ideation`), never the user's
// words: safe to count and to store on the reply's `data`.
// =============================================================================

export const DISTRESS_CATEGORIES = ['self_harm', 'suicidal_ideation', 'eating_disorder'] as const;

export type DistressCategory = (typeof DISTRESS_CATEGORIES)[number];

interface DistressRule {
  category: DistressCategory;
  /** Regex sources over normalised text; joined with `|`, bounded by spaces. */
  patterns: readonly string[];
}

/** `(?:i m|im|i am)`: "I'm", "Im", "I am" after normalisation. */
const I_AM = '(?:i m|im|i am)';
/** "want to", "wanna", "going to", "gonna", "need to", "have to". */
const INTENT = '(?:want to|wanna|going to|gonna|need to|have to|wish i could|thinking about|thinking of|plan to)';
const NOT = '(?:don t|dont|do not|no longer|not)';

export const DISTRESS_RULES: readonly DistressRule[] = [
  {
    category: 'suicidal_ideation',
    patterns: [
      'suicide',
      'suicidal',
      'kill myself',
      'killing myself',
      'end my life',
      'ending my life',
      'end it all',
      'take my own life',
      'taking my own life',
      `${INTENT} die`,
      'wish i (?:was|were) dead',
      'wish i wasn t (?:here|alive)',
      'better off dead',
      'better off without me',
      'no reason to live',
      'nothing to live for',
      `${NOT} want to (?:be alive|live|exist|wake up)`,
      `${I_AM} not safe`,
    ],
  },
  {
    category: 'self_harm',
    patterns: [
      'self harm',
      'self harming',
      'selfharm',
      'self injury',
      'self injuring',
      'harm myself',
      'harming myself',
      `${INTENT} hurt myself`,
      'hurt myself on purpose',
      'hurting myself on purpose',
      'cutting myself',
      'burning myself',
    ],
  },
  {
    category: 'eating_disorder',
    patterns: [
      'eating disorder',
      'anorexia',
      'anorexic',
      'bulimia',
      'bulimic',
      'binge and purge',
      'binging and purging',
      'bingeing and purging',
      'purging',
      'make myself (?:throw up|sick|vomit|puke)',
      'making myself (?:throw up|sick|vomit|puke)',
      'made myself (?:throw up|sick|vomit|puke)',
      'throw up after (?:eating|meals|i eat)',
      'starve myself',
      'starving myself',
      'starved myself',
      'laxatives? to lose',
      'taking laxatives',
      'haven t eaten in (?:days|a week|\\d+ days)',
      'stopped eating',
      'hate my body',
      'disgusted (?:by|with) my body',
    ],
  },
];

const COMPILED = DISTRESS_RULES.map((rule) => ({
  category: rule.category,
  re: new RegExp(`(?<= )(?:${rule.patterns.join('|')})(?= )`),
}));

export interface DistressScreenOutcome {
  hit: boolean;
  /** The categories that matched, in `DISTRESS_CATEGORIES` order. */
  categories: DistressCategory[];
  /** Rule codes (`distress:<category>`), sorted. Never user text. */
  codes: string[];
}

/** Screens free text for self-harm, suicidal-ideation and disordered-eating cues. Pure. */
export function screenDistress(texts: readonly (string | null | undefined)[]): DistressScreenOutcome {
  const found = new Set<DistressCategory>();

  for (const raw of texts) {
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    const text = normalizeForScreen(raw);
    for (const rule of COMPILED) if (rule.re.test(text)) found.add(rule.category);
  }

  const categories = DISTRESS_CATEGORIES.filter((c) => found.has(c));
  return { hit: categories.length > 0, categories, codes: categories.map((c) => `distress:${c}`) };
}
