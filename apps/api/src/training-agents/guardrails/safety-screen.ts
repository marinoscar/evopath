import {
  CONSERVATIVE_STEM_RULES,
  READINESS_CONSERVATIVE_THRESHOLDS,
  URGENT_SYMPTOM_RULES,
} from './safety-keywords';

// =============================================================================
// Guardrail G0: the free-text safety screen
// =============================================================================
//
// `screenFreeText(texts)` runs over every free-text field of a request (goal
// sentence, limitation descriptions, preferences, a revise instruction)
// BEFORE any run row or job exists:
//
//   blocked       an urgent-symptom phrase (`safety-keywords.ts`): the run is
//                 recorded `blocked_safety`, nothing is enqueued, no provider
//                 is called, and the user sees `SAFETY_STOP_GUIDANCE`.
//   conservative  a pain / injury / recovery / pregnancy stem: the plan is
//                 built in conservative mode (`guardrails/limits.ts`).
//   ok            neither.
//
// `reasons` are rule codes (`urgent:chest_pain`, `stem:pain`), never the
// user's words. Pure; no I/O.
// =============================================================================

export type SafetyLevel = 'ok' | 'conservative' | 'blocked';

export interface SafetyScreenOutcome {
  level: SafetyLevel;
  /** Rule codes, sorted and de-duplicated. Never user text. */
  reasons: string[];
}

/** Lower case, diacritics removed, every non-alphanumeric run turned into one space. */
export function normalizeForScreen(text: string): string {
  return ` ${text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

function compile(patterns: readonly string[]): RegExp {
  // Word boundaries are spaces: the normalised text starts and ends with one.
  return new RegExp(`(?<= )(?:${patterns.join('|')})(?= )`);
}

const URGENT = URGENT_SYMPTOM_RULES.map((rule) => ({ code: rule.code, re: compile(rule.patterns) }));
const CONSERVATIVE = CONSERVATIVE_STEM_RULES.map((rule) => ({ code: rule.code, re: compile(rule.patterns) }));

/** Screens free text: `blocked` wins over `conservative`, which wins over `ok`. */
export function screenFreeText(texts: readonly (string | null | undefined)[]): SafetyScreenOutcome {
  const urgent = new Set<string>();
  const stems = new Set<string>();

  for (const raw of texts) {
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    const text = normalizeForScreen(raw);
    for (const rule of URGENT) if (rule.re.test(text)) urgent.add(`urgent:${rule.code}`);
    for (const rule of CONSERVATIVE) if (rule.re.test(text)) stems.add(`stem:${rule.code}`);
  }

  if (urgent.size > 0) return { level: 'blocked', reasons: [...urgent].sort() };
  if (stems.size > 0) return { level: 'conservative', reasons: [...stems].sort() };
  return { level: 'ok', reasons: [] };
}

/** The four numeric check-in scores, averaged over the last 7 days (`null` when never scored). */
export interface ReadinessAverages {
  energy: number | null;
  sleepQuality: number | null;
  soreness: number | null;
  stress: number | null;
}

/** The readiness reasons that make a run conservative (`readiness:low_energy`, ...). */
export function readinessReasons(readiness: ReadinessAverages | null | undefined): string[] {
  if (!readiness) return [];
  const t = READINESS_CONSERVATIVE_THRESHOLDS;
  const reasons: string[] = [];
  if (readiness.energy !== null && readiness.energy <= t.energy) reasons.push('readiness:low_energy');
  if (readiness.sleepQuality !== null && readiness.sleepQuality <= t.sleepQuality) reasons.push('readiness:poor_sleep');
  if (readiness.soreness !== null && readiness.soreness >= t.soreness) reasons.push('readiness:high_soreness');
  if (readiness.stress !== null && readiness.stress >= t.stress) reasons.push('readiness:high_stress');
  return reasons;
}

/** Conservative mode for a run: its flag and every reason (text stems, declared limitations, readiness). */
export interface ConservativeMode {
  conservative: boolean;
  reasons: string[];
}

/**
 * The run's conservative mode: any declared limitation, any conservative stem
 * in the free text, low readiness, or (H8, #192) a health summary
 * consideration flagged `conservative`, which counts like a reported
 * limitation (`health_summary`). (A `blocked` screen never gets here.)
 */
export function conservativeModeOf(args: {
  texts: readonly (string | null | undefined)[];
  limitationCount: number;
  readiness?: ReadinessAverages | null;
  healthSummaryConservative?: boolean;
}): ConservativeMode {
  const screen = screenFreeText(args.texts);
  const reasons = new Set<string>(screen.level === 'ok' ? [] : screen.reasons.filter((r) => r.startsWith('stem:')));
  if (args.limitationCount > 0) reasons.add('limitation_declared');
  if (args.healthSummaryConservative) reasons.add('health_summary');
  for (const reason of readinessReasons(args.readiness)) reasons.add(reason);

  const sorted = [...reasons].sort();
  return { conservative: sorted.length > 0, reasons: sorted };
}
