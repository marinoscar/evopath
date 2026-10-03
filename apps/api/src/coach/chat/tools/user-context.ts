import { addDays, isRealDate, toDbDate } from '../../../check-ins/local-date';
import type { CoachChatToolDeps } from './coach-chat-tool.types';

// =============================================================================
// Shared helpers for the coach chat's read tools (#338)
// =============================================================================
//
// THE CHAT'S PRIVACY RULE (#338, `coach/context/coach-never-send.ts`). The
// coach chat's OWN tool results carry the user's free text (notes, pain
// notes, intake text, plan rationale, bio, gym names, activity notes): the
// owner decided the coach should see every data point about him. Each free
// text value is a plain JSON field value (data, never an instruction),
// collapsed and bounded by `userText` (2000 characters, above any stored note). Secrets never ride along: no email, no
// credential, no storage key or URL, nothing of another user; ids appear only
// where a follow-up tool takes them (`workoutId`).
// =============================================================================

/**
 * The longest single free-text value a coach chat tool returns, in characters:
 * a safety bound well above every stored note (the owner wants no artificial
 * caps, #338), not a budget.
 */
export const COACH_USER_TEXT_MAX = 2000;

/** Collapses whitespace and clips to `max` characters; null when empty. */
export function userText(text: string | null | undefined, max: number = COACH_USER_TEXT_MAX): string | null {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return null;
  return [...clean].slice(0, max).join('').trim();
}

/** A copy of `value` without the keys whose value is null or undefined (keeps tool results small). */
export function dropNulls<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && item !== undefined) out[key] = item;
  }
  return out as Partial<T>;
}

/** A Decimal-ish database value as a number (null stays null). */
export function num(value: { toString(): string } | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

/** Rounds to `places` decimals. */
export function round(value: number, places = 1): number {
  const f = 10 ** places;
  return Math.round(value * f + Number.EPSILON) / f;
}

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** The English weekday name of a `YYYY-MM-DD` day. */
export function weekdayOf(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return WEEKDAY_NAMES[(day + 6) % 7];
}

/** `HH:mm` (24-hour) of `instant` in `timeZone` (UTC for a missing or unknown zone). */
export function localTimeOf(instant: Date, timeZone: string | null | undefined): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);
  try {
    return format(timeZone || 'UTC');
  } catch {
    return format('UTC');
  }
}

export interface CoachUnits {
  unitSystem: 'metric' | 'imperial';
  /** Tool figures are always in these units... */
  weight: 'kg';
  distance: 'm';
  /** ...and the user prefers to talk in these. */
  preferredWeight: 'kg' | 'lb';
  preferredDistance: 'km' | 'mi';
}

export function unitsOf(unitSystem: string | null | undefined): CoachUnits {
  const imperial = unitSystem === 'imperial';
  return {
    unitSystem: imperial ? 'imperial' : 'metric',
    weight: 'kg',
    distance: 'm',
    preferredWeight: imperial ? 'lb' : 'kg',
    preferredDistance: imperial ? 'mi' : 'km',
  };
}

export interface CoachUserBasics {
  units: CoachUnits;
  /** IANA zone from the health profile; null when unset (the app then uses UTC). */
  timeZone: string | null;
}

/** The user's units and time zone; metric/UTC when the profile is unavailable. */
export async function userBasics(deps: CoachChatToolDeps, userId: string): Promise<CoachUserBasics> {
  try {
    const profile = deps.profile ? await deps.profile.healthProfile.get(userId) : null;
    return { units: unitsOf(profile?.unitSystem), timeZone: profile?.timeZone ?? null };
  } catch {
    return { units: unitsOf(null), timeZone: null };
  }
}

/** An `invalid_arguments` answer the model can correct. */
export interface CoachToolInvalid {
  error: 'invalid_arguments';
  message: string;
}

export function invalid(message: string): CoachToolInvalid {
  return { error: 'invalid_arguments', message };
}

export interface ResolvedRange {
  from: string;
  to: string;
  /** True when the asked range was longer than the cap and `from` was moved forward. */
  clamped: boolean;
}

/**
 * A local date range from optional `from`/`to`: `to` defaults to today, `from`
 * to `to - (defaultDays - 1)`; at most `maxDays` days (`from` moves forward).
 */
export function resolveRange(
  args: { from: string | null; to: string | null },
  today: string,
  defaultDays: number,
  maxDays: number,
): ResolvedRange | CoachToolInvalid {
  for (const [key, value] of [['from', args.from], ['to', args.to]] as const) {
    if (value !== null && !isRealDate(value)) return invalid(`${key} must be a real date as YYYY-MM-DD, or null`);
  }
  const to = args.to ?? today;
  const from = args.from ?? addDays(to, -(defaultDays - 1));
  const span = Math.round((toDbDate(to).getTime() - toDbDate(from).getTime()) / 86_400_000);
  if (span < 0) return invalid('from must be on or before to');
  if (span + 1 > maxDays) return { from: addDays(to, -(maxDays - 1)), to, clamped: true };
  return { from, to, clamped: false };
}
