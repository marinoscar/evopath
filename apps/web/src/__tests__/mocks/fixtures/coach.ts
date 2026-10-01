/**
 * AI Coach fixtures (E7.3, #243): `GET /api/coach/personas`,
 * `GET /api/coach/settings` and `GET /api/admin/coach/settings`, shaped like
 * the API's DTOs (`apps/api/src/coach/dto/`).
 */
import {
  COACH_MOMENTS,
  type CoachPersonaCard,
  type CoachSettingsView,
  type CoachStateView,
  type CoachTimelineItem,
  type SystemCoachSettings,
} from '../../../services/coach';

function lines(text: (level: number) => string): CoachPersonaCard['sampleLines'] {
  return Object.fromEntries(
    COACH_MOMENTS.map((moment) => [moment, { 1: text(1), 2: text(2), 3: text(3) }]),
  ) as CoachPersonaCard['sampleLines'];
}

export const UNCENSORED_SARGE_LINE = 'Get off your ass, recruit.';

export function mockCoachPersona(overrides: Partial<CoachPersonaCard> = {}): CoachPersonaCard {
  return {
    id: 'coach',
    name: 'Coach',
    tagline: 'Warm, specific, celebrates small wins.',
    vibe: 'Warm, specific, celebrates small wins',
    avatar: 'whistle',
    style: 'Specific over generic.',
    intensities: [
      { level: 1, label: 'Gentle', voice: 'coral', profane: false },
      { level: 2, label: 'Steady', voice: 'coral', profane: false },
      { level: 3, label: 'Firm', voice: 'coral', profane: false },
    ],
    sampleLines: lines(() => "You're one session from a {streak}-week streak."),
    censored: false,
    ...overrides,
  };
}

/** Sarge. `censored` (the default) serves the level-2 line at level 3, as the API does. */
export function mockSargePersona(censored = true): CoachPersonaCard {
  return mockCoachPersona({
    id: 'drill_sergeant',
    name: 'Sarge',
    tagline: 'Military cadence, no excuses.',
    vibe: 'Military cadence, no excuses',
    avatar: 'military_tech',
    style: 'Short imperative sentences.',
    intensities: [
      { level: 1, label: 'Tough', voice: 'onyx', profane: false },
      { level: 2, label: 'Brutal', voice: 'onyx', profane: false },
      { level: 3, label: 'Unhinged', voice: 'ash', profane: true },
    ],
    sampleLines: lines((level) =>
      level === 1
        ? 'Recruit. Be at the bar tonight.'
        : level === 2 || censored
          ? 'Reasons do not lift anything, recruit.'
          : UNCENSORED_SARGE_LINE,
    ),
    censored,
  });
}

export function mockCoachPersonas(censored = true): CoachPersonaCard[] {
  return [
    mockCoachPersona(),
    mockSargePersona(censored),
    mockCoachPersona({
      id: 'stoic',
      name: 'The Stoic',
      tagline: 'Calm. The obstacle is the way.',
      vibe: 'Calm, the obstacle is the way',
      avatar: 'account_balance',
      intensities: [
        { level: 1, label: 'Quiet', voice: 'sage', profane: false },
        { level: 2, label: 'Direct', voice: 'sage', profane: false },
        { level: 3, label: 'Severe', voice: 'sage', profane: false },
      ],
      sampleLines: lines(() => 'The session is gone. The next hour is still yours.'),
    }),
  ];
}

type ViewOverrides = {
  settings?: Partial<CoachSettingsView['settings']>;
  effective?: Partial<CoachSettingsView['effective']>;
  policy?: Partial<CoachSettingsView['policy']>;
};

export function mockCoachSettingsView(overrides: ViewOverrides = {}): CoachSettingsView {
  return {
    settings: {
      enabled: true,
      personaId: 'coach',
      intensity: 2,
      profanity: false,
      adultConfirmedAt: null,
      audio: { enabled: false, voice: null, speed: 1 },
      quietHours: { start: '21:30', end: '07:30' },
      maxNudgesPerDay: 2,
      lockScreenSafe: true,
      photoCadence: 'biweekly',
      why: null,
      preferredTime: null,
      ...overrides.settings,
    },
    effective: {
      maxNudgesPerDay: 2,
      register: { profane: false, reason: 'age_unverified' },
      intensity: 2,
      voice: 'coral',
      ...overrides.effective,
    },
    policy: {
      enabled: true,
      allowProfanePersonas: true,
      allowAudio: true,
      maxNudgesPerDayCeiling: 4,
      ...overrides.policy,
    },
  };
}

export const mockSystemCoachSettings: SystemCoachSettings = {
  enabled: true,
  allowProfanePersonas: false,
  allowAudio: true,
  maxNudgesPerDayCeiling: 4,
  audioRetentionDays: 30,
  autoSilenceAfterIgnored: 3,
  inactiveStopDays: 7,
};

// -----------------------------------------------------------------------------
// The /coach page (E7.8, #248): `GET /api/coach/state`, `GET /api/coach/messages`
// and the chat stream's SSE body.
// -----------------------------------------------------------------------------

export function mockCoachState(overrides: Partial<CoachStateView> = {}): CoachStateView {
  return {
    enabled: true,
    pausedUntil: null,
    silencedAt: null,
    weeklyTarget: { done: 2, planned: 3 },
    weeklyStreak: 4,
    streakPassesLeft: 1,
    nextSession: { date: '2026-10-02', name: 'Upper body A', programWorkoutId: '00000000-0000-4000-8000-0000000000aa' },
    unreadCount: 1,
    ...overrides,
  };
}

/** A UUID-shaped message id from a small integer (the deep link validates the shape). */
export function coachMessageId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function mockCoachMessage(overrides: Partial<CoachTimelineItem> = {}): CoachTimelineItem {
  return {
    id: coachMessageId(1),
    role: 'coach',
    kind: 'nudge',
    moment: 'missed_session',
    personaId: 'coach',
    intensity: 2,
    title: 'Missed yesterday',
    body: 'No stress. Ten minutes today keeps the habit alive.',
    audioStatus: 'none',
    audioStorageObjectId: null,
    voice: null,
    feedback: null,
    openedAt: '2026-09-29T10:00:00.000Z',
    data: null,
    createdAt: '2026-09-29T09:00:00.000Z',
    ...overrides,
  };
}

/** One SSE frame per entry, `event: <type>` with the JSON payload. */
export function coachSseBody(frames: Array<[string, unknown]>): string {
  return frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

export const mockCoachChatFrames: Array<[string, unknown]> = [
  ['tool', { name: 'get_training_signals', status: 'ok' }],
  ['delta', { text: 'You are doing great. ' }],
  ['delta', { text: 'Keep the streak going.' }],
  [
    'done',
    {
      messageId: coachMessageId(901),
      userMessageId: coachMessageId(900),
      links: [],
      pausedUntil: null,
      fallback: false,
    },
  ],
];
