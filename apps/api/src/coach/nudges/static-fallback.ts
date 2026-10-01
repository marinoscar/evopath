import type { CoachMessageText } from '../guard/coach-content-guard';
import type { CoachMoment } from '../personas';
import type { RenderedPersonaStyle } from '../personas/resolve-register';
import type { NudgeFill } from './nudge-context';

// =============================================================================
// The static persona fallback (E7.5, #245; spec §2.6 "On failure")
// =============================================================================
//
// PURE. When two model answers fail the content guard, the message is the
// registry's sample line for the moment at the RENDERED intensity (so a locked
// Sarge L3 falls back to the clean L2 line), with its placeholders filled
// from the context (`{n}`, `{streak}`, `{lift}`, `{time}`; every value is in
// the guard's allowed numbers). No model, no cost; persisted with
// `provider = 'static'`.
//
// The lock-screen pair is fixed copy with no digit and no health word, so it
// passes the `lock_screen` rule whatever the line says. Under the supportive
// register a pushy registry line is replaced by `SUPPORTIVE_FALLBACK_LINE`.
// =============================================================================

/** Clean, digit-free titles per moment (they double as the lock-screen title). */
export const FALLBACK_TITLES: Readonly<Record<CoachMoment, string>> = {
  missed_twice: "Let's get back on track",
  streak_at_risk: 'Your session is waiting',
  comeback: 'Welcome back',
  pr: 'New personal best',
  weekly_target_hit: 'Weekly target reached',
  missed_session: 'About yesterday',
  fresh_start: 'Fresh start',
  photo_prompt: 'Progress photo time',
  win_back: 'Stepping back for now',
  back_off: 'Stepping back for now',
  kickoff: 'Your plan is live',
  weekly_review: 'Your week in review',
  goal_at_risk: 'Your goal needs you today',
  goal_hit: 'Goal reached',
};

/** The calm line every persona falls back to under the supportive register. */
export const SUPPORTIVE_FALLBACK_LINE =
  "Rest counts as training too. Take care of yourself today, and I'll be here when you're ready for something light.";

/** `{name} has a message for you.`: the lock-screen body of every fallback. */
export function lockScreenBody(personaName: string): string {
  return `${personaName} has a message for you.`;
}

export function fillPlaceholders(line: string, fill: NudgeFill): string {
  return line
    .replace(/\{n\}/g, String(fill.n))
    .replace(/\{streak\}/g, String(fill.streak))
    .replace(/\{lift\}/g, fill.lift)
    .replace(/\{time\}/g, fill.time);
}

export interface StaticFallbackOptions {
  style: RenderedPersonaStyle;
  moment: CoachMoment;
  fill: NudgeFill;
  lockScreenSafe: boolean;
  /** Use the supportive line instead of the persona's (safety register). */
  supportive: boolean;
}

export function staticFallbackMessage(opts: StaticFallbackOptions): Required<Pick<CoachMessageText, 'title' | 'body' | 'pushTitle' | 'pushBody' | 'audioScript' | 'audioInstructions'>> {
  const { style, moment, fill, lockScreenSafe, supportive } = opts;
  const line = supportive ? SUPPORTIVE_FALLBACK_LINE : fillPlaceholders(style.persona.sampleLines[moment][style.intensity], fill);
  const body = truncate(line, 320);
  const title = FALLBACK_TITLES[moment];

  return {
    title,
    body,
    pushTitle: title,
    pushBody: lockScreenSafe ? lockScreenBody(style.persona.name) : truncate(body, 140),
    audioScript: truncate(body, 600),
    audioInstructions: truncate(style.ttsInstructions, 300),
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
