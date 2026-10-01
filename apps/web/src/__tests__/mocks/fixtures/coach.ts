/**
 * AI Coach fixtures (E7.3, #243): `GET /api/coach/personas`,
 * `GET /api/coach/settings` and `GET /api/admin/coach/settings`, shaped like
 * the API's DTOs (`apps/api/src/coach/dto/`).
 */
import {
  COACH_MOMENTS,
  type CoachMessageAudioRequest,
  type CoachMessageAudioView,
  type CoachPersonaCard,
  type CoachSettingsView,
  type CoachStats,
  type CoachStateView,
  type CoachTimelineItem,
  type SystemCoachSettings,
  type WeeklyReviewData,
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

/** `GET /api/admin/coach/stats` with nothing sent (E7.11): the panel's empty state. */
export const mockEmptyCoachStats: CoachStats = {
  range: { from: '2026-09-02', to: '2026-10-01', days: 30 },
  totals: { sent: 0, opened: 0, convertible: 0, converted: 0, up: 0, down: 0, openRate: null, convertRate: null },
  byAngle: [],
  byPersona: [],
  byMoment: [],
  kpis: {
    nudgeOpenRate: null,
    conversionRate: null,
    weeklyActiveUsers: 0,
    chatSessionsPerWau: null,
    photoCadenceAdherencePct: null,
    weeklyAdherencePct: null,
    optedOut: 0,
    enabled: 0,
    optOutRate: null,
  },
};

/** `GET /api/admin/coach/stats` with traffic (E7.11). */
export const mockCoachStats: CoachStats = {
  range: { from: '2026-09-02', to: '2026-10-01', days: 30 },
  totals: { sent: 40, opened: 24, convertible: 30, converted: 9, up: 5, down: 1, openRate: 0.6, convertRate: 0.3 },
  byAngle: [
    { key: 'identity', sent: 25, opened: 15, convertible: 20, converted: 7, up: 4, down: 0, openRate: 0.6, convertRate: 0.35 },
    { key: 'challenge', sent: 15, opened: 9, convertible: 10, converted: 2, up: 1, down: 1, openRate: 0.6, convertRate: 0.2 },
  ],
  byPersona: [
    { key: 'drill_sergeant', sent: 30, opened: 18, convertible: 22, converted: 7, up: 4, down: 1, openRate: 0.6, convertRate: 0.3182 },
    { key: 'analyst', sent: 10, opened: 6, convertible: 8, converted: 2, up: 1, down: 0, openRate: 0.6, convertRate: 0.25 },
  ],
  byMoment: [
    { key: 'missed_twice', sent: 30, opened: 18, convertible: 30, converted: 9, up: 4, down: 1, openRate: 0.6, convertRate: 0.3 },
    { key: 'pr', sent: 10, opened: 6, convertible: 0, converted: 0, up: 1, down: 0, openRate: 0.6, convertRate: null },
  ],
  kpis: {
    nudgeOpenRate: 0.6,
    conversionRate: 0.3,
    weeklyActiveUsers: 12,
    chatSessionsPerWau: 1.5,
    photoCadenceAdherencePct: 50,
    weeklyAdherencePct: null,
    optedOut: 2,
    enabled: 18,
    optOutRate: 0.1,
  },
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

/** On-demand Listen (#259): the storage object the default handlers report ready. */
export const COACH_AUDIO_OBJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const COACH_AUDIO_RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** `POST /api/coach/messages/:id/audio` → 202: generation started. */
export function mockCoachAudioPending(): CoachMessageAudioRequest {
  return { status: 'pending', runId: COACH_AUDIO_RUN_ID };
}

/** `POST` → 200 or `GET /api/coach/messages/:id/audio` once the audio exists. */
export function mockCoachAudioReady(storageObjectId = COACH_AUDIO_OBJECT_ID, voice = 'coral') {
  return { status: 'ready' as const, storageObjectId, voice } satisfies CoachMessageAudioRequest & CoachMessageAudioView;
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

/**
 * A turn the server stored and then failed to answer: the `error` frame names
 * the stored user row, so a retry sends `retryOf` (never a second user row).
 */
export const mockCoachChatStoredErrorFrames: Array<[string, unknown]> = [
  ['delta', { text: 'You are doing' }],
  ['error', { code: 'AI_PROVIDER_ERROR', message: 'The provider failed.', userMessageId: coachMessageId(900) }],
];

/** A failure before the user's turn was stored: a retry re-sends the text. */
export const mockCoachChatUnstoredErrorFrames: Array<[string, unknown]> = [
  ['error', { code: 'AI_PROVIDER_ERROR', message: 'The provider failed.', userMessageId: null }],
];

// -----------------------------------------------------------------------------
// A weekly review (E7.10): `CoachMessage.data` version 1, as
// `apps/api/src/coach/review/weekly-review-data.ts` stores it.
// -----------------------------------------------------------------------------

export const WEEKLY_REVIEW_PLAN_PROMPT =
  'Plan my week: four sessions, Monday, Tuesday, Thursday and Saturday, about 45 minutes each.';

type WeeklyReviewOverrides = {
  stats?: Partial<WeeklyReviewData['stats']>;
  prose?: Partial<WeeklyReviewData['prose']>;
};

/** The full stored `data` (including `emailProse` and `fallback`, which the card ignores). */
export function mockWeeklyReviewData(overrides: WeeklyReviewOverrides = {}) {
  const prose = {
    headline: 'Three of four, and a squat PR',
    intro: 'Strong week. You showed up three times and the squat moved.',
    wins: ['Back squat PR at 120 kg', 'Three check-ins logged'],
    focus: 'Protect Thursday: it is the session that slipped.',
    nextWeekPlanPrompt: WEEKLY_REVIEW_PLAN_PROMPT,
    ...overrides.prose,
  };
  return {
    version: 1 as const,
    isoWeek: '2026-W40',
    stats: {
      isoWeek: '2026-W40',
      weekStart: '2026-09-28',
      weekEnd: '2026-10-04',
      planned: 4,
      completed: 3,
      missed: 1,
      adherencePct: 75,
      weeklyStreak: 5,
      streakPassesLeft: 1,
      streakChange: 'advanced' as const,
      prs: [
        { exercise: 'Back squat', value: 120, unit: 'kg' as const, reps: 5 },
        { exercise: 'Pull-up', value: 12, unit: 'reps' as const, reps: null },
      ],
      checkIns: 3,
      photosAdded: 1,
      nextWeekSessions: 4,
      nextWeek: [
        { date: '2026-10-05', weekday: 'Mon', name: 'Upper body A' },
        { date: '2026-10-06', weekday: 'Tue', name: 'Lower body A' },
        { date: '2026-10-08', weekday: 'Thu', name: 'Upper body B' },
        { date: '2026-10-10', weekday: 'Sat', name: 'Lower body B' },
      ],
      noPlan: false,
      firstWeek: false,
      ...overrides.stats,
    },
    prose,
    emailProse: { ...prose },
    register: 'clean' as const,
    fallback: { app: false, email: false },
  };
}

/** A `weekly_review` timeline row: `title` = headline, `body` = intro. */
export function mockWeeklyReviewMessage(
  overrides: WeeklyReviewOverrides & { message?: Partial<CoachTimelineItem> } = {},
): CoachTimelineItem {
  const data = mockWeeklyReviewData(overrides);
  return mockCoachMessage({
    id: coachMessageId(40),
    kind: 'weekly_review',
    moment: 'weekly_review',
    title: data.prose.headline,
    body: data.prose.intro,
    data,
    createdAt: '2026-10-04T17:00:00.000Z',
    ...overrides.message,
  });
}
