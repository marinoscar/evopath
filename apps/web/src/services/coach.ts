/**
 * The AI Coach's settings, as the web app sees them (E7.3, #243;
 * docs/specs/ai-coach.md §2.3, §2.4, §3.1, §3.2, §3.6, §3.7).
 *
 *   GET  /api/coach/personas          ai:use   the persona gallery (static sample lines)
 *   GET  /api/coach/settings          ai:use   my settings, the effective register, the policy
 *   PUT  /api/coach/settings          ai:use   merge-patch; `null` resets; `confirmAdult: true`
 *   GET  /api/admin/coach/settings    ai_config:read    the deployment's coach policy
 *   PUT  /api/admin/coach/settings    ai_config:write   any subset of the policy
 *   GET  /api/admin/coach/stats       ai_config:read    engagement aggregates (E7.11)
 *
 * THE API DECIDES. Whether profanity is allowed (`effective.register`), the
 * nudge cap actually applied and whether Sarge's level-3 lines are served
 * uncensored are all answered server-side; the page only renders them. The
 * browser never stamps `adultConfirmedAt`: the 18+ dialog sends
 * `confirmAdult: true` and the server records the time.
 *
 * E7.8 (#248) adds the `/coach` page's calls, below the settings section:
 *
 *   GET  /api/coach/state                    ai:use + programs:read  the header
 *   GET  /api/coach/messages?before=&limit=  ai:use                  the timeline, newest first
 *   POST /api/coach/messages/:id/opened      ai:use                  mark a message seen (E7.5)
 *   POST /api/coach/messages/:id/feedback    ai:use                  thumbs up/down/clear (E7.5)
 *   POST /api/coach/chat/stream              ai:use + programs:read  one chat turn, as SSE
 *
 * Coach refusals carry their code in `details.code` (the envelope's `code` is
 * status-derived); `COACH_PROFANITY_LOCKED` names the failed unlock condition
 * in `details.reason`.
 */
import { api, API_BASE_URL, ApiError } from './api';
import { postSse } from './sse';
import type { CoachPhotoCadence } from '../types';

// -----------------------------------------------------------------------------
// Constants mirrored from the API
// -----------------------------------------------------------------------------

/** Mirrors `COACH_MOMENTS` (`apps/api/src/coach/personas/persona.types.ts`), in display order. */
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
  // Activity goals (#269): appended, as on the API.
  'goal_at_risk',
  'goal_hit',
] as const;

export type CoachMoment = (typeof COACH_MOMENTS)[number];

export const COACH_MOMENT_LABELS: Record<CoachMoment, string> = {
  missed_twice: 'Missed two sessions',
  streak_at_risk: 'Streak at risk',
  comeback: 'Comeback',
  pr: 'Personal record',
  weekly_target_hit: 'Weekly target hit',
  missed_session: 'Missed a session',
  fresh_start: 'Fresh start',
  photo_prompt: 'Progress photo',
  win_back: 'Win-back',
  back_off: 'Backing off',
  kickoff: 'Program kickoff',
  weekly_review: 'Weekly review',
  goal_at_risk: 'Goal at risk',
  goal_hit: 'Goal reached',
};

/** Mirrors `COACH_REGISTER_REASONS` (`resolve-register.ts`). */
export type CoachRegisterReason =
  | 'system_disabled'
  | 'age_unverified'
  | 'underage'
  | 'toggle_off'
  | 'persona_or_intensity';

/** The one persona with a profane level (spec §2.4, condition 4). */
export const PROFANE_PERSONA_ID = 'drill_sergeant';
export const PROFANE_INTENSITY = 3;

export const COACH_PHOTO_CADENCES: readonly CoachPhotoCadence[] = ['off', 'weekly', 'biweekly', 'monthly'];

export const COACH_INTENSITY_MIN = 1;
export const COACH_INTENSITY_MAX = 3;
export const COACH_AUDIO_SPEED_MIN = 0.75;
export const COACH_AUDIO_SPEED_MAX = 1.5;
export const COACH_WHY_MAX_LENGTH = 200;
/** The schema's own ceiling on `maxNudgesPerDay` and on the admin's `maxNudgesPerDayCeiling`. */
export const COACH_MAX_NUDGES_PER_DAY_MAX = 4;
/** `HH:mm`, 24-hour: mirrors `COACH_TIME_OF_DAY_PATTERN`. */
export const COACH_TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Coach codes, carried in `details.code`. Mirrors `COACH_ERRORS`. */
export const COACH_ERRORS = {
  DISABLED: 'COACH_DISABLED',
  PROFANITY_LOCKED: 'COACH_PROFANITY_LOCKED',
  AUDIO_DISABLED: 'COACH_AUDIO_DISABLED',
  PERSONA_UNKNOWN: 'COACH_PERSONA_UNKNOWN',
  PREVIEW_RATE_LIMITED: 'COACH_PREVIEW_RATE_LIMITED',
  MESSAGE_NOT_FOUND: 'COACH_MESSAGE_NOT_FOUND',
  AUDIO_RATE_LIMITED: 'COACH_AUDIO_RATE_LIMITED',
} as const;

// -----------------------------------------------------------------------------
// GET /api/coach/personas
// -----------------------------------------------------------------------------

export interface CoachPersonaIntensity {
  level: number;
  label: string;
  /** Default voice at this level. */
  voice: string;
  /** Adult language (Sarge L3 only). */
  profane: boolean;
}

export interface CoachPersonaCard {
  id: string;
  name: string;
  tagline: string;
  vibe: string;
  /** Icon key (`whistle`, `military_tech`, ...). */
  avatar: string;
  /** The style card's summary. */
  style: string;
  intensities: CoachPersonaIntensity[];
  /** Every moment at every intensity (`'1' | '2' | '3'` keys). */
  sampleLines: Record<CoachMoment, Record<string, string>>;
  /** The profane level's lines were withheld (the clean level stands in). */
  censored: boolean;
}

export function getCoachPersonas(): Promise<CoachPersonaCard[]> {
  return api.get<CoachPersonaCard[]>('/coach/personas');
}

// -----------------------------------------------------------------------------
// GET / PUT /api/coach/settings
// -----------------------------------------------------------------------------

export interface CoachSettingsValue {
  enabled: boolean;
  personaId: string;
  intensity: number;
  profanity: boolean;
  adultConfirmedAt: string | null;
  audio: { enabled: boolean; voice: string | null; speed: number };
  quietHours: { start: string; end: string };
  maxNudgesPerDay: number;
  lockScreenSafe: boolean;
  photoCadence: CoachPhotoCadence;
  why: string | null;
  preferredTime: string | null;
}

export interface CoachRegister {
  profane: boolean;
  /** The failed unlock condition; `null` exactly when `profane`. */
  reason: CoachRegisterReason | null;
}

export interface CoachPolicy {
  enabled: boolean;
  allowProfanePersonas: boolean;
  allowAudio: boolean;
  maxNudgesPerDayCeiling: number;
}

export interface CoachSettingsView {
  settings: CoachSettingsValue;
  effective: {
    /** `maxNudgesPerDay` clamped to the ceiling. */
    maxNudgesPerDay: number;
    register: CoachRegister;
    /** A locked Sarge L3 renders as L2. */
    intensity: number;
    voice: string;
  };
  policy: CoachPolicy;
}

/**
 * The PUT body: any subset; `null` resets a field to its default. Never
 * `adultConfirmedAt` (send `confirmAdult: true`).
 */
export interface CoachSettingsPut {
  enabled?: boolean | null;
  personaId?: string | null;
  intensity?: number | null;
  profanity?: boolean | null;
  audio?: { enabled?: boolean | null; voice?: string | null; speed?: number | null } | null;
  quietHours?: { start?: string | null; end?: string | null } | null;
  maxNudgesPerDay?: number | null;
  lockScreenSafe?: boolean | null;
  photoCadence?: CoachPhotoCadence | null;
  why?: string | null;
  preferredTime?: string | null;
  confirmAdult?: true;
}

export function getCoachSettings(): Promise<CoachSettingsView> {
  return api.get<CoachSettingsView>('/coach/settings');
}

export function updateCoachSettings(body: CoachSettingsPut): Promise<CoachSettingsView> {
  return api.put<CoachSettingsView>('/coach/settings', body);
}

// -----------------------------------------------------------------------------
// GET / PUT /api/admin/coach/settings
// -----------------------------------------------------------------------------

export interface SystemCoachSettings {
  enabled: boolean;
  allowProfanePersonas: boolean;
  allowAudio: boolean;
  maxNudgesPerDayCeiling: number;
  audioRetentionDays: number;
  autoSilenceAfterIgnored: number;
  inactiveStopDays: number;
}

/** Inclusive bounds of each numeric policy field; mirrors `systemCoachSchema`. */
export const SYSTEM_COACH_NUMBER_BOUNDS = {
  maxNudgesPerDayCeiling: { min: 1, max: COACH_MAX_NUDGES_PER_DAY_MAX },
  audioRetentionDays: { min: 1, max: 3650 },
  autoSilenceAfterIgnored: { min: 1, max: 20 },
  inactiveStopDays: { min: 1, max: 90 },
} as const;

export function getSystemCoachSettings(): Promise<SystemCoachSettings> {
  return api.get<SystemCoachSettings>('/admin/coach/settings');
}

export function updateSystemCoachSettings(patch: Partial<SystemCoachSettings>): Promise<SystemCoachSettings> {
  return api.put<SystemCoachSettings>('/admin/coach/settings', patch);
}

// -----------------------------------------------------------------------------
// GET /api/admin/coach/stats (E7.11, #251)
// -----------------------------------------------------------------------------

/** Mirrors `COACH_ANGLES` (`apps/api/src/coach/nudges/angle-picker.ts`). */
export const COACH_ANGLE_LABELS: Record<string, string> = {
  loss_aversion: 'Keep the streak',
  identity: 'Identity',
  humor: 'Humour',
  challenge: 'Small challenge',
  data: 'One true number',
  future_self: 'Your why',
  social_proof_self: 'Beat your past self',
};

/** Persona display names, mirrored from the API registry for the stats table. */
export const COACH_PERSONA_LABELS: Record<string, string> = {
  coach: 'Coach',
  drill_sergeant: 'Sarge',
  stoic: 'The Stoic',
  analyst: 'The Analyst',
  butler: 'Reginald',
  hype: 'The Announcer',
  nana: 'Nana',
};

/** One funnel bucket; a rate is `null` when its denominator is 0. */
export interface CoachFunnel {
  sent: number;
  opened: number;
  convertible: number;
  converted: number;
  up: number;
  down: number;
  openRate: number | null;
  convertRate: number | null;
}

export interface CoachFunnelRow extends CoachFunnel {
  /** The angle, persona id or moment; `none` when the message had none. */
  key: string;
}

export interface CoachStats {
  range: { from: string; to: string; days: number };
  totals: CoachFunnel;
  byAngle: CoachFunnelRow[];
  byPersona: CoachFunnelRow[];
  byMoment: CoachFunnelRow[];
  kpis: {
    nudgeOpenRate: number | null;
    conversionRate: number | null;
    weeklyActiveUsers: number;
    chatSessionsPerWau: number | null;
    photoCadenceAdherencePct: number | null;
    weeklyAdherencePct: number | null;
    optedOut: number;
    enabled: number;
    optOutRate: number | null;
  };
}

/** Aggregates only (no user ids, no text); `ai_config:read`, reachable while AI is off. */
export function getCoachStats(days = 30): Promise<CoachStats> {
  return api.get<CoachStats>(`/admin/coach/stats?days=${days}`);
}

// -----------------------------------------------------------------------------
// POST /api/coach/voice-preview (E7.6, #246)
// -----------------------------------------------------------------------------

/**
 * Whether the voice preview route exists. E7.6 shipped
 * `POST /api/coach/voice-preview` (rate-limited, static sample lines), so
 * "Hear it" is live; the flag stays so a fork can switch the button off.
 */
export const COACH_VOICE_PREVIEW_AVAILABLE = true;

/** At most this many previews per user in `COACH_PREVIEW_WINDOW_MINUTES` (the server enforces it). */
export const COACH_PREVIEW_LIMIT = 10;
export const COACH_PREVIEW_WINDOW_MINUTES = 10;

export interface CoachVoicePreviewRequest {
  personaId: string;
  intensity?: number;
  voice?: string;
  speed?: number;
  moment?: CoachMoment;
}

/**
 * The 202 answer: a queued speech run. Poll `GET /ai/runs/:id` (`useAiRun`);
 * once `succeeded`, `output` is the audio (`AiSpeechRunOutput`), played with
 * `AiSpeechPlayer` and its AI-generated disclosure.
 */
export interface CoachVoicePreview {
  runId: string;
  jobId: string;
  personaId: string;
  /** The level spoken: a locked Sarge 3 speaks level 2. */
  intensity: number;
  moment: CoachMoment;
  voice: string;
  /** The clean line stood in for a locked adult-language level. */
  censored: boolean;
}

export function previewCoachVoice(body: CoachVoicePreviewRequest): Promise<CoachVoicePreview> {
  return api.post<CoachVoicePreview>('/coach/voice-preview', body);
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export interface CoachErrorInfo {
  status: number | null;
  /** `details.code` (a coach code) when present. */
  code: string | null;
  /** `details.reason`: the failed unlock condition for `COACH_PROFANITY_LOCKED`. */
  reason: string | null;
  message: string;
}

export function coachErrorOf(error: unknown, fallback = 'Something went wrong. Try again.'): CoachErrorInfo {
  if (error instanceof ApiError) {
    const details = (error.details ?? {}) as { code?: unknown; reason?: unknown };
    return {
      status: error.status,
      code: typeof details.code === 'string' ? details.code : null,
      reason: typeof details.reason === 'string' ? details.reason : null,
      message: error.message || fallback,
    };
  }
  return { status: null, code: null, reason: null, message: fallback };
}

/** Plain-language text for each failed unlock condition (spec §2.4). */
export const PROFANITY_REASON_TEXT: Record<CoachRegisterReason, string> = {
  system_disabled: 'Adult language is switched off for this deployment by your administrator.',
  underage:
    'Adult language is only for people aged 18 or over, and the date of birth in your health profile says you are under 18.',
  age_unverified: 'Confirm you are 18 or older to unlock adult language.',
  toggle_off: 'Adult language is off. Turn it on to hear Sarge uncensored.',
  persona_or_intensity: 'Adult language applies only to Sarge at Unhinged (level 3).',
};

export function profanityReasonText(reason: string | null | undefined): string {
  if (reason && reason in PROFANITY_REASON_TEXT) return PROFANITY_REASON_TEXT[reason as CoachRegisterReason];
  return 'Adult language cannot be turned on right now.';
}

/** A user-facing message for a failed `PUT /api/coach/settings`. */
export function coachSaveErrorMessage(info: CoachErrorInfo): string {
  switch (info.code) {
    case COACH_ERRORS.PROFANITY_LOCKED:
      return profanityReasonText(info.reason);
    case COACH_ERRORS.DISABLED:
      return 'The coach is switched off for this deployment, so it cannot be turned on.';
    case COACH_ERRORS.AUDIO_DISABLED:
      return 'Spoken coach messages are switched off for this deployment.';
    case COACH_ERRORS.PERSONA_UNKNOWN:
      return 'That persona is no longer available. Reload the page and choose another.';
    default:
      if (info.status === null || info.status >= 500) {
        return 'Could not reach the server, so nothing was saved. Your changes are still here; try again.';
      }
      return info.message;
  }
}


// =============================================================================
// The /coach page (E7.8, #248; docs/specs/ai-coach.md §2.9, §2.13)
// =============================================================================

// -----------------------------------------------------------------------------
// GET /api/coach/state
// -----------------------------------------------------------------------------

/** Mirrors `coachStateViewSchema` (`apps/api/src/coach/planning/dto/coach-state.dto.ts`). */
export interface CoachStateView {
  enabled: boolean;
  pausedUntil: string | null;
  silencedAt: string | null;
  weeklyTarget: { done: number; planned: number };
  weeklyStreak: number;
  streakPassesLeft: number;
  nextSession: { date: string; name: string; programWorkoutId: string } | null;
  unreadCount: number;
  /** When the caller last started the chat over (#323); the timeline lists only messages after it. */
  chatClearedAt: string | null;
}

export function getCoachState(): Promise<CoachStateView> {
  return api.get<CoachStateView>('/coach/state');
}

// -----------------------------------------------------------------------------
// GET /api/coach/messages
// -----------------------------------------------------------------------------

export type CoachMessageRole = 'coach' | 'user';
export type CoachAudioStatus = 'none' | 'pending' | 'ready' | 'failed';
export type CoachFeedback = 'up' | 'down';

/** Mirrors `coachTimelineItemSchema` (`apps/api/src/coach/chat/dto/coach-chat.dto.ts`). */
export interface CoachTimelineItem {
  id: string;
  role: CoachMessageRole;
  /** `nudge`, `chat`, `weekly_review`, `celebration`, `photo_prompt`, `comeback`, `kickoff` or `system`. */
  kind: string;
  moment: string | null;
  /** Null for user turns and safety replies. */
  personaId: string | null;
  intensity: number | null;
  title: string;
  body: string;
  audioStatus: CoachAudioStatus;
  /** Only while `audioStatus` is `ready`. */
  audioStorageObjectId: string | null;
  voice: string | null;
  feedback: CoachFeedback | null;
  openedAt: string | null;
  /** Kind-specific; read defensively (`coachMessageData`). */
  data: unknown;
  createdAt: string;
}

export interface CoachTimelinePage {
  /** Newest first. */
  items: CoachTimelineItem[];
  /** Pass as `before` for the next (older) page; null on the last page. */
  nextCursor: string | null;
}

export const COACH_TIMELINE_PAGE_SIZE = 30;

export function getCoachMessages(params: { before?: string; limit?: number } = {}): Promise<CoachTimelinePage> {
  const query = new URLSearchParams();
  if (params.before) query.set('before', params.before);
  query.set('limit', String(params.limit ?? COACH_TIMELINE_PAGE_SIZE));
  return api.get<CoachTimelinePage>(`/coach/messages?${query.toString()}`);
}

// -----------------------------------------------------------------------------
// POST /api/coach/chat/clear (#323)
// -----------------------------------------------------------------------------

/**
 * "Start over": a soft clear. The timeline, the chat history the coach sees
 * and the nudge context then hold only messages after now; nothing is deleted
 * and memories and settings stay. Idempotent; answers 204.
 */
export function clearCoachChat(): Promise<void> {
  return api.post<void>('/coach/chat/clear');
}

/** A message id as the API mints them; the `?m=` deep link is validated against it. */
const COACH_MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCoachMessageId(value: string | null | undefined): value is string {
  return typeof value === 'string' && COACH_MESSAGE_ID_PATTERN.test(value);
}

// -----------------------------------------------------------------------------
// POST /api/coach/messages/:id/opened and /feedback (E7.5)
// -----------------------------------------------------------------------------

export function markCoachMessageOpened(id: string): Promise<void> {
  return api.post<void>(`/coach/messages/${encodeURIComponent(id)}/opened`);
}

export function setCoachMessageFeedback(id: string, feedback: CoachFeedback | null): Promise<void> {
  return api.post<void>(`/coach/messages/${encodeURIComponent(id)}/feedback`, { feedback });
}

// -----------------------------------------------------------------------------
// POST / GET /api/coach/messages/:id/audio — on-demand Listen (#259)
// -----------------------------------------------------------------------------

/**
 * The POST answer. `200 ready`: the message already has audio. `202 pending`:
 * generation started (or was already running); poll `getCoachMessageAudio`.
 */
export type CoachMessageAudioRequest =
  | { status: 'ready'; storageObjectId: string; voice: string }
  | { status: 'pending'; runId: string };

/** The GET answer: the message's audio as it stands (no side effects). */
export interface CoachMessageAudioView {
  status: CoachAudioStatus;
  storageObjectId?: string | null;
  runId?: string | null;
  voice?: string | null;
}

/** Ask for a coach message's audio; generation happens only on this call. */
export function requestCoachMessageAudio(id: string): Promise<CoachMessageAudioRequest> {
  return api.post<CoachMessageAudioRequest>(`/coach/messages/${encodeURIComponent(id)}/audio`);
}

/** Read a coach message's audio status (cheap polling while `pending`). */
export function getCoachMessageAudio(id: string): Promise<CoachMessageAudioView> {
  return api.get<CoachMessageAudioView>(`/coach/messages/${encodeURIComponent(id)}/audio`);
}

export type CoachAudioFailureKind = 'disabled' | 'unavailable' | 'rate_limited' | 'not_found' | 'other';

export interface CoachAudioFailure {
  kind: CoachAudioFailureKind;
  message: string;
}

export const COACH_AUDIO_MESSAGES = {
  creating: 'Creating audio…',
  failed: "Couldn't create audio — try again",
  disabled: 'Spoken messages are turned off',
  unavailable: "Voice isn't set up yet — ask an admin",
  rateLimited: 'Too many requests, try again in a minute',
  notFound: 'This message is no longer available',
} as const;

/** Classify a refused or failed audio request into what the bubble shows. */
export function coachAudioFailureOf(error: unknown): CoachAudioFailure {
  if (error instanceof ApiError) {
    const details = (error.details ?? {}) as { code?: unknown };
    const code = typeof details.code === 'string' ? details.code : error.code;
    if (error.status === 403 || code === COACH_ERRORS.AUDIO_DISABLED) {
      return { kind: 'disabled', message: COACH_AUDIO_MESSAGES.disabled };
    }
    if (error.status === 409) return { kind: 'unavailable', message: COACH_AUDIO_MESSAGES.unavailable };
    if (error.status === 429) return { kind: 'rate_limited', message: COACH_AUDIO_MESSAGES.rateLimited };
    if (error.status === 404) return { kind: 'not_found', message: COACH_AUDIO_MESSAGES.notFound };
  }
  return { kind: 'other', message: COACH_AUDIO_MESSAGES.failed };
}

/** Whether the caller hears coach messages: their own toggle and the deployment's policy. */
export function coachSpeechEnabled(view: CoachSettingsView | null | undefined): boolean {
  return Boolean(view?.settings.audio.enabled && view.policy.allowAudio);
}

// -----------------------------------------------------------------------------
// Kind-specific `data`, read defensively
// -----------------------------------------------------------------------------

export interface CoachChatLink {
  label: string;
  href: string;
}

/** The parts of `data` the page renders; every field optional, junk dropped. */
export interface CoachMessageData {
  links: CoachChatLink[];
  /** A safety reply (`distress`, `symptom`) or the supportive register (`pain`). */
  safety: string | null;
  fallback: boolean;
  /** Weekly review (E7.10): any of these may be absent. */
  headline: string | null;
  adherence: { done: number; planned: number } | null;
  wins: string[];
  focus: string | null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
}

/** Only app-internal links (`/train`), never an absolute or protocol-relative URL. */
export function isInternalHref(href: unknown): href is string {
  return typeof href === 'string' && href.startsWith('/') && !href.startsWith('//');
}

export function coachLinksOf(value: unknown): CoachChatLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((link) => {
    if (typeof link !== 'object' || link === null) return [];
    const { label, href } = link as { label?: unknown; href?: unknown };
    return typeof label === 'string' && label.trim() && isInternalHref(href) ? [{ label, href }] : [];
  });
}

export function coachMessageData(data: unknown): CoachMessageData {
  const d = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const stats = typeof d.stats === 'object' && d.stats !== null ? (d.stats as Record<string, unknown>) : d;
  const adherenceSource = stats.adherence ?? stats.weeklyTarget;
  let adherence: CoachMessageData['adherence'] = null;
  if (typeof adherenceSource === 'object' && adherenceSource !== null) {
    const { done, planned } = adherenceSource as { done?: unknown; planned?: unknown };
    if (typeof done === 'number' && typeof planned === 'number') adherence = { done, planned };
  }
  const focusValue = stats.focus ?? d.focus;
  return {
    links: coachLinksOf(d.links),
    safety: typeof d.safety === 'string' ? d.safety : null,
    fallback: d.fallback === true,
    headline: typeof (stats.headline ?? d.headline) === 'string' ? ((stats.headline ?? d.headline) as string) : null,
    adherence,
    wins: stringList(stats.wins ?? d.wins),
    focus: typeof focusValue === 'string' ? focusValue : Array.isArray(focusValue) ? stringList(focusValue)[0] ?? null : null,
  };
}

// -----------------------------------------------------------------------------
// `data` of a `weekly_review` message (E7.10), version 1
// -----------------------------------------------------------------------------
//
// Mirrors `apps/api/src/coach/review/weekly-review-data.ts` (the contract) and
// `weekly-review-stats.ts`. The card renders this shape only when
// `parseWeeklyReviewData` accepts it; anything else (another version, a
// malformed row) falls back to the defensive `coachMessageData` rendering.

export const WEEKLY_REVIEW_DATA_VERSION = 1;
export const WEEKLY_STREAK_CHANGES = ['advanced', 'pass_used', 'reset', 'held'] as const;
export type WeeklyStreakChange = (typeof WEEKLY_STREAK_CHANGES)[number];

export interface WeeklyReviewPr {
  exercise: string;
  value: number;
  unit: 'kg' | 'reps';
  reps: number | null;
}

export interface WeeklyReviewNextSession {
  date: string;
  weekday: string;
  name: string;
}

/**
 * One active activity goal in the review (#269), as of the week's Sunday.
 * A day goal reads as days hit in the week (`unit: 'days'`, `target` 7).
 */
export interface WeeklyReviewGoal {
  /** The user's own label. */
  title: string;
  metric?: 'sessions' | 'minutes' | 'steps' | 'distance_m';
  period?: 'week' | 'day';
  unit: 'sessions' | 'minutes' | 'steps' | 'meters' | 'days';
  done: number;
  target: number;
  hit: boolean;
  /** Consecutive hit periods, the reviewed one included when hit. */
  streakPeriods: number;
}

export const WEEKLY_REVIEW_GOAL_UNITS = ['sessions', 'minutes', 'steps', 'meters', 'days'] as const;

export interface WeeklyReviewStats {
  isoWeek: string;
  weekStart: string;
  weekEnd: string;
  planned: number;
  completed: number;
  missed: number;
  /** Null when nothing was planned. */
  adherencePct: number | null;
  weeklyStreak: number;
  streakPassesLeft: number;
  streakChange: WeeklyStreakChange;
  prs: WeeklyReviewPr[];
  checkIns: number;
  photosAdded: number;
  nextWeekSessions: number;
  nextWeek: WeeklyReviewNextSession[];
  noPlan: boolean;
  firstWeek: boolean;
  /** Absent on reviews written before activity goals, and when there are none. */
  goals?: WeeklyReviewGoal[];
}

export interface WeeklyReviewProse {
  headline: string;
  intro: string;
  wins: string[];
  focus: string;
  nextWeekPlanPrompt: string;
}

export interface WeeklyReviewData {
  version: typeof WEEKLY_REVIEW_DATA_VERSION;
  isoWeek: string;
  stats: WeeklyReviewStats;
  prose: WeeklyReviewProse;
  register: 'clean' | 'profane' | 'supportive';
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

function parseProse(v: unknown): WeeklyReviewProse | null {
  if (!isRec(v)) return null;
  const { headline, intro, wins, focus, nextWeekPlanPrompt } = v;
  if (!isStr(headline) || !isStr(intro) || !isStr(focus) || !isStr(nextWeekPlanPrompt)) return null;
  if (!Array.isArray(wins) || !wins.every(isStr)) return null;
  return { headline, intro, wins: wins.filter((w) => w.trim() !== ''), focus, nextWeekPlanPrompt };
}

function parsePr(v: unknown): WeeklyReviewPr | null {
  if (!isRec(v)) return null;
  const { exercise, value, unit, reps } = v;
  if (!isStr(exercise) || !isNum(value) || (unit !== 'kg' && unit !== 'reps')) return null;
  if (reps !== null && !isNum(reps)) return null;
  return { exercise, value, unit, reps };
}

function parseNextSession(v: unknown): WeeklyReviewNextSession | null {
  if (!isRec(v) || !isStr(v.date) || !isStr(v.weekday) || !isStr(v.name)) return null;
  return { date: v.date, weekday: v.weekday, name: v.name };
}

function parseGoal(v: unknown): WeeklyReviewGoal | null {
  if (!isRec(v)) return null;
  const { title, metric, period, unit, done, target, hit, streakPeriods } = v;
  if (!isStr(title) || !(WEEKLY_REVIEW_GOAL_UNITS as readonly unknown[]).includes(unit)) return null;
  if (!isNum(done) || !isNum(target) || !isBool(hit) || !isNum(streakPeriods)) return null;
  const goal: WeeklyReviewGoal = { title, unit: unit as WeeklyReviewGoal['unit'], done, target, hit, streakPeriods };
  if (metric === 'sessions' || metric === 'minutes' || metric === 'steps' || metric === 'distance_m') goal.metric = metric;
  if (period === 'week' || period === 'day') goal.period = period;
  return goal;
}

/** `stats.goals`: optional; a malformed row is dropped rather than hiding the whole review. */
function parseGoals(v: unknown): WeeklyReviewGoal[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map(parseGoal).filter((g): g is WeeklyReviewGoal => g !== null);
}

function parseStats(v: unknown): WeeklyReviewStats | null {
  if (!isRec(v)) return null;
  const nums = ['planned', 'completed', 'missed', 'weeklyStreak', 'streakPassesLeft', 'checkIns', 'photosAdded', 'nextWeekSessions'] as const;
  if (!nums.every((k) => isNum(v[k]))) return null;
  if (!isStr(v.isoWeek) || !isStr(v.weekStart) || !isStr(v.weekEnd)) return null;
  if (v.adherencePct !== null && !isNum(v.adherencePct)) return null;
  if (!(WEEKLY_STREAK_CHANGES as readonly unknown[]).includes(v.streakChange)) return null;
  if (!isBool(v.noPlan) || !isBool(v.firstWeek)) return null;
  if (!Array.isArray(v.prs) || !Array.isArray(v.nextWeek)) return null;
  const prs = v.prs.map(parsePr);
  const nextWeek = v.nextWeek.map(parseNextSession);
  if (prs.some((p) => p === null) || nextWeek.some((s) => s === null)) return null;
  const goals = parseGoals(v.goals);
  return {
    ...(goals ? { goals } : {}),
    isoWeek: v.isoWeek,
    weekStart: v.weekStart,
    weekEnd: v.weekEnd,
    planned: v.planned as number,
    completed: v.completed as number,
    missed: v.missed as number,
    adherencePct: v.adherencePct as number | null,
    weeklyStreak: v.weeklyStreak as number,
    streakPassesLeft: v.streakPassesLeft as number,
    streakChange: v.streakChange as WeeklyStreakChange,
    prs: prs as WeeklyReviewPr[],
    checkIns: v.checkIns as number,
    photosAdded: v.photosAdded as number,
    nextWeekSessions: v.nextWeekSessions as number,
    nextWeek: nextWeek as WeeklyReviewNextSession[],
    noPlan: v.noPlan,
    firstWeek: v.firstWeek,
  };
}

/**
 * A light runtime guard over a `weekly_review` message's `data`: the typed
 * version-1 shape, or null (another version, or malformed). Extra keys are
 * ignored; `emailProse` and `fallback` are not needed by the card.
 */
export function parseWeeklyReviewData(data: unknown): WeeklyReviewData | null {
  if (!isRec(data) || data.version !== WEEKLY_REVIEW_DATA_VERSION || !isStr(data.isoWeek)) return null;
  const stats = parseStats(data.stats);
  const prose = parseProse(data.prose);
  if (!stats || !prose) return null;
  const register = data.register === 'profane' || data.register === 'supportive' ? data.register : 'clean';
  return { version: WEEKLY_REVIEW_DATA_VERSION, isoWeek: data.isoWeek, stats, prose, register };
}

/**
 * The reply as display text. Bodies are plain text; the one Markdown construct
 * the chat produces is an app link (`[Adjust today's workout](/train)`), which
 * `done.links` also carries as a button, so the brackets are reduced to the
 * label here. Nothing is ever interpreted as HTML (React escapes it).
 */
export function coachDisplayText(body: string): string {
  return body.replace(/\[([^\]\n]+)\]\((\/[^)\s]*)\)/g, '$1');
}

// -----------------------------------------------------------------------------
// POST /api/coach/chat/stream
// -----------------------------------------------------------------------------

/** Mirrors `COACH_CHAT_TEXT_MAX`. */
export const COACH_CHAT_TEXT_MAX = 2000;

/** The composer's quick replies (spec §2.13), sent as typed text. */
export const COACH_QUICK_REPLIES = [
  'Motivate me',
  'I missed — now what?',
  'Adjust this week',
  "I'm sick",
  'How am I doing?',
] as const;

export type CoachSafetyLevel = 'blocked' | 'conservative';

export interface CoachChatDone {
  messageId: string;
  userMessageId: string;
  links: CoachChatLink[];
  pausedUntil: string | null;
  fallback: boolean;
}

export interface CoachChatHandlers {
  onSafety?: (frame: { level: CoachSafetyLevel; screen: string }) => void;
  onTool?: (frame: { name: string; status: string }) => void;
  onDelta?: (text: string) => void;
  onDone?: (frame: CoachChatDone) => void;
  /**
   * A failure AFTER streaming began (an `error` frame). `userMessageId` is the
   * user's stored turn when the server stored it before failing (a retry then
   * sends `retryOf` instead of storing the text again), `null` when it did not.
   */
  onError?: (frame: CoachChatErrorFrame) => void;
  /**
   * The turn changed what the coach remembers (#325): a `memory` frame. A
   * frame without a usable `op` or `memoryId` is ignored.
   */
  onMemory?: (frame: CoachChatMemoryFrame) => void;
  /** Any frame at all (including unknown events): the stream did start. */
  onAnyFrame?: (event: string) => void;
}

export type CoachChatMemoryOp = 'added' | 'updated' | 'deleted';

/** A `memory` frame on the chat stream (#325). */
export interface CoachChatMemoryFrame {
  op: CoachChatMemoryOp;
  memoryId: string;
  content: string;
}

/** The frame's data as a `CoachChatMemoryFrame`, or null when malformed. */
export function parseCoachMemoryFrame(data: Record<string, unknown>): CoachChatMemoryFrame | null {
  const op = data.op;
  if (op !== 'added' && op !== 'updated' && op !== 'deleted') return null;
  if (typeof data.memoryId !== 'string' || data.memoryId === '') return null;
  return { op, memoryId: data.memoryId, content: typeof data.content === 'string' ? data.content : '' };
}

export interface CoachChatErrorFrame {
  code: string;
  message: string;
  userMessageId: string | null;
}

export interface CoachChatStreamOptions {
  /**
   * Answer this already-stored user message again instead of storing a new
   * user row. The `text` sent must equal the stored text.
   */
  retryOf?: string | null;
}

export function coachChatStreamUrl(): string {
  return `${API_BASE_URL}/coach/chat/stream`;
}

/**
 * One chat turn. Resolves when the stream ends (or is aborted); REJECTS with
 * `ApiError` when a precondition refused it before the first byte
 * (`COACH_DISABLED`, `AI_FEATURE_UNAVAILABLE`, `429`): nothing was stored then.
 */
export async function streamCoachChat(
  text: string,
  handlers: CoachChatHandlers,
  signal?: AbortSignal,
  options: CoachChatStreamOptions = {},
): Promise<void> {
  await postSse<Record<string, unknown>>({
    url: coachChatStreamUrl(),
    body: options.retryOf ? { text, retryOf: options.retryOf } : { text },
    authorization: () => {
      const token = api.getAccessToken();
      return token ? `Bearer ${token}` : null;
    },
    reauthenticate: () => api.refreshToken(),
    signal,
    onFrame: (event, raw) => {
      const data = typeof raw === 'object' && raw !== null ? raw : {};
      handlers.onAnyFrame?.(event);
      switch (event) {
        case 'safety':
          handlers.onSafety?.({
            level: data.level === 'blocked' ? 'blocked' : 'conservative',
            screen: typeof data.screen === 'string' ? data.screen : 'pain',
          });
          break;
        case 'tool':
          handlers.onTool?.({
            name: typeof data.name === 'string' ? data.name : 'tool',
            status: typeof data.status === 'string' ? data.status : '',
          });
          break;
        case 'delta':
          if (typeof data.text === 'string') handlers.onDelta?.(data.text);
          break;
        case 'done':
          handlers.onDone?.({
            messageId: typeof data.messageId === 'string' ? data.messageId : '',
            userMessageId: typeof data.userMessageId === 'string' ? data.userMessageId : '',
            links: coachLinksOf(data.links),
            pausedUntil: typeof data.pausedUntil === 'string' ? data.pausedUntil : null,
            fallback: data.fallback === true,
          });
          break;
        case 'memory': {
          const frame = parseCoachMemoryFrame(data);
          if (frame) handlers.onMemory?.(frame);
          break;
        }
        case 'error':
          handlers.onError?.({
            code: typeof data.code === 'string' ? data.code : 'ERROR',
            message: typeof data.message === 'string' ? data.message : 'The coach could not reply.',
            userMessageId: typeof data.userMessageId === 'string' && data.userMessageId ? data.userMessageId : null,
          });
          break;
        default:
          break;
      }
    },
  });
}

/** Friendly labels for the chat's tools (`tool` frames carry only the name). */
export const COACH_TOOL_LABELS: Record<string, string> = {
  get_training_signals: 'Checking your training',
  get_today_plan: "Looking at today's plan",
  get_recent_workouts: 'Reviewing recent workouts',
  get_check_ins: 'Reading your check-ins',
  get_progress_photo_summary: 'Checking progress photos',
  get_last_weekly_review: 'Reading your last weekly review',
  pause_coach: 'Pausing the coach',
};

export function coachToolLabel(name: string): string {
  return COACH_TOOL_LABELS[name] ?? 'Working on it';
}

export type CoachChatFailureKind = 'disabled' | 'unavailable' | 'rate_limited' | 'offline' | 'other';

export interface CoachChatFailure {
  kind: CoachChatFailureKind;
  message: string;
}

/** Classify a chat refusal or failure into what the page shows. */
export function coachChatFailureOf(error: unknown): CoachChatFailure {
  if (error instanceof ApiError) {
    const details = (error.details ?? {}) as { code?: unknown; reason?: unknown };
    if (details.code === COACH_ERRORS.DISABLED || error.code === COACH_ERRORS.DISABLED) {
      return { kind: 'disabled', message: 'The coach is switched off. Turn it on in your coach settings to chat.' };
    }
    if (error.status === 409 || details.reason === 'AI_FEATURE_UNAVAILABLE') {
      return {
        kind: 'unavailable',
        message: 'Coach chat is not available right now: no AI model is set up for it. Ask your administrator.',
      };
    }
    if (error.status === 429) {
      return { kind: 'rate_limited', message: "You've reached the chat limit for now. Try again later." };
    }
    return { kind: 'other', message: error.message || 'The coach could not reply. Try again.' };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { kind: 'offline', message: 'You are offline. Reconnect to chat with your coach.' };
  }
  return { kind: 'other', message: 'The coach could not reply. Try again.' };
}
