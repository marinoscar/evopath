import { createCoachChatTools, type CoachChatToolDeps } from '../../src/coach/chat/tools';
import {
  COACH_CHAT_TOOL_LIFTED,
  COACH_CHAT_TOOL_NEVER_SEND,
  COACH_NEVER_SEND,
  COACH_NEVER_SEND_IDS,
} from '../../src/coach/context/coach-never-send';
import { NEVER_SEND } from '../../src/training-agents/context/never-send';
import { NOW, PAYLOAD, nudgeSignals, setupNudge } from './coach-nudge.fixtures';

// =============================================================================
// The coach's never-send canary (E7.5, #245; spec §2.6, AC 6)
// =============================================================================
//
// One canary per never-send entry, seeded in the source the nudge job could
// plausibly read it from. Two kinds of proof:
//
//   SEEDED   the canary sits in a row or a signals field the job DOES read;
//            it must appear in no model request.
//   UNREAD   the source is a table the job must never touch at all; the
//            recorded Prisma access proves it was not read.
//
// Every id of `COACH_NEVER_SEND` has exactly one row below, so a new entry
// without a canary fails the coverage case. The weekly review (E7.10) and the
// chat (E7.7) extend this file with their own requests.
// =============================================================================

const C = {
  name: 'CANARY-NAME-Zq81',
  email: 'canary-email-Zq82@example.com',
  dob: new Date('1980-02-03T00:00:00Z'),
  painNote: 'CANARY-PAIN-NOTE-Zq83',
  bodyWeight: 913.77,
  bodyFat: 47.71,
  programWorkoutId: '00000000-0000-4000-8000-00000000c0de',
  exerciseId: '00000000-0000-4000-8000-00000000c0df',
  priorBody: 'CANARY-PRIOR-BODY-Zq84',
  audioObject: '00000000-0000-4000-8000-00000000c0e0',
  photoNote: 'CANARY-PHOTO-NOTE-Zq85',
  storageKey: 'ai-outputs/CANARY-KEY-Zq86',
};

/** never-send id -> how it is proven. */
const PROOF: Record<string, { seeded?: string[]; unread?: string[] }> = {
  name: { seeded: [C.name] },
  email: { seeded: [C.email] },
  date_of_birth: { seeded: ['1980-02-03', '1980'] },
  exact_age: { seeded: ['46 years'] },
  check_in_notes: { unread: ['checkIn'] },
  pain_notes: { seeded: [C.painNote], unread: ['workoutSet'] },
  other_free_text: { unread: ['workout', 'measurement'] },
  medications: { unread: ['medication'] },
  labs: { unread: ['labResult', 'measurement', 'healthSummary'] },
  documents_photos: { unread: ['healthDocument', 'storageObject'] },
  storage: { seeded: [C.storageKey, C.audioObject], unread: ['storageObject'] },
  other_gyms: { unread: ['gym'] },
  gym_name: { unread: ['gym'] },
  other_users: { unread: ['user'] },
  ids: { seeded: [C.programWorkoutId, C.exerciseId] },
  progress_photos: { seeded: [C.photoNote], unread: ['progressPhoto'] },
  coach_audio: { seeded: [C.audioObject] },
  body_measurements: { seeded: ['913.77', '47.71'] },
  coach_message_bodies: { seeded: [C.priorBody] },
};

describe('coach never-send canary (ai.coach.nudge)', () => {
  it('COACH_NEVER_SEND extends the training agents\' list', () => {
    for (const entry of NEVER_SEND) expect(COACH_NEVER_SEND_IDS).toContain(entry.id);
    expect(COACH_NEVER_SEND_IDS).toEqual(expect.arrayContaining(['progress_photos', 'coach_audio']));
  });

  it('every never-send entry has a canary proof', () => {
    expect(Object.keys(PROOF).sort()).toEqual([...COACH_NEVER_SEND_IDS].sort());
    for (const entry of COACH_NEVER_SEND) {
      const proof = PROOF[entry.id];
      expect((proof.seeded?.length ?? 0) + (proof.unread?.length ?? 0)).toBeGreaterThan(0);
    }
  });

  it('no canary reaches the model request, and no forbidden table is read', async () => {
    const signals = nudgeSignals({
      body: { weightKg: { latest: C.bodyWeight, changePerWeek: -0.4, points: 5 }, bodyFatPct: { latest: C.bodyFat, points: 2 } },
      pain: [
        {
          exerciseId: C.exerciseId,
          slug: 'squat',
          name: 'Squat',
          lastFlaggedOn: '2026-09-30',
          flaggedSessions28d: 1,
          consecutiveFlaggedSessions: 1,
        },
      ],
    });
    signals.sessions[0].programWorkoutId = C.programWorkoutId;
    (signals.pain[0] as Record<string, unknown>).note = C.painNote;

    const t = setupNudge({
      signals,
      dob: C.dob,
      userExtras: { name: C.name, email: C.email, progressPhotos: [{ note: C.photoNote, storageKey: C.storageKey }] },
      historyExtras: { body: C.priorBody, audioStorageObjectId: C.audioObject, data: { storageKey: C.storageKey } },
    });
    await t.handler.run('job-canary', PAYLOAD, NOW);

    expect(t.respondStructured).toHaveBeenCalled();
    const requests = t.respondStructured.mock.calls.map((call) => JSON.stringify(call[0]));
    const leaks: string[] = [];
    for (const [id, proof] of Object.entries(PROOF)) {
      for (const canary of proof.seeded ?? []) {
        if (requests.some((r) => r.includes(canary))) leaks.push(`${id}: ${canary}`);
      }
      for (const model of proof.unread ?? []) {
        if (t.accessedModels.has(model)) leaks.push(`${id}: read prisma.${model}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('the user-curated memory block (#325) is the one allowed addition: it rides in, nothing else does', async () => {
    const memory = 'MEMORY-ALLOWED-Zq90 User prefers to be called Bobby.';
    const t = setupNudge({
      dob: C.dob,
      userExtras: { name: C.name, email: C.email },
      historyExtras: { body: C.priorBody },
      memoryBlock: `<user_memories>\nUser-provided notes.\n- (preference) ${memory}\n</user_memories>`,
    });
    await t.handler.run('job-canary', PAYLOAD, NOW);

    const requests = t.respondStructured.mock.calls.map((call) => JSON.stringify(call[0]));
    expect(requests.some((r) => r.includes(memory))).toBe(true);
    for (const canary of [C.name, C.email, '1980-02-03', C.priorBody]) {
      expect(requests.some((r) => r.includes(canary))).toBe(false);
    }
    // The block is read through the memory service only: no memory table access from the job itself.
    expect(t.accessedModels.has('userMemory')).toBe(false);
  });
});

// =============================================================================
// The coach chat's READ TOOLS (#338): all relevant data, no secrets
// =============================================================================
//
// Every read tool runs against sources seeded with the user's own free text
// (which must now arrive) and with secrets next to it in the same rows (which
// must never arrive): the email, the date of birth, storage keys and URLs,
// device and provider ids, photo notes, gym locations and notes, lab notes,
// another user's rows (filtered by `userId` in every query).
// =============================================================================

const SECRET = {
  email: 'secret-email-Zq91@example.com',
  dob: '1984-07-13',
  storageKey: 'uploads/SECRET-KEY-Zq92.jpg',
  url: 'https://storage.example/SECRET-URL-Zq93',
  device: '9c0ffee0-0000-4000-8000-00000000d0e1',
  externalId: 'SECRET-EXTERNAL-Zq94',
  photoNote: 'SECRET-PHOTO-NOTE-Zq95',
  gymNote: 'SECRET-GYM-NOTE-Zq96',
  latitude: 9.93333,
  labNote: 'SECRET-LAB-NOTE-Zq97',
  otherUser: 'SECRET-OTHER-USER-Zq98',
};

const FREE = {
  workoutNote: 'FREE-WORKOUT-NOTE-Zq01',
  setNote: 'FREE-SET-NOTE-Zq02',
  painNote: 'FREE-PAIN-NOTE-Zq03',
  exerciseNote: 'FREE-EXERCISE-NOTE-Zq04',
  gymName: 'FREE-GYM-NAME-Zq05',
  checkInNote: 'FREE-CHECKIN-NOTE-Zq06',
  activityNote: 'FREE-ACTIVITY-NOTE-Zq07',
  bio: 'FREE-BIO-Zq08',
  goalText: 'FREE-GOAL-TEXT-Zq09',
  rationale: 'FREE-RATIONALE-Zq10',
  why: 'FREE-WHY-Zq11',
};

const CHAT_USER = '11111111-1111-4111-8111-111111111111';
const CHAT_NOW = new Date('2026-10-01T18:00:00.000Z');
const WORKOUT_ID = '0a000000-0000-4000-8000-0000000000a1';
const BENCH = '0e000000-0000-4000-8000-0000000000b1';

function chatDeps() {
  const gym = { name: FREE.gymName, notes: SECRET.gymNote, latitude: SECRET.latitude, longitude: SECRET.latitude };
  const workout = {
    id: WORKOUT_ID,
    userId: CHAT_USER,
    name: 'Upper A',
    date: new Date('2026-09-29T00:00:00.000Z'),
    status: 'completed',
    startedAt: new Date('2026-09-29T12:00:00.000Z'),
    endedAt: new Date('2026-09-29T13:00:00.000Z'),
    durationSeconds: 3600,
    notes: FREE.workoutNote,
    readinessSnapshot: { note: SECRET.otherUser },
    photos: [{ storageKey: SECRET.storageKey, url: SECRET.url, note: SECRET.photoNote }],
    gym,
    programWorkout: null,
    programSession: null,
    exercises: [
      {
        id: 'we1',
        exerciseId: BENCH,
        position: 0,
        notes: FREE.exerciseNote,
        exercise: { name: 'Bench press', trackingMode: 'weight_reps' },
        sets: [
          {
            id: 's1',
            setNumber: 1,
            weightKg: 100,
            reps: 5,
            durationSeconds: null,
            distanceMeters: null,
            rpe: 8,
            rir: 2,
            restSeconds: 120,
            isWarmup: false,
            completed: true,
            painFlag: true,
            painNote: FREE.painNote,
            notes: FREE.setNote,
          },
        ],
      },
    ],
  };
  const intake = {
    goal: { type: 'strength', description: FREE.goalText },
    experience: 'intermediate',
    daysPerWeek: 3,
    minutesPerSession: 60,
  };
  const program = {
    id: '0d000000-0000-4000-8000-0000000000d1',
    name: 'Strong 8',
    goal: 'strength',
    intake,
    status: 'active',
    source: 'ai',
    autonomy: 'autonomous',
    startDate: new Date('2026-09-21T00:00:00.000Z'),
    rationale: FREE.rationale,
    notes: null,
    currentVersion: 1,
    gym,
  };
  return {
    prisma: {
      user: { findUnique: jest.fn().mockResolvedValue({ displayName: 'Oscar', providerDisplayName: null, email: SECRET.email }) },
      workout: { findMany: jest.fn().mockResolvedValue([workout]), findFirst: jest.fn().mockResolvedValue(workout) },
      workoutExercise: { groupBy: jest.fn().mockResolvedValue([]) },
      exercise: {
        findMany: jest.fn().mockResolvedValue([{ id: BENCH, name: 'Bench press', slug: 'bench-press', trackingMode: 'weight_reps', aliases: [] }]),
      },
      program: { findFirst: jest.fn().mockResolvedValue(program) },
      programBlock: { findMany: jest.fn().mockResolvedValue([]) },
      programWeek: { findMany: jest.fn().mockResolvedValue([]), aggregate: jest.fn().mockResolvedValue({ _max: { weekNumber: 8 } }) },
      programWorkout: { findMany: jest.fn().mockResolvedValue([]) },
      programExercise: { findMany: jest.fn().mockResolvedValue([]) },
      gym: { findFirst: jest.fn().mockResolvedValue(gym) },
      activityEntry: {
        findMany: jest.fn().mockResolvedValue([
          {
            occurredOn: new Date('2026-09-30T00:00:00.000Z'),
            occurredAt: null,
            activityKind: 'walk',
            completed: true,
            durationSeconds: 1800,
            steps: 4000,
            distanceMeters: 2500,
            source: 'integration',
            provider: `health_connect:${SECRET.device}`,
            externalId: SECRET.externalId,
            healthSyncDeviceId: SECRET.device,
            note: FREE.activityNote,
            workoutId: null,
          },
        ]),
      },
      measurement: {
        findMany: jest.fn().mockResolvedValue([
          {
            metricKey: 'weight',
            value: 92,
            unit: 'kg',
            measuredAt: new Date('2026-09-30T07:00:00.000Z'),
            localDate: null,
            notes: SECRET.labNote,
            sourceRef: { storageKey: SECRET.storageKey },
            externalId: SECRET.externalId,
            healthSyncDeviceId: SECRET.device,
          },
        ]),
      },
      sleepSession: { findMany: jest.fn().mockResolvedValue([]) },
      coachState: { findUnique: jest.fn().mockResolvedValue({ pausedUntil: null, weeklyStreak: 1 }), upsert: jest.fn() },
      coachMessage: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    signals: { forUser: jest.fn().mockRejectedValue(new Error('not under test')) },
    today: { today: jest.fn().mockResolvedValue({ kind: 'no_program', date: '2026-10-01' }) },
    checkIns: {
      today: jest.fn().mockResolvedValue('2026-10-01'),
      list: jest.fn().mockResolvedValue({
        items: [{ date: '2026-10-01', energy: 4, sleepQuality: 3, soreness: 2, stress: 1, note: FREE.checkInNote, updatedAt: '' }],
      }),
    },
    photos: {
      summarize: jest.fn().mockResolvedValue({ count: 1, lastLocalDate: '2026-09-20', byPose: {}, storageKey: SECRET.storageKey, note: SECRET.photoNote }),
    },
    now: () => CHAT_NOW,
    goals: { progressForUser: jest.fn().mockResolvedValue([]) },
    profile: {
      healthProfile: {
        get: jest.fn().mockResolvedValue({
          dateOfBirth: SECRET.dob,
          sexAtBirth: 'male',
          heightMm: 1800,
          unitSystem: 'metric',
          timeZone: 'America/Costa_Rica',
          bio: FREE.bio,
        }),
      },
      userSettings: {
        getSettings: jest.fn().mockResolvedValue({ coach: { why: FREE.why }, profile: { email: SECRET.email } }),
        patchSettings: jest.fn(),
      },
    },
    history: {
      priorBuckets: jest.fn().mockResolvedValue(new Map()),
      prsForWorkout: jest.fn().mockResolvedValue(new Map()),
      history: jest.fn().mockResolvedValue({
        records: { maxWeightKg: null, maxReps: null, bestE1rmKg: null },
        lastTime: { gym: { id: '0f000000-0000-4000-8000-0000000000f1', name: FREE.gymName } },
      }),
    },
  };
}

/** Arguments for each read tool (strict schemas: every field present). */
const READ_TOOL_ARGS: Record<string, unknown> = {
  get_training_signals: {},
  get_today_plan: {},
  get_recent_workouts: {},
  get_check_ins: {},
  get_progress_photo_summary: {},
  get_last_weekly_review: {},
  get_goals: {},
  get_profile: {},
  get_training_profile: {},
  get_health_summary: {},
  list_biomarkers: {},
  get_biomarker_values: { keys: ['ldl_cholesterol'], sinceDays: null },
  get_sleep: {},
  get_now: {},
  get_about_me: {},
  get_workout_history: { from: null, to: null, limit: null },
  get_workout: { workoutId: WORKOUT_ID },
  get_plan_week: { weekNumber: null },
  get_exercise_history: { exercise: 'Bench press', limit: null },
  get_activity: { from: null, to: null },
};

describe('coach never-send canary (coach chat read tools, #338)', () => {
  it('lifts only documented entries, and every lifted id is a real never-send id', () => {
    for (const id of Object.keys(COACH_CHAT_TOOL_LIFTED)) expect(COACH_NEVER_SEND_IDS).toContain(id);
    const still = COACH_CHAT_TOOL_NEVER_SEND.map((entry) => entry.id).sort();
    expect(still).toEqual(
      ['coach_audio', 'coach_message_bodies', 'date_of_birth', 'documents_photos', 'email', 'labs', 'medications', 'other_users', 'progress_photos', 'storage'].sort(),
    );
  });

  it('every read tool is covered here', () => {
    const tools = createCoachChatTools(chatDeps() as unknown as CoachChatToolDeps, { pausedUntil: null });
    const reads = tools.map((t) => t.tool.name).filter((name) => name.startsWith('get_') || name.startsWith('list_'));
    expect(reads.sort()).toEqual(Object.keys(READ_TOOL_ARGS).sort());
  });

  it("the user's own free text arrives; no secret does, and every query is scoped to the caller", async () => {
    const deps = chatDeps();
    const tools = createCoachChatTools(deps as unknown as CoachChatToolDeps, { pausedUntil: null });
    const outputs: Record<string, string> = {};
    for (const [name, args] of Object.entries(READ_TOOL_ARGS)) {
      const tool = tools.find((t) => t.tool.name === name)!;
      const parsed = tool.parseArguments(JSON.stringify(args));
      if (!parsed.success) throw new Error(`${name}: ${parsed.error}`);
      outputs[name] = JSON.stringify(await tool.execute(parsed.data, { userId: CHAT_USER }));
    }
    const all = Object.values(outputs).join('\n');

    const leaks = Object.entries(SECRET).filter(([, secret]) => all.includes(String(secret)));
    expect(leaks).toEqual([]);
    const missing = Object.entries(FREE).filter(([, text]) => !all.includes(text));
    expect(missing).toEqual([]);
    // The tools that carry the workout really answered (not `unavailable`).
    for (const name of ['get_workout_history', 'get_workout', 'get_about_me', 'get_activity', 'get_exercise_history']) {
      expect(outputs[name]).not.toContain('"error"');
    }

    // Every read of a user-owned table filters by the caller.
    for (const model of ['workout', 'activityEntry', 'program', 'measurement']) {
      const api = (deps.prisma as Record<string, Record<string, jest.Mock>>)[model];
      for (const fn of Object.values(api)) {
        for (const [query] of fn.mock.calls) {
          expect(JSON.stringify(query.where)).toContain(CHAT_USER);
        }
      }
    }
  });
});
