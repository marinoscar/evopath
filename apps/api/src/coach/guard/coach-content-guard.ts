// =============================================================================
// The AI Coach content guard (E7.2, #242; docs/specs/ai-coach.md §2.6)
// =============================================================================
//
// A PURE function over a coach-written message and its context. Every string
// the coach writes (nudge, review, chat reply, static fallback) passes it.
// Rules and their reasons:
//
//   banned_term         slurs, protected traits, body or weight shaming,
//                       sexual content, self-harm, diet restriction,
//                       extreme exercise, medical claims (every register)
//   profanity           a profane word while the register is not profane,
//                       or on any persona or level other than Sarge L3, or in
//                       an email (always clean), or in a supportive register
//   insult_target       in the profane register, an insult attached to the
//                       body, weight, health or worth instead of effort
//   lock_screen         `lockScreenSafe` on and `pushTitle`/`pushBody` carry
//                       profanity, a health term or a digit
//   invented_number     a figure in `title`, `body` or `audioScript` that is
//                       not in the context's allowed numbers
//   length              over the schema limit, or empty
//   supportive_register a challenge phrasing or a pushy angle while the
//                       register is supportive (safety, spec §2.14)
//
// A violation names the rule and the field, never the text: the result is
// safe to log and to count (`coach.guard.rejected{reason}`).
// =============================================================================

import { findCoachPersona } from '../personas';
import { isProfaneCombination, type CoachRegister } from '../personas/resolve-register';
import {
  BANNED_GROUPS,
  INSULT_BODY_TERMS,
  INSULT_WORDS,
  LOCK_SCREEN_HEALTH_TERMS,
  PROFANITY_PATTERNS,
  SUPPORTIVE_ANGLES,
  SUPPORTIVE_REGISTER_CHALLENGE_PATTERNS,
  WORTH_INSULT_PATTERN,
} from './banned-terms';

export const COACH_GUARD_REASONS = [
  'profanity',
  'banned_term',
  'insult_target',
  'lock_screen',
  'invented_number',
  'length',
  'supportive_register',
] as const;

export type CoachGuardReason = (typeof COACH_GUARD_REASONS)[number];

/** The text fields of a coach message (spec §2.6 `coachNudgeSchema`). */
export const COACH_TEXT_FIELDS = ['title', 'body', 'pushTitle', 'pushBody', 'audioScript', 'audioInstructions'] as const;

export type CoachTextField = (typeof COACH_TEXT_FIELDS)[number];

/** Upper bounds per field (the schema's `.max()`). */
export const COACH_FIELD_MAX_LENGTH: Readonly<Record<CoachTextField, number>> = {
  title: 60,
  body: 320,
  pushTitle: 60,
  pushBody: 140,
  audioScript: 600,
  audioInstructions: 300,
};

/** Fields that must not be empty in a full message. `audioInstructions` may be. */
export const COACH_REQUIRED_FIELDS: readonly CoachTextField[] = ['title', 'body', 'pushTitle', 'pushBody', 'audioScript'];

/** Fields whose figures must come from the context. */
const NUMBER_CHECKED_FIELDS: ReadonlySet<CoachTextField> = new Set(['title', 'body', 'audioScript']);

const PUSH_FIELDS: ReadonlySet<CoachTextField> = new Set(['pushTitle', 'pushBody']);

export type CoachMessageText = Partial<Record<CoachTextField, string>>;

export interface CoachGuardContext {
  personaId: string;
  intensity: number;
  /** `resolveRegister(...)`, evaluated for this message. */
  register: Pick<CoachRegister, 'profane'>;
  /**
   * Whole numbers 0 to `COACH_GUARD_SMALL_COUNT_MAX` pass `invented_number`
   * without a source: a count the model derived ("your third session", "2 days
   * left") is not an invented measurement. The chat sets it (#338).
   */
  allowSmallCounts?: boolean;
  /** The user's `coach.lockScreenSafe`. */
  lockScreenSafe: boolean;
  /** Every figure the context holds (signals, plan, state). Strings for times like `17:30`. */
  allowedNumbers: Iterable<number | string>;
  /** The safety register is in force (spec §2.14): calm, no challenge, no profanity. */
  supportive?: boolean;
  /** The learning-loop angle the message was written for, when there is one. */
  angle?: string | null;
  /** `email` is always the clean register (the weekly review email). */
  surface?: 'app' | 'email';
}

export interface CoachGuardViolation {
  reason: CoachGuardReason;
  field: CoachTextField;
  /** For `banned_term`: which list matched (`slur`, `sexual`, ...). Never the text. */
  category?: string;
}

export interface CoachGuardResult {
  ok: boolean;
  violations: CoachGuardViolation[];
  /** The distinct reasons, in rule order: what a regeneration prompt names. */
  reasons: CoachGuardReason[];
}

/** Lower case with typographic quotes straightened, so `don’t` matches `don't`. */
export function normaliseForGuard(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').toLowerCase();
}

/** True when the text contains any profane word. */
export function containsProfanity(text: string): boolean {
  const t = normaliseForGuard(text);
  return PROFANITY_PATTERNS.some((p) => p.test(t));
}

/** The banned categories the text hits, in list order. */
export function bannedCategories(text: string): string[] {
  const t = normaliseForGuard(text);
  return BANNED_GROUPS.filter((g) => g.patterns.some((p) => p.test(t))).map((g) => g.category);
}

/**
 * Figures in the text: `17:30`, `82.5`, `1,000` and `3` are each one token.
 * A clock time is its own token, seconds and fractions included, so an ISO
 * timestamp `2026-10-03T07:15:00.000Z` yields `2026`, `10`, `03` and
 * `07:15:00.000` (whose `7:15` form `allowedNumberSet` also accepts, #338).
 */
export function extractNumbers(text: string): string[] {
  return text.match(/\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?!\d)|\d+(?:[.,]\d+)*/g) ?? [];
}

/** `07:15:00.000` -> { h: 7, mm: '15', s: 0 }; null for anything that is not a clock time. */
function parseClock(token: string): { h: number; mm: string; s: number | null } | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(token);
  if (!m) return null;
  return { h: Number(m[1]), mm: m[2], s: m[3] === undefined ? null : Number(m[3]) };
}

function canonicalNumber(token: string): string {
  if (token.includes(':')) {
    const clock = parseClock(token);
    if (!clock) return token;
    // `07:15`, `7:15` and `07:15:00.000` are the same time of day.
    return clock.s ? `${clock.h}:${clock.mm}:${String(clock.s).padStart(2, '0')}` : `${clock.h}:${clock.mm}`;
  }
  const plain = token.replace(/,(?=\d{3}\b)/g, '').replace(',', '.');
  const n = Number(plain);
  return Number.isFinite(n) ? String(n) : token;
}

/**
 * The forms one allowed figure may take in a reply: itself, and for a clock
 * time its `H:mm` form, its 12-hour form and its parts; for a decimal, its
 * rounded forms (a tool's `82.46` may be said as `82.5` or `82`).
 */
function allowedForms(value: string): string[] {
  const canonical = canonicalNumber(value);
  const forms = [canonical];
  const clock = value.includes(':') ? parseClock(value) : null;
  if (clock) {
    forms.push(`${clock.h}:${clock.mm}`, `${clock.h % 12 || 12}:${clock.mm}`, String(clock.h), String(Number(clock.mm)));
    if (clock.s !== null) forms.push(String(clock.s));
    return forms;
  }
  const n = Number(canonical);
  if (Number.isFinite(n) && !Number.isInteger(n)) forms.push(String(Math.round(n)), String(Math.round(n * 10) / 10));
  return forms;
}

/** The largest integer `allowSmallCounts` lets through: a count of days, sessions or sets. */
export const COACH_GUARD_SMALL_COUNT_MAX = 31;

/** Whether profanity is acceptable for this context at all. */
function profanityAllowed(ctx: CoachGuardContext): boolean {
  return (
    ctx.register.profane === true &&
    ctx.supportive !== true &&
    ctx.surface !== 'email' &&
    isProfaneCombination(ctx.personaId, ctx.intensity)
  );
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;:])\s+|\n+/).filter((s) => s.trim().length > 0);
}

/**
 * Every rule that applies to ONE field's text, except emptiness (a full
 * message's concern, see `guardCoachMessage`). Used directly for a single
 * string, such as a registry sample line or a chat reply.
 */
export function guardCoachText(field: CoachTextField, text: string, ctx: CoachGuardContext): CoachGuardViolation[] {
  const violations: CoachGuardViolation[] = [];
  const normalised = normaliseForGuard(text);

  // length (upper bound; emptiness is checked per message)
  if (text.length > COACH_FIELD_MAX_LENGTH[field]) violations.push({ reason: 'length', field });

  // banned_term — every register
  for (const category of bannedCategories(text)) violations.push({ reason: 'banned_term', field, category });

  const profane = PROFANITY_PATTERNS.some((p) => p.test(normalised));
  const lockScreen = ctx.lockScreenSafe && PUSH_FIELDS.has(field);

  // lock_screen — profanity, health terms and digits stay off a locked phone
  if (lockScreen && (profane || LOCK_SCREEN_HEALTH_TERMS.test(normalised) || /\d/.test(text))) {
    violations.push({ reason: 'lock_screen', field });
  }

  // profanity — only Sarge L3 with the unlock (a lock-screen field already failed above)
  if (profane && !lockScreen && !profanityAllowed(ctx)) violations.push({ reason: 'profanity', field });

  // insult_target — an insult must attach to effort, excuses or inaction
  if (WORTH_INSULT_PATTERN.test(normalised)) {
    violations.push({ reason: 'insult_target', field });
  } else if (ctx.register.profane) {
    const bodyAimed = sentences(normalised).some(
      (s) => (INSULT_WORDS.test(s) || PROFANITY_PATTERNS.some((p) => p.test(s))) && INSULT_BODY_TERMS.test(s),
    );
    if (bodyAimed) violations.push({ reason: 'insult_target', field });
  }

  // invented_number — figures come from the context, never the model
  if (NUMBER_CHECKED_FIELDS.has(field)) {
    if (inventedNumbers(text, ctx).length > 0) violations.push({ reason: 'invented_number', field });
  }

  // supportive_register — calm and warm, no challenge
  if (ctx.supportive === true && SUPPORTIVE_REGISTER_CHALLENGE_PATTERNS.some((p) => p.test(normalised))) {
    violations.push({ reason: 'supportive_register', field });
  }

  return violations;
}

function allowedNumberSet(ctx: Pick<CoachGuardContext, 'allowedNumbers' | 'personaId'>): Set<string> {
  const set = new Set<string>();
  for (const value of ctx.allowedNumbers) for (const form of allowedForms(String(value))) set.add(form);
  for (const value of findCoachPersona(ctx.personaId)?.lexiconNumbers ?? []) set.add(String(value));
  return set;
}

function isSmallCount(canonical: string): boolean {
  if (!/^\d+$/.test(canonical)) return false;
  return Number(canonical) <= COACH_GUARD_SMALL_COUNT_MAX;
}

/**
 * The figures of `text` that the context does not hold (distinct, as written):
 * what `invented_number` rejects, and what a regeneration prompt names.
 */
export function inventedNumbers(text: string, ctx: Pick<CoachGuardContext, 'allowedNumbers' | 'personaId' | 'allowSmallCounts'>): string[] {
  const allowed = allowedNumberSet(ctx);
  const out = new Set<string>();
  for (const token of extractNumbers(text)) {
    const canonical = canonicalNumber(token);
    if (allowed.has(canonical)) continue;
    if (ctx.allowSmallCounts === true && isSmallCount(canonical)) continue;
    out.add(token);
  }
  return [...out];
}

/**
 * Guard a whole coach message. Every field present is checked by
 * `guardCoachText`; every required field must be present and non-empty; and
 * in a supportive register only a supportive angle may be used.
 */
export function guardCoachMessage(
  message: CoachMessageText,
  ctx: CoachGuardContext,
  required: readonly CoachTextField[] = COACH_REQUIRED_FIELDS,
): CoachGuardResult {
  const violations: CoachGuardViolation[] = [];

  for (const field of COACH_TEXT_FIELDS) {
    const text = message[field];
    if (text === undefined || text === null || text.trim().length === 0) {
      if (required.includes(field)) violations.push({ reason: 'length', field });
      continue;
    }
    violations.push(...guardCoachText(field, text, ctx));
  }

  if (ctx.supportive === true && ctx.angle && !SUPPORTIVE_ANGLES.includes(ctx.angle)) {
    violations.push({ reason: 'supportive_register', field: 'body' });
  }

  const reasons = COACH_GUARD_REASONS.filter((r) => violations.some((v) => v.reason === r));
  return { ok: violations.length === 0, violations, reasons };
}
